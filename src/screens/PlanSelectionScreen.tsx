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
import { useUser, useAuth } from '@clerk/clerk-expo';
import { APP_LOGO, APP_NAME_PREFIX, APP_NAME_SUFFIX, API_URL } from '../config';
import { startRazorpayCheckout } from '../utils/razorpayCheckout';
import { storage } from '../utils/storageCompat';
import {
  CallEngine,
  setStoredEngine,
  PlanTier,
  setStoredPlanTier,
} from '../utils/enginePreference';

interface PlanSelectionScreenProps {
  onContinue: () => void;
  onLoginPress?: () => void;
}

const isIndia = (() => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz.includes('Kolkata') || tz.includes('Calcutta') || tz.includes('India')) return true;
  } catch (_) { }
  return false;
})();

interface MonthlyBundle {
  id: PlanTier;
  engine: CallEngine;
  name: string;
  modelName: string;
  modelId: string;
  subtitle: string;
  badge?: string;
  price: string;
  billingPeriod: string;
  minutes: number;
  minutesLabel: string;
  accentColor: string;
  bgColor: string;
  borderColor: string;
  iconName: 'gift' | 'zap' | 'activity' | 'layers';
}

const MONTHLY_BUNDLES: MonthlyBundle[] = [
  {
    id: 'trial',
    engine: 'livekit',
    name: 'Free Trial',
    modelName: 'Gemini 3.5 Live',
    modelId: 'shaktalk_trial_free',
    subtitle: 'Real-Time Live Translation (Simultaneous)',
    badge: '10 min free trial',
    price: 'Free',
    billingPeriod: '',
    minutes: 10,
    minutesLabel: '10 min (one-time trial)',
    accentColor: '#38BDF8',
    bgColor: '#081D26',
    borderColor: '#38BDF8',
    iconName: 'gift',
  },
  {
    id: 'starter',
    engine: 'legacy',
    name: 'Basic Plan',
    modelName: 'Gemini 2.5 Live',
    modelId: 'shaktalk_standard_monthly',
    subtitle: 'Turn-by-Turn Translation (One-by-One)',
    price: isIndia ? '₹499' : '$4.99',
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
    modelId: 'shaktalk_pro_monthly',
    subtitle: 'Real-Time Live Translation (Simultaneous)',
    price: isIndia ? '₹1,000' : '$14.99',
    billingPeriod: '/month',
    minutes: 110,
    minutesLabel: '110 min / month',
    accentColor: '#2FE0A8',
    bgColor: '#0A1E1A',
    borderColor: '#2FE0A8',
    iconName: 'activity',
  },
];

