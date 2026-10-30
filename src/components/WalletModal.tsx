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

const TOPUP_OPTIONS = [
  { label: '$10', cents: 1000 },
  { label: '$25', cents: 2500 },
  { label: '$50', cents: 5000 },
  { label: '$100', cents: 10000 },
];

const PLAN_INFO: Record<
  PlanTier,
  {
    name: string;
    price: string;
    monthlyAmount: string;
    model: string;
    color: string;
    icon: 'zap' | 'activity' | 'layers';
    description: string;
  }
> = {
  starter: {
    name: 'Base Plan',
    price: '$9.99',
    monthlyAmount: '$9.99 / mo',
    model: 'Gemini 2.5 Flash',
    color: '#39FF14',
    icon: 'zap',
    description: 'Turn-by-Turn Translation (Paid via Razorpay)',
  },
  pro: {
    name: 'Pro Plan',
    price: '$24.99',
    monthlyAmount: '$24.99 / mo',
    model: 'Gemini 3.5 Live',
    color: '#2FE0A8',
    icon: 'activity',
    description: 'Real-Time Simultaneous Live Translation',
  },
  business: {
    name: 'Dual AI All-Access',
    price: '$49.99',
    monthlyAmount: '$49.99 / mo',
    model: 'Both 3.5 Live & 2.5 Flash',
    color: '#E6A23C',
    icon: 'layers',
    description: 'Both Turn-by-Turn & Live Simultaneous',
  },
  payg: {
    name: 'Standard Plan',
    price: '$0.00',
    monthlyAmount: 'Pay as you go',
    model: 'Gemini Flash',
    color: '#8A9793',
    icon: 'zap',
    description: 'Standard Translation Access',
  },
};

export function WalletModal({ visible, onClose, onBalanceUpdated }: WalletModalProps) {
  const { getToken } = useAuth();
  const { user } = useUser();
  const [balance, setBalance] = useState('$0.00');
  const [loading, setLoading] = useState(false);
  const [processingTopup, setProcessingTopup] = useState(false);
  const [selectedAmountCents, setSelectedAmountCents] = useState(2500);
  const [customAmount, setCustomAmount] = useState('');
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

      const res = await fetch(`${API_URL}/wallet/balance`, { headers });
      const data = await res.json();
      if (data.ok && data.balanceFormatted) {
        setBalance(data.balanceFormatted);
        onBalanceUpdated?.(data.balanceFormatted);
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

  const handleCustomAmountChange = (text: string) => {
    const sanitized = text.replace(/[^0-9.]/g, '');
    const parts = sanitized.split('.');
    const clean = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : sanitized;
    setCustomAmount(clean);

    const num = parseFloat(clean);
    if (!isNaN(num) && num > 0) {
      setSelectedAmountCents(Math.round(num * 100));
    } else {
      setSelectedAmountCents(0);
    }
  };

  const handleTopup = async () => {
    if (!selectedAmountCents || selectedAmountCents < 100) {
      const msg = 'Please enter a valid amount (minimum $1.00).';
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
        name: 'ShakTalk Wallet Top-up',
        description: `Add $${(selectedAmountCents / 100).toFixed(2)} to Wallet Balance`,
        email: user?.primaryEmailAddress?.emailAddress || 'aabir.hussain1@gmail.com',
      });

      if (result.success) {
        await fetchBalance();
        setCustomAmount('');
        if (Platform.OS === 'web') {
          alert('🎉 Top-up Successful! Your wallet balance has been updated.');
        } else {
          Alert.alert('Top-up Successful! 🎉', 'Your wallet balance has been updated.');
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

  const isCustomActive = !!customAmount;

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
                  <Text style={[styles.planPriceValue, { color: activePlan.color }]}>{activePlan.price}</Text>
                  <Text style={styles.planPriceSub}>/mo paid</Text>
                </View>
              </View>

              <View style={styles.planDivider} />

              <View style={styles.planFooterRow}>
                <Feather name="check-circle" size={12} color={activePlan.color} style={{ marginRight: 6 }} />
                <Text style={styles.planFooterText}>{activePlan.description}</Text>
              </View>
            </View>

            {/* Available Wallet Cash Card */}
            <View style={styles.balanceCard}>
              <View style={styles.balanceHeaderRow}>
                <Text style={styles.balanceLabel}>AVAILABLE WALLET CASH</Text>
                <Feather name="shield" size={12} color="#2FE0A8" />
              </View>
              {loading ? (
                <ActivityIndicator color="#2FE0A8" style={{ marginVertical: 6 }} />
              ) : (
                <Text style={styles.balanceAmount}>{balance}</Text>
              )}
              <Text style={styles.balanceSub}>
                Use wallet cash for extra call time, model add-ons, or automatic plan renewals.
              </Text>
            </View>

            {/* Quick Preset Buttons */}
            <Text style={styles.sectionLabel}>CHOOSE TOP-UP AMOUNT</Text>
            <View style={styles.amountGrid}>
              {TOPUP_OPTIONS.map((opt) => {
                const isSelected = !isCustomActive && selectedAmountCents === opt.cents;
                return (
                  <TouchableOpacity
                    key={opt.cents}
                    style={[styles.amountBtn, isSelected && styles.amountBtnSelected]}
                    onPress={() => {
                      setCustomAmount('');
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

            {/* Custom Any-Amount Input */}
            <View style={styles.customSection}>
              <Text style={styles.customLabel}>OR ENTER ANY AMOUNT ($)</Text>
              <View style={[styles.customInputRow, isCustomActive && styles.customInputRowActive]}>
                <Text style={[styles.currencyPrefix, isCustomActive && styles.currencyPrefixActive]}>$</Text>
                <TextInput
                  style={styles.customInput}
                  value={customAmount}
                  onChangeText={handleCustomAmountChange}
                  placeholder="e.g. 22"
                  placeholderTextColor="rgba(255, 255, 255, 0.3)"
                  keyboardType="decimal-pad"
                  maxLength={6}
                />
                {isCustomActive ? (
                  <TouchableOpacity
                    onPress={() => {
                      setCustomAmount('');
                      setSelectedAmountCents(2500);
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
                (processingTopup || selectedAmountCents < 100) && { opacity: 0.6 },
              ]}
              onPress={handleTopup}
              disabled={processingTopup || selectedAmountCents < 100}
              activeOpacity={0.85}
            >
              {processingTopup ? (
                <ActivityIndicator color="#000" size="small" />
              ) : (
                <>
                  <Feather name="plus-circle" size={18} color="#000" style={{ marginRight: 8 }} />
                  <Text style={styles.topupBtnText}>
                    {selectedAmountCents >= 100
                      ? `Top-up $${(selectedAmountCents / 100).toFixed(2)} with Razorpay`
                      : 'Enter an amount (min $1.00)'}
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
    fontSize: 34,
    fontWeight: '900',
    color: '#2FE0A8',
    letterSpacing: -0.5,
    marginVertical: 2,
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
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  amountBtnSelected: {
    borderColor: '#2FE0A8',
    backgroundColor: 'rgba(47, 224, 168, 0.14)',
  },
  amountText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFF',
  },
  amountTextSelected: {
    color: '#2FE0A8',
    fontWeight: '800',
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
  currencyPrefix: {
    fontSize: 17,
    fontWeight: '800',
    color: 'rgba(255, 255, 255, 0.4)',
    marginRight: 6,
  },
  currencyPrefixActive: {
    color: '#2FE0A8',
  },
  customInput: {
    flex: 1,
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
    height: '100%',
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
    fontSize: 15,
    fontWeight: '800',
    color: '#000',
    letterSpacing: 0.2,
  },
});
