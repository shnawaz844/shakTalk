require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Load GCP service account credentials from env var (for Render deployment).
// Set GOOGLE_APPLICATION_CREDENTIALS_JSON to the full JSON contents of your key file.
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    const credPath = path.join(os.tmpdir(), 'gcp-credentials.json');
    fs.writeFileSync(credPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
    console.log('[geminiService] GCP credentials loaded from env var.');
  } catch (err) {
    console.error('[geminiService] Failed to write GCP credentials:', err.message);
  }
}

// ── Startup diagnostic: verify credentials file is readable ─────────────────
const credFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credFile) {
  try {
    const stat = fs.statSync(credFile);
    const raw = fs.readFileSync(credFile, 'utf8');
    const parsed = JSON.parse(raw);
    console.log(`[geminiService] ✅ Credentials file OK: ${credFile} (${stat.size} bytes, project=${parsed.project_id}, client_email=${parsed.client_email})`);
  } catch (err) {
    console.error(`[geminiService] ❌ Credentials file UNREADABLE at "${credFile}":`, err.message);
  }
} else {
  console.error('[geminiService] ❌ GOOGLE_APPLICATION_CREDENTIALS is not set!');
}

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

if (!project) {
  console.error('[geminiService] GOOGLE_CLOUD_PROJECT is not set!');
  process.exit(1);
}

console.log(`[geminiService] Initializing Vertex AI: project=${project}, location=${location}`);

const ai = new GoogleGenAI({
  vertexai: true,
  project,
  location,
});

// Overridable for A/B testing candidate models against the current one
// without editing code each time — unset falls back to the model already
// proven in production.
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-live-2.5-flash-native-audio';

// Sample rate the client streams raw PCM at (must match src streaming recorder config).
const INPUT_SAMPLE_RATE = 16000;
// Sample rate Gemini Native Audio outputs.
const OUTPUT_SAMPLE_RATE = 24000;

// BCP-47 codes for the app's language picker (src/config.ts LANGUAGES) — used
// only as a hint to Gemini's speech transcription (AudioTranscriptionConfig.
// languageCodes), never to restrict which languages the app handles. Without
// a hint, the model auto-detects the transcription's language/script per
// utterance, which is what let the "original" transcript text occasionally
// come back in the wrong script (e.g. Hindi speech rendered in Devanagari
// even for an English-language session). Any language name not in this map
// simply keeps the old auto-detect behavior — new languages don't need to be
// added here to work, this only makes existing ones more accurate.
const LANGUAGE_NAME_TO_BCP47 = {
  English: 'en-US',
  Hindi: 'hi-IN',
  Urdu: 'ur-PK',
  Mandarin: 'zh-CN',
  Cantonese: 'zh-HK',
  Arabic: 'ar-SA',
  'Arabic (Standard)': 'ar',
  'Arabic (Saudi)': 'ar-SA',
  'Arabic (UAE)': 'ar-AE',
  'Arabic (Qatar)': 'ar-QA',
  'Arabic (Kuwait)': 'ar-KW',
  'Arabic (Oman)': 'ar-OM',
  'Arabic (Bahrain)': 'ar-BH',
  Spanish: 'es-ES',
  French: 'fr-FR',
  German: 'de-DE',
  Russian: 'ru-RU',
  Ukrainian: 'uk-UA',
};

function bcp47For(languageName) {
  return LANGUAGE_NAME_TO_BCP47[languageName];
}

const SCRIPT_RANGES = {
  Hindi: /[ऀ-ॿ]/u,
  Arabic: /[؀-ۿ]/u,
  'Arabic (Standard)': /[؀-ۿ]/u,
  'Arabic (Saudi)': /[؀-ۿ]/u,
  'Arabic (UAE)': /[؀-ۿ]/u,
  'Arabic (Qatar)': /[؀-ۿ]/u,
  'Arabic (Kuwait)': /[؀-ۿ]/u,
  'Arabic (Oman)': /[؀-ۿ]/u,
  'Arabic (Bahrain)': /[؀-ۿ]/u,
  Urdu: /[؀-ۿ]/u,
  Mandarin: /[一-鿿]/u,
  Cantonese: /[一-鿿]/u,
  English: /[A-Za-z]/u,
  Spanish: /[A-Za-z]/u,
  French: /[A-Za-z]/u,
  German: /[A-Za-z]/u,
  Russian: /[\u0400-\u04FF]/u,
  Ukrainian: /[\u0400-\u04FF]/u,
};

// Common romanized/Hinglish words (Hindi spoken in Latin letters)
const HINGLISH_WORDS = new Set([
  'kya', 'kar', 'rahe', 'raha', 'rahi', 'ho', 'hai', 'hain', 'nahi', 'nahin',
  'main', 'mai', 'hum', 'aap', 'tum', 'kaise', 'kaisa', 'kaisi', 'kahan',
  'kidhar', 'kab', 'kyun', 'kyu', 'baat', 'suno', 'bolo', 'achha', 'accha',
  'thik', 'theek', 'haan', 'bhai', 'yaar', 'namaste', 'shukriya', 'samajh',
  'gaya', 'gayi', 'gaye', 'hoga', 'hogi', 'honge', 'tha', 'thi', 'the',
  'chal', 'chalo', 'karo', 'kiya', 'karenge', 'batao', 'dekho', 'pata',
  'mujhe', 'tumhe', 'unhe', 'unko', 'uska', 'unka', 'mera', 'meri', 'mere',
  'apna', 'apni', 'apne', 'kuch', 'sab', 'aur', 'par', 'bhi', 'bahut',
  'kare', 'bolo', 'sunte', 'shuru', 'khatam', 'wala', 'wali', 'wale'
]);

