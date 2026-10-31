/**
 * ShakTalk Razorpay Payment Service
 * Handles order creation, hosted checkout rendering, and signature verification.
 * 
 * Unit Cost & Margin Analysis:
 * - Gemini 2.5 Flash Raw Cost: ~$0.025 / min
 * - Gemini 3.5 Live Raw Cost: ~$0.050 / min
 * - Retail Rate Card: $0.100 / min (₹9.50 / min)
 * - Gross Profit Margin: 50% to 75%
 */
const crypto = require('crypto');

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('[paymentService] Warning: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not set in environment.');
}

const PLANS = {
  starter: {
    name: 'Base Plan',
    modelName: 'Gemini 2.5 Flash',
    engine: 'legacy',
    amountCents: 999, // $9.99
    minutesIncluded: 100,
    currency: 'USD',
    displayPrice: '$9.99',
    displayMinutes: '100 min / month',
    description: '100 min/mo Turn-by-Turn Translation (Gemini 2.5 Flash)',
  },
  pro: {
    name: 'Pro Plan',
    modelName: 'Gemini 3.5 Live',
    engine: 'livekit',
    amountCents: 2499, // $24.99
    minutesIncluded: 250,
    currency: 'USD',
    displayPrice: '$24.99',
    displayMinutes: '250 min / month',
    description: '250 min/mo Simultaneous Live Translation (Gemini 3.5 Live)',
  },
  business: {
    name: 'Dual AI All-Access',
    modelName: 'Dual Gemini 3.5 & 2.5',
    engine: 'livekit',
    amountCents: 4999, // $49.99
    minutesIncluded: 500,
    currency: 'USD',
    displayPrice: '$49.99',
    displayMinutes: '500 min / month',
    description: '500 min/mo Dual AI Translation Access',
  },
};

/**
 * Creates a Razorpay Order via REST API.
 * Supports plan purchases or wallet minutes top-ups.
 */
async function createOrder({ tier, amountCents, email, userId, type = 'plan' }) {
  let finalAmount = 0;
  let currency = 'USD';
  let planName = 'ShakTalk Wallet Top-up';
  let displayPrice = '';
  let minutes = 0;

  if (type === 'wallet_topup') {
    finalAmount = Number(amountCents);
    if (finalAmount < 600) {
      throw new Error('Minimum wallet top-up is 60 minutes ($6.00)');
    }
    minutes = Math.floor(finalAmount / 10);
    displayPrice = `$${(finalAmount / 100).toFixed(2)}`;
    planName = `ShakTalk Wallet - ${minutes} Minutes Top-up`;
  } else {
    const plan = PLANS[tier] || PLANS.pro;
    finalAmount = plan.amountCents;
    planName = `${plan.name} (${plan.minutesIncluded} mins/mo)`;
    displayPrice = plan.displayPrice;
    minutes = plan.minutesIncluded;
  }

  const authHeader = 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  const receipt = `shak_${type}_${Date.now()}`.slice(0, 40);

  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({
      amount: finalAmount,
      currency,
      receipt,
      notes: {
        type,
        tier: tier || 'none',
        plan_name: planName,
        minutes_included: String(minutes),
        user_id: userId || 'anonymous',
      },
    }),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`Razorpay Order creation failed: ${data.error.description || JSON.stringify(data.error)}`);
  }

  return {
    orderId: data.id,
    amount: data.amount,
    currency: data.currency,
    tier: tier || 'wallet',
    planName,
    displayPrice,
    minutes,
    type,
    keyId: RAZORPAY_KEY_ID,
  };
}

/**
 * Validates the Razorpay HMAC signature.
 */
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expectedSignature === signature;
}

/**
 * Renders the hosted Razorpay Checkout page that opens in the app's browser modal.
 */
