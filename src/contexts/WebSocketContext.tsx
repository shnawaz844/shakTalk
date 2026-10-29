import { useAuth } from '@clerk/clerk-expo';
import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { websocketService } from '../services/websocketService';
import { WS_URL, CALL_ENGINE } from '../config';
import type { LiveKitCallInfo } from '../livekit/useLiveKitCall';
import { CallEngine, getCurrentEngine, getStoredEngine } from '../utils/enginePreference';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface TranslatedAudioPayload {
  audioBase64: string;
  mimeType: string;
  originalText: string;
  translatedText: string;
}

export interface TranslatedAudioChunkPayload {
  audioBase64: string;
  mimeType: string;
  index: number;
  text: string;
  turnId?: string;
}

export interface LiveSubtitlePayload {
  speaker: 'self' | 'partner';
  originalText?: string;
  translatedText?: string;
  turnId?: string;
  isFinal?: boolean;
}

interface WebSocketContextType {
  status: ConnectionStatus;
  role: 'host' | 'guest' | null;
  sessionId: string | null;
  myLang: string | null;
  partnerLang: string | null;
  isProcessing: boolean;
  isGeminiReady: boolean;
  /** Set once the server hands out the LiveKit room token (LiveKit engine only). */
  liveKit: LiveKitCallInfo | null;
  queueDepth: number;
  callEngine: CallEngine;
  createSession: (lang: string, userId?: string, speakerGender?: string, speakerAge?: number, preferredEngine?: CallEngine) => Promise<void>;
  joinSession: (sid: string, lang: string, userId?: string, speakerGender?: string, speakerAge?: number, preferredEngine?: CallEngine) => Promise<void>;
  sendAudioStreamChunk: (
    audioBase64: string,
    mimeType: string,
    role: string,
    sid: string,
    clientSentAt?: number
  ) => void;
  sendPauseQueue: (role: string, sid: string) => void;
  sendResumeQueue: (role: string, sid: string) => void;
  sendCancelQueue: (role: string, sid: string) => void; // kept for compat
  claimTurn: (role: string, sid: string, confidence?: number) => void;
  releaseTurn: (role: string, sid: string) => void;
  endSession: (role: string, sid: string) => void;
  sendWebRTCOffer: (sdp: any, role: string, sid: string) => void;
  sendWebRTCAnswer: (sdp: any, role: string, sid: string) => void;
  sendWebRTCIceCandidate: (candidate: any, role: string, sid: string) => void;
  sendWebRTCReady: (role: string, sid: string) => void;
  registerCallbacks: (id: string, callbacks: WebSocketCallbacks) => void;
  unregisterCallbacks: (id: string) => void;
}

interface WebSocketCallbacks {
  onTranslatedAudio?: (payload: TranslatedAudioPayload) => void;
  onTranslatedAudioChunk?: (payload: TranslatedAudioChunkPayload) => void;
  onTranslatedAudioFinal?: (originalText: string, translatedText: string, audioBase64?: string, turnId?: string) => void;
  onTranscript?: (originalText: string, translatedText: string, turnId?: string) => void;
  onLiveSubtitle?: (payload: LiveSubtitlePayload) => void;
  onLiveSubtitleClear?: () => void;
  onPartnerDisconnected?: () => void;
  onError?: (message: string) => void;
  onPartnerSpeaking?: () => void;
  onTurnRejected?: () => void;
  onLockReleased?: () => void;
  onQueueResumed?: () => void;
  onSessionReadyEvent?: (partnerLang: string, engine?: CallEngine) => void;
  onWebRTCOffer?: (sdp: any) => void;
  onWebRTCAnswer?: (sdp: any) => void;
  onWebRTCIceCandidate?: (candidate: any) => void;
  onWebRTCReady?: () => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Login token sent with create/join so the server can verify who is calling.
  // Kept in a ref: clerk-expo's useAuth() returns a new getToken on every
  // render, which would otherwise recreate createSession/joinSession each
  // render (and re-run any effect that depends on them).
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [role, setRole] = useState<'host' | 'guest' | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [myLang, setMyLang] = useState<string | null>(null);
  const [partnerLang, setPartnerLang] = useState<string | null>(null);
  const [callEngine, setCallEngine] = useState<CallEngine>(getCurrentEngine());
  const [isProcessing, setIsProcessing] = useState(false);
  // True once the server confirms both Gemini Live sessions are open and ready.
  // Audio fed before this point would be silently dropped by the server.
  const [isGeminiReady, setIsGeminiReady] = useState(false);
  const [liveKit, setLiveKit] = useState<LiveKitCallInfo | null>(null);
  // How many of the local user's sentences are queued server-side waiting to process
  const [queueDepth, setQueueDepth] = useState(0);

