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
const { FixedVoiceSpeaker, FIXED_VOICE } = require('./fixedVoice');
// Server-side echo guard is OFF on this branch (phones' own echo cancellation
// handles it). Set ECHO_GUARD=on to test it again, e.g. if the translated
// voice starts to sound like the OTHER person (their translation leaking
// back into this mic gets cloned).
const ECHO_GUARD_ON = process.env.ECHO_GUARD === 'on';

/**
 * LiveKit call engine
 * ───────────────────
 * Both phones join a LiveKit room (WebRTC, like a WhatsApp/Teams call) and
 * publish their microphone with the platform's echo cancellation and noise
 * suppression. Each listener hears ONLY the translation of their partner:
 * the partner's raw microphone is never delivered to them (blocked by the app
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
// Playout cushion at the start of each talk spurt (see _play).
const PREBUFFER_MS = Number(process.env.TRANSLATION_PREBUFFER_MS ?? 160);
// A new piece arriving this soon after the track ran dry counts as an underrun.
const UNDERRUN_WINDOW_MS = 400;

/** Simple linear resampler, only used if Gemini ever sends a rate other than 24 kHz. */
function resampleLinear(input, fromRate, toRate) {
  if (!fromRate || fromRate === toRate) return input;
  const outLen = Math.floor(input.length * toRate / fromRate);
  const out = new Int16Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = Math.round(input[i0] * (1 - frac) + input[i1] * frac);
  }
  return out;
}

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
  constructor({ roomName, langs, genders = {}, onText, onError }) {
    this.roomName = roomName;
    this.langs = langs;
    this.genders = genders; // role → 'male' | 'female' | 'neutral' (onboarding), for fixed-voice mode
    this.voices = {};       // role → FixedVoiceSpeaker (TRANSLATION_VOICE=fixed only)
    this.onText = onText;
    this.onError = onError || (() => {});
    this.room = null;
    this.closed = false;
    this.outputs = {}; // role → { source, chain }
    this.streams = {}; // role → LiveTranslateStream
    this.readers = {}; // role → ReadableStreamDefaultReader
    // Phones' echo cancellation handles loudspeaker leakage. Optional server
    // backup (ECHO_GUARD=on): role → EchoGuard for that person's mic.
    this.guards = ECHO_GUARD_ON ? {
      host: new EchoGuard(`${roomName.slice(0, 8)}:host`),
      guest: new EchoGuard(`${roomName.slice(0, 8)}:guest`),
    } : null;
  }

  partnerOf(role) {
    return role === 'host' ? 'guest' : 'host';
  }

  async start() {
    const token = await createToken(this.roomName, BOT_IDENTITY);
    const room = new Room();
    this.room = room;

    const muteRawMicToPartner = async (role, trackSid) => {
      const listener = this.partnerOf(role);
      const svc = getRoomService();
      if (svc && trackSid) {
        try {
          await svc.updateSubscriptions(this.roomName, listener, [trackSid], false);
          console.log(`[translatorBot] ${this.roomName}: unsubscribed ${listener} from ${role} raw mic (${trackSid})`);
        } catch (err) {
          console.warn(`[translatorBot] ${this.roomName}: updateSubscriptions failed for ${listener}: ${err.message}`);
        }
      }
    };

    const syncSubscriptions = async () => {
      const svc = getRoomService();
      if (!svc) return;
      const hostTransSid = this.outputs['host']?.pub?.sid;
      const guestTransSid = this.outputs['guest']?.pub?.sid;

      if (hostTransSid) {
        // Translation of Host speech goes to Guest
        await svc.updateSubscriptions(this.roomName, 'guest', [hostTransSid], true).catch(() => {});
        await svc.updateSubscriptions(this.roomName, 'host', [hostTransSid], false).catch(() => {});
      }
      if (guestTransSid) {
        // Translation of Guest speech goes to Host
        await svc.updateSubscriptions(this.roomName, 'host', [guestTransSid], true).catch(() => {});
        await svc.updateSubscriptions(this.roomName, 'guest', [guestTransSid], false).catch(() => {});
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
      this.outputs[role] = {
        source, track, pub, chain: Promise.resolve(),
        // Playout jitter buffer (see _play): audio held back at the start of a
        // talk spurt, how much of it, and since when.
        hold: [], holdSamples: 0, holdTimer: null, holdSince: 0,
        lastFlushAt: 0, stats: { underruns: 0, spurts: 0, lastLogAt: 0 },
      };
    }
    // Not awaited: the phones subscribe to their translation track themselves
    // (useLiveKitCall.ts); these server-side calls are a backup. Calls about a
    // phone that hasn't joined yet can take many seconds to fail, and awaiting
    // them delayed "translator ready" on the phones by up to ~24s in tests.
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
    if (FIXED_VOICE) {
      this.voices[role] = new FixedVoiceSpeaker({
        label: `${this.roomName.slice(0, 8)}:${role}→${this.langs[listener]}`,
        languageName: this.langs[listener],
        gender: this.genders[role],
        // TTS audio arrives faster than real time in one stream, so it needs no cushion.
        onAudio: (pcm, rate) => this._play(role, pcm, rate, { cushion: false }),
      });
    }
    this.streams[role] = new LiveTranslateStream({
      label: `${this.roomName.slice(0, 8)}:${role}→${this.langs[listener]}`,
      inputLanguage: this.langs[role],
      targetLanguage: this.langs[listener],
      // Gemini's cloned voice is played unless fixed-voice mode is on and working.
      onAudio: (pcm, rate) => {
        const v = this.voices[role];
        if (!v || v.failed) this._play(role, pcm, rate);
      },
      onText: (seg) => this.onText(role, seg),
      onTranslationDelta: (text) => this.voices[role]?.push(text),
      onTurnEnd: () => this.voices[role]?.flush(),
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
        let pcm = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
        if (this.guards) pcm = this.guards[role].filter(pcm);
        if (pcm.length) translate.feed(pcm);
      }
    } catch (err) {
      if (!this.closed) console.warn(`[translatorBot] ${this.roomName}: ${role} mic stream ended: ${err.message}`);
    }
  }

  /**
   * Send translated audio from Gemini into the call track, in order.
   *
   * Why there is a small buffer here ("slow motion" fix):
   * Gemini streams translated speech in bursts, roughly as fast as it is
   * generated. Inside a sentence it sometimes delivers the next piece a little
   * late. Before, every piece went into the call immediately, so a late piece
   * left the track empty for a moment in the middle of a word. The listener's
   * phone (WebRTC NetEQ) hides such gaps by STRETCHING the audio it already has
   * and then speeds up to catch up — that is the "slow motion" / robotic
   * sound. Holding the first PREBUFFER_MS of every talk spurt gives the track
   * a small cushion, so short delays from Gemini no longer reach the listener.
   *
   *   TRANSLATION_PREBUFFER_MS   default 160. 0 = off (old behaviour).
   *                              Raise to 240–300 if "[playout] ... underruns"
   *                              keeps showing up in the log.
   */
  _play(role, pcm, rate = OUTPUT_RATE, { cushion = true } = {}) {
    const out = this.outputs[role];
    if (!out || this.closed) return;
    // Copy into an aligned Int16Array (base64-decoded Buffers can start at an
    // odd byte offset).
    let samples = new Int16Array(pcm.length >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
    if (rate !== OUTPUT_RATE) samples = resampleLinear(samples, rate, OUTPUT_RATE);
    if (!samples.length) return;
    // Optional echo guard: the listener is hearing this, guard their mic.
    if (this.guards) this.guards[this.partnerOf(role)].onPlayback(samples, OUTPUT_RATE);

    const now = Date.now();
    // Already playing (or prebuffer off): append right behind what is queued.
    // While a cushion is being collected, everything joins the cushion so the
    // order never changes.
    const playing = out.source.queuedDuration > 0 || out.pumping;
    if (out.hold.length === 0 && (playing || PREBUFFER_MS <= 0 || !cushion)) {
      this._enqueue(out, samples);
      return;
    }

    // Track went quiet before this piece arrived. If the previous piece was
    // released less than a moment ago, the track ran dry in the middle of
    // speech: that is an underrun (the cause of the stretched sound).
    if (out.hold.length === 0) {
      if (out.lastFlushAt && now - out.lastFlushAt < UNDERRUN_WINDOW_MS) out.stats.underruns++;
      out.stats.spurts++;
      out.holdSince = now;
      this._logPlayout(role, out, now);
    }
    out.hold.push(samples);
    out.holdSamples += samples.length;

    if (out.holdSamples >= (PREBUFFER_MS / 1000) * OUTPUT_RATE) {
      this._releaseHold(out);
    } else if (!out.holdTimer) {
      // Never wait longer than PREBUFFER_MS in total, even if Gemini sends
      // only a short word: the cushion must not add more than that.
      out.holdTimer = setTimeout(() => this._releaseHold(out), PREBUFFER_MS);
    }
  }

  _releaseHold(out) {
    if (out.holdTimer) { clearTimeout(out.holdTimer); out.holdTimer = null; }
    const parts = out.hold;
    out.hold = [];
    out.holdSamples = 0;
    for (const p of parts) this._enqueue(out, p);
  }

  _enqueue(out, samples) {
    out.pumping = true;
    out.chain = out.chain.then(async () => {
      for (let i = 0; i < samples.length && !this.closed; i += FRAME_SAMPLES) {
        const part = samples.slice(i, i + FRAME_SAMPLES);
        await out.source.captureFrame(new AudioFrame(part, OUTPUT_RATE, 1, part.length));
      }
      // When this piece has been handed over, remember when the track will run
      // dry, so _play can tell "new sentence" from "late piece inside speech".
      out.lastFlushAt = Date.now() + out.source.queuedDuration;
    }).catch((err) => {
      console.warn(`[translatorBot] ${this.roomName}: playback error: ${err.message}`);
    }).finally(() => {
      out.pumping = false;
    });
  }

  _logPlayout(role, out, now) {
    if (now - out.stats.lastLogAt < 30000) return;
    out.stats.lastLogAt = now;
    if (out.stats.underruns) {
      console.log(`[playout] ${this.roomName.slice(0, 8)}:${role}→${this.partnerOf(role)}: ${out.stats.underruns} underruns in ${out.stats.spurts} talk spurts (Gemini audio arrived late mid-speech; prebuffer ${PREBUFFER_MS}ms)`);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of Object.values(this.streams)) s.close();
    for (const v of Object.values(this.voices)) v.close();
    for (const r of Object.values(this.readers)) { try { await r.cancel(); } catch (_) {} }
    try { await this.room?.disconnect(); } catch (_) {}
    console.log(`[translatorBot] ${this.roomName}: closed`);
  }
}

module.exports = { TranslatorBot, createToken, LIVEKIT_ENABLED, LIVEKIT_URL, BOT_IDENTITY };