// Common English stopwords and grammatical markers (Latin letters)
const ENGLISH_WORDS = new Set([
  'the', 'is', 'are', 'am', 'was', 'were', 'have', 'has', 'had', 'having',
  'do', 'does', 'did', 'done', 'doing',
  'you', 'your', 'yours', 'my', 'mine', 'me', 'we', 'our', 'ours', 'us',
  'they', 'them', 'their', 'theirs', 'he', 'him', 'his', 'she', 'her', 'hers',
  'it', 'its', 'this', 'that', 'these', 'those',
  'what', 'whats', 'why', 'when', 'where', 'how', 'who', 'whom', 'which',
  'can', 'could', 'will', 'would', 'shall', 'should', 'must', 'might',
  'and', 'but', 'or', 'so', 'if', 'because', 'with', 'for', 'from', 'to', 'of', 'at', 'in', 'on', 'about', 'also',
  'yes', 'no', 'not', 'please', 'thanks', 'thank', 'sorry', 'welcome', 'hello', 'hi', 'hey',
  'speaking', 'talking', 'listening', 'audible', 'hear', 'hearing', 'call', 'calling',
  'there', 'here', 'just', 'nothing', 'something', 'anything', 'everything',
  'know', 'knowing', 'think', 'thinking', 'want', 'going', 'come', 'coming', 'understand',
  'fine', 'good', 'morning', 'night', 'work', 'working', 'right'
]);

// English words phonetically transliterated into Devanagari by Gemini's native audio model
// when an English speaker speaks into a Hindi session.
// Unlike Hindi loan nouns (like "car", "phone", "train"), these are English grammatical words,
// question words, pronouns, auxiliary verbs, and conversational expressions that NEVER form
// a grammatical Hindi sentence unless the speaker is actually speaking English.
const DEVANAGARI_ENGLISH_GRAMMAR_WORDS = new Set([
  // Question words
  'व्हाट', 'वाट', 'व्हाट्स', 'वाट्स', 'व्हाय', 'वाई', 'व्हेन', 'वेन', 'वेयर', 'वेर', 'हाउ', 'हू', 'विच',
  // Pronouns
  'यू', 'योअर', 'योर', 'माय', 'माई', 'मी', 'आय', 'आई', 'वी', 'दे', 'ही', 'शी', 'इट', 'इट्स', 'अस', 'देम', 'हिम',
  // Auxiliary & Be verbs
  'इज़', 'इज', 'आर', 'एम', 'ऐम', 'वॉज़', 'वाज', 'वर', 'बीन', 'बी',
  'डू', 'डज़', 'डज', 'डिड', 'डन', 'डूइंग', 'डुइंग',
  'हैव', 'हैज़', 'हैज', 'हैड', 'हैविंग',
  'कैन', 'कुड', 'विल', 'वुड', 'शुड', 'मस्ट', 'माइट',
  // Prepositions & Conjunctions
  'एंड', 'बट', 'बिकॉज़', 'बिकॉज', 'विथ', 'विद', 'फॉर', 'फ्रॉम', 'टू', 'ऑफ', 'अबाउट', 'ऑल्सो', 'आलसो',
  // Conversational markers & verbs
  'हेलो', 'हैलो', 'हाय', 'ओके', 'यस', 'नो', 'नॉट', 'प्लीज', 'प्लीज़', 'थैंक', 'थैंक्स', 'सॉरी', 'वेलकम',
  'स्पीक', 'स्पीकिंग', 'लिसन', 'लिसनिंग', 'हियर', 'हियरिंग', 'टॉक', 'टॉकिंग', 'टेल', 'टेलिंग',
  'नो', 'नोइंग', 'थिंक', 'थिंकिंग', 'वांट', 'गोइंग', 'कमिंग',
  'ऑडिबल', 'ऑडीबल', 'अंडरस्टैंड', 'फाइन', 'गुड', 'मॉर्निंग', 'नाइट',
  'देयर', 'हियर', 'दिस', 'दैट', 'दीज़', 'दोज़', 'नथिंग', 'समथिंग', 'एनीथिंग', 'एवरीथिंग',
  // Very common phonetic transliterations in user speech turns
  'ऑफीस', 'ऑफिस', 'ऑफ़िस'
]);

/**
 * Returns true if the spoken text or translation indicates that the speaker
 * spoke in a different language than expected (e.g. speaking Hindi when English
 * was selected, or speaking English when Hindi was selected).
 */