  // Map of registered callbacks from various screens/components
  const callbacksMap = useRef<Map<string, WebSocketCallbacks>>(new Map());

  const registerCallbacks = useCallback((id: string, callbacks: WebSocketCallbacks) => {
    callbacksMap.current.set(id, callbacks);
  }, []);

  const unregisterCallbacks = useCallback((id: string) => {
    callbacksMap.current.delete(id);
  }, []);

  // Tracks when connection process started for calculating connection latency
  const connectStartTimeRef = useRef<number>(0);

  const handleMessage = useCallback((message: Record<string, any>) => {
    const { type } = message;

    if (type === 'session_created') {
      const elapsed = Date.now() - connectStartTimeRef.current;
      console.log(`[LATENCY][CALL_CONNECT] Host session created in ${elapsed}ms (sessionId=${message.sessionId}). Waiting for partner...`);
      setSessionId(message.sessionId);
      setRole('host');
      setStatus('waiting');
      setIsGeminiReady(false);
    }

    if (type === 'session_ready') {
      const elapsed = Date.now() - connectStartTimeRef.current;
      console.log(`[LATENCY][CALL_CONNECT] Partner joined & peer handshake ready in ${elapsed}ms (partnerLang=${message.partnerLang}, engine=${message.engine}). Waiting for Gemini AI warmup...`);
      setStatus('connected');
      setIsGeminiReady(false); // reset — gemini_ready will follow once both sessions are open
      if (message.role) {
        setRole(message.role);
      }
      if (message.myLang) {
        setMyLang(message.myLang);
      }
      const effectiveEngine = (message.engine === 'livekit' ? 'livekit' : 'legacy') as CallEngine;
      setCallEngine(effectiveEngine);
      if (message.partnerLang) {
        setPartnerLang(message.partnerLang);
        callbacksMap.current.forEach(c => c.onSessionReadyEvent?.(message.partnerLang, effectiveEngine));
      }
    }

    if (type === 'gemini_ready') {
      const elapsed = Date.now() - connectStartTimeRef.current;
      console.log(`[LATENCY][CALL_CONNECT] 🎉 Gemini AI speech engines READY in ${elapsed}ms! Call is fully established & audio unblocked.`);
      setIsGeminiReady(true);
    }

    if (type === 'livekit_ready') {
      setLiveKit({ url: message.url, token: message.token, identity: message.identity, partnerIdentity: message.partnerIdentity });
    }

    if (type === 'processing_started') {
      setIsProcessing(true);
      console.log(`[LATENCY][VOICE_TO_PARTNER] Server started processing speech turnId=${message.turnId} at ${Date.now()}`);
    }

    if (type === 'processing_done') {
      setIsProcessing(false);
    }

    // Server reports how many of our sentences are still in the queue
    if (type === 'queue_depth') {
      setQueueDepth(message.depth ?? 0);
    }

    // Distribute messages to all registered listeners
    callbacksMap.current.forEach((callbacks) => {
      if (type === 'translated_audio') {
        callbacks.onTranslatedAudio?.({
          audioBase64: message.audioBase64,
          mimeType: message.mimeType,
          originalText: message.originalText,
          translatedText: message.translatedText,
        });
      }

      if (type === 'translated_audio_chunk') {
        console.log(`[LATENCY][client] translated_audio_chunk idx=${message.index} turnId=${message.turnId} received at ${Date.now()}`);
        callbacks.onTranslatedAudioChunk?.({
          audioBase64: message.audioBase64,
          mimeType: message.mimeType,
          index: message.index,
          text: message.text,
          turnId: message.turnId,
        });
      }

      if (type === 'translated_audio_final') {
        console.log(`[LATENCY][client] translated_audio_final turnId=${message.turnId} received at ${Date.now()}`);
        callbacks.onTranslatedAudioFinal?.(message.originalText, message.translatedText, message.audioBase64, message.turnId);
      }

      if (type === 'transcript') {
        callbacks.onTranscript?.(message.originalText, message.translatedText, message.turnId);
      }

      if (type === 'live_subtitle') {
        callbacks.onLiveSubtitle?.({
          speaker: message.speaker,
          originalText: message.originalText,
          translatedText: message.translatedText,
          turnId: message.turnId,
          isFinal: message.isFinal,
        });
      }

      if (type === 'live_subtitle_clear') {
        callbacks.onLiveSubtitleClear?.();
      }

      if (type === 'partner_disconnected') {
        setStatus('disconnected');
        callbacks.onPartnerDisconnected?.();
      }

      if (type === 'partner_speaking') {
        console.log(`[LATENCY][client] partner_speaking received (turnId=${message.turnId}) at ${Date.now()}`);
        callbacks.onPartnerSpeaking?.();
      }

      if (type === 'turn_rejected') {
        callbacks.onTurnRejected?.();
      }

      if (type === 'lock_released') {
        callbacks.onLockReleased?.();
      }

      if (type === 'queue_resumed') {
        callbacks.onQueueResumed?.();
      }

      if (type === 'error') {
        setIsProcessing(false);
        callbacks.onError?.(message.message);
      }

      if (type === 'webrtc_offer') {
        callbacks.onWebRTCOffer?.(message.sdp);
      }

      if (type === 'webrtc_answer') {
        callbacks.onWebRTCAnswer?.(message.sdp);
      }

      if (type === 'webrtc_ice_candidate') {
        callbacks.onWebRTCIceCandidate?.(message.candidate);
      }

      if (type === 'webrtc_ready') {
        callbacks.onWebRTCReady?.();
      }
    });
  }, []);

