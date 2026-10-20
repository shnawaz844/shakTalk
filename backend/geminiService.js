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
// without editing code each time - unset falls back to the model already
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

/**
 * Returns true only when `text` is confidently written in a DIFFERENT,
 * script-distinguishable language than `expectedLang` — never for languages
 * that share a script (can't tell those apart) and never when there isn't
 * enough text yet to judge (biases toward letting audio through rather than
 * blocking real speech on a false positive).
 *
 * Used for BOTH:
 *  • Output-side: checking translated text (prevents wrong-language audio
 *    reaching the listener).
 *  • Input-side: checking the speaker's raw inputTranscription (proximity
 *    gate — prevents partner's leaked voice from being re-translated).
 */
function scriptMismatch(text, expectedLang) {
  const expectedPattern = SCRIPT_RANGES[expectedLang];
  if (!expectedPattern) return false;

  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters < 6) return false; // not enough signal yet

  if (expectedPattern.test(text)) return false; // has expected-script content — allow

  for (const [lang, pattern] of Object.entries(SCRIPT_RANGES)) {
    if (lang === expectedLang || pattern.source === expectedPattern.source) continue;
    const otherMatches = (text.match(new RegExp(pattern.source, 'gu')) || []).length;
    if (otherMatches >= letters * 0.6) return true; // confidently a different, distinguishable script
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
    this.isSameLanguage = (inputLang || '').toLowerCase() === (outputLang || '').toLowerCase();
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
      this.inFlightBurstBuffers = [];
      this.inFlightBurstBytes = 0;
      return;
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
      ? `You are an audio pipe facilitating a phone call between two callers who both speak ${this.inputLang}. You are NOT an assistant, you have no personality, and nobody in this conversation is talking to you. Audio comes in from a speaker who speaks ${this.inputLang}; output the exact same spoken content clearly in ${this.outputLang}, maintaining high voice clarity and natural delivery.${ageInstruction}

ABSOLUTE RULES:
1. Your output language is ${this.outputLang}. Speak the user's spoken words clearly and naturally in ${this.outputLang}.
2. STRICT FULL DELIVERY: Every word and sentence spoken by the user MUST be relayed completely and as it is. Never omit, drop, summarize, or truncate any part of what was spoken.
3. Never answer questions or add commentary. Output ONLY the exact content spoken by the user. If they ask a question, relay the question itself so the other caller can answer.
4. Never introduce yourself, acknowledge instructions, or say filler words like "sure", "okay", or "translating".
5. PRESERVE PERSPECTIVE EXACTLY. Keep all pronouns (I, you, we, they) exactly as intended by the speaker.
6. Ignore background noise, silence, coughing, or static — output nothing if no clear speech is present.
7. CRITICAL: Do NOT repeat previous sentences. Only process new speech since the last turn. Never loop or replay earlier turns.
8. NEVER extend or invent extra text beyond what was actually spoken.`
      : `You are a real-time speech translation pipe for a live phone call between two callers.
This microphone belongs ONLY to Caller A who speaks ${this.inputLang}.
Caller B on the other end of the call speaks ${this.outputLang}.
Your job is to translate Caller A's spoken ${this.inputLang} into ${this.outputLang}.${ageInstruction}

CRITICAL LANGUAGE ISOLATION & CROSS-TALK REJECTION:
1. ACCEPT ONLY ${this.inputLang}: You must ONLY accept and translate speech that is spoken in ${this.inputLang}.
2. REJECT ${this.outputLang} (CROSS-TALK & ECHO): If the audio received on this microphone contains speech in ${this.outputLang} (for example, if Caller B is in the same room or speakerphone audio leaks into this mic), you MUST COMPLETELY REJECT IT AND OUTPUT ABSOLUTELY NOTHING. Output total silence. Never translate or repeat speech that is already in ${this.outputLang}.
3. OUTPUT LANGUAGE IS ALWAYS ${this.outputLang}: When translating valid ${this.inputLang} speech, your output language must strictly be ${this.outputLang} — never anything else.
4. STRICT TRANSLATION: Every single word and phrase spoken in ${this.inputLang} MUST be translated faithfully into ${this.outputLang}. Never omit, drop, skip, or summarize.
5. NO CONVERSATIONAL REPLIES: You are an audio translation pipe, NOT a conversational assistant. Never answer questions or add conversational commentary — translate the words spoken so the listener can answer.
6. NO FILLER: Never introduce yourself or say filler words like "translating" or "sure". Output ONLY the translated words.
7. PRESERVE PERSPECTIVE: Keep all pronouns and conversational tone exactly as intended by the speaker.
8. NEVER REPEAT OR LOOP: Only translate new speech from the current turn. Never replay or repeat sentences from prior turns.
9. IGNORE NOISE: Ignore background noise, room reverberation, static, breathing, or coughing — output nothing if no clear speech is present.
10. NEVER EXTEND: Translate only the exact words spoken. Do not guess, hallucinate, or extend sentences.`;

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
            // 500ms balances snappy detection with not clipping natural mid-sentence
            // pauses (thinking, breathing, emphasis). 300ms was too aggressive for
            // Hindi speakers who frequently pause within sentences, causing word loss.
            silenceDurationMs: 500,
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
            // Skip live subtitle relay if gated or suppressed
            if (!this.inputLangGated && !this.turnSuppressed && this.callbacks.onTranscriptionChunk) {
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

          // Cross-talk proximity gate:
          // If the mic captures speech in a different script (e.g. English speech on a Hindi mic
          // or Hindi speech on an English mic), suppress the turn immediately!
          if (!this.isSameLanguage && scriptMismatch(this.fullOriginalText, this.inputLang)) {
            console.log(`[geminiService] 🛑 Cross-talk gate triggered (${this.inputLang}→${this.outputLang}): detected non-${this.inputLang} speech in mic ("${this.fullOriginalText}"). Suppressing turn.`);
            this.turnSuppressed = true;
            this.inFlightBurstBuffers = [];
            this.inFlightBurstBytes = 0;
            this.outputAudioBuffers = [];
          }

          // Immediately update live subtitle for self so the speaker sees their speech on screen without waiting for translation output!
          if (!this.turnSuppressed && this.callbacks.onTranscriptionChunk) {
            this.callbacks.onTranscriptionChunk({
              turnId: this.turnId || `turn-${Date.now()}`,
              originalText: this.fullOriginalText.trim(),
              translatedText: this.fullTranslationText.trim(),
            });
          }
        }
      }

      if (msg.serverContent && msg.serverContent.turnComplete) {
        if (this.turnSuppressed) {
          console.log(`[geminiService] Suppressed cross-talk turn completed — dropping without relay.`);
          this._resetTurnState();
          return;
        }

        // Final flush of any remaining burst audio.
        this._emitBurst(true);

        // NOTE: native-audio Live sessions are known to occasionally send a
        // premature turnComplete mid-sentence (see googleapis/js-genai#707,
        // googleapis/python-genai#2117). We can't fix that upstream bug here —
        // we just finalize with whatever we've accumulated and move on; the
        // persistent session stays open so the next turn is unaffected.
        let translatedAudioBase64 = null;
        if (this.outputAudioBuffers.length > 0) {
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
          console.log(`[LATENCY][server] Turn ${this.turnId} (${this.inputLang}->${this.outputLang}): complete. chunks=${this.audioChunkIndex}, streamDurationMs=${streamDurationMs}, maxInterChunkGapMs=${this.turnMaxGapMs}`);
        }

        if (this.callbacks.onTurnComplete) {
          this.callbacks.onTurnComplete({
            originalText: this.fullOriginalText.trim(),
            translatedText: this.fullTranslationText.trim(),
            translatedAudioBase64,
            originalAudioBase64,
            turnId: this.turnId,
            suppressed: false,
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

module.exports = { warmupSession, feedAudioChunk, closeSession };
