import React, { useState, useEffect } from 'react';
import { View, Image, Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { APP_OPENING_SCREEN } from './src/config';
import { ClerkProvider, useAuth, useUser } from '@clerk/clerk-expo';
import { tokenCache } from './src/utils/tokenCache';
import { HomeScreen } from './src/screens/HomeScreen';
import { SessionScreen } from './src/screens/SessionScreen';
import { LiveCallScreen } from './src/screens/LiveCallScreen';
import { CALL_ENGINE, API_URL } from './src/config';
import { AuthScreen } from './src/screens/AuthScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { ConsentScreen, saveConsent } from './src/screens/ConsentScreen';
import { hasAcceptedCurrentTerms, pendingAgreement } from './src/legal/legal';
import { ConversationDetailScreen } from './src/screens/ConversationDetailScreen';
import { AudioRecordingsScreen } from './src/screens/AudioRecordingsScreen';
import { PlanSelectionScreen } from './src/screens/PlanSelectionScreen';
import { WebSocketProvider } from './src/contexts/WebSocketContext';
import {
  getCurrentEngine,
  getCurrentPlanTier,
  setStoredEngine,
  setStoredPlanTier,
  CallEngine,
  PlanTier,
} from './src/utils/enginePreference';
import * as WebBrowser from 'expo-web-browser';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';

WebBrowser.maybeCompleteAuthSession();
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const styleId = 'shaktalk-web-no-outline';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.innerHTML = `
      input, textarea, select {
        outline: none !important;
        -webkit-tap-highlight-color: transparent !important;
      }
      input:focus, textarea:focus, select:focus {
        outline: none !important;
        box-shadow: none !important;
        border-color: transparent !important;
      }
    `;
    document.head.appendChild(style);
  }
}


type AppScreen = 'onboarding' | 'home' | 'session' | 'profile' | 'conversation' | 'recordings';
type AuthFlow = 'plan-selection' | 'login';

interface SessionParams {
  sessionId: string;
  role: 'host' | 'guest';
  myLang: string;
  partnerLang: string;
  engine?: 'legacy' | 'livekit';
}

const publishableKey =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ||
  'pk_test_cHJvcGVyLWphZ3Vhci04NS5jbGVyay5hY2NvdW50cy5kZXYk';

/**
 * Signed-in users must have accepted the current Terms before using the app.
 * If they ticked the box on the sign-in screen, that is saved here silently;
 * otherwise (existing users, or after the terms change) ConsentScreen asks.
 */
function ConsentGate({ children }: { children: React.ReactNode }) {
  const { user } = useUser();
  const { getToken } = useAuth();
  const accepted = hasAcceptedCurrentTerms(user?.unsafeMetadata);
  const [autoSaving, setAutoSaving] = useState(!accepted && !!pendingAgreement.acceptedAt);

  useEffect(() => {
    if (accepted || !user || !pendingAgreement.acceptedAt) return;
    pendingAgreement.acceptedAt = null;
    saveConsent(user, getToken, 'signup')
      .catch((e) => console.warn('[Consent] auto-save failed:', e?.message))
      .finally(() => setAutoSaving(false));
  }, [accepted, user]); // eslint-disable-line react-hooks/exhaustive-deps

  if (accepted) return <>{children}</>;
  if (autoSaving) return <View style={{ flex: 1, backgroundColor: '#0A0D0C' }} />;
  return <ConsentScreen />;
}