function isLanguageMismatch(originalText, translatedText, inputLang, outputLang) {
  if (!originalText && !translatedText) return false;

  const orig = (originalText || '').trim();
  const trans = (translatedText || '').trim();

  // If input and output language are identical (e.g. English->English), no cross-language mismatch
  if (inputLang.toLowerCase() === outputLang.toLowerCase()) return false;

  // ── 1. SCRIPT MISMATCH CHECK ─────────────────────────────────────────────
  const inputPattern = SCRIPT_RANGES[inputLang];
  if (inputPattern) {
    const origLetters = (orig.match(/[\p{L}\p{M}]/gu) || []).length;
    if (origLetters >= 4) {
      const expectedMatches = (orig.match(new RegExp(inputPattern.source, 'gu')) || []).length;
      // If expected script is < 30% of total letters, check if another script dominates
      if (expectedMatches < origLetters * 0.30) {
        for (const [lang, pat] of Object.entries(SCRIPT_RANGES)) {
          if (lang === inputLang || pat.source === inputPattern.source) continue;
          const otherMatches = (orig.match(new RegExp(pat.source, 'gu')) || []).length;
          if (otherMatches >= origLetters * 0.50) {
            console.log(`[isLanguageMismatch] 🛑 Script mismatch: Expected ${inputLang} (${expectedMatches}/${origLetters} letters), but input "${orig}" matches ${lang} (${otherMatches}/${origLetters} letters)`);
            return true;
          }
        }
      }
    }
  }

  // ── 2. ENGLISH SESSION RECEIVING HINDI / DEVANAGARI OR OTHER SCRIPTS ────
  if (inputLang === 'English') {
    if (/[ऀ-ॿ]/u.test(orig)) {
      console.log(`[isLanguageMismatch] 🛑 Devanagari script detected in English session: "${orig}"`);
      return true;
    }
    if (/[؀-ۿ]/u.test(orig)) {
      console.log(`[isLanguageMismatch] 🛑 Arabic/Urdu script detected in English session: "${orig}"`);
      return true;
    }
    if (/[\u0400-\u04FF]/u.test(orig)) {
      console.log(`[isLanguageMismatch] 🛑 Cyrillic script detected in English session: "${orig}"`);
      return true;
    }
    if (/[一-鿿]/u.test(orig)) {
      console.log(`[isLanguageMismatch] 🛑 Chinese script detected in English session: "${orig}"`);
      return true;
    }

    // ── 3. ENGLISH SESSION RECEIVING ROMANIZED HINDI (HINGLISH) ───────────
    const words = orig.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
    if (words.length >= 3) {
      let hinglishCount = 0;
      for (const w of words) {
        if (HINGLISH_WORDS.has(w)) hinglishCount++;
      }
      const ratio = hinglishCount / words.length;
      if ((words.length === 3 && hinglishCount >= 2 && ratio >= 0.60) ||
          (words.length >= 4 && hinglishCount >= 3 && ratio >= 0.35)) {
        console.log(`[isLanguageMismatch] 🛑 Romanized Hindi (Hinglish) detected in English session (${hinglishCount}/${words.length} words, ratio=${Math.round(ratio * 100)}%): "${orig}"`);
        return true;
      }
    }
  }

  // ── 4. HINDI SESSION RECEIVING ENGLISH (LATIN OR PHONETIC DEVANAGARI) ─────
  if (inputLang === 'Hindi') {
    // Note: \\p{M} preserves Devanagari matras (vowel signs like ू , ी , े) and halants (्)
    const tokens = orig.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      let englishCount = 0;
      for (const tok of tokens) {
        if (ENGLISH_WORDS.has(tok) || DEVANAGARI_ENGLISH_GRAMMAR_WORDS.has(tok)) {
          englishCount++;
        }
      }
      const ratio = englishCount / tokens.length;
      // 2-word phrase: both must be English (e.g. "व्हाट आर", "what are", "कैन यू")
      // 3+ words: >= 2 English words AND >= 35% ratio (e.g. "ऑफीस व्हाट आर यू डूइंग?" -> 5/5 = 100%)
      const isEnglish = (tokens.length === 2 && englishCount === 2) ||
                        (tokens.length >= 3 && englishCount >= 2 && ratio >= 0.35);
      if (isEnglish) {
        console.log(`[isLanguageMismatch] 🛑 English speech detected in Hindi session (${englishCount}/${tokens.length} words, ratio=${Math.round(ratio * 100)}%): "${orig}"`);
        return true;
      }
    }
  }

  // ── 5. PASSTHROUGH / ECHO CHECK ──────────────────────────────────────────
  if (orig.length >= 4 && trans.length >= 4) {
    const cleanO = orig.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
    const cleanT = trans.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
    if (cleanO === cleanT) {
      console.log(`[isLanguageMismatch] 🛑 Identical input/output detected ("${orig}" === "${trans}")`);
      return true;
    }
  }

  return false;
}

/**
 * Wraps raw PCM data in a WAV header so the audio can be played/stored easily.
 */
function wrapPcmInWav(pcmBuffer, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;

  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  pcmBuffer.copy(buffer, 44);

  return buffer;
}

/**
 * A persistent Gemini Live session for a specific translation direction.
 *
 * Unlike a request/response API, this stays open for the entire call.
 * Audio is fed in continuously via feedAudio() and Gemini's own
 * automaticActivityDetection decides where speech turns start/end
 * (realtimeInputConfig below) — the server no longer decides "this is
 * one sentence" itself. Output audio/text arrives incrementally as
 * serverContent.modelTurn parts and is streamed out via onAudioChunk
 * as soon as each part arrives, rather than buffered until turnComplete.
 */
