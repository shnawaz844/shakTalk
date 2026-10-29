require('dotenv').config();
// Gemini 3.5 Live Translate needs the 2.x SDK (translationConfig). It is
// installed under an alias so the legacy engine (geminiService.js) keeps the
// 1.x SDK it was tested with.
const { GoogleGenAI, Modality } = require('google-genai-v2');

/**
 * Continuous speech-to-speech translation with Gemini 3.5 Live Translate.
 *
 * Unlike the legacy engine (gemini-live-2.5-flash-native-audio), this model
 * does not wait for the speaker to pause: it translates while they talk and
 * streams translated speech back continuously. One LiveTranslateStream =
 * one direction (one speaker → one listener language).
 *
 * Config (env):
 *   GEMINI_TRANSLATE_MODEL     default 'gemini-3.5-live-translate-preview'
 *   GEMINI_TRANSLATE_BACKEND   'vertex' (default, uses GOOGLE_CLOUD_PROJECT +
 *                              GOOGLE_APPLICATION_CREDENTIALS like the legacy
 *                              engine) or 'apikey' (uses GEMINI_API_KEY)
 *   GEMINI_TRANSLATE_LOCATION  Vertex region; defaults to GOOGLE_CLOUD_LOCATION
 *   GEMINI_TRANSLATE_ECHO      'true' to have the model repeat speech that is
 *                              already in the listener's language (default
 *                              false: the listener hears the original voice
 *                              directly over the call anyway)
 */

const MODEL = process.env.GEMINI_TRANSLATE_MODEL || 'gemini-3.5-live-translate-preview';
const BACKEND = (process.env.GEMINI_TRANSLATE_BACKEND || 'vertex').toLowerCase();
// echoTargetLanguage: should the model also speak words that are ALREADY in
// the listener's language (English words inside Hinglish, for example)?
// Default OFF: in two-phone tests (29 Oct 2026) turning it on made the model
// mis-hear speech and output a different sentence. Trade-off when off: a
// sentence spoken in the listener's own language is not repeated to them.
//   GEMINI_TRANSLATE_ECHO_TARGET=true|false  (clear name; default false)
//   GEMINI_TRANSLATE_ECHO                    (old name, value read inverted:
//                                             "false" means ON) — still honoured
const ECHO_TARGET = process.env.GEMINI_TRANSLATE_ECHO_TARGET !== undefined
  ? process.env.GEMINI_TRANSLATE_ECHO_TARGET === 'true'
  : (process.env.GEMINI_TRANSLATE_ECHO !== undefined ? process.env.GEMINI_TRANSLATE_ECHO === 'false' : false);


// Optional cost saving: stop streaming the mic to Gemini while nobody is
// talking (input audio is billed per second). Off by default; see
// _shouldSend below. Turn on with GEMINI_TRANSLATE_SKIP_SILENCE=true.
const SKIP_SILENCE = process.env.GEMINI_TRANSLATE_SKIP_SILENCE === 'true';
const SILENCE_HANGOVER_MS = 1500; // keep sending this long after the last speech
const PRE_ROLL_FRAMES = 3;        // ~300ms kept back so the start of a word isn't clipped

const INPUT_MIME = 'audio/pcm;rate=16000';

// App language names (src/config.ts LANGUAGES) → codes the model accepts.
// Cantonese has no spoken target of its own in the model's list; Traditional
// Chinese is the closest available target.
const TARGET_CODES = {
  English: 'en',
  Hindi: 'hi',
  Urdu: 'ur',
  Mandarin: 'zh-Hans',
  Cantonese: 'zh-Hant',
  Arabic: 'ar',
  'Arabic (Standard)': 'ar',
  'Arabic (Saudi)': 'ar',
  'Arabic (UAE)': 'ar',
  'Arabic (Qatar)': 'ar',
  'Arabic (Kuwait)': 'ar',
  'Arabic (Oman)': 'ar',
  'Arabic (Bahrain)': 'ar',
  Spanish: 'es',
  French: 'fr',
  German: 'de',
  Russian: 'ru',
  Ukrainian: 'uk',
};

// Every language name the app can send (used by server.js to reject anything else).
const SUPPORTED_LANGUAGES = Object.keys(TARGET_CODES);

// Accuracy check: the writing system each target language should come back in.
// Latin-script languages are skipped (English/Spanish/French/German can't be
// told apart by script alone).
const TARGET_SCRIPTS = {
  hi: /[\u0900-\u097F]/,           // Devanagari
  ar: /[\u0600-\u06FF]/, ur: /[\u0600-\u06FF]/, // Arabic script
  'zh-Hans': /[\u4E00-\u9FFF]/, 'zh-Hant': /[\u4E00-\u9FFF]/, // Han
  ru: /[\u0400-\u04FF]/, uk: /[\u0400-\u04FF]/, // Cyrillic
};

