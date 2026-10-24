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
import { CallEngine, setStoredEngine } from '../utils/enginePreference';

interface PlanSelectionScreenProps {
  onContinue: () => void;
}

interface Plan {
  engine: CallEngine;
  modelId: string;
  icon: string;
  title: string;
  subtitle: string;
  badge: string;
  badgeColor: string;
  costPerMin: string;
  costNote: string;
  features: string[];
  accentColor: string;
  bgColor: string;
  borderColor: string;
}

const PLANS: Plan[] = [
  {
    engine: 'legacy',
    modelId: 'gemini-live-2.5-flash-native-audio',
    icon: '?',
    title: '2.5 Flash',
    subtitle: 'Vertex AI · Stable',
    badge: 'STABLE',
    badgeColor: '#39FF14',
    costPerMin: '~$0.037',
    costNote: 'per audio minute',
    features: [
      'Battle-tested & reliable',
      'Low-latency translation',
      'Powered by Google Vertex AI',
      'Turn-based voice translation',
    ],
    accentColor: '#39FF14',
    bgColor: '#0D1F10',
    borderColor: '#39FF14',
  },
  {
    engine: 'livekit',
    modelId: 'gemini-3.5-live-translate-preview',
    icon: '??',
    title: '3.5 Live',
    subtitle: 'Simultaneous LiveKit',
    badge: 'PREVIEW',
    badgeColor: '#2FE0A8',
    costPerMin: '~$0.037',
    costNote: 'per audio minute · may be free in preview',
    features: [
      'Real-time simultaneous voice',
      'Cutting-edge translation AI',
      'Powered by LiveKit + Gemini',
      'Ultra-natural conversation flow',
    ],
    accentColor: '#2FE0A8',
    bgColor: '#0A1E1A',
    borderColor: '#2FE0A8',
  },
];