export function PlanSelectionScreen({ onContinue, onLoginPress }: PlanSelectionScreenProps) {
  const { user } = useUser();
  const { getToken, signOut } = useAuth();
  const [selectedTier, setSelectedTier] = useState<PlanTier>('trial');
  const [isProcessing, setIsProcessing] = useState(false);

  const selectedBundle =
    MONTHLY_BUNDLES.find((b) => b.id === selectedTier) || MONTHLY_BUNDLES[0];

  const markPlanChosen = async (tier: PlanTier) => {
    if (user) {
      try {
        await user.update({
          unsafeMetadata: {
            ...(user.unsafeMetadata || {}),
            planChosen: true,
            planTier: tier,
          },
        });
      } catch (e: any) {
        console.warn('[PlanSelection] Metadata save notice:', e?.message);
      }
      try {
        await storage.setItem(`shak_plan_chosen_${user.id}`, 'true');
      } catch (_) {}
    }
  };

  const handleContinueWithPayment = async () => {
    setIsProcessing(true);
    try {
      // 1. FREE TRIAL SELECTION (10 mins, Gemini 3.5 Live) - No Payment Required
      if (selectedBundle.id === 'trial') {
        await setStoredEngine('livekit');
        await setStoredPlanTier('trial');
        await markPlanChosen('trial');

        try {
          const token = await getToken();
          if (token) {
            await fetch(`${API_URL}/user/set-plan`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                engine: 'livekit',
                modelId: 'shaktalk_trial_free',
                tier: 'trial',
              }),
            });
          }
        } catch (e: any) {
          console.warn('[PlanSelection] Trial sync notice:', e?.message);
        }

        if (Platform.OS === 'web') {
          window.alert('🎉 10-Minute Free Trial Activated! You have 10 minutes of Real-Time Live Translation ready to use.');
          onContinue();
        } else {
          Alert.alert(
            'Free Trial Activated! 🎉',
            'You have 10 free minutes of Real-Time Live Translation powered by Gemini 3.5 Live. Welcome to ShakTalk!',
            [
              {
                text: 'Start Translating',
                onPress: () => onContinue(),
              },
            ]
          );
        }
        return;
      }

      // 2. PAID PLANS (Basic & Pro) - Razorpay Checkout
      const userEmail =
        user?.primaryEmailAddress?.emailAddress ||
        user?.emailAddresses?.[0]?.emailAddress ||
        'user@shaktalk.com';

      const result = await startRazorpayCheckout({
        type: 'plan',
        tier: selectedBundle.id,
        name: 'ShakTalk',
        description: `${selectedBundle.name} Monthly Subscription`,
        email: userEmail,
      });

      if (result.success) {
        await setStoredEngine(selectedBundle.engine);
        await setStoredPlanTier(selectedBundle.id);
        await markPlanChosen(selectedBundle.id);

        try {
          const token = await getToken();
          if (token) {
            await fetch(`${API_URL}/user/set-plan`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                engine: selectedBundle.engine,
                modelId:
                  selectedBundle.id === 'starter'
                    ? 'gemini-live-2.5-flash-native-audio'
                    : 'gemini-3.5-live-translate-preview',
                tier: selectedBundle.id,
              }),
            });
          }
        } catch (e: any) {
          console.warn('[PlanSelection] Plan sync notice:', e?.message);
        }

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
              await markPlanChosen(selectedBundle.id);
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

  const userEmailDisplay = user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.glowTopRight} />
      <View style={styles.glowBottomLeft} />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Top Action Bar */}
        <View style={styles.topBarRow}>
          {userEmailDisplay ? (
            <View style={styles.userBadge}>
              <Feather name="user" size={13} color="#2FE0A8" style={{ marginRight: 6 }} />
              <Text style={styles.userBadgeText} numberOfLines={1}>{userEmailDisplay}</Text>
            </View>
          ) : (
            <View style={{ flex: 1 }} />
          )}

          {user ? (
            <TouchableOpacity
              style={styles.signOutPill}
              onPress={() => signOut().catch(() => {})}
              activeOpacity={0.8}
            >
              <Feather name="log-out" size={12} color="rgba(255,255,255,0.6)" style={{ marginRight: 4 }} />
              <Text style={styles.signOutPillText}>Sign Out</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.topSignInPill}
              onPress={onLoginPress || onContinue}
              activeOpacity={0.8}
            >
              <Feather name="log-in" size={13} color="#2FE0A8" style={{ marginRight: 6 }} />
              <Text style={styles.topSignInPillText}>Existing User? Sign In</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Header */}
        <View style={styles.header}>
          <Image source={APP_LOGO} style={styles.logo} resizeMode="cover" />
          <Text style={styles.appName}>
            {APP_NAME_PREFIX}
            {APP_NAME_SUFFIX ? <Text style={styles.appNameGreen}>{APP_NAME_SUFFIX}</Text> : null}
          </Text>
          <Text style={styles.headline}>Choose Your Monthly Plan</Text>
          <Text style={styles.subheadline}>
            Select a plan to get your included translation minutes. Free 10-minute trial included for everyone.
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
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={[styles.cardTitle, isActive && { color: bundle.accentColor }]}>
                          {bundle.name}
                        </Text>
                        {bundle.badge && (
                          <View style={[styles.cardBadge, { backgroundColor: bundle.accentColor + '20', borderColor: bundle.accentColor + '55' }]}>
                            <Text style={[styles.cardBadgeText, { color: bundle.accentColor }]}>{bundle.badge}</Text>
                          </View>
                        )}
                      </View>
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
                    <Text style={styles.costPeriodLabel}>
                      {bundle.id === 'trial' ? 'min (one-time trial)' : 'min / month'}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }} />
                  <View
                    style={[
                      styles.pricePill,
                      {
                        backgroundColor: isActive
                          ? bundle.accentColor + '20'
                          : 'rgba(255, 255, 255, 0.05)',
                        borderColor: isActive
                          ? bundle.accentColor + '55'
                          : 'rgba(255, 255, 255, 0.1)',
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.pricePillText,
                        isActive && { color: bundle.accentColor },
                      ]}
                    >
                      {bundle.price}{bundle.billingPeriod}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Continue Button */}
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
                {selectedBundle.id === 'trial'
                  ? `Start with Free Trial (${selectedBundle.minutes} mins)`
                  : `Continue with ${selectedBundle.name} (${selectedBundle.minutes} mins)`}
              </Text>
              <Feather name="arrow-right" size={18} color="#000" />
            </>
          )}
        </TouchableOpacity>

        {/* Already have an account shortcut (shown if not logged in) */}
        {!user && (
          <TouchableOpacity
            style={styles.loginShortcutBtn}
            onPress={onLoginPress || onContinue}
            activeOpacity={0.8}
          >
            <Text style={styles.loginShortcutText}>
              Already have an active account or plan? <Text style={styles.loginShortcutHighlight}>Sign In</Text>
            </Text>
          </TouchableOpacity>
        )}

        {/* Trust & Security Badge */}
        <View style={styles.securityRow}>
          <Feather name="shield" size={13} color="rgba(255,255,255,0.4)" />
          <Text style={styles.securityText}>Secured via 256-bit Encrypted Payment Gateway</Text>
        </View>

        <Text style={styles.footerNote}>
          Subscriptions auto-renew monthly until canceled in Store settings. 10 free Pro minutes included for new accounts on first device.
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
  topBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  userBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    maxWidth: '70%',
  },
  userBadgeText: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 12,
    fontWeight: '600',
  },
  signOutPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  signOutPillText: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 12,
    fontWeight: '600',
  },
  topSignInPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(47, 224, 168, 0.12)',
    borderColor: 'rgba(47, 224, 168, 0.35)',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
  },
  topSignInPillText: {
    color: '#2FE0A8',
    fontSize: 12.5,
    fontWeight: '700',
  },
  loginShortcutBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    marginTop: 6,
    marginBottom: 4,
  },
  loginShortcutText: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 13.5,
    fontWeight: '500',
  },
  loginShortcutHighlight: {
    color: '#2FE0A8',
    fontWeight: '800',
    textDecorationLine: 'underline',
  },

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
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: '#fff', fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
  cardBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
  },
  cardBadgeText: {
    fontSize: 10.5,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  cardSubtitle: { color: 'rgba(255,255,255,0.48)', fontSize: 12, marginTop: 3 },
  cardRight: { justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
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
    alignItems: 'center',
    marginTop: 10,
  },
  costAmount: { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  costPeriodLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 13, fontWeight: '500' },
  pricePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: 1,
  },
  pricePillText: {
    fontSize: 13,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.8)',
  },

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