/** True when `text` clearly isn't written in the target language's script. */
function looksLikeWrongLanguage(text, targetCode) {
  const script = TARGET_SCRIPTS[targetCode];
  if (!script) return false;
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters < 8) return false; // too short to judge
  const inScript = (text.match(new RegExp(script.source, 'gu')) || []).length;
  return inScript < letters * 0.3;
}

function targetCodeFor(languageName) {
  return TARGET_CODES[languageName] || 'en';
}

let _ai = null;
function getClient() {
  if (_ai) return _ai;
  if (BACKEND === 'apikey') {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_TRANSLATE_BACKEND=apikey but GEMINI_API_KEY is not set');
    _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, vertexai: false });
  } else {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error('GOOGLE_CLOUD_PROJECT is not set (needed for GEMINI_TRANSLATE_BACKEND=vertex)');
    const location = process.env.GEMINI_TRANSLATE_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    _ai = new GoogleGenAI({ vertexai: true, project, location });
  }
  console.log(`[liveTranslate] model=${MODEL} backend=${BACKEND}${BACKEND === 'vertex' ? ` location=${process.env.GEMINI_TRANSLATE_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1'}` : ''}`);
  return _ai;
}

// How long transcription text must stop changing before the current
// subtitle line is treated as finished (for the transcript + database).
const SEGMENT_IDLE_MS = 1200;
// Speech onset for latency logs: RMS above ~-36 dBFS after 1.5s of quiet.
const SPEECH_RMS = 500;
const SPEECH_GAP_MS = 1500;
// Audio kept while (re)connecting: ~2s of 100ms frames.
const MAX_PENDING_FRAMES = 20;

class LiveTranslateStream {
  /**
   * @param {object} opts
   * @param {string} opts.label            for logs, e.g. "session:host→Hindi"
   * @param {string} opts.inputLanguage    app language name of the SPEAKER (used for mismatch detection)
   * @param {string} opts.targetLanguage   app language name of the LISTENER
   * @param {(pcm24k: Buffer) => void} opts.onAudio
   * @param {(seg: {segId:string, originalText:string, translatedText:string, isFinal:boolean}) => void} opts.onText
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor({ label, inputLanguage, targetLanguage, onAudio, onText, onError, onTranslationDelta, onTurnEnd }) {
    this.label = label;
    this.inputLanguage = inputLanguage || 'Unknown';
    this.targetLanguage = targetLanguage;
    this.targetCode = targetCodeFor(targetLanguage);
    this.onAudio = onAudio;
    this.onText = onText;
    // Optional (fixed-voice mode): each new piece of translated text, and the end of a turn.
    this.onTranslationDelta = onTranslationDelta || (() => { });
    this.onTurnEnd = onTurnEnd || (() => { });
    this.onError = onError || (() => { });

    this.session = null;
    this.connectPromise = null;
    this.closed = false;
    this.generation = 0;
    this._gen = 0;
    this.resumeHandle = null;
    this.audioGen = 0;   // which connection's audio is currently being played (see _onMessage)
    this.lastRate = 24000;
    this.useResumption = process.env.GEMINI_TRANSLATE_RESUMPTION !== 'false';
    this.pending = [];
    this.retryAfter = 0;
    this.failures = 0;

    this._newSegment();
    this.stats = { segments: 0, wrongLanguage: 0 };
    this.preRoll = []; // recent quiet frames, only used with SKIP_SILENCE

    // Latency bookkeeping, from the audio itself: when the speaker starts
    // talking after a quiet spell, how long until translated audio comes back.
    this.speechStartAt = 0;
    this.lastLoudAt = 0;
    this.awaitingFirstAudio = false;
  }

  _newSegment() {
    if (this.segTimer) clearTimeout(this.segTimer);
    this.segTimer = null;
    this.seg = { segId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, originalText: '', translatedText: '' };
  }

  _config(handle) {
    const config = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      translationConfig: {
        targetLanguageCode: this.targetCode,
        echoTargetLanguage: ECHO_TARGET,
      },
    };
    if (this.useResumption) config.sessionResumption = handle ? { handle } : {};
    return config;
  }

  start() {
    return this._ensureConnected();
  }

  _ensureConnected() {
    if (this.session || this.closed) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const gen = ++this._gen;
    const handle = this.resumeHandle;
    const openedAt = Date.now();
    console.log(`[liveTranslate] ${this.label}: connecting (target=${this.targetCode}${handle ? ', resuming' : ''})`);

    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('connect timed out after 10s'));
        }
      }, 10000);

      getClient().live.connect({
        model: MODEL,
        config: this._config(handle),
        callbacks: {
          onmessage: (msg) => this._onMessage(msg, gen),
          onerror: (e) => {
            if (!settled && !this.session) {
              settled = true;
              clearTimeout(timer);
              reject(new Error(`connection error: ${e?.message || e}`));
            }
            this._onDrop(gen, `error: ${e?.message || e}`, openedAt);
          },
          onclose: (e) => {
            if (!settled && !this.session) {
              settled = true;
              clearTimeout(timer);
              reject(new Error(`closed by server (${e?.code}): ${e?.reason || 'no reason provided'}`));
            }
            this._onDrop(gen, `closed ${e?.code ?? ''} ${e?.reason ?? ''}`.trim(), openedAt, e?.code);
          },
        },
      }).then((session) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(session);
        }
      }, (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    })
      .then((session) => {
        if (this.closed) { try { session.close(); } catch (_) { } return; }
        this.session = session;
        this.generation = gen;
        this.failures = 0;
        console.log(`[liveTranslate] ${this.label}: ready (${Date.now() - openedAt}ms)`);
        const queued = this.pending;
        this.pending = [];
        for (const b64 of queued) this._send(b64);
      })
      .catch((err) => {
        this.failures += 1;
        this.retryAfter = Date.now() + Math.min(5000, 500 * this.failures);
        console.error(`[liveTranslate] ${this.label}: connect failed: ${err.message}`);
        if (handle) this.resumeHandle = null; // a stale handle must not block reconnecting
        this.onError(err);
      })
      .finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  _onDrop(gen, why, openedAt, code) {
    if (gen !== this.generation || this.closed) return; // replaced, or we ended the call
    console.warn(`[liveTranslate] ${this.label}: ${why}`);
    this.session = null;
    // 1007 right after setup = a config field the model rejected. The only
    // optional one is session resumption (reported unsupported early in the
    // preview), so drop it and reconnect.
    if (code === 1007 && this.useResumption && Date.now() - openedAt < 5000) {
      console.warn(`[liveTranslate] ${this.label}: setup rejected, retrying without session resumption`);
      this.useResumption = false;
      this.resumeHandle = null;
    }
    this._ensureConnected();
  }

  _onMessage(msg, gen) {
    if (msg.sessionResumptionUpdate && gen === this.generation) {
      const { resumable, newHandle } = msg.sessionResumptionUpdate;
      if (resumable && newHandle) this.resumeHandle = newHandle;
    }
    if (msg.goAway && gen === this.generation) {
      // Server will close this connection soon: open the next one now and
      // retire this one once the new one is ready.
      const old = this.session;
      this.session = null;
      console.log(`[liveTranslate] ${this.label}: goAway (${msg.goAway.timeLeft}), reconnecting`);
      this._ensureConnected().then(() => setTimeout(() => { try { old?.close(); } catch (_) { } }, 3000));
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData?.data) {
          // After a goAway the old and the new Gemini connection are both open
          // for a few seconds. Both can send audio, and playing both made the
          // translation overlap/stretch ("slow motion") and switch voices back
          // and forth. Rule: the old connection may finish its sentence until
          // the new one produces its first audio; from then on only the newest
          // connection is played.
          if (gen < this.audioGen) continue;
          if (gen > this.audioGen) {
            if (this.audioGen) {
              console.log(`[voice] ${this.label}: audio now comes from a new Gemini connection (#${gen}); the cloned voice can sound different for the first few seconds`);
            }
            this.audioGen = gen;
          }

          // Output sample rate: Gemini says it in the mimeType
          // ("audio/pcm;rate=24000"). The call track is built for 24 kHz; any
          // other rate would play at the wrong speed, so log it loudly.
          const rateMatch = /rate=(\d+)/.exec(part.inlineData.mimeType || '');
          const rate = rateMatch ? Number(rateMatch[1]) : 24000;
          if (rate !== this.lastRate) {
            if (rate !== 24000) console.warn(`[voice] ${this.label}: Gemini sent audio at ${rate} Hz (expected 24000) — mimeType "${part.inlineData.mimeType}"`);
            this.lastRate = rate;
          }

          const pcm = Buffer.from(part.inlineData.data, 'base64');

          if (this.awaitingFirstAudio) {
            this.awaitingFirstAudio = false;
            console.log(`[LATENCY][translate] ${this.label}: translated audio started ${Date.now() - this.speechStartAt}ms after the speaker started talking`);
          }

          // Stream translated audio to the listener (translatorBot paces it).
          this.onAudio(pcm, rate);
        }
      }
    }

    let changed = false;
    if (sc.inputTranscription?.text) {
      this.seg.originalText += sc.inputTranscription.text;
      changed = true;
    }
    if (sc.outputTranscription?.text) {
      this.seg.translatedText += sc.outputTranscription.text;
      if (gen >= this.audioGen) this.onTranslationDelta(sc.outputTranscription.text);
      changed = true;
    }
    if (changed) {
      this.onText({ ...this.seg, isFinal: false });
      if (this.segTimer) clearTimeout(this.segTimer);
      this.segTimer = setTimeout(() => this._finishSegment(), SEGMENT_IDLE_MS);
    }
    if (sc.turnComplete) {
      this.onTurnEnd();
      this._finishSegment();
    }
  }

  _finishSegment() {
    const { segId, originalText, translatedText } = this.seg;
    if (translatedText.trim() && looksLikeWrongLanguage(translatedText, this.targetCode)) {
      // Known preview-model issue: sometimes answers in the wrong language.
      // Logged so we can measure how often it happens per language pair.
      this.stats.wrongLanguage++;
      console.warn(`[accuracy] ${this.label}: translation does not look like ${this.targetCode} (${this.stats.wrongLanguage}/${this.stats.segments + 1} segments): "${translatedText.trim().slice(0, 80)}"`);
    }
    if (translatedText.trim()) this.stats.segments++;
    if (originalText.trim() || translatedText.trim()) {
      this.onText({ segId, originalText: originalText.trim(), translatedText: translatedText.trim(), isFinal: true });
    }
    this._newSegment();
  }

  _send(b64) {
    try {
      this.session.sendRealtimeInput({ audio: { data: b64, mimeType: INPUT_MIME } });
    } catch (err) {
      this.session = null;
      this.pending.push(b64);
    }
  }

  /** Feed raw 16-bit 16kHz mono PCM (any length; ~100ms frames recommended). */
  feed(pcm16k) {
    if (this.closed) return;
    const buf = Buffer.isBuffer(pcm16k) ? pcm16k : Buffer.from(pcm16k);
    this._trackSpeech(buf);
    if (SKIP_SILENCE && !this._shouldSend(buf)) return;
    const b64 = buf.toString('base64');
    if (this.session) { this._send(b64); return; }
    this.pending.push(b64);
    if (this.pending.length > MAX_PENDING_FRAMES) this.pending.shift();
    if (!this.connectPromise && Date.now() >= this.retryAfter) this._ensureConnected();
  }

  _trackSpeech(buf) {
    const n = buf.length >> 1;
    if (!n) return;
    let sum = 0;
    for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); sum += v * v; }
    const rms = Math.sqrt(sum / n);
    const now = Date.now();
    if (rms > SPEECH_RMS) {
      if (now - this.lastLoudAt > SPEECH_GAP_MS) {
        this.speechStartAt = now;
        this.awaitingFirstAudio = true;
      }
      this.lastLoudAt = now;
    }
  }

  /**
   * SKIP_SILENCE only: decide whether this frame goes to Gemini.
   * Sends while someone spoke in the last SILENCE_HANGOVER_MS; otherwise keeps
   * the last PRE_ROLL_FRAMES frames aside and, when speech starts again, sends
   * them first so the beginning of the first word isn't cut off.
   */
  _shouldSend(buf) {
    const speaking = Date.now() - this.lastLoudAt < SILENCE_HANGOVER_MS;
    if (speaking) {
      if (this.preRoll.length) {
        const held = this.preRoll; this.preRoll = [];
        for (const b of held) this._sendOrQueue(b.toString('base64'));
      }
      return true;
    }
    this.preRoll.push(buf);
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
    return false;
  }

  _sendOrQueue(b64) {
    if (this.session) { this._send(b64); return; }
    this.pending.push(b64);
    if (this.pending.length > MAX_PENDING_FRAMES) this.pending.shift();
  }

  close() {
    this.closed = true;
    if (this.segTimer) clearTimeout(this.segTimer);
    this._finishSegment();
    try { this.session?.close(); } catch (_) { }
    this.session = null;
    this.pending = [];
  }
}

module.exports = { LiveTranslateStream, targetCodeFor, looksLikeWrongLanguage, SUPPORTED_LANGUAGES, MODEL };