function MainApp() {
  const { user } = useUser();
  const isOnboarded = !!(user?.unsafeMetadata as any)?.onboardingComplete;
  const [screen, setScreen] = useState<AppScreen>(isOnboarded ? 'home' : 'onboarding');
  const [sessionParams, setSessionParams] = useState<SessionParams | null>(null);
  const [activeConversation, setActiveConversation] = useState<{ id: string, myUserId: string } | null>(null);
  const [activeRecordings, setActiveRecordings] = useState<{ id: string, myUserId: string, myLang: string, partnerLang: string } | null>(null);

  const handleSessionReady = (params: SessionParams) => {
    setSessionParams(params);
    setScreen('session');
  };

  const handleEndSession = () => {
    setSessionParams(null);
    setScreen('home');
  };

  return (
    <WebSocketProvider>
      <View style={{ flex: 1, backgroundColor: '#0A0A0A' }}>
        {screen === 'onboarding' && (
          <OnboardingScreen onComplete={() => setScreen('home')} />
        )}
        {screen === 'home' && (
          <HomeScreen
            onSessionReady={handleSessionReady}
            onOpenProfile={() => setScreen('profile')}
            onOpenConversation={(id, myUserId) => {
              setActiveConversation({ id, myUserId });
              setScreen('conversation');
            }}
            onOpenRecordings={(id, myUserId, myLang, partnerLang) => {
              setActiveRecordings({ id, myUserId, myLang, partnerLang });
              setScreen('recordings');
            }}
          />
        )}
        {screen === 'profile' && (
          <ProfileScreen onBack={() => setScreen('home')} />
        )}
        {screen === 'session' && sessionParams && (sessionParams.engine || CALL_ENGINE) === 'livekit' && (
          <LiveCallScreen
            sessionId={sessionParams.sessionId}
            role={sessionParams.role}
            myLang={sessionParams.myLang}
            partnerLang={sessionParams.partnerLang}
            onEnd={handleEndSession}
          />
        )}
        {screen === 'session' && sessionParams && (sessionParams.engine || CALL_ENGINE) === 'legacy' && (
          <SessionScreen
            sessionId={sessionParams.sessionId}
            role={sessionParams.role}
            myLang={sessionParams.myLang}
            partnerLang={sessionParams.partnerLang}
            onEnd={handleEndSession}
          />
        )}
        {screen === 'conversation' && activeConversation && (
          <ConversationDetailScreen
            conversationId={activeConversation.id}
            myUserId={activeConversation.myUserId}
            onBack={() => {
              setActiveConversation(null);
              setScreen('home');
            }}
          />
        )}
        {screen === 'recordings' && activeRecordings && (
          <AudioRecordingsScreen
            conversationId={activeRecordings.id}
            myUserId={activeRecordings.myUserId}
            myLang={activeRecordings.myLang}
            partnerLang={activeRecordings.partnerLang}
            onBack={() => {
              setActiveRecordings(null);
              setScreen('home');
            }}
          />
        )}
      </View>
    </WebSocketProvider>
  );
}

function AppNavigator({ openingFinished }: { openingFinished: boolean }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [authFlow, setAuthFlow] = React.useState<AuthFlow>('plan-selection');

  // When user signs in, restore their purchased plan and credit state from server
  React.useEffect(() => {
    if (!isSignedIn) return;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;

        // Fetch user's existing subscription & credits from server
        const res = await fetch(`${API_URL}/user/account-state`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const state = await res.json();

        if (state.ok && state.hasPurchasedPlan) {
          // Restore server's source of truth into local device storage
          await setStoredEngine(state.planEngine as CallEngine);
          await setStoredPlanTier(state.planTier as PlanTier);
          console.log(`[App] Restored account state for ${state.userId}: Tier=${state.planTier}, Engine=${state.planEngine}, Total=${state.totalMinutes}m`);
        } else {
          // New user who chose a plan before sign up: save to backend
          const engine = getCurrentEngine();
          const tier = getCurrentPlanTier();
          const MODEL_MAP: Record<string, string> = {
            legacy: 'gemini-live-2.5-flash-native-audio',
            livekit: 'gemini-3.5-live-translate-preview',
          };
          await fetch(`${API_URL}/user/set-plan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ engine, modelId: MODEL_MAP[engine], tier }),
          });
        }
      } catch (err) {
        console.warn('[App] Account sync warning:', err);
      }
    })();
  }, [isSignedIn]);

  if (!isLoaded || !openingFinished) {
    return (
      <View style={{ flex: 1, backgroundColor: '#182527', width: '100%', height: '100%' }}>
        <StatusBar hidden={true} />
        <Image
          source={APP_OPENING_SCREEN}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
        />
      </View>
    );
  }

  if (isSignedIn) {
    return (
      <>
        <StatusBar style="light" hidden={false} />
        <ConsentGate>
          <MainApp />
        </ConsentGate>
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" hidden={false} />
      {authFlow === 'plan-selection' ? (
        <PlanSelectionScreen onContinue={() => setAuthFlow('login')} onLoginPress={() => setAuthFlow('login')} />
      ) : (
        <AuthScreen />
      )}
    </>
  );
}

export default function App() {
  const [openingFinished, setOpeningFinished] = useState(false);

  useEffect(() => {
    // Immediately hide Android's native splash screen so our full-screen startup image displays
    void SplashScreen.hideAsync().catch(() => {});

    // Keep the branded full-screen startup poster visible for 2.5 seconds
    const timer = setTimeout(() => {
      setOpeningFinished(true);
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#182527' }}>
      <SafeAreaProvider>
        <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
          <AppNavigator openingFinished={openingFinished} />
        </ClerkProvider>
      </SafeAreaProvider>
      {!openingFinished && (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: '100%',
            height: '100%',
            backgroundColor: '#182527',
            zIndex: 99999,
          }}
          pointerEvents="none"
        >
          <StatusBar hidden={true} />
          <Image
            source={APP_OPENING_SCREEN}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
        </View>
      )}
    </View>
  );
}
