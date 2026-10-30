import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ActivityIndicator,
  Alert,
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

  const fetchBalance = async () => {
    try {
      setLoading(true);
      const token = await getToken();
      if (!token) return;

      const res = await fetch(`${API_URL}/wallet/balance`, {
        headers: { Authorization: `Bearer ${token}` },
      });
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

  const handleTopup = async () => {
    try {
      setProcessingTopup(true);
      const token = await getToken();
      if (!token) {
        Alert.alert('Notice', 'Please sign in to top up your wallet.');
        return;
      }

      const result = await startRazorpayCheckout({
        type: 'wallet_topup',
        amountCents: selectedAmountCents,
        authToken: token,
        name: 'ShakTalk Wallet',
        description: `Add $${(selectedAmountCents / 100).toFixed(2)} to Wallet Balance`,
        email: 'aabir.hussain1@gmail.com',
      });

      if (result.success) {
        Alert.alert('Top-up Successful! 🎉', 'Your wallet balance has been updated.');
        await fetchBalance();
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
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
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

          {/* Top-up Selection */}
          <Text style={styles.sectionLabel}>CHOOSE TOP-UP AMOUNT</Text>
          <View style={styles.amountGrid}>
            {TOPUP_OPTIONS.map((opt) => {
              const isSelected = selectedAmountCents === opt.cents;
              return (
                <TouchableOpacity
                  key={opt.cents}
                  style={[styles.amountBtn, isSelected && styles.amountBtnSelected]}
                  onPress={() => setSelectedAmountCents(opt.cents)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.amountText, isSelected && styles.amountTextSelected]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Top-up Button */}
          <TouchableOpacity
            style={[styles.topupBtn, processingTopup && { opacity: 0.7 }]}
            onPress={handleTopup}
            disabled={processingTopup}
            activeOpacity={0.85}
          >
            {processingTopup ? (
              <ActivityIndicator color="#000" size="small" />
            ) : (
              <>
                <Feather name="plus-circle" size={18} color="#000" style={{ marginRight: 6 }} />
                <Text style={styles.topupBtnText}>
                  Top-up ${(selectedAmountCents / 100).toFixed(2)} with Razorpay
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
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  content: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#121714',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    padding: 22,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
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
    backgroundColor: 'rgba(47, 224, 168, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFF',
  },
  closeBtn: {
    padding: 6,
  },
  balanceCard: {
    backgroundColor: '#0D1411',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(47, 224, 168, 0.25)',
    padding: 20,
    alignItems: 'center',
    marginBottom: 20,
  },
  balanceLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: 'rgba(255, 255, 255, 0.5)',
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  balanceAmount: {
    fontSize: 34,
    fontWeight: '900',
    color: '#2FE0A8',
    letterSpacing: -0.5,
    marginVertical: 4,
  },
  balanceSub: {
    fontSize: 11.5,
    color: 'rgba(255, 255, 255, 0.45)',
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 16,
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
    gap: 8,
    marginBottom: 20,
  },
  amountBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
  },
  amountBtnSelected: {
    backgroundColor: '#182C22',
    borderColor: '#2FE0A8',
  },
  amountText: {
    fontSize: 15,
    fontWeight: '700',
    color: 'rgba(255, 255, 255, 0.8)',
  },
  amountTextSelected: {
    color: '#2FE0A8',
  },
  topupBtn: {
    flexDirection: 'row',
    height: 52,
    borderRadius: 14,
    backgroundColor: '#2FE0A8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topupBtnText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#000',
  },
});

