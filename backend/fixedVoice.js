/**
 * Fixed-voice mode (TRANSLATION_VOICE=fixed)
 * ─────────────────────────────────────────
 * Gemini 3.5 Live Translate has no fixed voice: it imitates the speaker, and
 * Google lists "voice replication can be inconsistent" as a known limitation
 * (the voice can shift after pauses, after a reconnect, or drift in long
 * speech; `voiceName` is accepted but ignored). There is no setting to lock it.
 *
 * This mode makes the voice 100% stable by not playing Gemini's audio at all:
 *   Gemini Live Translate  → translated TEXT (outputTranscription, streamed)
 *   Google Cloud TTS (Chirp 3 HD, streaming) → speech in ONE fixed voice
 * The voice is chosen per listener language and the speaker's gender from
 * onboarding, so a male speaker always sounds like the same male voice.
 *
 * Trade-offs (TRANSLATION_VOICE=gemini switches back):
 *   + voice never changes during a call
 *   - adds roughly 0.3–0.8 s (text is spoken in phrases, plus TTS start-up)
 *   - the voice no longer sounds like the speaker
 *   - TTS cost on top of Gemini (Chirp 3 HD is billed per character)
 *
 * If TTS fails (API not enabled, quota, unsupported language) this speaker
 * reports `failed = true` and translatorBot falls back to Gemini's own audio
 * for the rest of the call, so a call never goes silent.
 *
 * Env:
 *   TRANSLATION_VOICE=fixed|gemini     default fixed; gemini = Gemini's cloned voice
 *   TTS_VOICE_MALE=Charon              Chirp 3 HD voice names
 *   TTS_VOICE_FEMALE=Kore
 *   TTS_LOCATION / GOOGLE_CLOUD_PROJECT use the same service account as Vertex
 *     (enable "Cloud Text-to-Speech API" in that project)
 */

let TextToSpeechClient = null;
try {
  ({ TextToSpeechClient } = require('@google-cloud/text-to-speech'));
} catch (err) {
  // Only needed when TRANSLATION_VOICE=fixed; reported when used.
}

// Default ON: Gemini's cloned voice was observed switching gender mid-call
// (male speaker → female voice). TRANSLATION_VOICE=gemini restores the cloned voice.
const FIXED_VOICE = (process.env.TRANSLATION_VOICE || 'fixed').toLowerCase() !== 'gemini';
const VOICE_MALE = process.env.TTS_VOICE_MALE || 'Charon';
const VOICE_FEMALE = process.env.TTS_VOICE_FEMALE || 'Kore';
const OUTPUT_RATE = 24000;

// App language name → TTS locale (Chirp 3 HD).
const TTS_LOCALES = {
  English: 'en-US',
  Hindi: 'hi-IN',
  Urdu: 'ur-IN',
  Mandarin: 'cmn-CN',
  Cantonese: 'yue-HK',
  Arabic: 'ar-XA',
  'Arabic (Standard)': 'ar-XA',
  'Arabic (Saudi)': 'ar-XA',
  'Arabic (UAE)': 'ar-XA',
  'Arabic (Qatar)': 'ar-XA',
  'Arabic (Kuwait)': 'ar-XA',
  'Arabic (Oman)': 'ar-XA',
  'Arabic (Bahrain)': 'ar-XA',
  Spanish: 'es-ES',
  French: 'fr-FR',
  German: 'de-DE',
  Russian: 'ru-RU',
  Ukrainian: 'uk-UA',
};

// When to hand text to TTS: at the end of a sentence or clause, or once enough
// words have collected, or when no new text came for a moment.
const SENTENCE_END = /[.!?।॥؟。！？]\s*$/;
const CLAUSE_END = /[,;:،、，；]\s*$/;
const MIN_CLAUSE_CHARS = 15;   // don't speak tiny fragments like "So,"
const MAX_CHARS = 120;         // long run-on text: speak it anyway
const IDLE_FLUSH_MS = 250;     // no new text for this long: speak what we have
// A TTS stream is kept open across phrases (same voice, no start-up cost) and
// closed after this long without text. Google closes idle streams itself.
const STREAM_IDLE_MS = 4000;

let client = null;
// Result of the start-up check: null = not known yet, true = works, false = doesn't.
let ttsHealthy = null;
// If TTS sends no audio this long after the first phrase, fall back to Gemini's voice.
const FIRST_AUDIO_TIMEOUT_MS = 3000;
function getClient() {
  if (!client) client = new TextToSpeechClient();
  return client;
}

class FixedVoiceSpeaker {
  /**
   * @param {object} opts
   * @param {string} opts.label            for logs
   * @param {string} opts.languageName     app language name of the LISTENER
   * @param {string} [opts.gender]         speaker's gender from onboarding: male | female | neutral
   * @param {(pcm: Buffer, rate: number) => void} opts.onAudio
   */
  constructor({ label, languageName, gender, onAudio }) {
    this.label = label;
    this.onAudio = onAudio;
    this.locale = TTS_LOCALES[languageName];
    const name = gender === 'female' ? VOICE_FEMALE : VOICE_MALE;
    this.voiceName = this.locale ? `${this.locale}-Chirp3-HD-${name}` : null;
    this.text = '';
    this.flushTimer = null;
    this.call = null;
    this.idleTimer = null;
    this.failed = false;
    this.gotAudio = false; // any TTS audio received yet in this call
    this.closed = false;

    if (!TextToSpeechClient) this._fail('@google-cloud/text-to-speech is not installed (cd backend && npm install)');
    else if (!this.voiceName) this._fail(`no TTS voice for "${languageName}"`);
    else if (ttsHealthy === false) this._fail('Cloud Text-to-Speech failed the start-up check (see the [fixedVoice] line at server start)');
    else console.log(`[fixedVoice] ${label}: voice ${this.voiceName}`);
  }

