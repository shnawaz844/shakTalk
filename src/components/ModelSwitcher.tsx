import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ViewStyle,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAuth } from '@clerk/clerk-expo';
import { startRazorpayCheckout } from '../utils/razorpayCheckout';
import {
  CallEngine,
  getStoredEngine,
  setStoredEngine,
  subscribeEngineChange,
  PlanTier,
  getStoredPlanTier,
  setStoredPlanTier,
} from '../utils/enginePreference';
import { API_URL } from '../config';

interface ModelSwitcherProps {
  style?: ViewStyle;
}

interface PlanDetails {
  name: string;
  tier: PlanTier;
  price: string;
  amount: string;
}

const PLAN_MAP: Record<CallEngine, PlanDetails> = {
  legacy: {
    name: 'Base Plan',
    tier: 'starter',
    price: '$9.99/mo',
    amount: '$9.99',
  },
  livekit: {
    name: 'Pro Plan',
    tier: 'pro',
    price: '$24.99/mo',
    amount: '$24.99',
  },
};

export function ModelSwitcher({ style }: ModelSwitcherProps) {
  const [engine, setEngine] = useState<CallEngine>('legacy');
  const [currentTier, setCurrentTier] = useState<PlanTier>('starter');
  const [isUpgrading, setIsUpgrading] = useState(false);
  const { getToken } = useAuth();

  useEffect(() => {
    getStoredEngine().then(setEngine);
    getStoredPlanTier().then(setCurrentTier);

    const unsubEngine = subscribeEngineChange(setEngine);
    return unsubEngine;
  }, []);

  const triggerPaymentFlow = async (targetEngine: CallEngine) => {
    const targetPlan = PLAN_MAP[targetEngine];
    setIsUpgrading(true);

    try {
      const result = await startRazorpayCheckout({
        type: 'plan',
        tier: targetPlan.tier,
        name: 'ShakTalk',
        description: `Upgrade to ${targetPlan.name}`,
        email: 'aabir.hussain1@gmail.com',
      });

      if (result.success) {
        await setStoredEngine(targetEngine);
        await setStoredPlanTier(targetPlan.tier);
        setEngine(targetEngine);
        setCurrentTier(targetPlan.tier);

        Alert.alert(
          'Plan Upgraded! 🎉',
          `You are now subscribed to the ${targetPlan.name} (${targetPlan.price}). Your AI model has been updated.`
        );
        return;
      }

      if (result.error && !result.error.toLowerCase().includes('cancel')) {
        Alert.alert('Payment Notice', result.error);
      }
    } catch (err: any) {
      console.error('[ModelSwitcher Payment] Error:', err);
      Alert.alert(
        'Payment Notice',
        err.message || 'Unable to connect to the payment gateway.',
        [
          {
            text: 'Switch Anyway (Test Mode)',
            style: 'destructive',
            onPress: async () => {
              await setStoredEngine(targetEngine);
              await setStoredPlanTier(targetPlan.tier);
              setEngine(targetEngine);
              setCurrentTier(targetPlan.tier);
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
    } finally {
      setIsUpgrading(false);
    }
  };

  const payUsingWalletBalance = async (targetEngine: CallEngine) => {
    const targetPlan = PLAN_MAP[targetEngine];
    try {
      setIsUpgrading(true);
      const token = await getToken();
      if (!token) {
        Alert.alert('Notice', 'Please sign in to use wallet balance.');
        return;
      }

      const res = await fetch(`${API_URL}/wallet/pay-with-wallet`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tier: targetPlan.tier }),
      });

      const data = await res.json();
      if (!data.ok) {
        Alert.alert(
          'Insufficient Wallet Balance',
          `${data.error || 'You do not have enough funds.'}\nYour current balance: ${data.currentBalance || '$0.00'}\n\nWould you like to pay with Razorpay instead?`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Pay via Razorpay',
              onPress: () => triggerPaymentFlow(targetEngine),
            },
          ]
        );
        return;
      }

      await setStoredEngine(targetEngine);
      await setStoredPlanTier(targetPlan.tier);
      setEngine(targetEngine);
      setCurrentTier(targetPlan.tier);

      Alert.alert(
        'Subscription Activated! 🎉',
        `Deducted ${targetPlan.amount} from your wallet balance. New Balance: ${data.newBalance}\nYour AI model is now upgraded to ${targetPlan.name}.`
      );
    } catch (err: any) {
      Alert.alert('Notice', err.message || 'Failed to pay with wallet.');
    } finally {
      setIsUpgrading(false);
    }
  };

  const handleSelect = (choice: CallEngine) => {
    if (choice === engine) return;

    const targetPlan = PLAN_MAP[choice];

    Alert.alert(
      `Switch to ${targetPlan.name}?`,
      `The ${targetPlan.name} requires an active ${targetPlan.price} subscription.\n\nHow would you like to pay?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pay with Wallet',
          onPress: () => payUsingWalletBalance(choice),
        },
        {
          text: `Razorpay (${targetPlan.amount})`,
          onPress: () => triggerPaymentFlow(choice),
        },
      ]
    );
  };

  return (
    <View style={[styles.container, style]}>
      <View style={styles.headerRow}>
        <Feather name="cpu" size={13} color="#2FE0A8" />
        <Text style={styles.headerLabel}>AI TRANSLATION MODEL</Text>
        {isUpgrading && (
          <ActivityIndicator size="small" color="#2FE0A8" style={{ marginLeft: 8 }} />
        )}
      </View>

      <View style={styles.switchWrapper}>
        {/* Gemini 2.5 Flash Button */}
        <TouchableOpacity
          style={[
            styles.modelBtn,
            engine === 'legacy' ? styles.modelBtnActive : styles.modelBtnInactive,
          ]}
          onPress={() => handleSelect('legacy')}
          activeOpacity={0.8}
          disabled={isUpgrading}
        >
          <View style={styles.btnContent}>
            <View style={styles.titleRow}>
              <View style={styles.titleWithIcon}>
                <Feather
                  name="zap"
                  size={13}
                  color={engine === 'legacy' ? '#39FF14' : '#8A9793'}
                  style={{ marginRight: 4 }}
                />
                <Text
                  style={[
                    styles.btnTitle,
                    engine === 'legacy' ? styles.btnTitleActiveLegacy : styles.btnTitleInactive,
                  ]}
                >
                  Base Plan
                </Text>
              </View>
              {engine === 'legacy' && (
                <View style={[styles.activeCheck, { backgroundColor: '#39FF14' }]}>
                  <Feather name="check" size={10} color="#000" />
                </View>
              )}
            </View>
            <Text style={styles.btnSubtitle}>Turn-by-Turn Translation</Text>
          </View>
        </TouchableOpacity>

        {/* Gemini 3.5 Live Button */}
        <TouchableOpacity
          style={[
            styles.modelBtn,
            engine === 'livekit' ? styles.modelBtnActive : styles.modelBtnInactive,
          ]}
          onPress={() => handleSelect('livekit')}
          activeOpacity={0.8}
          disabled={isUpgrading}
        >
          <View style={styles.btnContent}>
            <View style={styles.titleRow}>
              <View style={styles.titleWithIcon}>
                <Feather
                  name="activity"
                  size={13}
                  color={engine === 'livekit' ? '#2FE0A8' : '#8A9793'}
                  style={{ marginRight: 4 }}
                />
                <Text
                  style={[
                    styles.btnTitle,
                    engine === 'livekit' ? styles.btnTitleActiveLive : styles.btnTitleInactive,
                  ]}
                >
                  Pro Plan
                </Text>
              </View>
              {engine === 'livekit' && (
                <View style={[styles.activeCheck, { backgroundColor: '#2FE0A8' }]}>
                  <Feather name="check" size={10} color="#000" />
                </View>
              )}
            </View>
            <Text style={styles.btnSubtitle}>Real-time Translation</Text>
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#121714',
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 6,
  },
  headerLabel: {
    color: '#8A9793',
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  switchWrapper: {
    flexDirection: 'row',
    gap: 8,
  },
  modelBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
  },
  modelBtnActive: {
    backgroundColor: '#182C22',
    borderColor: '#2FE0A8',
  },
  modelBtnInactive: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  btnContent: {
    flexDirection: 'column',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  btnTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  btnTitleActiveLegacy: {
    color: '#39FF14',
  },
  btnTitleActiveLive: {
    color: '#2FE0A8',
  },
  btnTitleInactive: {
    color: '#D1DDD9',
  },
  btnSubtitle: {
    fontSize: 10,
    color: '#7C8985',
    marginTop: 3,
  },
  activeCheck: {
    width: 15,
    height: 15,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
