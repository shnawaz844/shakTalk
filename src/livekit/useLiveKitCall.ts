import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from 'livekit-client';
import { startCallAudio, stopCallAudio, setSpeakerphone } from './audio';

/**
 * The call, LiveKit edition.
 *
 * Like a WhatsApp/Teams call: this phone publishes its microphone over
 * WebRTC (echo cancellation + noise suppression on), and plays two things:
 *   • the partner's real voice, turned down (PARTNER_VOICE_VOLUME), and
 *   • the translation of the partner, at full volume — published into the
 *     room by the server's translator bot as "translation-of-<partner>".
 * Nothing else is subscribed, so you never hear your own translation.
 *
 * Because everything is played through WebRTC, the phone's echo canceller
 * keeps the loudspeaker out of the mic: no mic gating, no dropped words.
 */

/** How loud the partner's original voice is under the translation (0–1). */
export const PARTNER_VOICE_VOLUME = 0.25;
const TRANSLATOR_IDENTITY = 'translator';

export interface LiveKitCallInfo {
  url: string;
  token: string;
  identity: 'host' | 'guest';
  partnerIdentity: 'host' | 'guest';
}

export function useLiveKitCall(info: LiveKitCallInfo | null) {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [micEnabled, setMicEnabledState] = useState(true);
  const [partnerTalking, setPartnerTalking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const webAudioElsRef = useRef<HTMLMediaElement[]>([]);

  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    const { url, token, partnerIdentity } = info;
    const translationTrackName = `translation-of-${partnerIdentity}`;

    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    roomRef.current = room;

    const wanted = (pub: RemoteTrackPublication, p: RemoteParticipant) =>
      pub.kind === Track.Kind.Audio &&
      p.identity === TRANSLATOR_IDENTITY &&
      pub.trackName === translationTrackName;

    const consider = (pub: RemoteTrackPublication, p: RemoteParticipant) => {
      pub.setSubscribed(wanted(pub, p));
    };

    room.on(RoomEvent.TrackPublished, consider);
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      if (Platform.OS === 'web') {
        // Native plays subscribed audio automatically; the browser needs an element.
        const el = track.attach();
        el.style.display = 'none';
        document.body.appendChild(el);
        webAudioElsRef.current.push(el);
      }
      console.log(`[LiveKitCall] playing translation (${p.identity}/${pub.trackName})`);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (Platform.OS !== 'web') return;
      track.detach().forEach((el) => el.remove());
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      setPartnerTalking(speakers.some((s) => s.identity === partnerIdentity));
    });
    room.on(RoomEvent.ConnectionStateChanged, (state) => setConnectionState(state));
    room.on(RoomEvent.MediaDevicesError, (e: Error) => setError(e.message || 'Microphone error'));

    (async () => {
      try {
        await startCallAudio();
        if (cancelled) return;
        await room.connect(url, token, { autoSubscribe: false });
        if (cancelled) { await room.disconnect(); return; }
        // Tracks published before we connected.
        room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => consider(pub, p)));
        await room.localParticipant.setMicrophoneEnabled(true, {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
        try {
          room.localParticipant.setTrackSubscriptionPermissions(false, [
            { participantIdentity: TRANSLATOR_IDENTITY, allowAll: true },
          ]);
        } catch (_) {}
        if (Platform.OS === 'web') await room.startAudio().catch(() => {});
        await setSpeakerphone(true).catch(() => {});
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not join the call');
      }
    })();

    return () => {
      cancelled = true;
      room.removeAllListeners();
      room.disconnect().catch(() => {});
      roomRef.current = null;
      webAudioElsRef.current.forEach((el) => el.remove());
      webAudioElsRef.current = [];
      stopCallAudio().catch(() => {});
    };
  }, [info?.url, info?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMicEnabled = useCallback(async (enabled: boolean) => {
    setMicEnabledState(enabled);
    await roomRef.current?.localParticipant.setMicrophoneEnabled(enabled, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }).catch(() => {});
  }, []);

  const setSpeaker = useCallback(async (on: boolean) => {
    await setSpeakerphone(on).catch((e) => console.warn('[LiveKitCall] speaker switch failed:', e));
  }, []);

  return {
    connectionState,
    isConnected: connectionState === ConnectionState.Connected,
    micEnabled,
    partnerTalking,
    error,
    setMicEnabled,
    setSpeaker,
  };
}
