import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { APP_LOGO, APP_NAME_PREFIX, APP_NAME_SUFFIX } from '../config';
import { startRazorpayCheckout } from '../utils/razorpayCheckout';
import {
  CallEngine,
  setStoredEngine,
  PlanTier,
  setStoredPlanTier,
} from '../utils/enginePreference';

interface PlanSelectionScreenProps {
  onContinue: () => void;
}

interface MonthlyBundle {
  id: PlanTier;
  engine: CallEngine;
  name: string;
  modelName: string;
  modelId: string;
  subtitle: string;
  price: string;
  billingPeriod: string;
  minutes: number;
  minutesLabel: string;
  accentColor: string;
  bgColor: string;
  borderColor: string;
  iconName: 'zap' | 'activity' | 'layers';
}

const MONTHLY_BUNDLES: MonthlyBundle[] = [
  {
    id: 'starter',
    engine: 'legacy',
    name: 'Base Plan',
    modelName: 'Gemini 2.5 Flash',
    modelId: 'live-2.5-flash-native-audio',
    subtitle: 'Turn-by-Turn Translation (One-by-One)',
    price: '$9.99',
    billingPeriod: '/month',
    minutes: 100,
    minutesLabel: '100 min / month',
    accentColor: '#39FF14',
    bgColor: '#0D1F10',
    borderColor: '#39FF14',
    iconName: 'zap',
  },
  {
    id: 'pro',
    engine: 'livekit',
    name: 'Pro Plan',
    modelName: 'Gemini 3.5 Live',
    modelId: 'gemini-3.5-live-translate-preview',
    subtitle: 'Real-Time Live Translation (Simultaneous)',
    price: '$24.99',
    billingPeriod: '/month',
    minutes: 250,
    minutesLabel: '250 min / month',
    accentColor: '#2FE0A8',
    bgColor: '#0A1E1A',
    borderColor: '#2FE0A8',
    iconName: 'activity',
  },
  {
    id: 'business',
    engine: 'livekit',
    name: 'Dual AI All-Access',
    modelName: 'Both Gemini 3.5 Live & 2.5 Flash',
    modelId: 'gemini-3.5-live + live-2.5-flash',
    subtitle: 'Both Turn-by-Turn & Live Translation',
    price: '$49.99',
    billingPeriod: '/month',
    minutes: 500,
    minutesLabel: '500 min / month',
    accentColor: '#E6A23C',
    bgColor: '#1D170A',
    borderColor: '#E6A23C',
    iconName: 'layers',
  },
];

