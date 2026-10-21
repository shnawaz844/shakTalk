const {
  Room,
  RoomEvent,
  AudioStream,
  AudioSource,
  AudioFrame,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  TrackKind,
} = require('@livekit/rtc-node');
const { AccessToken } = require('livekit-server-sdk');
const { LiveTranslateStream } = require('./liveTranslate');

/**
 * LiveKit call engine
 * ───────────────────
 * Both phones join a LiveKit room (WebRTC, like a WhatsApp/Teams call) and
 * publish their microphone with the platform's echo cancellation and noise
 * suppression. Each listener hears the partner's real voice directly
 * (~200–300ms), turned down, with the translation on top.
 *
 * This bot joins the same room as a third participant ("translator"):
 *   host mic  → Gemini Live Translate (→ guest's language) → track "translation-of-host"
 *   guest mic → Gemini Live Translate (→ host's language)  → track "translation-of-guest"
 * Each phone subscribes only to its partner's mic and to the translation of
 * its partner, so nobody hears their own translation.
 *
 * Because the translation is played through the call (WebRTC), the phone's
 * echo canceller removes it from the mic — no mic gating is needed.
 */

const LIVEKIT_URL = process.env.LIVEKIT_URL;
// The bot can reach LiveKit over an internal address when it runs next to it.
const LIVEKIT_BOT_URL = process.env.LIVEKIT_BOT_URL || LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const LIVEKIT_ENABLED = Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

const BOT_IDENTITY = 'translator';
const OUTPUT_RATE = 24000; // Gemini output
const FRAME_SAMPLES = OUTPUT_RATE / 50; // 20ms frames into the call

async function createToken(roomName, identity, { canPublish = true } = {}) {
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
  }

  partnerOf(role) {
    return role === 'host' ? 'guest' : 'host';
  }

  async start() {
    const token = await createToken(this.roomName, BOT_IDENTITY);
    const room = new Room();
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const role = participant.identity;
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      if (role !== 'host' && role !== 'guest') return;
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
      await room.localParticipant.publishTrack(track, options);
      this.outputs[role] = { source, track, chain: Promise.resolve() };
    }

    // Participants who joined (and were subscribed) before our handler ran.
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
          if (participant.identity === 'host' || participant.identity === 'guest') this._pipe(participant.identity, pub.track);
        }
      }
    }
    console.log(`[translatorBot] ${this.roomName}: joined, translating host(${this.langs.host}) ↔ guest(${this.langs.guest})`);
  }

  _stream(role) {
    if (this.streams[role]) return this.streams[role];
    const listener = this.partnerOf(role);
    this.streams[role] = new LiveTranslateStream({
      label: `${this.roomName.slice(0, 8)}:${role}→${this.langs[listener]}`,
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
        translate.feed(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
      }
    } catch (err) {
      if (!this.closed) console.warn(`[translatorBot] ${this.roomName}: ${role} mic stream ended: ${err.message}`);
    }
  }

  _play(role, pcm) {
    const out = this.outputs[role];
    if (!out || this.closed) return;
    // Copy into an aligned Int16Array (base64-decoded Buffers can start at an
    // odd byte offset) and push it into the call in 20ms frames, in order.
    const samples = new Int16Array(pcm.length >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
    out.chain = out.chain.then(async () => {
      for (let i = 0; i < samples.length && !this.closed; i += FRAME_SAMPLES) {
        const part = samples.slice(i, i + FRAME_SAMPLES);
        await out.source.captureFrame(new AudioFrame(part, OUTPUT_RATE, 1, part.length));
      }
    }).catch((err) => console.warn(`[translatorBot] ${this.roomName}: playback error: ${err.message}`));
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
