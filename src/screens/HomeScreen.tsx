import React, { useState, useEffect, useRef, useCallback } from 'react';
import { storage } from '../utils/storageCompat';
import {
  View,
  Text,
  Alert,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Modal,
  Platform,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
  Image,
  Share,
  Linking,
  TextInput,
  Clipboard,
  AppState,
  AppStateStatus,
} from 'react-native';
import { websocketService } from '../services/websocketService';
import { Feather, FontAwesome } from '@expo/vector-icons';
import { LanguageSelector } from '../components/LanguageSelector';
import { QRCodeDisplay } from '../components/QRCodeDisplay';
import { QRScanner } from '../components/QRScanner';
import { useWebSocket } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/StatusBadge';
import { WalletModal } from '../components/WalletModal';
import { useAuth, useUser } from '@clerk/clerk-expo';
import { useAuthFetch } from '../utils/authFetch';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { WS_URL, APP_NAME_PREFIX, APP_NAME_SUFFIX, APP_LOGO, JOIN_BASE_URL, APP_NAME, API_URL } from '../config';
import { colors, DESKTOP_BREAKPOINT } from '../theme';
import {
  getStoredPlanTier,
  setStoredPlanTier,
  subscribePlanTierChange,
  PlanTier,
  getStoredEngine,
  setStoredEngine,
  subscribeEngineChange,
  CallEngine,
} from '../utils/enginePreference';

// Invite links already acted on in this app run (kept outside the component so
// it survives Home being re-created when returning from a call).
const handledInviteIds = new Set<string>();
const LAST_LAUNCH_INVITE_KEY = 'shaktalk_last_launch_invite';

interface HomeScreenProps {
  onSessionReady: (params: {
    sessionId: string;
    role: 'host' | 'guest';
    myLang: string;
    partnerLang: string;
    engine?: 'legacy' | 'livekit';
  }) => void;
  onOpenProfile: () => void;
  onOpenConversation: (conversationId: string, myUserId: string) => void;
  onOpenRecordings: (conversationId: string, myUserId: string, myLang: string, partnerLang: string) => void;
}

interface RecentConversation {
  id: string;
  sessionId: string;
  myLang: string;
  partnerLang: string;
  startedAt: string;
  lastMessage: { text: string; sentAt: string; isMe: boolean } | null;
  messageCount: number;
}

function extractSessionIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    // 1. UUID pattern check (standard v4 UUID: 8-4-4-4-12 hex digits)
    const uuidMatch = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
      return uuidMatch[0];
    }

    // 2. /join/<id> pattern
    const joinMatch = url.match(/\/join\/([^/?#]+)/i);
    if (joinMatch && joinMatch[1]) {
      return decodeURIComponent(joinMatch[1]);
    }

    // 3. Query parameter: ?sessionId=... or ?session=... or ?sid=...
    const queryMatch = url.match(/[?&](?:sessionId|session|sid)=([^&#]+)/i);
    if (queryMatch && queryMatch[1]) {
      return decodeURIComponent(queryMatch[1]);
    }
  } catch (e) {
    console.warn('[extractSessionIdFromUrl] Error parsing URL:', url, e);
  }
  return null;
}

export function HomeScreen({ onSessionReady, onOpenProfile, onOpenConversation, onOpenRecordings }: HomeScreenProps) {
  const { signOut, getToken } = useAuth();
  const authFetch = useAuthFetch();
  const { user } = useUser();
  // Voice profile from Clerk metadata — used for Gemini voice warm-up at session start
  const meta = user?.unsafeMetadata as any;
  const speakerGender: string | undefined = meta?.gender;
  const speakerAge: number | undefined = meta?.age !== undefined ? Number(meta.age) : undefined;
  const nativeLanguage: string | undefined = meta?.nativeLanguage;

  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= DESKTOP_BREAKPOINT;

  const [myLang, setMyLang] = useState('English');
  const [currentTier, setCurrentTier] = useState<PlanTier>('pro');
  const [showWallet, setShowWallet] = useState(false);
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [currentEngineState, setCurrentEngineState] = useState<CallEngine>('livekit');

  useEffect(() => {
    getStoredPlanTier().then(setCurrentTier);
    getStoredEngine().then(setCurrentEngineState);
    const unsubTier = subscribePlanTierChange(setCurrentTier);
    const unsubEngine = subscribeEngineChange(setCurrentEngineState);
    return () => {
      unsubTier();
      unsubEngine();
    };
  }, []);

  const fetchWalletBalance = useCallback(async () => {
    try {
      const token = await getToken().catch(() => null);
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const url = user?.id
        ? `${API_URL}/wallet/balance?userId=${encodeURIComponent(user.id)}`
        : `${API_URL}/wallet/balance`;

      if (user?.id) {
        try {
          const billingRes = await fetch(`${API_URL}/billing/me?userId=${encodeURIComponent(user.id)}`, { headers });
          if (billingRes.ok) {
            const bData = await billingRes.json();
            if (bData.ok && bData.totalMinutes !== undefined) {
              const planKey = (bData.plan || 'pro').toLowerCase();
              const isStandard = planKey === 'standard' || planKey === 'starter';
              const pTier: PlanTier = isStandard ? 'starter' : 'pro';
              const pEngine: CallEngine = isStandard ? 'legacy' : 'livekit';

              setCurrentTier(pTier);
              setCurrentEngineState(pEngine);
              setStoredPlanTier(pTier);
              setStoredEngine(pEngine);

              setWalletBalance(`${bData.totalMinutes} mins`);
              return;
            }
          }
        } catch (_) {}
      }

      const res = await fetch(url, { headers });
      const data = await res.json();
      if (data.ok) {
        // Wallet minutes (e.g. 200 mins)
        const walletMins = data.walletMinutes !== undefined
          ? Number(data.walletMinutes)
          : (data.balanceMinutes !== undefined
              ? Number(data.balanceMinutes)
              : (data.balanceCents !== undefined ? Math.floor(Number(data.balanceCents) / 10) : 0));

        // Plan minutes (e.g. 100 mins for starter)
        let planMins = 100;
        if (data.planMinutesRemaining !== undefined) {
          planMins = Number(data.planMinutesRemaining);
        } else if (currentTier === 'business') {
          planMins = 500;
        } else if (currentTier === 'pro') {
          planMins = 250;
        } else if (currentTier === 'starter') {
          planMins = 100;
        }

        // Total available minutes = plan minutes + wallet minutes (e.g. 100 plan + 200 wallet = 300 mins)
        const totalMins = data.totalMinutes !== undefined ? Number(data.totalMinutes) : (walletMins + planMins);
        setWalletBalance(`${totalMins} mins`);

        // Low-minutes once-a-day reminder:
        // Alert when plan minutes are finished and wallet minutes are less than 5 minutes
        const planOver = data.planMinutesRemaining !== undefined ? data.planMinutesRemaining <= 0 : false;
        const walletLeft = data.walletMinutes !== undefined ? data.walletMinutes : totalMins;

        if (planOver && walletLeft < 5) {
          const today = new Date().toISOString().slice(0, 10);
          storage.getItem('last_low_balance_notified_date').then((lastDate) => {
            if (lastDate !== today) {
              storage.setItem('last_low_balance_notified_date', today).catch(() => {});
              const msg = `Your monthly plan minutes are finished and you have only ${walletLeft} minute${walletLeft === 1 ? '' : 's'} remaining in your wallet. Top up your wallet to continue calling without interruption.`;
              if (Platform.OS === 'web') {
                alert(`⚠️ Low Minutes Notice:

${msg}`);
              } else {
                Alert.alert('Low Minutes Notice ⚠️', msg, [
                  { text: 'Later', style: 'cancel' },
                  { text: 'Top Up Wallet', onPress: () => setShowWallet(true) },
                ]);
              }
            }
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[HomeScreen] fetchWalletBalance error:', e);
    }
  }, [getToken, user?.id]);

  useEffect(() => {
    fetchWalletBalance();
  }, [currentTier, fetchWalletBalance]);

  const planInfo = (() => {
    const isStandard = currentTier === 'starter' || currentEngineState === 'legacy';
    if (isStandard) {
      return { label: 'Standard Plan (100 mins)', color: '#39FF14', icon: 'zap' as const };
    }
    return { label: 'Pro Plan (110 mins)', color: '#2FE0A8', icon: 'activity' as const };
  })();

  // Default to the user's native language (set in their profile) until they
  // explicitly pick a different language here — an explicit pick, once made,
  // persists and always wins over the native-language default afterward.
  const MY_LANG_KEY = 'shak_my_language';
  useEffect(() => {
    storage.getItem(MY_LANG_KEY)
      .then(saved => {
        if (saved) setMyLang(saved);
        else if (nativeLanguage) setMyLang(nativeLanguage);
      })
      .catch(() => { });
  }, [nativeLanguage]);

  const handleSetMyLang = (lang: string) => {
    setMyLang(lang);
    storage.setItem(MY_LANG_KEY, lang).catch(() => { });
  };
  const [showQR, setShowQR] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showManualJoin, setShowManualJoin] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [manualCodeError, setManualCodeError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [recentConversations, setRecentConversations] = useState<RecentConversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(false);
  const roleRef = useRef<'host' | 'guest' | null>(null);
  const userId = user?.id;

  // Helper to format timestamps
  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes || 1}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  // Fetch recent conversations on mount
  useEffect(() => {
    if (!userId) return;
    const httpUrl = WS_URL.replace(/^ws(s)?:\/\//, 'http$1://');
    setLoadingConvs(true);
    authFetch(`${httpUrl}/conversations?userId=${encodeURIComponent(userId)}`)
      .then(async r => {
        if (!r.ok) {
          const errText = await r.text().catch(() => '');
          throw new Error(`HTTP ${r.status}: ${errText}`);
        }
        return r.json();
      })
      .then(data => { if (Array.isArray(data)) setRecentConversations(data); })
      .catch(e => console.warn('[HomeScreen] Failed to load conversations:', e))
      .finally(() => setLoadingConvs(false));
  }, [userId, authFetch]);

  const [connectingMsg, setConnectingMsg] = useState<string | null>(null);
  const pendingJoinRef = useRef<string | null>(null);

  const { status, sessionId, shortCode, myLang: wsMyLang, partnerLang, role: wsRole, callEngine, createSession, joinSession, reconnectHostSession, endSession } = useWebSocket({
    onError: (msg) => {
      setErrorMsg(msg);
      setConnectingMsg(null);
      pendingJoinRef.current = null;
    },
    onTranslatedAudio: () => { },
    onPartnerDisconnected: () => { },
  });

  React.useEffect(() => {
    const resolvedRole = wsRole || roleRef.current;
    if (status === 'connected' && sessionId && partnerLang && resolvedRole) {
      setConnectingMsg(null);
      const effectiveMyLang = wsMyLang || myLang;
      onSessionReady({ sessionId, role: resolvedRole, myLang: effectiveMyLang, partnerLang, engine: callEngine });
    }
  }, [status, sessionId, wsMyLang, myLang, partnerLang, wsRole, callEngine]);

  const handleJoinFromUrl = async (url: string | null, fromLaunch = false) => {
    if (!url) return;
    const incomingSid = extractSessionIdFromUrl(url);
    if (!incomingSid) return;
    // The link that OPENED the app is acted on only once. Home is re-created
    // after every call, and getInitialURL() keeps returning that same link
    // (also after the app is restored from the background), so without this
    // the ended call was joined again and showed "Call not found".
    // A link the user taps again (fromLaunch = false) is always tried.
    if (fromLaunch) {
      if (handledInviteIds.has(incomingSid)) return;
      handledInviteIds.add(incomingSid);
      const last = await storage.getItem(LAST_LAUNCH_INVITE_KEY).catch(() => null);
      if (last === incomingSid) return;
      storage.setItem(LAST_LAUNCH_INVITE_KEY, incomingSid).catch(() => {});
    }

    if (pendingJoinRef.current === incomingSid || sessionId === incomingSid) {
      return;
    }

    pendingJoinRef.current = incomingSid;
    setConnectingMsg('Connecting to call from invite link…');
    setErrorMsg(null);

    const ok = await checkMicPermission();
    if (!ok) {
      setConnectingMsg(null);
      pendingJoinRef.current = null;
      return;
    }

    roleRef.current = 'guest';
    try {
      console.log('[HomeScreen] Joining session from link:', incomingSid);
      await joinSession(incomingSid, myLang, userId, speakerGender, speakerAge);
    } catch (err: any) {
      console.error('[HomeScreen] Error joining from link:', err);
      setErrorMsg(err?.message || 'Failed to join call from link.');
      setConnectingMsg(null);
      pendingJoinRef.current = null;
    }
  };

  useEffect(() => {
    // 1. Initial launch from link (cold start)
    Linking.getInitialURL()
      .then(url => {
        if (url) handleJoinFromUrl(url, true);
      })
      .catch(e => console.warn('[HomeScreen] getInitialURL error:', e));

    // 2. Incoming link while app is already open or backgrounded
    const sub = Linking.addEventListener('url', event => {
      if (event?.url) handleJoinFromUrl(event.url);
    });

    return () => {
      sub.remove();
    };
  }, [myLang, userId, speakerGender, speakerAge]);


  useEffect(() => {
    const handleAppStateChange = async (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        if (showQR && roleRef.current === 'host' && sessionId) {
          if (!websocketService.isConnected() || status === 'disconnected') {
            console.log('[HomeScreen] App active; reattaching host to waiting lobby session:', sessionId);
            try {
              await reconnectHostSession(sessionId, myLang, userId, speakerGender, speakerAge);
            } catch (err) {
              console.warn('[HomeScreen] Failed to reattach lobby session:', err);
            }
          }
        }
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, [showQR, sessionId, myLang, userId, speakerGender, speakerAge, status, reconnectHostSession]);

  const checkMicPermission = async (): Promise<boolean> => {
    if (Platform.OS === 'web') return true;
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setErrorMsg('Microphone permission is required to start or join calls.');
        return false;
      }
      return true;
    } catch (e) {
      console.warn('[HomeScreen] Permission request error:', e);
      return true;
    }
  };

  const handleStartSession = async () => {
    setErrorMsg(null);
    if (walletBalance && (walletBalance === '0 mins' || walletBalance === '0 min')) {
      const msg = 'You have 0 call minutes remaining. Please top up your wallet to make calls.';
      if (Platform.OS === 'web') {
        alert(msg);
      } else {
        Alert.alert('No Minutes Remaining', msg, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Top Up Wallet', onPress: () => setShowWallet(true) },
        ]);
      }
      setShowWallet(true);
      return;
    }
    const ok = await checkMicPermission();
    if (!ok) return;
    roleRef.current = 'host';
    await createSession(myLang, userId, speakerGender, speakerAge);
    setShowQR(true);
  };

  // ── WhatsApp / native share ───────────────────────────────────────────────
  const buildShareMessage = (sid: string) => {
    const joinUrl = `${JOIN_BASE_URL}/${sid}`;
    return (
      `Join my ${APP_NAME} call 🌐 We each speak our own language and ${APP_NAME} translates live.\n\n` +
      `👉 Tap to join: ${joinUrl}\n\n` +
      (shortCode ? `Or open ${APP_NAME} → "Enter code" → ${shortCode}` : `Or open ${APP_NAME} → "Scan QR" and scan my screen.`)
    );
  };

  const handleShareWhatsApp = async (sid: string) => {
    try {
      const msg = buildShareMessage(sid);
      const encoded = encodeURIComponent(msg);
      const waScheme = `whatsapp://send?text=${encoded}`;
      const waWeb = `https://wa.me/?text=${encoded}`;

      // 1. Try native WhatsApp scheme directly
      const canOpen = await Linking.canOpenURL(waScheme).catch(() => false);
      if (canOpen) {
        await Linking.openURL(waScheme);
        return;
      }

      // 2. Try opening scheme anyway (iOS canOpenURL can return false if not whitelisted)
      try {
        await Linking.openURL(waScheme);
        return;
      } catch (_) {}

      // 3. Fallback to universal wa.me link
      try {
        await Linking.openURL(waWeb);
        return;
      } catch (_) {}

      // 4. Ultimate fallback: native OS share sheet
      await Share.share({ message: msg, title: `Join my ${APP_NAME} call` });
    } catch (err) {
      console.warn('[handleShareWhatsApp] error:', err);
    }
  };

  const handleShareNative = async (sid: string) => {
    const msg = buildShareMessage(sid);
    await Share.share({ message: msg, title: `Join my ${APP_NAME} call` });
  };

  const handleCopyLink = (sid: string) => {
    const joinUrl = `${JOIN_BASE_URL}/${sid}`;
    if (Platform.OS === 'web') {
      navigator.clipboard?.writeText(joinUrl).catch(() => {});
    } else {
      Clipboard.setString(joinUrl);
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const handleManualJoin = async () => {
    const code = manualCode.trim();
    if (!code) {
      setManualCodeError('Please enter a session code or link.');
      return;
    }
    // Extract session ID from code or URL
    const sid = extractSessionIdFromUrl(code) || code;
    setManualCodeError(null);
    setShowManualJoin(false);
    setManualCode('');

    const ok = await checkMicPermission();
    if (!ok) return;
    roleRef.current = 'guest';
    setConnectingMsg('Joining call…');
    try {
      await joinSession(sid, myLang, userId, speakerGender, speakerAge);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to join call.');
      setConnectingMsg(null);
      pendingJoinRef.current = null;
    }
  };

  const handleScanned = async (scannedId: string) => {
    setShowScanner(false);
    const ok = await checkMicPermission();
    if (!ok) return;
    roleRef.current = 'guest';
    await joinSession(scannedId, myLang, userId, speakerGender, speakerAge);
  };

  const validConversations = recentConversations.filter(conv => conv.messageCount > 0);
  const showRecent = (loadingConvs && recentConversations.length === 0) || validConversations.length > 0;

  return (
    <SafeAreaView style={styles.container}>
      {/* Background accents */}
      <View style={styles.topGlow} />
      <View style={styles.bottomGlow} />

      <ScrollView
        contentContainerStyle={[styles.scroll, isDesktop && styles.scrollDesktop]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.page, isDesktop && styles.pageDesktop]}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerTitleContainer}>
              <Image
                source={APP_LOGO}
                style={styles.logoIcon}
                resizeMode="cover"
              />
              <Text style={styles.title}>
                {APP_NAME_PREFIX}
                {APP_NAME_SUFFIX ? <Text style={styles.titleGreen}>{APP_NAME_SUFFIX}</Text> : null}
              </Text>
            </View>

            <View style={styles.headerActions}>
              {/* Wallet Button */}
              <TouchableOpacity
                onPress={() => setShowWallet(true)}
                style={styles.walletBadge}
                activeOpacity={0.75}
              >
                <Feather name="credit-card" size={12} color="#2FE0A8" style={{ marginRight: 5 }} />
                <Text style={styles.walletBadgeText}>
                  {walletBalance || '0 mins'}
                </Text>
              </TouchableOpacity>

              {/* Profile Avatar Button */}
              <TouchableOpacity onPress={onOpenProfile} style={styles.profileBtn} activeOpacity={0.75}>
                {user?.imageUrl ? (
                  <Image source={{ uri: user.imageUrl }} style={styles.profileAvatar} />
                ) : (
                  <Feather name="user" size={16} color={colors.muted} />
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* Subheader Greeting Row with Active Model Badge */}
          <View style={styles.greetingHeaderRow}>
            <View style={{ flex: 1, marginRight: 10 }}>
              <Text style={styles.greetTitle}>Ready when you are</Text>
              <Text style={styles.subtitle}>Start a call and share the code, or join one.</Text>
            </View>

            {/* Active Model / Plan Chip */}
            <TouchableOpacity
              onPress={onOpenProfile}
              style={[
                styles.modelBadge,
                {
                  borderColor: planInfo.color + '45',
                  backgroundColor: planInfo.color + '14',
                },
              ]}
              activeOpacity={0.75}
            >
              <Feather name={planInfo.icon} size={11} color={planInfo.color} style={{ marginRight: 5 }} />
              <Text style={[styles.modelBadgeText, { color: planInfo.color }]}>
                {planInfo.label}
              </Text>
              <Feather name="chevron-right" size={12} color={planInfo.color} style={{ marginLeft: 3 }} />
            </TouchableOpacity>
          </View>

          {/* Connecting from link banner */}
          {connectingMsg && (
            <View style={styles.connectingBox}>
              <ActivityIndicator size="small" color={colors.signal} style={{ marginRight: 8 }} />
              <Text style={styles.connectingText}>{connectingMsg}</Text>
            </View>
          )}

          {/* Error */}
          {errorMsg && (
            <View style={styles.errorBox}>
              <Feather name="alert-circle" size={14} color={colors.danger} />
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
          )}

          {/* Language Config */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>YOU'LL SPEAK</Text>
            <LanguageSelector label="" selected={myLang} onSelect={handleSetMyLang} />
          </View>

          {/* Actions */}
          <View style={[styles.actions, isDesktop && styles.actionsDesktop]}>
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                isDesktop && styles.entryCard,
              ]}
              onPress={handleStartSession}
              disabled={status === 'connecting' || status === 'waiting'}
              activeOpacity={0.85}
            >
              <View style={[styles.entryIconWrap, isDesktop && styles.entryIconWrapDesktop]}>
                {status === 'connecting' ? (
                  <ActivityIndicator color={colors.ink} size="small" />
                ) : (
                  <Feather name="phone-call" size={isDesktop ? 22 : 20} color={colors.ink} />
                )}
              </View>
              <View style={isDesktop ? { alignItems: 'center' } : undefined}>
                <Text style={styles.primaryBtnText}>
                  {status === 'connecting' ? 'Connecting…' : 'Start a call'}
                </Text>
                {isDesktop && <Text style={styles.entryCardSub}>Get a code to share</Text>}
              </View>
            </TouchableOpacity>

            {!isDesktop && (
              <View style={styles.orRow}>
                <View style={styles.orLine} />
                <Text style={styles.orText}>or join a call</Text>
                <View style={styles.orLine} />
              </View>
            )}

            <View style={[styles.joinRow, isDesktop && styles.joinRowDesktop]}>
              <TouchableOpacity
                style={[
                  styles.secondaryBtn,
                  !isDesktop && styles.halfBtn,
                  isDesktop && styles.entryCard,
                  isDesktop && styles.entryCardSecondary,
                ]}
                onPress={() => setShowScanner(true)}
                activeOpacity={0.85}
              >
                <View style={[styles.entryIconWrap, styles.entryIconWrapSecondary, isDesktop && styles.entryIconWrapDesktop]}>
                  <Feather name="camera" size={isDesktop ? 22 : 18} color={colors.signal} />
                </View>
                <View style={isDesktop ? { alignItems: 'center' } : undefined}>
                  <Text style={styles.secondaryBtnText}>Scan QR</Text>
                  {isDesktop && <Text style={styles.entryCardSub}>Use partner's code</Text>}
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.secondaryBtn,
                  !isDesktop && styles.halfBtn,
                  isDesktop && styles.entryCard,
                  isDesktop && styles.entryCardSecondary,
                ]}
                onPress={() => { setManualCode(''); setManualCodeError(null); setShowManualJoin(true); }}
                activeOpacity={0.85}
              >
                <View style={[styles.entryIconWrap, styles.entryIconWrapSecondary, isDesktop && styles.entryIconWrapDesktop]}>
                  <Feather name="edit-3" size={isDesktop ? 22 : 18} color={colors.signal} />
                </View>
                <View style={isDesktop ? { alignItems: 'center' } : undefined}>
                  <Text style={styles.secondaryBtnText}>Enter code</Text>
                  {isDesktop && <Text style={styles.entryCardSub}>Paste code or link</Text>}
                </View>
              </TouchableOpacity>
            </View>
          </View>

          {/* Recent Conversations — only shown once there's something to show */}
          {showRecent && (
            <View style={styles.recentSection}>
              <View style={styles.recentHeader}>
                <Feather name="message-square" size={13} color={colors.muted} />
                <Text style={styles.recentTitle}> RECENT CONVERSATIONS</Text>
              </View>
              {loadingConvs && validConversations.length === 0 ? (
                <ActivityIndicator color={colors.signal} style={{ marginTop: 16 }} />
              ) : null}
              {validConversations.map(conv => (
                <View key={conv.id} style={styles.convItemWrapper}>
                  {/* Chat transcript button */}
                  <TouchableOpacity
                    style={styles.convItem}
                    onPress={() => onOpenConversation(conv.id, userId || '')}
                    activeOpacity={0.75}
                  >
                    <View style={styles.convIcon}>
                      <Feather name="globe" size={16} color={colors.signal} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={styles.convLangs}>{conv.myLang} ↔ {conv.partnerLang || '...'}</Text>
                        <Text style={styles.convTime}>
                          {conv.lastMessage ? timeAgo(conv.lastMessage.sentAt) : timeAgo(conv.startedAt)}
                        </Text>
                      </View>
                      <Text style={styles.convPreview} numberOfLines={1}>
                        {conv.lastMessage
                          ? `${conv.lastMessage.isMe ? 'You: ' : ''}${conv.lastMessage.text}`
                          : `${conv.messageCount} messages`}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  {/* Recordings button */}
                  <TouchableOpacity
                    style={styles.recordingsBtn}
                    onPress={() => onOpenRecordings(conv.id, userId || '', conv.myLang, conv.partnerLang || '')}
                    activeOpacity={0.75}
                  >
                    <Feather name="headphones" size={15} color={colors.signal} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* QR Code Modal (Host) */}
      <Modal visible={showQR} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Waiting for them to join</Text>
            <Text style={styles.modalSubtitle}>Share the code, or have them scan this screen</Text>

            {sessionId ? (
              <>
                <QRCodeDisplay sessionId={sessionId} />
                {shortCode && (
                  <View style={styles.shortCodeBox}>
                    <Text style={styles.shortCodeLabel}>CODE</Text>
                    <Text style={styles.shortCodeText} selectable>{shortCode}</Text>
                  </View>
                )}
              </>
            ) : (
              <ActivityIndicator color={colors.signal} size="large" style={{ marginVertical: 40 }} />
            )}

            <StatusBadge status={status} role="host" />

            {status === 'connected' && (
              <Text style={styles.connectedMsg}>Partner connected! Starting call…</Text>
            )}

            {/* Share buttons — only shown once we have a session ID */}
            {sessionId && (
              <>
                {/* Copyable join link */}
                <TouchableOpacity
                  style={styles.linkBox}
                  onPress={() => handleCopyLink(sessionId)}
                  activeOpacity={0.75}
                >
                  <Feather name="link-2" size={14} color={colors.signal} style={{ marginRight: 8 }} />
                  <Text style={styles.linkText} numberOfLines={1} ellipsizeMode="middle">
                    {`${JOIN_BASE_URL}/${sessionId}`}
                  </Text>
                  <View style={[styles.copyBadge, linkCopied && styles.copyBadgeActive]}>
                    <Feather name={linkCopied ? 'check' : 'copy'} size={12} color={linkCopied ? colors.ink : colors.signal} />
                    <Text style={[styles.copyBadgeText, linkCopied && styles.copyBadgeTextActive]}>
                      {linkCopied ? 'Copied' : 'Copy'}
                    </Text>
                  </View>
                </TouchableOpacity>

                {/* Share invite row with WhatsApp & Share icons in front */}
                <View style={styles.shareCard}>
                  <View style={styles.shareLabelGroup}>
                    <Feather name="send" size={14} color={colors.signal} style={{ marginRight: 8 }} />
                    <Text style={styles.shareCardText}>Share invite to join</Text>
                  </View>
                  <View style={styles.shareActions}>
                    <TouchableOpacity
                      style={styles.waBtn}
                      onPress={() => handleShareWhatsApp(sessionId)}
                      activeOpacity={0.8}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      accessibilityLabel="Share on WhatsApp"
                    >
                      <FontAwesome name="whatsapp" size={20} color="#FFFFFF" />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.shareSheetBtn}
                      onPress={() => handleShareNative(sessionId)}
                      activeOpacity={0.8}
                      accessibilityLabel="Share invite"
                    >
                      <Feather name="share-2" size={17} color={colors.warm} />
                    </TouchableOpacity>
                  </View>
                </View>
              </>
            )}

            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => {
                if (sessionId) {
                  endSession('host', sessionId);
                }
                setShowQR(false);
              }}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* QR Scanner Modal (Guest) */}
      <Modal visible={showScanner} animationType="slide">
        <QRScanner
          onScanned={handleScanned}
          onCancel={() => setShowScanner(false)}
        />
      </Modal>

      {/* Manual Code Join Modal */}
      <Modal visible={showManualJoin} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.manualModalHeader}>
              <View style={styles.manualIconWrap}>
                <Feather name="hash" size={20} color={colors.signal} />
              </View>
              <Text style={styles.modalTitle}>Enter session code</Text>
              <Text style={styles.modalSubtitle}>Paste a session code or invite link from your partner</Text>
            </View>

            <View style={styles.inputContainer}>
              <TextInput
                style={styles.codeInput}
                value={manualCode}
                onChangeText={(t) => { setManualCode(t); setManualCodeError(null); }}
                placeholder="6-letter code or invite link…"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={handleManualJoin}
                returnKeyType="join"
                multiline={false}
              />
              {manualCode.length > 0 && (
                <TouchableOpacity onPress={() => setManualCode('')} style={styles.clearBtn}>
                  <Feather name="x" size={16} color={colors.muted} />
                </TouchableOpacity>
              )}
            </View>

            {manualCodeError && (
              <View style={styles.errorBox}>
                <Feather name="alert-circle" size={13} color={colors.danger} />
                <Text style={styles.errorText}>{manualCodeError}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.primaryBtn, { width: '100%', marginTop: 14 }]}
              onPress={handleManualJoin}
              activeOpacity={0.85}
            >
              <Feather name="phone-incoming" size={18} color={colors.ink} />
              <Text style={styles.primaryBtnText}>Join call</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => { setShowManualJoin(false); setManualCode(''); setManualCodeError(null); }}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Wallet Modal */}
      <WalletModal
        visible={showWallet}
        onClose={() => setShowWallet(false)}
        onBalanceUpdated={(newBal) => {
          setWalletBalance(newBal);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  scroll: { padding: 24, paddingBottom: 48 },
  scrollDesktop: { alignItems: 'center', paddingTop: 56 },
  page: { width: '100%' },
  pageDesktop: { maxWidth: 640 },
  topGlow: {
    position: 'absolute', top: -80, right: -80,
    width: 260, height: 260, borderRadius: 130,
    backgroundColor: colors.signal, opacity: 0.06,
  },
  bottomGlow: {
    position: 'absolute', bottom: -80, left: -80,
    width: 260, height: 260, borderRadius: 130,
    backgroundColor: colors.signal, opacity: 0.06,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
    paddingTop: Platform.OS === 'android' ? 16 : 8,
  },
  headerTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    marginRight: 9,
    overflow: 'hidden',
  },
  title: {
    color: colors.warm,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  titleGreen: {
    color: colors.signal,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  walletBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(47, 224, 168, 0.4)',
    backgroundColor: 'rgba(47, 224, 168, 0.12)',
  },
  walletBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#2FE0A8',
    letterSpacing: 0.2,
  },
  greetingHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  greetTitle: {
    color: colors.warm,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  modelBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  modelBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  profileBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hair,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  signOutBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hair,
    justifyContent: 'center',
    alignItems: 'center',
  },
  connectingBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(47,224,168,0.1)',
    borderWidth: 1, borderColor: 'rgba(47,224,168,0.3)',
    borderRadius: 12, padding: 12, marginBottom: 16,
  },
  connectingText: { color: colors.signal, fontSize: 13, fontWeight: '600', flex: 1 },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(232,92,92,0.1)',
    borderWidth: 1, borderColor: 'rgba(232,92,92,0.25)',
    borderRadius: 12, padding: 12, marginBottom: 16,
  },
  errorText: { color: colors.danger, fontSize: 13, flex: 1 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1, borderColor: colors.hair,
    padding: 20,
    marginBottom: 28,
  },
  cardTitle: {
    color: colors.muted,
    fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 2, marginBottom: 18,
  },
  actions: { gap: 12 },
  actionsDesktop: { flexDirection: 'row', gap: 16, alignItems: 'stretch' },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: colors.signal, borderRadius: 16,
    paddingVertical: 18, paddingHorizontal: 24,
    shadowColor: colors.signal, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
  },
  primaryBtnText: { color: colors.ink, fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  orLine: { flex: 1, height: 1, backgroundColor: colors.hair },
  orText: { color: colors.muted, fontSize: 12 },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: colors.surface2,
    borderWidth: 1, borderColor: colors.hair,
    borderRadius: 16, paddingVertical: 18, paddingHorizontal: 24,
  },
  secondaryBtnText: { color: colors.warm, fontSize: 16, fontWeight: '700' },

  // Desktop: the two entries become equal-weight cards side by side instead
  // of a ranked primary button + secondary line, since there's room for both
  // to read as clear, deliberate choices rather than one being squeezed in.
  entryCard: {
    flex: 1, flexDirection: 'column', paddingVertical: 32, gap: 14,
    borderRadius: 20,
  },
  entryCardSecondary: {},
  entryCardSub: { color: 'rgba(10,13,12,0.55)', fontSize: 12.5, marginTop: 2 },
  entryIconWrap: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(10,13,12,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  entryIconWrapSecondary: { backgroundColor: colors.surface3 },
  entryIconWrapDesktop: { width: 52, height: 52, borderRadius: 26 },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderWidth: 1, borderColor: colors.hair,
    padding: 28, alignItems: 'center', paddingBottom: 48,
  },
  modalTitle: { color: colors.warm, fontSize: 20, fontWeight: '700', marginBottom: 4 },
  modalSubtitle: { color: colors.muted, fontSize: 13, marginBottom: 20, textAlign: 'center' },
  connectedMsg: {
    color: colors.signal, fontSize: 13, fontWeight: '600',
    marginTop: 16, textAlign: 'center',
  },
  // Mobile join row & buttons
  joinRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  joinRowDesktop: {
    flex: 2,
    flexDirection: 'row',
    gap: 14,
  },
  halfBtn: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 12,
    justifyContent: 'center',
    gap: 10,
  },

  // Copyable link
  linkBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hair,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    width: '100%',
    marginTop: 18,
  },
  linkText: {
    flex: 1,
    color: colors.muted,
    fontSize: 12.5,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  copyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(52,211,153,0.12)',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginLeft: 8,
  },
  copyBadgeActive: {
    backgroundColor: colors.signal,
  },
  copyBadgeText: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: '700',
  },
  copyBadgeTextActive: {
    color: colors.ink,
  },

  // Share invite to join card
  shareCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hair,
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 16,
    width: '100%',
    marginTop: 12,
  },
  shareLabelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  shareCardText: {
    color: colors.warm,
    fontSize: 13.5,
    fontWeight: '600',
  },
  shareActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  waBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#25D366',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#25D366',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 5,
    elevation: 3,
  },
  shareSheetBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.hair,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Manual Join Modal
  manualModalHeader: {
    alignItems: 'center',
    marginBottom: 16,
  },
  manualIconWrap: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(52,211,153,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    backgroundColor: colors.surface2,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.hair,
    paddingHorizontal: 14,
  },
  shortCodeBox: { alignItems: 'center', marginTop: 12, marginBottom: 4 },
  shortCodeLabel: { color: colors.muted, fontSize: 11, letterSpacing: 2 },
  shortCodeText: { color: colors.warm, fontSize: 28, fontWeight: '800', letterSpacing: 6, marginTop: 2 },
  codeInput: {
    flex: 1,
    color: colors.warm,
    fontSize: 14,
    paddingVertical: 14,
  },
  clearBtn: {
    padding: 6,
  },

  cancelBtn: {
    marginTop: 16,
    paddingHorizontal: 32, paddingVertical: 12,
    borderRadius: 12, borderWidth: 1, borderColor: colors.hair,
  },
  cancelBtnText: { color: colors.muted, fontSize: 14 },

  // Recent Conversations
  recentSection: { marginTop: 32 },
  recentHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  recentTitle: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginLeft: 6 },
  convItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.hair,
  },
  convItemWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  recordingsBtn: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hair,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  convIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.surface2,
    justifyContent: 'center', alignItems: 'center',
    marginRight: 14,
  },
  convLangs: { color: colors.warm, fontSize: 14, fontWeight: '600' },
  convTime: { color: colors.muted, fontSize: 11 },
  convPreview: { color: colors.muted, fontSize: 13, marginTop: 4 },
});