class LiveTranslationSession {
  constructor(inputLang, outputLang, voiceProfile = {}, callbacks = {}) {
    this.inputLang = inputLang;
    this.outputLang = outputLang;
    this.voiceProfile = voiceProfile; // { gender?: string, age?: number }
    this.callbacks = callbacks; // { onAudioChunk, onTurnComplete, onError }

    this.session = null;
    this.isConnecting = false;
    this.connectPromise = null;
    this.closedByUs = false;

    // Heartbeat: send silent PCM every KEEPALIVE_INTERVAL_MS while the session
    // is open and idle (no speech). Gemini Live closes idle connections after
    // ~60s without input — the keepalive prevents that timeout so translation
    // resumes correctly after a long pause in conversation.
    this._keepaliveTimer = null;
    this._lastFeedAt = 0;

    this._resetTurnState();
  }

  _resetTurnState() {
    // Output (Gemini's spoken translation) accumulated for the in-flight turn.
    this.outputAudioBuffers = [];
    this.fullTranslationText = '';
    this.fullOriginalText = '';
    this.audioChunkIndex = 0;
    // Input (the speaker's raw audio) accumulated for the in-flight turn,
    // so it can be persisted alongside the translation once the turn ends.
    // NOTE: reset on each turn, not across reconnects — see feedAudio below.
    this.inputAudioBuffers = [];
    // Latency-diagnostic bookkeeping for the in-flight turn (see feedAudio/_onMessage).
    this.turnId = null;
    this.turnFirstChunkAt = null;
    this.turnLastChunkAt = null;
    this.turnMaxGapMs = 0;
    // In-flight audio burst accumulator for low-latency streaming without jitter.
    this.inFlightBurstBuffers = [];
    this.inFlightBurstBytes = 0;
    this.turnSuppressed = false;
  }

  _suppressCurrentTurn(reason = '') {
    if (this.turnSuppressed) return;
    this.turnSuppressed = true;
    this.inFlightBurstBuffers = [];
    this.inFlightBurstBytes = 0;
    this.outputAudioBuffers = [];
    if (reason) {
      console.log(`[LiveTranslationSession] 🛑 Turn ${this.turnId || 'active'} suppressed (${this.inputLang}→${this.outputLang}): ${reason}`);
    }
    if (this.callbacks.onSuppressed) {
      this.callbacks.onSuppressed({ turnId: this.turnId });
    }
  }