  const createSession = useCallback(async (lang: string, userId?: string, speakerGender?: string, speakerAge?: number, preferredEngine?: CallEngine) => {
    connectStartTimeRef.current = Date.now();
    console.log(`[LATENCY][CALL_CONNECT] Creating session at ${connectStartTimeRef.current}...`);
    setStatus('connecting');
    try {
      websocketService.onMessage(handleMessage);
      websocketService.onClose(() => {
        setStatus('disconnected');
        setIsProcessing(false);
      });
      websocketService.onError(() => { setStatus('error'); });
      await websocketService.connect(WS_URL);
      setLiveKit(null);
      setMyLang(lang);
      const engine = preferredEngine || await getStoredEngine();
      setCallEngine(engine);
      const authToken = await getTokenRef.current({ skipCache: true }).catch(() => getTokenRef.current().catch(() => null));
      websocketService.send({
        type: 'create_session', authToken: authToken || undefined, lang, userId, engine,
        ...(speakerGender ? { speakerGender } : {}),
        ...(speakerAge !== undefined ? { speakerAge } : {}),
      });
    } catch (e) {
      setStatus('error');
      callbacksMap.current.forEach(c => c.onError?.('Failed to connect to server.'));
    }
  }, [handleMessage]);

  const joinSession = useCallback(async (sid: string, lang: string, userId?: string, speakerGender?: string, speakerAge?: number, preferredEngine?: CallEngine) => {
    connectStartTimeRef.current = Date.now();
    console.log(`[LATENCY][CALL_CONNECT] Joining session ${sid} at ${connectStartTimeRef.current}...`);
    setStatus('connecting');
    try {
      websocketService.onMessage(handleMessage);
      websocketService.onClose(() => {
        setStatus('disconnected');
        setIsProcessing(false);
      });
      websocketService.onError(() => { setStatus('error'); });
      await websocketService.connect(WS_URL);
      setLiveKit(null);
      setMyLang(lang);
      const engine = preferredEngine || await getStoredEngine();
      setCallEngine(engine);
      const authToken = await getTokenRef.current({ skipCache: true }).catch(() => getTokenRef.current().catch(() => null));
      websocketService.send({
        type: 'join_session', authToken: authToken || undefined, sessionId: sid, lang, userId, engine,
        ...(speakerGender ? { speakerGender } : {}),
        ...(speakerAge !== undefined ? { speakerAge } : {}),
      });
      setSessionId(sid);
      setRole('guest');
    } catch (e) {
      setStatus('error');
      callbacksMap.current.forEach(c => c.onError?.('Failed to connect to server.'));
    }
  }, [handleMessage]);

