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
const ECHO_TARGET = process.env.GEMINI_TRANSLATE_ECHO_TARGET !== undefined
  ? process.env.GEMINI_TRANSLATE_ECHO_TARGET === 'true'
  : (process.env.GEMINI_TRANSLATE_ECHO !== undefined ? process.env.GEMINI_TRANSLATE_ECHO === 'false' : true);

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
  constructor({ label, inputLanguage, targetLanguage, voiceProfile, onAudio, onText, onError }) {
    this.label = label;
    this.inputLanguage = inputLanguage || 'Unknown';
    this.targetLanguage = targetLanguage;
    this.targetCode = targetCodeFor(targetLanguage);
    this.voiceProfile = voiceProfile || {};
    const gender = (this.voiceProfile.gender || '').toLowerCase();
    // Male -> 'Puck', Female -> 'Aoede', Default -> 'Puck'
    this.voiceName = gender === 'female' ? 'Aoede' : 'Puck';
    this.onAudio = onAudio;
    this.onText = onText;
    this.onError = onError || (() => { });

    this.session = null;
    this.connectPromise = null;
    this.closed = false;
    this.generation = 0;
    this._gen = 0;
    this.resumeHandle = null;
    this.useResumption = process.env.GEMINI_TRANSLATE_RESUMPTION !== 'false';
    this.pending = [];
    this.retryAfter = 0;
    this.failures = 0;

    this._newSegment();

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
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this.voiceName,
          },
        },
      },
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
    console.log(`[liveTranslate] ${this.label}: connecting (target=${this.targetCode}, voice=${this.voiceName}${handle ? ', resuming' : ''})`);

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
          const pcm = Buffer.from(part.inlineData.data, 'base64');

          if (this.awaitingFirstAudio) {
            this.awaitingFirstAudio = false;
            console.log(`[LATENCY][translate] ${this.label}: translated audio started ${Date.now() - this.speechStartAt}ms after the speaker started talking`);
          }

          // Directly stream translated audio to listener in real time (zero buffering)
          this.onAudio(pcm);
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
      changed = true;
    }
    if (changed) {
      this.onText({ ...this.seg, isFinal: false });
      if (this.segTimer) clearTimeout(this.segTimer);
      this.segTimer = setTimeout(() => this._finishSegment(), SEGMENT_IDLE_MS);
    }
    if (sc.turnComplete) {
      this._finishSegment();
    }
  }

  _finishSegment() {
    const { segId, originalText, translatedText } = this.seg;
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

  close() {
    this.closed = true;
    if (this.segTimer) clearTimeout(this.segTimer);
    this._finishSegment();
    try { this.session?.close(); } catch (_) { }
    this.session = null;
    this.pending = [];
  }
}

module.exports = { LiveTranslateStream, targetCodeFor, MODEL };
