if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
  try {
    const nodeCrypto = require('crypto');
    globalThis.crypto = nodeCrypto.webcrypto || {
      getRandomValues: (arr) => nodeCrypto.randomFillSync(arr),
    };
  } catch (_) {}
}

let rtcNode = null;
try {
  rtcNode = require('@livekit/rtc-node');
} catch (err) {
  console.warn('[translatorBot] Warning: @livekit/rtc-node is not installed or failed to load:', err.message);
}

const Room = rtcNode?.Room;
const RoomEvent = rtcNode?.RoomEvent;
const AudioStream = rtcNode?.AudioStream;
const AudioSource = rtcNode?.AudioSource;
const AudioFrame = rtcNode?.AudioFrame;
const LocalAudioTrack = rtcNode?.LocalAudioTrack;
const TrackPublishOptions = rtcNode?.TrackPublishOptions;
const TrackSource = rtcNode?.TrackSource;
const TrackKind = rtcNode?.TrackKind;

let AccessToken = null;
let RoomServiceClient = null;
try {
  ({ AccessToken, RoomServiceClient } = require('livekit-server-sdk'));
} catch (err) {
  console.warn('[translatorBot] Warning: livekit-server-sdk is not installed or failed to load:', err.message);
}
const { LiveTranslateStream } = require('./liveTranslate');
const { EchoGuard } = require('./echoGuard');

/**
 * LiveKit call engine
 * ───────────────────
 * Both phones join a LiveKit room (WebRTC, like a WhatsApp/Teams call) and
 * publish their microphone with the platform's echo cancellation and noise
 * suppression. Each listener hears ONLY the translation of their partner:
 * raw microphones are never delivered to the other phone (blocked by the app
 * via track subscription permissions, and by this bot as a backup).
 *
 * This bot joins the same room as a third participant ("translator"):
 *   host mic  → Gemini Live Translate (→ guest's language) → track "translation-of-host"
 *   guest mic → Gemini Live Translate (→ host's language)  → track "translation-of-guest"
 * Each phone subscribes only to the translation of its partner, so nobody
 * hears their own translation.
 *
 * Because the translation is played through the call (WebRTC), the phone's
 * echo canceller removes it from the mic — no mic gating is needed.
 */

const LIVEKIT_URL = process.env.LIVEKIT_URL;
// The bot can reach LiveKit over an internal address when it runs next to it.
const LIVEKIT_BOT_URL = process.env.LIVEKIT_BOT_URL || LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const LIVEKIT_ENABLED = Boolean(rtcNode && AccessToken && LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

const BOT_IDENTITY = 'translator';
const OUTPUT_RATE = 24000; // Gemini output
const FRAME_SAMPLES = OUTPUT_RATE / 50; // 20ms frames into the call

let roomService = null;
function getRoomService() {
  if (!roomService && RoomServiceClient && (LIVEKIT_BOT_URL || LIVEKIT_URL) && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
    let raw = LIVEKIT_BOT_URL || LIVEKIT_URL;
    let httpUrl = raw;
    if (httpUrl.startsWith('wss://')) httpUrl = 'https://' + httpUrl.slice(6);
    else if (httpUrl.startsWith('ws://')) httpUrl = 'http://' + httpUrl.slice(5);
    roomService = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  }
  return roomService;
}

async function createToken(roomName, identity, { canPublish = true } = {}) {
  if (!AccessToken) throw new Error('livekit-server-sdk is not available');
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '6h' });
  at.addGrant({ roomJoin: true, room: roomName, canPublish, canSubscribe: true, canPublishData: true });
  return at.toJwt();
}

