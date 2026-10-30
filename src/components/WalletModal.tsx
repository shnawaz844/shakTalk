import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ActivityIndicator,
  Alert,
  Platform,
  TextInput,
  ScrollView,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAuth, useUser } from '@clerk/clerk-expo';
import { startRazorpayCheckout } from '../utils/razorpayCheckout';
import { API_URL } from '../config';
import {
  PlanTier,
  getStoredPlanTier,
  subscribePlanTierChange,
} from '../utils/enginePreference';

interface WalletModalProps {
  visible: boolean;
  onClose: () => void;
  onBalanceUpdated?: (balanceFormatted: string) => void;
}

// Preset top-up packages in minutes
const MINUTE_PRESETS = [
  { minutes: 50, cents: 500, label: '50 Mins' },
  { minutes: 100, cents: 1000, label: '100 Mins' },
  { minutes: 250, cents: 2499, label: '250 Mins' },
  { minutes: 500, cents: 4999, label: '500 Mins' },
];

const PLAN_INFO: Record<
  PlanTier,
  {
    name: string;
    model: string;
    monthlyMinutes: string;
    color: string;
    icon: 'zap' | 'activity' | 'layers';
    description: string;
  }
> = {
  starter: {
    name: 'Base Plan',
    model: 'Gemini 2.5 Flash',
    monthlyMinutes: '100 mins',
    color: '#39FF14',
    icon: 'zap',
    description: '100 min/mo Turn-by-Turn Translation',
  },
  pro: {
    name: 'Pro Plan',
    model: 'Gemini 3.5 Live',
    monthlyMinutes: '250 mins',
    color: '#2FE0A8',
    icon: 'activity',
    description: '250 min/mo Simultaneous Live Translation',
  },
  business: {
    name: 'Dual AI All-Access',
    model: 'Dual Gemini 3.5 & 2.5',
    monthlyMinutes: '500 mins',
    color: '#E6A23C',
    icon: 'layers',
    description: '500 min/mo Dual AI Translation Access',
  },
  payg: {
    name: 'Standard Plan',
    model: 'Gemini Flash',
    monthlyMinutes: '0 mins',
    color: '#8A9793',
    icon: 'zap',
    description: 'Standard translation access',
  },
};

