import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Platform, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, {
  useSharedValue, useAnimatedStyle,
  withRepeat, withSequence, withTiming, Easing,
} from 'react-native-reanimated';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { useWebSocket } from '../hooks/useWebSocket';
import { useLiveKitCall } from '../livekit/useLiveKitCall';
import { Alert } from '../utils/alertCompat';
import { colors, DESKTOP_BREAKPOINT } from '../theme';
import { AiCallNotice, AiTranslationLabel } from '../components/AiCallNotice';
import { APP_NAME_LOWER } from '../config';
import { sessionStyles as styles, formatDuration } from './SessionScreen';

const KEEP_AWAKE_TAG = `${APP_NAME_LOWER}-call`;

/**
 * Call screen for the LiveKit engine. Looks exactly like SessionScreen (same
 * layout and styles); only the audio underneath is different:
 *   • the call itself is a WebRTC call (useLiveKitCall) — you hear your
 *     partner's real voice right away, turned down, with the translation on top;
 *   • translation is done by the server's translator bot (Gemini Live
 *     Translate) and arrives as its own audio track in the call;
 *   • subtitles and the transcript still come over the existing WebSocket.
 * No recording, uploading, playback queue or mic gating happens in the app.
 */

interface LiveCallScreenProps {
  sessionId: string;
  role: 'host' | 'guest';
  myLang: string;
  partnerLang: string;
  onEnd: () => void;
}

interface TranscriptEntry {
  id: string;
  direction: 'sent' | 'received';
  original: string;
  translated: string;
  timestamp: number;
}

interface ActiveSubtitle {
  speaker: 'self' | 'partner';
  originalText: string;
  translatedText: string;
  isFinal: boolean;
  timestamp: number;
}