class TranslatorBot {
  /**
   * @param {object} opts
   * @param {string} opts.roomName
   * @param {{host: string, guest: string}} opts.langs  app language names
   * @param {(role: 'host'|'guest', seg: object) => void} opts.onText   transcription of what `role` said
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor({ roomName, langs, onText, onError }) {
    this.roomName = roomName;
    this.langs = langs;
    this.onText = onText;
    this.onError = onError || (() => {});
    this.room = null;
    this.closed = false;
    this.outputs = {}; // role → { source, chain }
    this.streams = {}; // role → LiveTranslateStream
    this.readers = {}; // role → ReadableStreamDefaultReader
    // Phone echo cancellation removes most loudspeaker leakage; the EchoGuard
    // catches what's left. role → EchoGuard for that person's mic (guards it
    // only while AUDIBLE translation plays to them — see echoGuard.js).
    this.guards = {
      host: new EchoGuard(`${roomName.slice(0, 8)}:host`),
      guest: new EchoGuard(`${roomName.slice(0, 8)}:guest`),
    };
  }

  partnerOf(role) {
    return role === 'host' ? 'guest' : 'host';
  }

  async start() {
    const token = await createToken(this.roomName, BOT_IDENTITY);
    const room = new Room();
    this.room = room;

    // Each (listener, track, on/off) subscription change only needs to be sent
    // to LiveKit once. Before, the same calls were repeated on every
    // TrackPublished / ParticipantConnected / TrackSubscribed event (4–8 HTTP
    // requests each time). The app now also blocks raw-mic subscriptions at the
    // source (setTrackSubscriptionPermissions in useLiveKitCall.ts); this is the
    // server-side backup.
    const applied = new Set();
    const setSubscribed = async (listener, trackSid, subscribe) => {
      const svc = getRoomService();
      const key = `${listener}|${trackSid}|${subscribe}`;
      if (!svc || !trackSid || applied.has(key)) return false;
      applied.add(key); // mark first, so events arriving together don't repeat the call
      applied.delete(`${listener}|${trackSid}|${!subscribe}`);
      try {
        await svc.updateSubscriptions(this.roomName, listener, [trackSid], subscribe);
        return true;
      } catch (err) {
        applied.delete(key); // the participant may not have joined yet; the next event retries
        return false;
      }
    };

    const muteRawMicToPartner = async (role, trackSid) => {
      const listener = this.partnerOf(role);
      if (await setSubscribed(listener, trackSid, false)) {
        console.log(`[translatorBot] ${this.roomName}: unsubscribed ${listener} from ${role} raw mic (${trackSid})`);
      }
    };

    const syncSubscriptions = async () => {
      const svc = getRoomService();
      if (!svc) return;
      const hostTransSid = this.outputs['host']?.pub?.sid;
      const guestTransSid = this.outputs['guest']?.pub?.sid;

      if (hostTransSid) {
        // Translation of Host speech goes to Guest
        await setSubscribed('guest', hostTransSid, true);
        await setSubscribed('host', hostTransSid, false);
      }
      if (guestTransSid) {
        // Translation of Guest speech goes to Host
        await setSubscribed('host', guestTransSid, true);
        await setSubscribed('guest', guestTransSid, false);
      }
    };
    this.syncSubscriptions = syncSubscriptions;

    room.on(RoomEvent.TrackPublished, (publication, participant) => {
      const role = participant.identity;
      if (role === 'host' || role === 'guest') {
        muteRawMicToPartner(role, publication.sid);
        syncSubscriptions();
      }
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      const listener = participant.identity;
      if (listener === 'host' || listener === 'guest') {
        const speaker = this.partnerOf(listener);
        for (const p of room.remoteParticipants.values()) {
          if (p.identity === speaker) {
            for (const pub of p.trackPublications.values()) {
              if (pub.kind === TrackKind.KIND_AUDIO) {
                muteRawMicToPartner(speaker, pub.sid || pub.track?.sid);
              }
            }
          }
        }
        syncSubscriptions();
      }
    });

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const role = participant.identity;
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      if (role !== 'host' && role !== 'guest') return;
      muteRawMicToPartner(role, track.sid || publication?.sid);
      this._pipe(role, track);
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      if (!this.closed) console.warn(`[translatorBot] ${this.roomName}: disconnected from LiveKit (${reason})`);
    });

    // Gemini connections open in parallel with joining the room, so they're
    // warm by the time anyone speaks.
    for (const role of ['host', 'guest']) this._stream(role).start();

    await room.connect(LIVEKIT_BOT_URL, token, { autoSubscribe: true, dynacast: false });

    for (const role of ['host', 'guest']) {
      const source = new AudioSource(OUTPUT_RATE, 1, 2000);
      const track = LocalAudioTrack.createAudioTrack(`translation-of-${role}`, source);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      const pub = await room.localParticipant.publishTrack(track, options);
      this.outputs[role] = { source, track, pub, chain: Promise.resolve() };
    }
    // Not awaited: these LiveKit API calls are a backup (the app itself only
    // lets the translator receive its mic), and calls about a phone that
    // hasn't joined yet can take many seconds to fail. Awaiting them delayed
    // "translator ready" on the phones by up to ~24s.
    syncSubscriptions().catch(() => {});

    // Participants who joined (and were subscribed) before our handler ran.
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        if (pub.kind === TrackKind.KIND_AUDIO) {
          if (participant.identity === 'host' || participant.identity === 'guest') {
            muteRawMicToPartner(participant.identity, pub.sid || pub.track?.sid);
            if (pub.track) this._pipe(participant.identity, pub.track);
          }
        }
      }
    }
    syncSubscriptions().catch(() => {}); // backup, not awaited (see above)
    console.log(`[translatorBot] ${this.roomName}: joined, translating host(${this.langs.host}) ↔ guest(${this.langs.guest})`);
  }

  _stream(role) {
    if (this.streams[role]) return this.streams[role];
    const listener = this.partnerOf(role);
    this.streams[role] = new LiveTranslateStream({
      label: `${this.roomName.slice(0, 8)}:${role}→${this.langs[listener]}`,
      inputLanguage: this.langs[role],
      targetLanguage: this.langs[listener],
      onAudio: (pcm) => this._play(role, pcm),
      onText: (seg) => this.onText(role, seg),
      onError: (err) => this.onError(err),
    });
    return this.streams[role];
  }

  async _pipe(role, track) {
    // A re-subscribed track (after a network blip) replaces the old reader.
    if (this.readers[role]) {
      try { await this.readers[role].cancel(); } catch (_) {}
    }
    const stream = new AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 100 });
    const reader = stream.getReader();
    this.readers[role] = reader;
    const translate = this._stream(role);
    console.log(`[translatorBot] ${this.roomName}: receiving ${role} mic`);
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done || this.closed) break;
        const d = frame.data;
        const pcm = this.guards[role].filter(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
        if (pcm.length) translate.feed(pcm);
      }
    } catch (err) {
      if (!this.closed) console.warn(`[translatorBot] ${this.roomName}: ${role} mic stream ended: ${err.message}`);
    }
  }

  _play(role, pcm) {
    const out = this.outputs[role];
    if (!out || this.closed) return;
    const listener = this.partnerOf(role);
    // Copy into an aligned Int16Array (base64-decoded Buffers can start at an
    // odd byte offset) and push it into the call in 20ms frames, in order.
    const samples = new Int16Array(pcm.length >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);

    // The listener is the one hearing this: guard their mic while it plays.
    this.guards[listener].onPlayback(samples, OUTPUT_RATE);
    out.chain = out.chain.then(async () => {
      for (let i = 0; i < samples.length && !this.closed; i += FRAME_SAMPLES) {
        const part = samples.slice(i, i + FRAME_SAMPLES);
        await out.source.captureFrame(new AudioFrame(part, OUTPUT_RATE, 1, part.length));
      }
    }).catch((err) => {
      console.warn(`[translatorBot] ${this.roomName}: playback error: ${err.message}`);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of Object.values(this.streams)) s.close();
    for (const r of Object.values(this.readers)) { try { await r.cancel(); } catch (_) {} }
    try { await this.room?.disconnect(); } catch (_) {}
    console.log(`[translatorBot] ${this.roomName}: closed`);
  }
}

module.exports = { TranslatorBot, createToken, LIVEKIT_ENABLED, LIVEKIT_URL, BOT_IDENTITY };
