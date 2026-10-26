import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { APP_LOGO, APP_NAME_PREFIX, APP_NAME_SUFFIX } from '../config';
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
  minutes: string;
  ratePerMin: string;
  badge: string;
  badgeColor: string;
  accentColor: string;
  bgColor: string;
  borderColor: string;
  iconName: 'zap' | 'activity' | 'layers';
  features: string[];
}

const MONTHLY_BUNDLES: MonthlyBundle[] = [
  {
    id: 'starter',
    engine: 'legacy',
    name: '2.5 Flash Plan',
    modelName: 'Gemini 2.5 Flash Native Audio',
    modelId: 'live-2.5-flash-native-audio',
    subtitle: 'Vertex AI • Stable & Turn-Based',
    price: '$9.99',
    billingPeriod: '/month',
    minutes: '150 Minutes Included',
    ratePerMin: '~$0.066 / min',
    badge: 'STABLE',
    badgeColor: '#39FF14',
    accentColor: '#39FF14',
    bgColor: '#0D1F10',
    borderColor: '#39FF14',
    iconName: 'zap',
    features: [
      'Model: live-2.5-flash-native-audio',
      '150 monthly voice translation minutes',
      'Turn-based crisp speech translation',
      'Powered by Google Vertex AI infrastructure',
      'Full audio WAV recordings & transcripts',
      'Reliable low-latency connection',
    ],
  },
  {
    id: 'pro',
    engine: 'livekit',
    name: '3.5 Live Plan',
    modelName: 'Gemini 3.5 Live Translate',
    modelId: 'gemini-3.5-live-translate-preview',
    subtitle: 'LiveKit • Real-Time Simultaneous Voice',
    price: '$24.99',
    billingPeriod: '/month',
    minutes: '250 Minutes Included',
    ratePerMin: '~$0.100 / min',
    badge: 'PREVIEW • LIVE',
    badgeColor: '#2FE0A8',
    accentColor: '#2FE0A8',
    bgColor: '#0A1E1A',
    borderColor: '#2FE0A8',
    iconName: 'activity',
    features: [
      'Model: gemini-3.5-live-translate-preview',
      '250 monthly voice translation minutes',
      'Real-time simultaneous two-way translation',
      'Speak & listen simultaneously (zero waiting)',
      'LiveKit SFU high-speed audio pipeline',
      'Dual-track cloud recordings & transcripts',
    ],
  },
  {
    id: 'business',
    engine: 'livekit',
    name: 'Dual AI All-Access',
    modelName: 'Both Gemini 3.5 Live & 2.5 Flash',
    modelId: 'gemini-3.5-live + live-2.5-flash',
    subtitle: 'Switch Between Both Engines Anytime',
    price: '$49.99',
    billingPeriod: '/month',
    minutes: '500 Minutes Included',
    ratePerMin: '~$0.099 / min',
    badge: 'ALL-ACCESS',
    badgeColor: '#E6A23C',
    accentColor: '#E6A23C',
    bgColor: '#1D170A',
    borderColor: '#E6A23C',
    iconName: 'layers',
    features: [
      'Access both 3.5 Live & 2.5 Flash models',
      '500 monthly voice translation minutes',
      'Switch between models on-the-fly during calls',
      'Dedicated AWS high-bandwidth media routes',
      'Priority 24/7 technical customer support',
      'Unlimited cloud recordings storage',
    ],
  },
];