export function PlanSelectionScreen({ onContinue }: PlanSelectionScreenProps) {
  const [selected, setSelected] = useState<CallEngine>('legacy');

  const handleContinue = async () => {
    await setStoredEngine(selected);
    onContinue();
  };

  const selectedPlan = PLANS.find(p => p.engine === selected)!;

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
          <Text style={styles.headline}>Choose Your AI Plan</Text>
          <Text style={styles.subheadline}>
            Select the translation model that fits your needs.{'\n'}You can change this later in settings.
          </Text>
        </View>

        {/* Plan Cards */}
        <View style={styles.cardsContainer}>
          {PLANS.map((plan) => {
            const isActive = selected === plan.engine;
            return (
              <TouchableOpacity
                key={plan.engine}
                style={[
                  styles.card,
                  isActive && { borderColor: plan.borderColor, backgroundColor: plan.bgColor },
                ]}
                onPress={() => setSelected(plan.engine)}
                activeOpacity={0.85}
              >
                {/* Card Header */}
                <View style={styles.cardHeader}>
                  <View style={styles.cardTitleRow}>
                    <Text style={styles.cardIcon}>{plan.icon}</Text>
                    <View>
                      <Text style={[styles.cardTitle, isActive && { color: plan.accentColor }]}>
                        {plan.title}
                      </Text>
                      <Text style={styles.cardSubtitle}>{plan.subtitle}</Text>
                    </View>
                  </View>
                  <View style={styles.cardRight}>
                    <View style={[styles.badge, { borderColor: plan.badgeColor + '60' }]}>
                      <Text style={[styles.badgeText, { color: plan.badgeColor }]}>{plan.badge}</Text>
                    </View>
                    {isActive && (
                      <View style={[styles.checkCircle, { backgroundColor: plan.accentColor }]}>
                        <Feather name="check" size={12} color="#000" />
                      </View>
                    )}
                  </View>
                </View>

                {/* Divider */}
                <View style={[styles.cardDivider, isActive && { backgroundColor: plan.accentColor + '30' }]} />

                {/* Cost */}
                <View style={styles.costRow}>
                  <View>
                    <Text style={[styles.costAmount, isActive && { color: plan.accentColor }]}>
                      {plan.costPerMin}
                    </Text>
                    <Text style={styles.costNote}>{plan.costNote}</Text>
                  </View>
                  <View style={[styles.costBadge, {
                    backgroundColor: plan.accentColor + '18',
                    borderColor: plan.accentColor + '40',
                  }]}>
                    <Feather name="zap" size={10} color={plan.accentColor} />
                    <Text style={[styles.costBadgeText, { color: plan.accentColor }]}>Token-billed</Text>
                  </View>
                </View>

                {/* Features */}
                <View style={styles.featureList}>
                  {plan.features.map((feat, i) => (
                    <View key={i} style={styles.featureRow}>
                      <View style={[
                        styles.featureDot,
                        { backgroundColor: isActive ? plan.accentColor : 'rgba(255,255,255,0.2)' },
                      ]} />
                      <Text style={[styles.featureText, isActive && { color: 'rgba(255,255,255,0.85)' }]}>
                        {feat}
                      </Text>
                    </View>
                  ))}
                </View>

                {/* Model ID */}
                <View style={styles.modelIdRow}>
                  <Feather name="cpu" size={9} color="rgba(255,255,255,0.2)" />
                  <Text style={styles.modelIdText} numberOfLines={1}>{plan.modelId}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Disclaimer */}
        <View style={styles.disclaimer}>
          <Feather name="info" size={12} color="rgba(255,255,255,0.25)" />
          <Text style={styles.disclaimerText}>
            Billed per active audio minute of translation. Both models use Google's Live API audio token pricing (25 tokens/sec).
          </Text>
        </View>

        {/* Continue Button */}
        <TouchableOpacity
          style={[styles.continueBtn, { backgroundColor: selectedPlan.accentColor }]}
          onPress={handleContinue}
          activeOpacity={0.85}
        >
          <Text style={styles.continueBtnText}>Continue with {selectedPlan.title}</Text>
          <Feather name="arrow-right" size={18} color="#000" />
        </TouchableOpacity>

        <Text style={styles.footerNote}>
          Your plan is saved to your account and synced across devices.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  glowTopRight: {
    position: 'absolute', top: -80, right: -80,
    width: 280, height: 280, borderRadius: 140,
    backgroundColor: '#39FF14', opacity: 0.04,
  },
  glowBottomLeft: {
    position: 'absolute', bottom: -80, left: -80,
    width: 280, height: 280, borderRadius: 140,
    backgroundColor: '#2FE0A8', opacity: 0.04,
  },
  scroll: { padding: 24, paddingBottom: 40 },

  header: { alignItems: 'center', marginBottom: 32, paddingTop: 8 },
  logo: { width: 60, height: 60, borderRadius: 16, marginBottom: 12 },
  appName: { color: '#fff', fontSize: 28, fontWeight: '800', letterSpacing: -0.5, marginBottom: 16 },
  appNameGreen: { color: '#39FF14' },
  headline: {
    color: '#fff', fontSize: 22, fontWeight: '700',
    letterSpacing: -0.3, marginBottom: 10, textAlign: 'center',
  },
  subheadline: {
    color: 'rgba(255,255,255,0.4)', fontSize: 13, textAlign: 'center', lineHeight: 20,
  },

  cardsContainer: { gap: 14, marginBottom: 18 },
  card: {
    borderRadius: 20, borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#111', padding: 18,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardIcon: { fontSize: 26 },
  cardTitle: { color: '#fff', fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
  cardSubtitle: { color: 'rgba(255,255,255,0.35)', fontSize: 11, marginTop: 2 },
  cardRight: { alignItems: 'flex-end', gap: 6 },
  badge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  checkCircle: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cardDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginBottom: 14 },

  costRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  costAmount: { color: '#fff', fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  costNote: { color: 'rgba(255,255,255,0.3)', fontSize: 10, marginTop: 2 },
  costBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
  },
  costBadgeText: { fontSize: 10, fontWeight: '600' },

  featureList: { gap: 7, marginBottom: 14 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  featureDot: { width: 5, height: 5, borderRadius: 3 },
  featureText: { color: 'rgba(255,255,255,0.45)', fontSize: 12, flex: 1 },

  modelIdRow: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.05)',
    paddingTop: 10, marginTop: 2,
  },
  modelIdText: { color: 'rgba(255,255,255,0.15)', fontSize: 9, fontFamily: 'monospace', flex: 1 },

  disclaimer: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12, padding: 12, marginBottom: 24,
  },
  disclaimerText: { color: 'rgba(255,255,255,0.25)', fontSize: 11, lineHeight: 17, flex: 1 },

  continueBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 16, height: 56, marginBottom: 16,
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3, shadowRadius: 14, elevation: 6,
  },
  continueBtnText: { color: '#000', fontSize: 16, fontWeight: '800' },

  footerNote: { color: 'rgba(255,255,255,0.2)', fontSize: 11, textAlign: 'center', lineHeight: 16 },
});
