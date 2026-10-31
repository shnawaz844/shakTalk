import { useEffect, useId } from 'react';
import { useWebSocketContext, TranslatedAudioPayload, TranslatedAudioChunkPayload, LiveSubtitlePayload } from '../contexts/WebSocketContext';

export { ConnectionStatus, TranslatedAudioPayload, TranslatedAudioChunkPayload, LiveSubtitlePayload } from '../contexts/WebSocketContext';

interface UseWebSocketOptions {
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
  onSessionReadyEvent?: (partnerLang: string, engine?: string) => void;
  onWebRTCOffer?: (sdp: any) => void;
  onWebRTCAnswer?: (sdp: any) => void;
  onWebRTCIceCandidate?: (candidate: any) => void;
  onWebRTCReady?: () => void;
  onMinutesLow?: (minutesLeft: number) => void;
  onMinutesOut?: (graceSeconds: number) => void;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const context = useWebSocketContext();
  const hookId = useId();

  useEffect(() => {
    context.registerCallbacks(hookId, options);
    return () => {
      context.unregisterCallbacks(hookId);
    };
  }, [hookId, options, context]);

  return {
    status: context.status,
    role: context.role,
    sessionId: context.sessionId,
    shortCode: context.shortCode,
    myLang: context.myLang,
    partnerLang: context.partnerLang,
    callEngine: context.callEngine,
    isProcessing: context.isProcessing,
    isGeminiReady: context.isGeminiReady,
    liveKit: context.liveKit,
    queueDepth: context.queueDepth,
    createSession: context.createSession,
    joinSession: context.joinSession,
    reconnectHostSession: context.reconnectHostSession,
    sendAudioStreamChunk: context.sendAudioStreamChunk,
    sendPauseQueue: context.sendPauseQueue,
    sendResumeQueue: context.sendResumeQueue,
    sendCancelQueue: context.sendCancelQueue,
    claimTurn: context.claimTurn,
    releaseTurn: context.releaseTurn,
    endSession: context.endSession,
    sendWebRTCOffer: context.sendWebRTCOffer,
    sendWebRTCAnswer: context.sendWebRTCAnswer,
    sendWebRTCIceCandidate: context.sendWebRTCIceCandidate,
    sendWebRTCReady: context.sendWebRTCReady,
  };
}