export function PlanSelectionScreen({ onContinue }: PlanSelectionScreenProps) {
  const [selectedTier, setSelectedTier] = useState<PlanTier>('pro');
  const [isProcessing, setIsProcessing] = useState(false);

  const selectedBundle =
    MONTHLY_BUNDLES.find((b) => b.id === selectedTier) || MONTHLY_BUNDLES[1];

  const handleContinueWithPayment = async () => {
    setIsProcessing(true);
    try {
      const result = await startRazorpayCheckout({
        type: 'plan',
        tier: selectedBundle.id,
        name: 'ShakTalk',
        description: `${selectedBundle.name} Monthly Subscription`,
        email: 'aabir.hussain1@gmail.com',
      });

      if (result.success) {
        await setStoredEngine(selectedBundle.engine);
        await setStoredPlanTier(selectedBundle.id);

        if (Platform.OS === 'web') {
          window.alert(`🎉 Payment Successful! Your ${selectedBundle.name} subscription is now active.`);
          onContinue();
        } else {
          Alert.alert(
            'Payment Successful! 🎉',
            `Your ${selectedBundle.name} subscription is now active. Welcome to ShakTalk!`,
            [
              {
                text: 'Continue',
                onPress: () => onContinue(),
              },
            ]
          );
        }
        return;
      }

      if (result.error && !result.error.toLowerCase().includes('cancel')) {
        Alert.alert('Payment Notice', result.error);
      }
    } catch (err: any) {
      console.error('[Payment] Error:', err);
      Alert.alert(
        'Payment Notice',
        err.message || 'Unable to connect to the payment gateway. Please try again.',
        [
          {
            text: 'Skip for Now (Test Mode)',
            style: 'destructive',
            onPress: async () => {
              await setStoredEngine(selectedBundle.engine);
              await setStoredPlanTier(selectedBundle.id);
              onContinue();
            },
          },
          { text: 'Retry', style: 'default' },
        ]
      );
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.glowTopRight} />
      <View style={styles.glowBottomLeft} />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <Image source={APP_LOGO} style={styles.logo} resizeMode="cover" />
          <Text style={styles.appName}>
            {APP_NAME_PREFIX}
            {APP_NAME_SUFFIX ? <Text style={styles.appNameGreen}>{APP_NAME_SUFFIX}</Text> : null}
          </Text>
          <Text style={styles.headline}>Choose Your Monthly Plan</Text>
          <Text style={styles.subheadline}>
            Select a monthly subscription to get your included translation minutes.
          </Text>
        </View>

        {/* Monthly Bundles Cards */}
        <View style={styles.cardsContainer}>
          {MONTHLY_BUNDLES.map((bundle) => {
            const isActive = selectedTier === bundle.id;
            return (
              <TouchableOpacity
                key={bundle.id}
                style={[
                  styles.card,
                  isActive && {
                    borderColor: bundle.borderColor,
                    backgroundColor: bundle.bgColor,
                  },
                ]}
                onPress={() => setSelectedTier(bundle.id)}
                activeOpacity={0.88}
                disabled={isProcessing}
              >
                {/* Header */}
                <View style={styles.cardHeader}>
                  <View style={styles.cardTitleRow}>
                    <View
                      style={[
                        styles.iconCircle,
                        {
                          backgroundColor: isActive
                            ? bundle.accentColor + '22'
                            : 'rgba(255,255,255,0.06)',
                        },
                      ]}
                    >
                      <Feather
                        name={bundle.iconName}
                        size={18}
                        color={isActive ? bundle.accentColor : 'rgba(255,255,255,0.7)'}
                      />
                    </View>
                    <View>
                      <Text style={[styles.cardTitle, isActive && { color: bundle.accentColor }]}>
                        {bundle.name}
                      </Text>
                      <Text style={styles.cardSubtitle}>{bundle.subtitle}</Text>
                    </View>
                  </View>

                  <View style={styles.cardRight}>
                    <View
                      style={[
                        styles.checkCircle,
                        isActive && {
                          backgroundColor: bundle.accentColor,
                          borderColor: bundle.accentColor,
                        },
                      ]}
                    >
                      {isActive && <Feather name="check" size={13} color="#000" />}
                    </View>
                  </View>
                </View>

                {/* Pricing & Minutes Row */}
                <View style={styles.costRow}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                    <Text style={[styles.costAmount, isActive && { color: bundle.accentColor }]}>
                      {bundle.minutes}
                    </Text>
                    <Text style={styles.costPeriodLabel}>min / month</Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Continue to Payment Button */}
        <TouchableOpacity
          style={[
            styles.continueBtn,
            { backgroundColor: selectedBundle.accentColor },
            isProcessing && { opacity: 0.7 },
          ]}
          onPress={handleContinueWithPayment}
          activeOpacity={0.85}
          disabled={isProcessing}
        >
          {isProcessing ? (
            <ActivityIndicator color="#000" size="small" />
          ) : (
            <>
              <Text style={styles.continueBtnText}>
                Continue with {selectedBundle.name} ({selectedBundle.minutes} mins)
              </Text>
              <Feather name="arrow-right" size={18} color="#000" />
            </>
          )}
        </TouchableOpacity>

        {/* Trust & Security Badge */}
        <View style={styles.securityRow}>
          <Feather name="shield" size={13} color="rgba(255,255,255,0.4)" />
          <Text style={styles.securityText}>Secured via 256-bit Razorpay Payment Gateway</Text>
        </View>

        <Text style={styles.footerNote}>
          Cancel or change your subscription model anytime in your profile settings.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  glowTopRight: {
    position: 'absolute',
    top: -80,
    right: -80,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#39FF14',
    opacity: 0.04,
  },
  glowBottomLeft: {
    position: 'absolute',
    bottom: -80,
    left: -80,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#2FE0A8',
    opacity: 0.04,
  },
  scroll: { padding: 20, paddingBottom: 40 },

  header: { alignItems: 'center', marginBottom: 22, paddingTop: 6 },
  logo: { width: 56, height: 56, borderRadius: 16, marginBottom: 12 },
  appName: { color: '#fff', fontSize: 26, fontWeight: '800', letterSpacing: -0.5, marginBottom: 8 },
  appNameGreen: { color: '#39FF14' },
  headline: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginBottom: 8,
    textAlign: 'center',
  },
  subheadline: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 12.5,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 16,
  },

  cardsContainer: { gap: 14, marginBottom: 20 },
  card: {
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#111',
    padding: 18,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: '#fff', fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
  cardSubtitle: { color: 'rgba(255,255,255,0.48)', fontSize: 12, marginTop: 3 },
  cardRight: { justifyContent: 'center', alignItems: 'center' },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  costRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 10,
  },
  costAmount: { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  minutesChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: 1,
  },
  minutesChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: 'rgba(255, 255, 255, 0.75)',
  },
  costPeriodLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 13, fontWeight: '500' },

  continueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 16,
    height: 54,
    marginBottom: 10,
    shadowColor: '#2FE0A8',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    elevation: 6,
  },
  continueBtnText: { color: '#000', fontSize: 15.5, fontWeight: '800' },

  securityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 12,
  },
  securityText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11.5,
    fontWeight: '500',
  },

  footerNote: {
    color: 'rgba(255,255,255,0.22)',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 16,
  },
});
