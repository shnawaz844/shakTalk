import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { API_URL } from '../config';
import { PlanTier } from './enginePreference';

export interface CheckoutOptions {
  type: 'plan' | 'wallet_topup';
  tier?: PlanTier;
  amountCents?: number;
  currency?: 'USD' | 'INR';
  email?: string;
  authToken?: string | null;
  userId?: string | null;
  name?: string;
  description?: string;
}

export interface CheckoutResult {
  success: boolean;
  orderId?: string;
  paymentId?: string;
  error?: string;
}

/**
 * Loads Razorpay's checkout script dynamically on web platforms.
 */
export async function loadRazorpayWebScript(): Promise<boolean> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return true;
  if ((window as any).Razorpay) return true;

  return new Promise((resolve) => {
    const existing = document.getElementById('razorpay-checkout-script');
    if (existing) {
      existing.addEventListener('load', () => resolve(true));
      existing.addEventListener('error', () => resolve(false));
      return;
    }
    const script = document.createElement('script');
    script.id = 'razorpay-checkout-script';
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

/**
 * Seamlessly handles Razorpay checkout across Web, iOS, and Android.
 * - On Web: Uses Razorpay inline JS modal for instant in-tab checkout without popup or redirect issues.
 * - On Mobile: Uses WebBrowser.openAuthSessionAsync with app deep linking.
 */
export async function startRazorpayCheckout(
  options: CheckoutOptions
): Promise<CheckoutResult> {
  // 1. Create order on the backend
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.authToken) {
    headers['Authorization'] = `Bearer ${options.authToken}`;
  }

  const orderRes = await fetch(`${API_URL}/payment/create-order`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: options.type,
      tier: options.tier,
      amountCents: options.amountCents,
      currency: options.currency,
      email: options.email || 'aabir.hussain1@gmail.com',
      userId: options.userId || undefined,
    }),
  });

  const orderData = await orderRes.json();
  if (!orderData.ok) {
    throw new Error(orderData.error || 'Failed to initialize payment order');
  }

  // 2. Platform-specific execution
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    await loadRazorpayWebScript();

    if (!(window as any).Razorpay) {
      throw new Error('Razorpay payment gateway could not be loaded on this browser.');
    }

    return new Promise<CheckoutResult>((resolve) => {
      const isIndia = (() => {
        try {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
          if (tz.includes('Kolkata') || tz.includes('Calcutta') || tz.includes('India')) return true;
        } catch (_) {}
        return false;
      })();

      // Enforce authoritative Build Plan PDF pricing:
      // Pro: ₹1,499 (149900 paise) / $14.99 (1499 cents)
      // Standard: ₹499 (49900 paise) / $4.99 (499 cents)
      let targetAmount = options.amountCents || orderData.amount;
      let targetCurrency = options.currency || orderData.currency || (isIndia ? 'INR' : 'USD');

      if (options.type === 'plan') {
        if (options.tier === 'pro') {
          targetAmount = isIndia ? 149900 : 1499;
          targetCurrency = isIndia ? 'INR' : 'USD';
        } else {
          targetAmount = isIndia ? 49900 : 499;
          targetCurrency = isIndia ? 'INR' : 'USD';
        }
      }

      const isMismatch = !!(orderData.amount && targetAmount && Number(orderData.amount) !== Number(targetAmount));

      const rzpOptions: any = {
        key: orderData.keyId,
        amount: targetAmount,
        currency: targetCurrency,
        name: options.name || 'ShakTalk',
        description: options.description || orderData.planName,
        prefill: {
          email: options.email || 'aabir.hussain1@gmail.com',
        },
        theme: {
          color: '#2FE0A8',
        },
      };

      if (!isMismatch && orderData.orderId) {
        rzpOptions.order_id = orderData.orderId;
      }

      rzpOptions.handler = async function (response: any) {
          try {
            const verifyHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
            if (options.authToken) {
              verifyHeaders['Authorization'] = `Bearer ${options.authToken}`;
            }

            const verifyRes = await fetch(`${API_URL}/payment/verify`, {
              method: 'POST',
              headers: verifyHeaders,
              body: JSON.stringify({
                orderId: response.razorpay_order_id || orderData.orderId || 'direct_checkout',
                paymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature || 'direct_verified',
                tier: options.tier || 'none',
                type: options.type,
                amountCents: targetAmount,
                userId: options.userId || undefined,
              }),
            });
            const verifyData = await verifyRes.json();
            if (verifyData.ok) {
              resolve({
                success: true,
                orderId: response.razorpay_order_id,
                paymentId: response.razorpay_payment_id,
              });
            } else {
              resolve({
                success: false,
                error: verifyData.error || 'Payment verification failed.',
              });
            }
          } catch (err: any) {
            resolve({
              success: false,
              error: err.message || 'Error verifying payment signature.',
            });
          }
        };

      rzpOptions.modal = {
        ondismiss: function () {
          resolve({ success: false, error: 'Payment was cancelled.' });
        },
      };

      const rzp = new (window as any).Razorpay(rzpOptions);
      rzp.open();
    });
  } else {
    // Mobile (iOS & Android)
    const returnUrl = 'shaktalk://';
    const checkoutUrl = `${orderData.checkoutUrl}&return_scheme=${encodeURIComponent(returnUrl)}`;

    const result = await WebBrowser.openAuthSessionAsync(checkoutUrl, returnUrl);

    if (result.type === 'success' && result.url) {
      const isSuccess =
        result.url.includes('status=success') ||
        result.url.includes('paymentId=') ||
        result.url.includes('payment-status');
      if (isSuccess) {
        return { success: true, orderId: orderData.orderId };
      }
    }

    return {
      success: false,
      error:
        result.type === 'cancel' || result.type === 'dismiss'
          ? 'Payment was cancelled.'
          : 'Payment could not be verified.',
    };
  }
}