  _fail(why) {
    if (this.failed) return;
    this.failed = true;
    console.warn(`[fixedVoice] ${this.label}: ${why} — using Gemini's own voice for this call`);
    this._endCall();
  }

  /** Newly translated text (a delta, as Gemini streams it). */
  push(delta) {
    if (this.failed || this.closed || !delta) return;
    this.text += delta;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const t = this.text.trimEnd();
    if (SENTENCE_END.test(t) || (CLAUSE_END.test(t) && t.length >= MIN_CLAUSE_CHARS) || t.length >= MAX_CHARS) {
      this.flush();
    } else {
      this.flushTimer = setTimeout(() => this.flush(), IDLE_FLUSH_MS);
    }
  }

  /** Speak whatever text is waiting (end of a phrase or of the turn). */
  flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const text = this.text.trim();
    this.text = '';
    if (!text || this.failed || this.closed) return;
    // Only open TTS streams once the start-up check has passed: without valid
    // credentials the Google client throws outside our handlers.
    if (ttsHealthy !== true) { this._fail(ttsHealthy === false ? 'Cloud Text-to-Speech is not available' : 'Cloud Text-to-Speech start-up check has not finished'); return; }
    try {
      this._ensureCall().write({ input: { text } });
    } catch (err) {
      this._fail(`TTS write failed: ${err.message}`);
      return;
    }
    this._armIdle();
    if (!this.gotAudio && !this.firstAudioTimer) {
      this.firstAudioTimer = setTimeout(() => {
        if (!this.gotAudio) this._fail(`no audio from Cloud Text-to-Speech within ${FIRST_AUDIO_TIMEOUT_MS / 1000} s`);
      }, FIRST_AUDIO_TIMEOUT_MS);
    }
  }

  _ensureCall() {
    if (this.call) return this.call;
    const call = getClient().streamingSynthesize();
    this.call = call;
    call.on('data', (res) => {
      if (res.audioContent && res.audioContent.length && !this.closed) {
        if (!this.gotAudio) { this.gotAudio = true; clearTimeout(this.firstAudioTimer); console.log(`[fixedVoice] ${this.label}: speaking with ${this.voiceName}`); }
        this.onAudio(Buffer.from(res.audioContent), OUTPUT_RATE);
      }
    });
    call.on('error', (err) => {
      if (this.call === call) this.call = null;
      // Code 1 = cancelled by us; idle/deadline closes just mean "open a new one next time".
      if (err.code === 1 || /idle|deadline|timeout/i.test(err.message)) return;
      // Any error before the first audio means TTS isn't usable here (API off,
      // missing credentials, unknown voice): fall back so the call isn't silent.
      if (!this.gotAudio || /PERMISSION|not been used|disabled|NOT_FOUND|INVALID_ARGUMENT|credentials/i.test(err.message)) this._fail(err.message);
      else console.warn(`[fixedVoice] ${this.label}: TTS stream error: ${err.message}`);
    });
    call.on('end', () => { if (this.call === call) this.call = null; });
    call.write({
      streamingConfig: {
        voice: { name: this.voiceName, languageCode: this.locale },
        streamingAudioConfig: { audioEncoding: 'PCM', sampleRateHertz: OUTPUT_RATE },
      },
    });
    return call;
  }

  _armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this._endCall(), STREAM_IDLE_MS);
  }

  _endCall() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const call = this.call;
    this.call = null;
    if (call) { try { call.end(); } catch (_) {} }
  }

  close() {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    clearTimeout(this.firstAudioTimer);
    this._endCall();
  }
}

// One check at server start, so the log says plainly whether fixed voice works.
function selfTest() {
  if (!FIXED_VOICE) { console.log('[fixedVoice] off (TRANSLATION_VOICE=gemini): calls use Gemini\'s own voice'); return; }
  if (!TextToSpeechClient) { console.warn('[fixedVoice] NOT WORKING: @google-cloud/text-to-speech is not installed. Run: cd backend && npm install'); return; }
  // getProjectId() first: without credentials, calling listVoices directly
  // throws inside the Google client and would crash the server.
  let c;
  try { c = getClient(); } catch (err) { ttsHealthy = false; console.warn(`[fixedVoice] NOT WORKING: ${err.message}`); return; }
  Promise.resolve().then(() => c.getProjectId())
    .then(() => c.listVoices({ languageCode: 'en-US' }))
    .then(([res]) => {
      ttsHealthy = true;
      const n = (res.voices || []).filter((v) => /Chirp3-HD/.test(v.name)).length;
      console.log(`[fixedVoice] ready: Cloud Text-to-Speech reachable (${n} Chirp 3 HD en-US voices)`);
    })
    .catch((err) => { ttsHealthy = false; console.warn(`[fixedVoice] NOT WORKING, calls will use Gemini's own voice: ${err.message}\n  -> enable "Cloud Text-to-Speech API" in the Google Cloud project and check the service account credentials`); });
}
if (process.env.NODE_ENV !== 'test') selfTest();

module.exports = { FixedVoiceSpeaker, FIXED_VOICE, TTS_LOCALES };