function renderCheckoutHtml({ orderId, tier = 'pro', amountCents, email = 'aabir.hussain1@gmail.com', type = 'plan', returnScheme = 'shaktalk' }) {
  let title = 'ShakTalk Pro Plan';
  let displayPrice = '$24.99';
  let desc = '250 minutes of real-time live AI voice translation with Gemini 3.5 Live.';
  let badge = 'Active Subscription';
  let amount = 2499;

  if (type === 'wallet_topup') {
    amount = Number(amountCents) || 600;
    const mins = Math.floor(amount / 10);
    title = `${mins} Minutes Wallet Top-up`;
    displayPrice = `$${(amount / 100).toFixed(2)}`;
    desc = `Add ${mins} minutes to your ShakTalk translation wallet. Valid for all calls.`;
    badge = 'Prepaid Minutes';
  } else {
    const plan = PLANS[tier] || PLANS.pro;
    title = plan.name;
    displayPrice = plan.displayPrice;
    desc = `${plan.minutesIncluded} minutes / month of live translation with ${plan.modelName}.`;
    badge = 'Monthly Plan';
    amount = plan.amountCents;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>ShakTalk Secure Payment</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0A0D0C;
      color: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      text-align: center;
    }
    .card {
      background: #121817;
      border: 1px solid #1E2B27;
      border-radius: 24px;
      padding: 32px 24px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      background: rgba(47, 224, 168, 0.12);
      border: 1px solid rgba(47, 224, 168, 0.3);
      color: #2FE0A8;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
      text-transform: uppercase;
    }
    h1 {
      font-size: 24px;
      font-weight: 800;
      margin-bottom: 6px;
      letter-spacing: -0.3px;
    }
    .price {
      font-size: 36px;
      font-weight: 900;
      color: #2FE0A8;
      margin: 12px 0 20px;
    }
    .price span {
      font-size: 14px;
      color: rgba(255,255,255,0.5);
      font-weight: 500;
    }
    .desc {
      font-size: 13.5px;
      color: rgba(255,255,255,0.65);
      line-height: 20px;
      margin-bottom: 24px;
    }
    .btn {
      width: 100%;
      background: #2FE0A8;
      color: #000;
      border: none;
      padding: 16px;
      font-size: 16px;
      font-weight: 800;
      border-radius: 14px;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .btn:active { opacity: 0.8; }
    .cancel {
      display: inline-block;
      margin-top: 18px;
      color: rgba(255,255,255,0.4);
      font-size: 13px;
      text-decoration: none;
    }
    .status-msg {
      margin-top: 16px;
      font-size: 13px;
      color: #2FE0A8;
      display: none;
    }
    .spinner {
      border: 3px solid rgba(255,255,255,0.1);
      border-top: 3px solid #2FE0A8;
      border-radius: 50%;
      width: 24px;
      height: 24px;
      animation: spin 0.8s linear infinite;
      margin: 16px auto 0;
      display: none;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${badge}</div>
    <h1>${title}</h1>
    <div class="price">${displayPrice} ${type === 'plan' ? '<span>/ month</span>' : ''}</div>
    <div class="desc">${desc}</div>

    <button id="rzp-button" class="btn">Proceed to Pay ${displayPrice}</button>
    <div id="spinner" class="spinner"></div>
    <div id="status" class="status-msg">Verifying payment with bank...</div>
    <br>
    <a href="${returnScheme}://payment-cancel" class="cancel">Cancel and return to app</a>
  </div>

  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    var keyId = "${RAZORPAY_KEY_ID}";
    var orderId = "${orderId}";
    var tier = "${tier}";
    var amount = ${amount};
    var currency = "USD";
    var type = "${type}";
    var returnScheme = "${returnScheme}";

    var options = {
      key: keyId,
      amount: amount,
      currency: currency,
      name: "ShakTalk",
      description: "${title}",
      order_id: orderId,
      prefill: {
        email: "${email}"
      },
      theme: {
        color: "#2FE0A8"
      },
      handler: function (response) {
        document.getElementById('rzp-button').style.display = 'none';
        document.getElementById('spinner').style.display = 'block';
        document.getElementById('status').style.display = 'block';

        fetch('/payment/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: response.razorpay_order_id,
            paymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
            tier: tier,
            type: type,
            amountCents: amount
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          document.getElementById('spinner').style.display = 'none';

          if (data.ok) {
            document.getElementById('status').innerHTML = '✅ <b>Payment Successful!</b><br><br><span style="color:rgba(255,255,255,0.7);font-size:13px;">Payment ID: ' + response.razorpay_payment_id + '<br><br><button onclick="window.close()" style="margin-top:12px;background:#2FE0A8;color:#000;border:none;padding:10px 18px;border-radius:10px;font-weight:700;cursor:pointer;">Return to App</button></span>';
            document.getElementById('status').style.display = 'block';

            if (window.opener) {
              try {
                window.opener.postMessage({
                  type: 'shaktalk_payment_success',
                  status: 'success',
                  tier: tier,
                  paymentId: response.razorpay_payment_id
                }, '*');
              } catch(e) {}
              setTimeout(function() { window.close(); }, 800);
            }

            var base = returnScheme || 'shaktalk://';
            if (base.indexOf('://') === -1) {
              base = base + '://';
            }
            if (!base.endsWith('/') && !base.endsWith('?')) {
              base = base + '/';
            }
            var targetUrl = base + 'payment-success?status=success&type=' + encodeURIComponent(type) + '&tier=' + encodeURIComponent(tier) + '&paymentId=' + encodeURIComponent(response.razorpay_payment_id);
            try {
              window.location.href = targetUrl;
            } catch(e) {}
          } else {
            document.getElementById('status').innerHTML = '❌ <b>Payment Verification Failed</b><br><br><span style="color:#ff6b6b;font-size:13px;">' + (data.error || 'Please contact support.') + '</span>';
            document.getElementById('status').style.display = 'block';
          }
        })
        .catch(function(err) {
          document.getElementById('spinner').style.display = 'none';
          document.getElementById('status').innerHTML = '✅ <b>Payment Received!</b><br><br><span style="color:rgba(255,255,255,0.7);font-size:13px;">Payment ID: ' + response.razorpay_payment_id + '<br>You can now return to ShakTalk.</span>';
          document.getElementById('status').style.display = 'block';
        });
      },
      modal: {
        ondismiss: function() {
          console.log("Checkout modal closed");
        }
      }
    };

    var rzp = new Razorpay(options);

    document.getElementById('rzp-button').onclick = function(e) {
      rzp.open();
      e.preventDefault();
    };

    window.addEventListener('load', function() {
      setTimeout(function() {
        try { rzp.open(); } catch(e) {}
      }, 300);
    });
  </script>
</body>
</html>`;
}

module.exports = {
  createOrder,
  verifyPaymentSignature,
  renderCheckoutHtml,
  PLANS,
  RAZORPAY_KEY_ID,
};