export function LiveCallScreen({ sessionId, role, myLang, partnerLang, onEnd }: LiveCallScreenProps) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [activeSubtitle, setActiveSubtitle] = useState<ActiveSubtitle | null>(null);
  const [partnerSpeaking, setPartnerSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [durationSec, setDurationSec] = useState(0);
  // AI translation notice, shown at the start of every call (covers the ~1 s connect).
  const [showAiNotice, setShowAiNotice] = useState(true);
  const processedRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<ScrollView>(null);

  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= DESKTOP_BREAKPOINT;

  const addTranscript = useCallback((direction: 'sent' | 'received', original: string, translated: string, turnId?: string) => {
    const o = (original || '').trim();
    const t = (translated || '').trim();
    if (!o && !t) return;
    const key = turnId ? `${direction}-${turnId}` : null;
    if (key) {
      if (processedRef.current.has(key)) return;
      processedRef.current.add(key);
    }
    setTranscript(prev => [{ id: `${direction}-${Date.now()}-${prev.length}`, direction, original: o, translated: t, timestamp: Date.now() }, ...prev]);
  }, []);

  const { status, isGeminiReady, liveKit, endSession } = useWebSocket({
    onLiveSubtitle: useCallback((payload: any) => {
      if (payload.speaker === 'partner') setPartnerSpeaking(!payload.isFinal);
      setActiveSubtitle({
        speaker: payload.speaker,
        originalText: payload.originalText ?? '',
        translatedText: payload.translatedText ?? '',
        isFinal: payload.isFinal ?? false,
        timestamp: Date.now(),
      });
    }, []),
    onLiveSubtitleClear: useCallback(() => setPartnerSpeaking(false), []),
    onTranslatedAudioFinal: useCallback((original: string, translated: string, _audio?: string, turnId?: string) => {
      setPartnerSpeaking(false);
      addTranscript('received', original, translated, turnId);
    }, [addTranscript]),
    onTranscript: useCallback((original: string, translated: string, turnId?: string) => {
      addTranscript('sent', original, translated, turnId);
    }, [addTranscript]),
    onPartnerDisconnected: useCallback(() => {
      setPartnerSpeaking(false);
      Alert.alert('Partner Disconnected', 'Your partner has left the session.', [{ text: 'OK', onPress: onEnd }]);
    }, [onEnd]),
    onError: useCallback((msg: string) => {
      setPartnerSpeaking(false);
      Alert.alert('Error', msg);
    }, []),
  });

  const call = useLiveKitCall(liveKit);

  useEffect(() => {
    if (!call.error) return;
    setHasError(true);
    Alert.alert('Call error', call.error, [{ text: 'OK' }]);
  }, [call.error]);

  const handleToggleMute = useCallback(() => {
    if (hasError) { setHasError(false); return; }
    const next = !isPaused;
    setIsPaused(next);
    call.setMicEnabled(!next);
  }, [hasError, isPaused, call]);

  // The hook owns the speaker state, so the button always shows the real route choice.
  const isSpeakerOn = call.speakerOn;
  const toggleSpeaker = useCallback(() => {
    call.setSpeaker(!call.speakerOn);
  }, [call]);

  // Keep the screen on for the whole call (see SessionScreen for the web notes).
  useEffect(() => {
    if (status !== 'connected') return;
    const acquire = () => { activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {}); };
    acquire();
    const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', onVis);
    return () => {
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', onVis);
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [status]);

  const callStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (status !== 'connected') return;
    if (callStartRef.current === null) callStartRef.current = Date.now();
    const interval = setInterval(() => {
      setDurationSec(Math.floor((Date.now() - (callStartRef.current as number)) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [status]);

  const breathe = useSharedValue(0);
  useEffect(() => {
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2250, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 2250, easing: Easing.inOut(Easing.ease) })
      ),
      -1, false
    );
  }, [breathe]);
  const orbStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 + breathe.value * 0.035 }] }));
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.94 + breathe.value * 0.12 }],
    opacity: 0.35 + breathe.value * 0.35,
  }));

  const handleEnd = () => {
    Alert.alert('End Session', 'Are you sure you want to end this conversation?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'End', style: 'destructive', onPress: () => { endSession(role, sessionId); onEnd(); } },
    ]);
  };

  useEffect(() => { scrollRef.current?.scrollToEnd({ animated: true }); }, [transcript]);

  const partnerInitial = (partnerLang || '?').trim().charAt(0).toUpperCase();
  const isConnected = status === 'connected';
  const statusLabel = hasError
    ? 'Microphone error'
    : !isConnected
    ? 'Connecting…'
    : !call.isConnected
    ? 'Joining call…'
    : !isGeminiReady
    ? 'Starting translator…'
    : 'In call';

  const transcriptPanel = (
    <View style={[styles.panelInner, !isDesktop && { flex: 1 }]}>
      <View style={styles.panelHead}>
        <Text style={styles.panelTitle}>Conversation</Text>
        {!isDesktop && (
          <TouchableOpacity onPress={() => setShowTranscript(false)} style={styles.sheetClose}>
            <Feather name="x" size={15} color={colors.muted} />
          </TouchableOpacity>
        )}
      </View>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.logContent}
        showsVerticalScrollIndicator={false}
      >
        {transcript.length === 0 ? (
          <Text style={styles.logEmpty}>Nothing said yet.</Text>
        ) : (
          [...transcript].reverse().map((item) => {
            const isUser = item.direction === 'sent';
            const userLangText = isUser
              ? (item.original || item.translated)
              : (item.translated || item.original);
            return (
              <View
                key={item.id}
                style={[
                  styles.bubble,
                  isUser ? styles.bubbleYou : styles.bubbleThem,
                ]}
              >
                <Text style={styles.bubbleTranslated}>{userLangText}</Text>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topGlow} />

      <View style={[styles.body, isDesktop && styles.bodyDesktop]}>
        <View style={styles.stageColumn}>
          {hasError ? (
            <View style={styles.errorState}>
              <Feather name="alert-circle" size={40} color={colors.danger} />
              <Text style={styles.errorTitle}>Microphone error</Text>
              <Text style={styles.errorSub}>Tap the mic button below to retry.</Text>
            </View>
          ) : (
            <>
              <View style={styles.topbar}>
                <View style={styles.langPill}>
                  <Text style={styles.langPillText}>{myLang}</Text>
                  <Feather name="arrow-right" size={12} color={colors.muted} />
                  <Text style={styles.langPillText}>{partnerLang}</Text>
                </View>
                <Text style={styles.timer}>{formatDuration(durationSec)}</Text>
              </View>
              <AiTranslationLabel />

              <View style={styles.stageMid}>
                <View style={styles.orbWrap}>
                  <Animated.View style={[styles.ring, ringStyle, !isConnected && styles.ringIdle]} />
                  <Animated.View style={[styles.orb, orbStyle, !isConnected && styles.orbIdle]}>
                    <Text style={styles.orbLetter}>{partnerInitial}</Text>
                  </Animated.View>
                </View>
                <Text style={styles.statusSub}>
                  {partnerSpeaking || call.partnerTalking ? 'Partner is speaking…' : statusLabel}
                </Text>

                {/* ── LIVE TEXT TRANSLATION (Real-time in-call subtitles) ── */}
                <View style={styles.liveSubtitleCard}>
                  {activeSubtitle && (activeSubtitle.translatedText || activeSubtitle.originalText) ? (
                    <>
                      <View style={styles.subtitleHeader}>
                        <View style={[
                          styles.speakerBadge,
                          activeSubtitle.speaker === 'self' ? styles.speakerBadgeSelf : styles.speakerBadgePartner,
                        ]}>
                          <View style={[
                            styles.badgeDot,
                            activeSubtitle.speaker === 'self' ? styles.badgeDotSelf : styles.badgeDotPartner,
                          ]} />
                          <Text style={[
                            styles.speakerBadgeText,
                            activeSubtitle.speaker === 'self' ? styles.speakerTextSelf : styles.speakerTextPartner,
                          ]}>
                            {activeSubtitle.speaker === 'self' ? 'You' : 'Partner'}
                          </Text>
                        </View>
                        {!activeSubtitle.isFinal && (
                          <Text style={styles.liveIndicatorText}>Translating live…</Text>
                        )}
                      </View>

                      {(() => {
                        const isSelf = activeSubtitle.speaker === 'self';
                        const subtitleInMyLang = isSelf
                          ? (activeSubtitle.originalText || activeSubtitle.translatedText)
                          : (activeSubtitle.translatedText || activeSubtitle.originalText);
                        return (
                          <ScrollView
                            style={styles.subtitleScroll}
                            contentContainerStyle={styles.subtitleScrollContent}
                            showsVerticalScrollIndicator={true}
                            nestedScrollEnabled={true}
                          >
                            <Text style={styles.subtitleTranslated}>
                              {subtitleInMyLang || '…'}
                            </Text>
                          </ScrollView>
                        );
                      })()}
                    </>
                  ) : (
                    <View style={styles.subtitlePlaceholder}>
                      <Feather name="mic" size={14} color={colors.muted} />
                      <Text style={styles.placeholderText}>
                        Speak naturally — live translation appears here
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </>
          )}

          <View style={styles.controls}>
            {/* Mic / Mute */}
            <TouchableOpacity
              style={[
                styles.ctrl,
                isPaused && !hasError && styles.ctrlMuteActive,
                hasError && styles.ctrlError,
              ]}
              onPress={handleToggleMute}
              activeOpacity={0.8}
            >
              <Feather
                name={hasError ? 'refresh-cw' : isPaused ? 'mic-off' : 'mic'}
                size={22}
                color={isPaused && !hasError ? colors.ink : colors.warm}
              />
            </TouchableOpacity>

            {/* Speaker / Earpiece toggle (native only) */}
            {Platform.OS !== 'web' && (
              <TouchableOpacity
                style={[styles.ctrl, isSpeakerOn && styles.ctrlSpeakerActive]}
                onPress={toggleSpeaker}
                activeOpacity={0.8}
              >
                <Feather
                  name={isSpeakerOn ? 'volume-2' : 'volume-1'}
                  size={22}
                  color={isSpeakerOn ? colors.signal : colors.warm}
                />
              </TouchableOpacity>
            )}

            {/* End Call */}
            <TouchableOpacity style={[styles.ctrl, styles.ctrlEnd]} onPress={handleEnd} activeOpacity={0.85}>
              <Feather name="phone-off" size={24} color={colors.ink} />
            </TouchableOpacity>

            {!isDesktop && (
              <TouchableOpacity
                style={[styles.ctrl, showTranscript && styles.ctrlTranscriptActive]}
                onPress={() => setShowTranscript(true)}
                activeOpacity={0.8}
              >
                <Feather name="message-square" size={20} color={showTranscript ? colors.signal : colors.warm} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {isDesktop && <View style={styles.desktopPanel}>{transcriptPanel}</View>}
      </View>

      {!isDesktop && (
        <View
          pointerEvents={showTranscript ? 'auto' : 'none'}
          style={[styles.sheet, showTranscript && styles.sheetOpen]}
        >
          {transcriptPanel}
        </View>
      )}
      {showAiNotice && <AiCallNotice onClose={() => setShowAiNotice(false)} />}
    </SafeAreaView>
  );
}