  const sendAudioStreamChunk = useCallback(
    (audioBase64: string, mimeType: string, role: string, sid: string, clientSentAt?: number) => {
      // Fired continuously (~10x/sec) while the mic is live. Language and voice
      // profile are already known server-side from create_session/join_session,
      // so each chunk only carries what's needed to forward it to Gemini.
      websocketService.send({
        type: 'audio_stream_chunk',
        sessionId: sid,
        role,
        audioBase64,
        mimeType,
        clientSentAt: clientSentAt || Date.now(),
      });
    },
    []
  );

  const sendCancelQueue = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'cancel_queue', role, sessionId: sid });
  }, []);

  const sendPauseQueue = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'pause_queue', role, sessionId: sid });
  }, []);

  const sendResumeQueue = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'resume_queue', role, sessionId: sid });
  }, []);

  const claimTurn = useCallback((role: string, sid: string, confidence: number = 1) => {
    websocketService.send({ type: 'claim_turn', sessionId: sid, role, confidence });
  }, []);

  const releaseTurn = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'release_turn', sessionId: sid, role });
  }, []);

  const sendWebRTCOffer = useCallback((sdp: any, role: string, sid: string) => {
    websocketService.send({ type: 'webrtc_offer', sdp, role, sessionId: sid });
  }, []);

  const sendWebRTCAnswer = useCallback((sdp: any, role: string, sid: string) => {
    websocketService.send({ type: 'webrtc_answer', sdp, role, sessionId: sid });
  }, []);

  const sendWebRTCIceCandidate = useCallback((candidate: any, role: string, sid: string) => {
    websocketService.send({ type: 'webrtc_ice_candidate', candidate, role, sessionId: sid });
  }, []);

  const sendWebRTCReady = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'webrtc_ready', role, sessionId: sid });
  }, []);

  const endSession = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'end_session', sessionId: sid, role });
    websocketService.disconnect();
    setStatus('idle');
    setRole(null);
    setSessionId(null);
    setMyLang(null);
    setPartnerLang(null);
    setIsProcessing(false);
    setQueueDepth(0);
    setLiveKit(null);
  }, []);

  // Cleanup on provider unmount (rare, usually app close)
  useEffect(() => {
    return () => {
      websocketService.disconnect();
    };
  }, []);

  return (
    <WebSocketContext.Provider
      value={{
        status,
        role,
        sessionId,
        myLang,
        partnerLang,
        callEngine,
        isProcessing,
        isGeminiReady,
        liveKit,
        queueDepth,
        createSession,
        joinSession,
        sendAudioStreamChunk,
        sendPauseQueue,
        sendResumeQueue,
        sendCancelQueue,
        claimTurn,
        releaseTurn,
        endSession,
        sendWebRTCOffer,
        sendWebRTCAnswer,
        sendWebRTCIceCandidate,
        sendWebRTCReady,
        registerCallbacks,
        unregisterCallbacks,
      }}
    >
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocketContext = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocketContext must be used within a WebSocketProvider');
  }
  return context;
};