export function PlanSelectionScreen({ onContinue }: PlanSelectionScreenProps) {
  const [selectedTier, setSelectedTier] = useState<PlanTier>('pro');

  const selectedBundle =
    MONTHLY_BUNDLES.find((b) => b.id === selectedTier) || MONTHLY_BUNDLES[1];

  const handleContinue = async () => {
    await setStoredEngine(selectedBundle.engine);
    await setStoredPlanTier(selectedBundle.id);
    onContinue();
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
            Select a monthly subscription based on Google's live voice translation models.
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
                        styles.badge,
                        { borderColor: bundle.badgeColor + '70' },
                      ]}
                    >
                      <Text style={[styles.badgeText, { color: bundle.badgeColor }]}>
                        {bundle.badge}
                      </Text>
                    </View>
                    {isActive && (
                      <View style={[styles.checkCircle, { backgroundColor: bundle.accentColor }]}>
                        <Feather name="check" size={12} color="#000" />
                      </View>
                    )}
                  </View>
                </View>

                {/* Model ID Chip */}
                <View style={styles.modelChipRow}>
                  <Feather name="cpu" size={11} color={isActive ? bundle.accentColor : 'rgba(255,255,255,0.4)'} />
                  <Text style={[styles.modelChipText, isActive && { color: bundle.accentColor }]}>
                    {bundle.modelId}
                  </Text>
                </View>

                {/* Divider */}
                <View
                  style={[
                    styles.cardDivider,
                    isActive && { backgroundColor: bundle.accentColor + '30' },
                  ]}
                />

                {/* Pricing Row */}
                <View style={styles.costRow}>
                  <View>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                      <Text style={[styles.costAmount, isActive && { color: bundle.accentColor }]}>
                        {bundle.price}
                      </Text>
                      <Text style={styles.costPeriodLabel}>{bundle.billingPeriod}</Text>
                    </View>
                    <Text
                      style={[
                        styles.minutesLabel,
                        { color: isActive ? bundle.accentColor : '#fff' },
                      ]}
                    >
                      {bundle.minutes}
                    </Text>
                  </View>

                  <View
                    style={[
                      styles.costBadge,
                      {
                        backgroundColor: bundle.accentColor + '18',
                        borderColor: bundle.accentColor + '40',
                      },
                    ]}
                  >
                    <Feather name="clock" size={10} color={bundle.accentColor} />
                    <Text style={[styles.costBadgeText, { color: bundle.accentColor }]}>
                      {bundle.ratePerMin}
                    </Text>
                  </View>
                </View>

                {/* Features List */}
                <View style={styles.featureList}>
                  {bundle.features.map((feat, i) => (
                    <View key={i} style={styles.featureRow}>
                      <View
                        style={[
                          styles.featureDot,
                          {
                            backgroundColor: isActive
                              ? bundle.accentColor
                              : 'rgba(255,255,255,0.25)',
                          },
                        ]}
                      />
                      <Text
                        style={[
                          styles.featureText,
                          isActive && { color: 'rgba(255,255,255,0.9)' },
                        ]}
                      >
                        {feat}
                      </Text>
                    </View>
                  ))}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Continue Button */}
        <TouchableOpacity
          style={[styles.continueBtn, { backgroundColor: selectedBundle.accentColor }]}
          onPress={handleContinue}
          activeOpacity={0.85}
        >
          <Text style={styles.continueBtnText}>
            Continue with {selectedBundle.name} ({selectedBundle.price})
          </Text>
          <Feather name="arrow-right" size={18} color="#000" />
        </TouchableOpacity>

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
  cardSubtitle: { color: 'rgba(255,255,255,0.4)', fontSize: 11, marginTop: 2 },
  cardRight: { alignItems: 'flex-end', gap: 6 },
  badge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 8.5, fontWeight: '800', letterSpacing: 0.8 },
  checkCircle: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },

  modelChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 12,
  },
  modelChipText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 10.5,
    fontFamily: 'monospace',
    fontWeight: '600',
  },

  cardDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginBottom: 12 },

  costRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  costAmount: { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  costPeriodLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 13, fontWeight: '500' },
  minutesLabel: { fontSize: 12.5, fontWeight: '700', marginTop: 3 },
  costBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  costBadgeText: { fontSize: 10.5, fontWeight: '700' },

  featureList: { gap: 8 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  featureDot: { width: 5, height: 5, borderRadius: 3 },
  featureText: { color: 'rgba(255,255,255,0.55)', fontSize: 12, flex: 1 },

  continueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 16,
    height: 54,
    marginBottom: 14,
    shadowColor: '#2FE0A8',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    elevation: 6,
  },
  continueBtnText: { color: '#000', fontSize: 15.5, fontWeight: '800' },

  footerNote: {
    color: 'rgba(255,255,255,0.22)',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 16,
  },
});