export function WalletModal({ visible, onClose, onBalanceUpdated }: WalletModalProps) {
  const { getToken } = useAuth();
  const { user } = useUser();
  const [balanceMinutes, setBalanceMinutes] = useState(100);
  const [loading, setLoading] = useState(false);
  const [processingTopup, setProcessingTopup] = useState(false);
  const [selectedMinutes, setSelectedMinutes] = useState(100);
  const [selectedAmountCents, setSelectedAmountCents] = useState(1000);
  const [customMinutes, setCustomMinutes] = useState('');
  const [currentTier, setCurrentTier] = useState<PlanTier>('starter');

  useEffect(() => {
    getStoredPlanTier().then(setCurrentTier);
    const unsub = subscribePlanTierChange(setCurrentTier);
    return unsub;
  }, []);

  const activePlan = PLAN_INFO[currentTier] || PLAN_INFO.starter;

  const fetchBalance = async () => {
    try {
      setLoading(true);
      const token = await getToken().catch(() => null);
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const url = user?.id
        ? `${API_URL}/wallet/balance?userId=${encodeURIComponent(user.id)}`
        : `${API_URL}/wallet/balance`;

      const res = await fetch(url, { headers });
      const data = await res.json();
      if (data.ok) {
        const mins = data.balanceMinutes !== undefined ? Number(data.balanceMinutes) : Math.floor((data.balanceCents || 0) / 10);
        setBalanceMinutes(mins);
        onBalanceUpdated?.(`${mins} mins`);
      }
    } catch (e) {
      console.warn('[WalletModal] fetchBalance error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible) {
      fetchBalance();
      getStoredPlanTier().then(setCurrentTier);
    }
  }, [visible]);

  // Handle custom minutes input (e.g. 20 minutes)
  const handleCustomMinutesChange = (text: string) => {
    const sanitized = text.replace(/[^0-9]/g, '');
    setCustomMinutes(sanitized);

    const mins = parseInt(sanitized, 10);
    if (!isNaN(mins) && mins > 0) {
      setSelectedMinutes(mins);
      // Rate: 10 cents per minute ($0.10 / min)
      setSelectedAmountCents(mins * 10);
    } else {
      setSelectedMinutes(0);
      setSelectedAmountCents(0);
    }
  };

  const handleTopup = async () => {
    if (!selectedMinutes || selectedMinutes < 10) {
      const msg = 'Please enter at least 10 minutes to top up.';
      if (Platform.OS === 'web') {
        alert(msg);
      } else {
        Alert.alert('Notice', msg);
      }
      return;
    }

    try {
      setProcessingTopup(true);
      const token = await getToken().catch(() => null);

      const result = await startRazorpayCheckout({
        type: 'wallet_topup',
        amountCents: selectedAmountCents,
        authToken: token,
        userId: user?.id,
        name: `ShakTalk ${selectedMinutes} Mins Top-up`,
        description: `Add ${selectedMinutes} minutes to your call balance`,
        email: user?.primaryEmailAddress?.emailAddress || 'aabir.hussain1@gmail.com',
      });

      if (result.success) {
        await fetchBalance();
        setCustomMinutes('');
        if (Platform.OS === 'web') {
          alert(`🎉 Top-up Successful! ${selectedMinutes} minutes added to your wallet.`);
        } else {
          Alert.alert('Top-up Successful! 🎉', `${selectedMinutes} minutes added to your wallet.`);
        }
        return;
      }

      if (result.error && !result.error.toLowerCase().includes('cancel')) {
        Alert.alert('Top-up Notice', result.error);
      }
    } catch (err: any) {
      console.error('[WalletModal] Top-up error:', err);
      Alert.alert('Top-up Notice', err.message || 'Payment could not be completed.');
    } finally {
      setProcessingTopup(false);
    }
  };

  const isCustomActive = !!customMinutes;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.content}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={styles.iconCircle}>
                <Feather name="credit-card" size={18} color="#2FE0A8" />
              </View>
              <Text style={styles.title}>ShakTalk Wallet</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.7}>
              <Feather name="x" size={20} color="#8A9793" />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollBody}>
            {/* Active Subscription Plan Card */}
            <View style={[styles.planCard, { borderColor: activePlan.color + '45', backgroundColor: activePlan.color + '0C' }]}>
              <View style={styles.planCardHeader}>
                <View style={styles.planLeft}>
                  <View style={[styles.planIconCircle, { backgroundColor: activePlan.color + '22' }]}>
                    <Feather name={activePlan.icon} size={14} color={activePlan.color} />
                  </View>
                  <View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={[styles.planName, { color: activePlan.color }]}>{activePlan.name}</Text>
                      <View style={[styles.activePill, { backgroundColor: activePlan.color + '26' }]}>
                        <Text style={[styles.activePillText, { color: activePlan.color }]}>ACTIVE PLAN</Text>
                      </View>
                    </View>
                    <Text style={styles.planModelText}>{activePlan.model}</Text>
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[styles.planPriceValue, { color: activePlan.color }]}>{activePlan.monthlyMinutes}</Text>
                  <Text style={styles.planPriceSub}>/mo included</Text>
                </View>
              </View>

              <View style={styles.planDivider} />

              <View style={styles.planFooterRow}>
                <Feather name="clock" size={12} color={activePlan.color} style={{ marginRight: 6 }} />
                <Text style={styles.planFooterText}>{activePlan.description}</Text>
              </View>
            </View>

            {/* Available Wallet Minutes Card */}
            <View style={styles.balanceCard}>
              <View style={styles.balanceHeaderRow}>
                <Text style={styles.balanceLabel}>AVAILABLE WALLET MINUTES</Text>
                <Feather name="clock" size={13} color="#2FE0A8" />
              </View>
              {loading ? (
                <ActivityIndicator color="#2FE0A8" style={{ marginVertical: 6 }} />
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginVertical: 2 }}>
                  <Text style={styles.balanceAmount}>{balanceMinutes}</Text>
                  <Text style={styles.balanceUnit}>MINUTES</Text>
                </View>
              )}
              <Text style={styles.balanceSub}>
                Real-time live voice translation time available across all calls.
              </Text>
            </View>

            {/* Preset Minutes Selection */}
            <Text style={styles.sectionLabel}>CHOOSE TOP-UP MINUTES</Text>
            <View style={styles.amountGrid}>
              {MINUTE_PRESETS.map((opt) => {
                const isSelected = !isCustomActive && selectedMinutes === opt.minutes;
                return (
                  <TouchableOpacity
                    key={opt.minutes}
                    style={[styles.amountBtn, isSelected && styles.amountBtnSelected]}
                    onPress={() => {
                      setCustomMinutes('');
                      setSelectedMinutes(opt.minutes);
                      setSelectedAmountCents(opt.cents);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.amountText, isSelected && styles.amountTextSelected]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Custom Minutes Input */}
            <View style={styles.customSection}>
              <Text style={styles.customLabel}>OR ENTER MINUTES</Text>
              <View style={[styles.customInputRow, isCustomActive && styles.customInputRowActive]}>
                <Feather
                  name="clock"
                  size={16}
                  color={isCustomActive ? "#2FE0A8" : "rgba(255, 255, 255, 0.4)"}
                  style={{ marginRight: 8 }}
                />
                <TextInput
                  style={styles.customInput}
                  value={customMinutes}
                  onChangeText={handleCustomMinutesChange}
                  placeholder="e.g. 20"
                  placeholderTextColor="rgba(255, 255, 255, 0.3)"
                  keyboardType="number-pad"
                  maxLength={5}
                />
                {isCustomActive && selectedAmountCents > 0 && (
                  <View style={styles.customCalcBadge}>
                    <Text style={styles.customCalcText}>
                      {selectedMinutes} Mins
                    </Text>
                  </View>
                )}
                {isCustomActive ? (
                  <TouchableOpacity
                    onPress={() => {
                      setCustomMinutes('');
                      setSelectedMinutes(100);
                      setSelectedAmountCents(1000);
                    }}
                    style={styles.clearBtn}
                    activeOpacity={0.7}
                  >
                    <Feather name="x" size={16} color="rgba(255,255,255,0.6)" />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>

            {/* Top-up Button */}
            <TouchableOpacity
              style={[
                styles.topupBtn,
                (processingTopup || selectedMinutes < 10) && { opacity: 0.6 },
              ]}
              onPress={handleTopup}
              disabled={processingTopup || selectedMinutes < 10}
              activeOpacity={0.85}
            >
              {processingTopup ? (
                <ActivityIndicator color="#000" size="small" />
              ) : (
                <>
                  <Feather name="plus-circle" size={18} color="#000" style={{ marginRight: 8 }} />
                  <Text style={styles.topupBtnText}>
                    {selectedMinutes >= 10
                      ? `Top-up ${selectedMinutes} Minutes with Razorpay`
                      : 'Enter minutes (min 10 mins)'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  content: {
    width: '100%',
    maxWidth: 430,
    maxHeight: '90%',
    backgroundColor: '#121714',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    padding: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.5,
    shadowRadius: 24,
    elevation: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(47, 224, 168, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFF',
    letterSpacing: -0.3,
  },
  closeBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  scrollBody: {
    paddingBottom: 4,
  },
  planCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    marginBottom: 14,
  },
  planCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  planLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  planIconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  planName: {
    fontSize: 14,
    fontWeight: '800',
  },
  activePill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  activePillText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  planModelText: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.6)',
    marginTop: 1,
  },
  planPriceValue: {
    fontSize: 18,
    fontWeight: '800',
  },
  planPriceSub: {
    fontSize: 10,
    color: 'rgba(255, 255, 255, 0.45)',
  },
  planDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    marginVertical: 10,
  },
  planFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  planFooterText: {
    fontSize: 11.5,
    color: 'rgba(255, 255, 255, 0.7)',
    fontWeight: '500',
  },
  balanceCard: {
    backgroundColor: '#0D1411',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(47, 224, 168, 0.3)',
    padding: 18,
    alignItems: 'center',
    marginBottom: 16,
  },
  balanceHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  balanceLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    color: 'rgba(255, 255, 255, 0.5)',
    letterSpacing: 1.2,
  },
  balanceAmount: {
    fontSize: 38,
    fontWeight: '900',
    color: '#2FE0A8',
    letterSpacing: -0.5,
  },
  balanceUnit: {
    fontSize: 13,
    fontWeight: '800',
    color: 'rgba(47, 224, 168, 0.8)',
    letterSpacing: 0.8,
  },
  balanceSub: {
    fontSize: 11.5,
    color: 'rgba(255, 255, 255, 0.5)',
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 16,
  },
  sectionLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#8A9793',
    letterSpacing: 1.1,
    marginBottom: 10,
  },
  amountGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  amountBtn: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  amountBtnSelected: {
    borderColor: '#2FE0A8',
    backgroundColor: 'rgba(47, 224, 168, 0.14)',
  },
  amountText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#FFF',
  },
  amountTextSelected: {
    color: '#2FE0A8',
  },
  amountPriceSub: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.45)',
    marginTop: 2,
  },
  amountPriceSubSelected: {
    color: 'rgba(47, 224, 168, 0.85)',
  },
  customSection: {
    marginBottom: 18,
  },
  customLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#8A9793',
    letterSpacing: 1.1,
    marginBottom: 8,
  },
  customInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 14,
    paddingHorizontal: 16,
    height: 48,
  },
  customInputRowActive: {
    borderColor: '#2FE0A8',
    backgroundColor: 'rgba(47, 224, 168, 0.06)',
  },
  customInput: {
    flex: 1,
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
    height: '100%',
  },
  customCalcBadge: {
    backgroundColor: 'rgba(47, 224, 168, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginRight: 6,
  },
  customCalcText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#2FE0A8',
  },
  clearBtn: {
    padding: 6,
    borderRadius: 6,
  },
  topupBtn: {
    backgroundColor: '#2FE0A8',
    borderRadius: 16,
    paddingVertical: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2FE0A8',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 4,
  },
  topupBtnText: {
    fontSize: 14.5,
    fontWeight: '800',
    color: '#000',
    letterSpacing: 0.2,
  },
});
