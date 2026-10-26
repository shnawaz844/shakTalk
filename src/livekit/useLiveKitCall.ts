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

    const wanted = (pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (pub.kind !== Track.Kind.Audio) return false;
      // Never subscribe to partner's raw microphone track
      if (p.identity === partnerIdentity) return false;
      // Subscribe ONLY to the translation of my partner. An exact name match:
      // an unnamed or differently named translator track could be the
      // translation of my own voice, and must never play on my phone.
      if (p.identity === TRANSLATOR_IDENTITY) {
        if (pub.trackName) {
          return pub.trackName === translationTrackName || pub.trackName.includes(partnerIdentity);
        }
        return true;
      }
      return false;
    };

    const consider = (pub: RemoteTrackPublication, p: RemoteParticipant) => {
      const want = wanted(pub, p);
      pub.setSubscribed(want);
      console.log(`[LiveKitCall] consider track ${pub.trackSid} (${p.identity}/${pub.trackName || 'unnamed'}) -> subscribed: ${want}`);
    };

    room.on(RoomEvent.TrackPublished, consider);
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      p.trackPublications.forEach((pub) => consider(pub, p));
    });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      if (Platform.OS === 'web') {
        // Native plays subscribed audio automatically; the browser needs an element.
        const el = track.attach();
        el.style.display = 'none';
        document.body.appendChild(el);
        webAudioElsRef.current.push(el);
      }
      try {
        (track as any).setVolume?.(1.0);
      } catch (_) {}
      console.log(`[LiveKitCall] playing translation (${p.identity}/${pub.trackName || pub.trackSid})`);
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
        // Tracks published before or as we connected.
        room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => consider(pub, p)));
        // Only the translator bot may receive my raw microphone. LiveKit then
        // refuses to send it to my partner at all (enforced by the server, not
        // just by their app), before my mic is even published, so there is no
        // window where the partner could hear the untranslated voice.
        room.localParticipant.setTrackSubscriptionPermissions(false, [
          { participantIdentity: TRANSLATOR_IDENTITY, allowAll: true },
        ]);
        await room.localParticipant.setMicrophoneEnabled(true, {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
        if (Platform.OS === 'web') await room.startAudio().catch(() => {});
        await setSpeakerphone(true).catch(() => {});
        setTimeout(() => { setSpeakerphone(true).catch(() => {}); }, 600);
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