  // ── Keepalive heartbeat ───────────────────────────────────────────────────
  // Gemini Live closes idle WebSocket connections after approximately 60s of
  // no audio input. If both users are silent for a while (e.g. one finishes
  // speaking, the other is listening to the translation, then neither speaks
  // for >30s) the session gets torn down server-side. The next time the
  // speaker opens their mouth, feedAudio → ensureConnected triggers a fresh
  // connect, but that costs ~1-2s and the speaker's first words are dropped.
  //
  // Fix: while the session is open and the last real audio feed was >20s ago,
  // send one 200ms block of silent PCM. This counts as "activity" on the
  // Gemini side and resets its idle timer without triggering any turn or
  // output — silence at Gemini's VAD threshold is a no-op for translation.
  static get KEEPALIVE_INTERVAL_MS() { return 20000; } // check every 20s
  static get KEEPALIVE_IDLE_THRESHOLD_MS() { return 20000; } // send if idle >20s

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      this._sendKeepaliveIfNeeded();
    }, LiveTranslationSession.KEEPALIVE_INTERVAL_MS);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  _sendKeepaliveIfNeeded() {
    if (!this.session || this.closedByUs) return;
    const idleMs = Date.now() - this._lastFeedAt;
    if (idleMs < LiveTranslationSession.KEEPALIVE_IDLE_THRESHOLD_MS) return;

    try {
      // 200ms of silent 16-bit PCM @ 16kHz (16000 * 0.2 * 2 = 6400 bytes, all zeros)
      const silentPcm = Buffer.alloc(6400, 0);
      const silentBase64 = silentPcm.toString('base64');
      if (typeof this.session.sendRealtimeInput === 'function') {
        this.session.sendRealtimeInput({
          audio: { data: silentBase64, mimeType: 'audio/pcm;rate=16000' },
        });
        console.log(`[LiveTranslationSession] Keepalive sent (${this.inputLang}→${this.outputLang}), idleMs=${idleMs}`);
      }
    } catch (err) {
      console.warn(`[LiveTranslationSession] Keepalive failed (${this.inputLang}→${this.outputLang}):`, err.message);
    }
  }

  _emitBurst(force = false) {
    if (this.inFlightBurstBuffers.length === 0) return;

    if (this.turnSuppressed) {
      // Already suppressed — drain buffers silently without re-checking mismatch
      this.inFlightBurstBuffers = [];
      this.inFlightBurstBytes = 0;
      return;
    }

    // Cross-talk and language mismatch checks before emitting any burst.
    // Only check if we have enough original text to make a reliable decision (>= 3 chars).
    const origLen = (this.fullOriginalText || '').trim().length;
    if (origLen >= 3 && isLanguageMismatch(this.fullOriginalText, this.fullTranslationText, this.inputLang, this.outputLang)) {
      this._suppressCurrentTurn(`Burst check mismatch: input="${(this.fullOriginalText || '').trim()}", output="${(this.fullTranslationText || '').trim()}"`);
      return;
    }

    // CRITICAL: Gate chunk 0 so we NEVER leak wrong-language audio before input speech is verified!
    // For the very first burst of a turn, hold it in buffer until we have at least 2 characters
    // of transcribed input text (or until force=true at turnComplete).
    if (!force && this.audioChunkIndex === 0 && this.inputLang.toLowerCase() !== this.outputLang.toLowerCase()) {
      const textLen = (this.fullOriginalText || '').trim().length;
      if (textLen < 2 && this.inFlightBurstBytes < 36000) {
        // Hold in buffer until input transcription arrives (typically 50-100ms)
        return;
      }
    }

    // Minimum burst size:
    // First burst: ~200ms (9,600 bytes @ 24kHz 16-bit mono) for fast startup without audio buffer starvation.
    // Subsequent bursts: ~300ms (14,400 bytes) to maintain a healthy jitter buffer.
    const minBytes = this.audioChunkIndex === 0 ? 9600 : 14400;
    if (!force && this.inFlightBurstBytes < minBytes) return;

    const burstPcm = Buffer.concat(this.inFlightBurstBuffers);
    this.inFlightBurstBuffers = [];
    this.inFlightBurstBytes = 0;

    const wav = wrapPcmInWav(burstPcm, OUTPUT_SAMPLE_RATE);
    if (this.callbacks.onAudioChunk) {
      this.callbacks.onAudioChunk({
        audioBase64: wav.toString('base64'),
        index: this.audioChunkIndex++,
        text: this.fullTranslationText.trim(),
        turnId: this.turnId,
      });
    }
  }

  _buildVoiceName() {
    const { gender } = this.voiceProfile;
    // Gemini Live API prebuilt voices are discrete IDs, not a pitch/age
    // continuum, and Google doesn't publish per-voice age characteristics —
    // so gender picks the voice ID, and age instead shapes delivery via the
    // system prompt (see _buildAgeInstruction), which native-audio models
    // can actually act on since they synthesize speech generatively rather
    // than picking from a fixed recorded bank.
    if (gender === 'male') return 'Puck';
    if (gender === 'female') return 'Aoede';
    return 'Aoede'; // neutral fallback
  }

  _buildAgeInstruction() {
    const { age } = this.voiceProfile;
    if (typeof age !== 'number') return '';
    let bracket;
    if (age < 13) bracket = 'young child';
    else if (age < 18) bracket = 'teenager';
    else if (age < 30) bracket = 'young adult in their twenties';
    else if (age < 45) bracket = 'adult in their thirties or early forties';
    else if (age < 60) bracket = 'middle-aged adult in their forties or fifties';
    else bracket = 'senior adult over sixty';
    return ` Your spoken delivery should match the natural pitch, cadence, and energy of a ${bracket} — do not change the translated words themselves, only how they sound.`;
  }

  _buildConfig() {
    const voiceName = this._buildVoiceName();
    const ageInstruction = this._buildAgeInstruction();
    const inputCode = bcp47For(this.inputLang);
    const outputCode = bcp47For(this.outputLang);
    const isSameLanguage = this.inputLang.toLowerCase() === this.outputLang.toLowerCase();

    const systemPromptText = isSameLanguage
      ? `You are an audio relay pipe facilitating a live phone call between two callers who both speak ${this.inputLang}. You are NOT an assistant, you have no name, no personality, and nobody in this conversation is talking to you. Audio comes in from a speaker who speaks ${this.inputLang}; output the exact same spoken content clearly in ${this.outputLang}, maintaining high voice clarity and natural delivery.${ageInstruction}

CRITICAL RULES:
1. ONLY relay speech that is clearly spoken in ${this.inputLang}. If speech is in another language, or is background noise/coughing/silence, output ABSOLUTELY NOTHING.
2. Speak the exact words clearly and naturally. Never add, omit, or modify what was spoken.
3. Never answer questions or add commentary. If a question is asked, relay the question itself so the other caller can answer.
4. Never introduce yourself, acknowledge instructions, or say filler words like "sure" or "okay".
5. Preserve all pronouns (I, you, we, they) exactly.
6. CRITICAL: Do NOT repeat previous sentences. Only process new speech from the current turn. Never loop or replay earlier turns.`
      : `You are a strict, real-time speech translation pipe for a live phone call between two callers.
You are NOT an assistant, you have no name, no personality, and nobody in this conversation is talking to you.
The speaker on this channel speaks ONLY ${this.inputLang}.
The listener on the other end speaks and understands ${this.outputLang}.
Your ONLY job is to translate speech spoken in ${this.inputLang} into ${this.outputLang}.${ageInstruction}

ABSOLUTE RULES (MANDATORY):
1. STRICT INPUT LANGUAGE FILTER (ZERO TOLERANCE FOR OTHER LANGUAGES):
   - You MUST ONLY translate speech that is spoken in ${this.inputLang}.
   - The two callers are on a phone call, NOT in the same room. This channel receives ONLY the mic input from a ${this.inputLang} speaker.
   - If the audio contains speech in ${this.outputLang} or ANY language other than ${this.inputLang}, you MUST OUTPUT ABSOLUTELY NOTHING. Remain completely silent (zero words, zero audio).
   - If the speaker speaks in ${this.outputLang}, DO NOT output anything. Never translate ${this.outputLang} into ${this.outputLang}.
   - If the audio contains background noise, static, breathing, coughing, or unclear speech, output ABSOLUTELY NOTHING.

2. SPEAKER ECHO / LOUDSPEAKER BLEED — ABSOLUTE SILENCE RULE:
   - The phone may have previously played a ${this.outputLang} translation through its loudspeaker.
   - If you hear audio that sounds like ${this.outputLang} speech bleeding through from the phone's speaker or room echo, you MUST OUTPUT ABSOLUTELY NOTHING.
   - Any ${this.outputLang} audio in the input is ALWAYS loudspeaker bleed or echo — NEVER the designated speaker talking. Ignore it completely.

3. ACCURATE TRANSLATION INTO ${this.outputLang}:
   - When clear speech is spoken in ${this.inputLang}, translate every word faithfully and naturally into ${this.outputLang}.
   - Your output language is FIXED as ${this.outputLang}. Speak clearly and naturally.
   - STRICT FULL TRANSLATION: Translate the complete sentence without omitting, skipping, or summarizing.

4. PREVENT ECHO AND REPETITION:
   - NEVER repeat, replay, or loop sentences from earlier turns.
   - Only translate fresh, new speech spoken in the current turn.

5. NO ASSISTANT BEHAVIOR:
   - You are not a party to this call. Never answer questions, never say greetings, and never say filler words like "Sure", "Okay", or "Translating".
   - If the speaker asks a question (e.g. "Can you hear me?"), translate the question into ${this.outputLang} so the listener can answer it.
   - Preserve all pronouns (I, you, we, they) and perspective exactly as intended by the speaker.
   - Translate only what was actually spoken. Never invent, extend, or imagine extra words.`;

    return {
      model: LIVE_MODEL,
      config: {
        systemInstruction: {
          parts: [{
            text: systemPromptText
          }]
        },
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName
            }
          }
        },
        outputAudioTranscription: outputCode ? { languageCodes: [outputCode] } : {},
        // Providing a language hint for input transcription speeds up Gemini's
        // speech recognition and reduces first-chunk latency significantly.
        // Without a hint, Gemini must auto-detect the language before transcribing,
        // which caused 1400ms+ first-chunk latency on the English (iOS) side in logs.
        // The system prompt's absolute output-language lock (Rule 1) prevents
        // wrong-language output regardless of what language the speaker actually uses.
        inputAudioTranscription: inputCode ? { languageCodes: [inputCode] } : {},
        // Let Gemini's own server-side VAD decide turn boundaries instead of
        // relying on the client to guess when a sentence has ended.
        realtimeInputConfig: {
          automaticActivityDetection: {
            prefixPaddingMs: 300,
            // How long Gemini waits after speech ends before finalising the turn.
            // Increased to 1000ms: Hindi/Urdu speakers frequently pause mid-sentence
            // (for breathing, emphasis, or code-switching). 500ms was too aggressive
            // and caused multi-fragment turns with 17-22s VOICE_TO_PARTNER latency.
            // At 1000ms, complete sentences are captured in a single turn, and
            // Gemini translates them end-to-end — dramatically reducing total latency.
            silenceDurationMs: 1000,
          },
        },
      },
      callbacks: {
        onmessage: (data) => this._onMessage(data),
        onerror: (err) => this._onError(err),
        onclose: (e) => this._onClose(e),
      }
    };
  }

  _onMessage(data) {
    try {
      const msg = typeof data === 'string' || Buffer.isBuffer(data)
        ? JSON.parse(data.toString())
        : data;

      if (msg.serverContent && msg.serverContent.interrupted) {
        console.log(`[LiveTranslationSession] Turn interrupted (${this.inputLang}→${this.outputLang})`);
        const interruptedTurnId = this.turnId;
        this._resetTurnState();
        if (this.callbacks.onInterrupted) this.callbacks.onInterrupted({ turnId: interruptedTurnId });
        return;
      }

      if (msg.serverContent && msg.serverContent.modelTurn) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.text) {
            this.fullTranslationText += part.text;

            if (!this.turnSuppressed && isLanguageMismatch(this.fullOriginalText, this.fullTranslationText, this.inputLang, this.outputLang)) {
              this._suppressCurrentTurn(`ModelTurn mismatch: input="${(this.fullOriginalText || '').trim()}", output="${(this.fullTranslationText || '').trim()}"`);
            }

            if (!this.turnSuppressed && this.callbacks.onTranscriptionChunk) {
              this.callbacks.onTranscriptionChunk({
                turnId: this.turnId,
                originalText: this.fullOriginalText.trim(),
                translatedText: this.fullTranslationText.trim(),
              });
            }
          }
          if (part.inlineData) {
            if (this.turnSuppressed) break;

            const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
            this.outputAudioBuffers.push(pcmBuffer);

            const now = Date.now();
            if (!this.turnId) {
              this.turnId = `${now}-${Math.random().toString(36).slice(2, 7)}`;
              this.turnFirstChunkAt = now;
              this.turnMaxGapMs = 0;
              const sinceLastFeedMs = this.lastFeedAudioAt ? now - this.lastFeedAudioAt : null;
              console.log(`[LATENCY][server] Turn ${this.turnId} (${this.inputLang}->${this.outputLang}): first Gemini audio chunk, ${sinceLastFeedMs}ms since last input chunk fed`);
            } else if (this.turnLastChunkAt) {
              const gap = now - this.turnLastChunkAt;
              if (gap > this.turnMaxGapMs) this.turnMaxGapMs = gap;
            }
            this.turnLastChunkAt = now;

            // Stream audio immediately into burst queue for fast, uninterrupted playback
            this.inFlightBurstBuffers.push(pcmBuffer);
            this.inFlightBurstBytes += pcmBuffer.length;
            this._emitBurst(false);
          }
        }
      }

      if (msg.serverContent && msg.serverContent.outputTranscription) {
        if (msg.serverContent.outputTranscription.text) {
          this.fullTranslationText += msg.serverContent.outputTranscription.text;

          if (!this.turnSuppressed && isLanguageMismatch(this.fullOriginalText, this.fullTranslationText, this.inputLang, this.outputLang)) {
            this._suppressCurrentTurn(`OutputTranscription mismatch: input="${(this.fullOriginalText || '').trim()}", output="${(this.fullTranslationText || '').trim()}"`);
          }

          if (!this.turnSuppressed && this.callbacks.onTranscriptionChunk) {
            this.callbacks.onTranscriptionChunk({
              turnId: this.turnId,
              originalText: this.fullOriginalText.trim(),
              translatedText: this.fullTranslationText.trim(),
            });
          }
        }
      }

      if (msg.serverContent && msg.serverContent.inputTranscription) {
        if (msg.serverContent.inputTranscription.text) {
          // Accumulate the speaker's original (as-spoken) transcription text.
          this.fullOriginalText += msg.serverContent.inputTranscription.text;

          if (!this.turnSuppressed && isLanguageMismatch(this.fullOriginalText, this.fullTranslationText, this.inputLang, this.outputLang)) {
            this._suppressCurrentTurn(`InputTranscription mismatch: input="${(this.fullOriginalText || '').trim()}", output="${(this.fullTranslationText || '').trim()}"`);
          }

          // If language is verified and we have buffered chunks waiting, release them now!
          if (!this.turnSuppressed) {
            if (this.inFlightBurstBuffers.length > 0 && this.audioChunkIndex === 0) {
              this._emitBurst(false);
            }

            if (this.callbacks.onTranscriptionChunk) {
              this.callbacks.onTranscriptionChunk({
                turnId: this.turnId || `turn-${Date.now()}`,
                originalText: this.fullOriginalText.trim(),
                translatedText: this.fullTranslationText.trim(),
              });
            }
          }
        }
      }

      if (msg.serverContent && msg.serverContent.turnComplete) {
        if (!this.turnSuppressed && isLanguageMismatch(this.fullOriginalText, this.fullTranslationText, this.inputLang, this.outputLang)) {
          this._suppressCurrentTurn(`TurnComplete mismatch: input="${(this.fullOriginalText || '').trim()}", output="${(this.fullTranslationText || '').trim()}"`);
        }

        // Final flush of any remaining burst audio.
        this._emitBurst(true);

        const wasSuppressed = this.turnSuppressed;

        let translatedAudioBase64 = null;
        if (!wasSuppressed && this.outputAudioBuffers.length > 0) {
          translatedAudioBase64 = wrapPcmInWav(
            Buffer.concat(this.outputAudioBuffers), OUTPUT_SAMPLE_RATE
          ).toString('base64');
        }

        let originalAudioBase64 = null;
        if (this.inputAudioBuffers.length > 0) {
          originalAudioBase64 = wrapPcmInWav(
            Buffer.concat(this.inputAudioBuffers), INPUT_SAMPLE_RATE
          ).toString('base64');
        }

        if (this.turnId) {
          const streamDurationMs = this.turnFirstChunkAt ? Date.now() - this.turnFirstChunkAt : null;
          console.log(`[LATENCY][server] Turn ${this.turnId} (${this.inputLang}->${this.outputLang}): complete. chunks=${this.audioChunkIndex}, streamDurationMs=${streamDurationMs}, suppressed=${wasSuppressed}, input="${this.fullOriginalText.trim()}", output="${this.fullTranslationText.trim()}"`);
        }

        if (this.callbacks.onTurnComplete) {
          this.callbacks.onTurnComplete({
            originalText: this.fullOriginalText.trim(),
            translatedText: this.fullTranslationText.trim(),
            translatedAudioBase64,
            originalAudioBase64,
            turnId: this.turnId,
            suppressed: wasSuppressed,
          });
        }

        this._resetTurnState();
      }
    } catch (err) {
      console.error(`[LiveTranslationSession] onMessage error (${this.inputLang}→${this.outputLang}):`, err.message);
      if (this.callbacks.onError) this.callbacks.onError(err);
      this._resetTurnState();
    }
  }

  _onError(err) {
    console.error(`[LiveTranslationSession] Live session error (${this.inputLang}→${this.outputLang}):`, err);
    this.session = null; // Force reconnect on next feedAudio
    this.connectPromise = null; // Clear any in-flight connect promise so reconnect can start fresh
    this._stopKeepalive();
    if (this.callbacks.onError) this.callbacks.onError(err);
  }

  _onClose(e) {
    console.log(`[LiveTranslationSession] Session closed (${this.inputLang}→${this.outputLang}):`, e?.code, e?.reason);
    this.session = null; // Will reconnect lazily on next feedAudio, unless we closed it ourselves
    this.connectPromise = null; // Clear in-flight connect so ensureConnected can restart cleanly
    this._stopKeepalive();
    if (!this.closedByUs && e && e.code && e.code !== 1000 && this.callbacks.onError) {
      this.callbacks.onError(new Error(`Live session closed with code ${e.code}: ${e.reason || 'Unknown error'}`));
    }
  }

  /**
   * Ensure the Live API connection is open and ready.
   */
  async ensureConnected() {
    if (this.session) return;

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    console.log(`[LiveTranslationSession] Opening session (${this.inputLang}→${this.outputLang})...`);
    
    // Connect with a 10s timeout to prevent hanging forever on high-latency international connections
    const connectWithTimeout = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ai.live.connect timed out after 10000ms for ${this.inputLang}→${this.outputLang}`));
      }, 10000);

      ai.live.connect(this._buildConfig())
        .then((session) => {
          clearTimeout(timer);
          resolve(session);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });

    this.connectPromise = connectWithTimeout
      .then((session) => {
        this.session = session;
        this.connectPromise = null;
        this._lastFeedAt = Date.now(); // reset idle timer on fresh connect
        this._startKeepalive(); // start heartbeat to prevent idle timeout
        console.log(`[LiveTranslationSession] Session ready (${this.inputLang}→${this.outputLang})`);
      })
      .catch((err) => {
        this.connectPromise = null;
        throw err;
      });

    await this.connectPromise;
  }

  /**
   * Feed one small chunk of continuously-streamed raw PCM audio into the
   * session. Fire-and-forget from the caller's perspective — results come
   * back later via the onAudioChunk/onTurnComplete callbacks, not a return
   * value, since there's no per-chunk request/response boundary anymore.
   */
  async feedAudio(audioBase64, mimeType) {
    // Only accumulate input audio for the CURRENT turn — not across reconnects.
    // Pushing to inputAudioBuffers before ensureConnected means they grow
    // unboundedly if the session is dead and reconnects are slow/failing,
    // which eventually causes stalls. We accumulate after confirming the
    // session is alive instead, and cap the buffer to 30s of audio (~200
    // chunks @ 150ms) to prevent any runaway growth.
    const MAX_INPUT_BUFFERS = 200;

    this.lastFeedAudioAt = Date.now();
    this._lastFeedAt = Date.now(); // update idle timer for keepalive

    await this.ensureConnected();

    if (!this.session || typeof this.session.sendRealtimeInput !== 'function') {
      throw new Error('Live API connection is not available.');
    }

    // Accumulate after session is confirmed live, and cap to avoid unbounded growth.
    if (this.inputAudioBuffers.length < MAX_INPUT_BUFFERS) {
      this.inputAudioBuffers.push(Buffer.from(audioBase64, 'base64'));
    }

    this.session.sendRealtimeInput({ audio: { data: audioBase64, mimeType } });
  }

  /**
   * Gracefully close the session and free resources.
   */
  close() {
    this.closedByUs = true;
    this._stopKeepalive();
    if (this.session?.conn?.close) {
      this.session.conn.close();
    }
    this.session = null;
    this.connectPromise = null;
  }
}

/**
 * Per-call cache of persistent Gemini Live connections.
 * Key: `${sessionId}:${role}` → LiveTranslationSession
 */
const activeSessions = new Map();

/**
 * Open (and keep open for the whole call) a Live API session for a given
 * translation direction, wired up with callbacks for streamed output.
 *
 * @param {string} sessionId   - App session ID
 * @param {string} role        - 'host' or 'guest' (the SPEAKER's role)
 * @param {string} inputLang   - Speaker's language
 * @param {string} outputLang  - Listener's language
 * @param {object} voiceProfile - { gender?, age? }
 * @param {object} callbacks   - { onAudioChunk(chunk), onTurnComplete(result), onError(err) }
 */
async function warmupSession(sessionId, role, inputLang, outputLang, voiceProfile = {}, callbacks = {}) {
  const key = `${sessionId}:${role}`;
  if (activeSessions.has(key)) return; // Already warmed up

  const liveSession = new LiveTranslationSession(inputLang, outputLang, voiceProfile, callbacks);
  activeSessions.set(key, liveSession);

  try {
    await liveSession.ensureConnected();
    console.log(`[geminiService] Warmed up persistent session for ${role} in session ${sessionId}`);
  } catch (err) {
    console.error(`[geminiService] Warmup failed for ${role} in session ${sessionId}:`, err.message);
    // DO NOT delete from activeSessions! Keep liveSession so feedAudio can retry ensureConnected() lazily when speech begins.
  }
}

/**
 * Feed one streamed audio chunk from the client straight into the
 * persistent Gemini Live session for this session/role. Fire-and-forget —
 * translated output arrives later via the callbacks passed to warmupSession.
 */
function feedAudioChunk(sessionId, role, audioBase64, mimeType) {
  const key = `${sessionId}:${role}`;
  const liveSession = activeSessions.get(key);
  if (!liveSession) {
    console.warn(`[geminiService] No active session for ${role} in ${sessionId} — dropping chunk (not yet warmed up?)`);
    return;
  }
  liveSession.feedAudio(audioBase64, mimeType).catch((err) => {
    console.error(`[geminiService] feedAudio failed for ${role} in ${sessionId}:`, err.message);
    if (liveSession.callbacks.onError) liveSession.callbacks.onError(err);
  });
}

/**
 * Tear down the persistent Gemini Live session for a given app session/role.
 */
function closeSession(sessionId, role) {
  const key = `${sessionId}:${role}`;
  const liveSession = activeSessions.get(key);
  if (liveSession) {
    liveSession.close();
    activeSessions.delete(key);
    console.log(`[geminiService] Closed persistent session for ${role} in session ${sessionId}`);
  }
}

module.exports = { warmupSession, feedAudioChunk, closeSession, isLanguageMismatch };
