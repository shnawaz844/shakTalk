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
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAuth } from '@clerk/clerk-expo';
import { startRazorpayCheckout } from '../utils/razorpayCheckout';
import { API_URL } from '../config';

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

export function WalletModal({ visible, onClose, onBalanceUpdated }: WalletModalProps) {
  const { getToken } = useAuth();
  const [balance, setBalance] = useState('$0.00');
  const [loading, setLoading] = useState(false);
  const [processingTopup, setProcessingTopup] = useState(false);
  const [selectedAmountCents, setSelectedAmountCents] = useState(2500);
  const [customAmount, setCustomAmount] = useState('');

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
    }
  }, [visible]);

  const handleCustomAmountChange = (text: string) => {
    // Keep only numbers and max 1 decimal point
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
        name: 'ShakTalk Wallet Top-up',
        description: `Add $${(selectedAmountCents / 100).toFixed(2)} to Wallet Balance`,
        email: 'aabir.hussain1@gmail.com',
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

          {/* Balance Display Card */}
          <View style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>AVAILABLE BALANCE</Text>
            {loading ? (
              <ActivityIndicator color="#2FE0A8" style={{ marginVertical: 8 }} />
            ) : (
              <Text style={styles.balanceAmount}>{balance}</Text>
            )}
            <Text style={styles.balanceSub}>
              Use your wallet to subscribe to AI plans or pay for active call minutes.
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
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  content: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#121714',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    padding: 24,
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
    marginBottom: 20,
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
  balanceCard: {
    backgroundColor: '#0D1411',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(47, 224, 168, 0.3)',
    padding: 22,
    alignItems: 'center',
    marginBottom: 20,
  },
  balanceLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: 'rgba(255, 255, 255, 0.5)',
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  balanceAmount: {
    fontSize: 36,
    fontWeight: '900',
    color: '#2FE0A8',
    letterSpacing: -0.5,
    marginVertical: 4,
  },
  balanceSub: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.5)',
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#8A9793',
    letterSpacing: 1.1,
    marginBottom: 10,
  },
  amountGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 16,
  },
  amountBtn: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  amountBtnSelected: {
    borderColor: '#2FE0A8',
    backgroundColor: 'rgba(47, 224, 168, 0.14)',
  },
  amountText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFF',
  },
  amountTextSelected: {
    color: '#2FE0A8',
    fontWeight: '800',
  },
  customSection: {
    marginBottom: 20,
  },
  customLabel: {
    fontSize: 11,
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
    height: 50,
  },
  customInputRowActive: {
    borderColor: '#2FE0A8',
    backgroundColor: 'rgba(47, 224, 168, 0.06)',
  },
  currencyPrefix: {
    fontSize: 18,
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
    fontSize: 16,
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
    paddingVertical: 16,
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
