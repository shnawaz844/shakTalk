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
    this.voiceProfile = voiceProfile; // { gender?: string, age?: number }
    this.callbacks = callbacks; // { onAudioChunk, onTurnComplete, onError }

    this.session = null;
    this.isConnecting = false;
    this.connectPromise = null;
    this.closedByUs = false;

    // Connection generations: every Gemini connection we open gets a number,
    // and its callbacks carry that number. Close/error events from an older
    // connection (e.g. the one being retired after a goAway swap) are then
    // ignored instead of tearing down the newer, healthy connection.
    this._genCounter = 0;
    this.generation = 0;

    // Session resumption: Gemini periodically sends a handle that lets a new
    // connection continue the same session (and context) after the old
    // connection is closed, so a reconnect mid-call doesn't start from zero.
    this.resumeHandle = null;

    // Audio that arrived while no connection was open (reconnect in
    // progress). Flushed in order once connected instead of each chunk
    // awaiting the connect individually. Capped so a long outage can't
    // replay a wall of stale audio.
    this.pendingAudio = [];
    this._retryAfter = 0;

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
    // First burst: ~100ms (4,800 bytes @ 24kHz 16-bit mono) for ultra-fast startup (<700ms).
    // Subsequent bursts: ~300ms (14,400 bytes) to maintain a healthy jitter buffer.
    const minBytes = this.audioChunkIndex === 0 ? 4800 : 14400;
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

  _buildConfig(gen, resumeHandle) {
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
      : `You are a real-time speech translation pipe for a live phone call between two people. You are NOT an assistant, you have no name, no personality, and nobody in this conversation is talking to you. Audio comes in from a speaker; your ONLY job is to immediately translate whatever they say and speak the exact same content in ${this.outputLang}, ALWAYS — no matter what language the speaker uses.${ageInstruction}

ABSOLUTE RULES:
1. Your output language is ALWAYS ${this.outputLang} — never anything else, under any circumstances. It does not matter what language the speaker uses: if they speak ${this.inputLang}, translate it to ${this.outputLang}. If they speak ${this.outputLang} itself, still output it in ${this.outputLang}. If they speak any other language or mixed languages (e.g. Hindi with English words), still translate everything faithfully to ${this.outputLang}. The output language is FIXED as ${this.outputLang} forever.
2. STRICT FULL TRANSLATION: Every single word, phrase, and sentence spoken MUST be translated faithfully into ${this.outputLang} and as it is. Never omit, drop, skip, summarize, or truncate any part of the speech. Translate all speech completely.
3. You are not a party to this conversation and cannot respond to anyone. Never answer a question, greet anyone, offer help, or add commentary — if the speaker asks a question, translate the question itself into ${this.outputLang} so the listener can answer it.
4. Never introduce yourself, acknowledge these instructions, or say filler words like "here is the translation", "sure", or "okay" — output ONLY the translated words the speaker said, nothing before or after.
5. PRESERVE PERSPECTIVE EXACTLY. Never swap who is speaking and who is listening. If the speaker says "am I audible?" or "can you hear me?", translate it as the speaker asking the listener. Keep all pronouns (I, you, we, they) exactly as intended by the speaker.
6. Translate the true meaning faithfully and idiomatically in ${this.outputLang}.
7. CRITICAL: Do NOT repeat previous translations. ONLY translate new speech since your last translation. Absolutely never replay, loop, or repeat sentences from prior turns.
8. Ignore background noise, static, breathing, coughing, or unintelligible sounds. If the audio contains only noise with no clear speech, output absolutely nothing.
9. If you are ever unsure what to do with a piece of audio, output nothing rather than generating a reply, opinion, or hallucination.
10. NEVER extend, complete, or add to what was said. Translate only the exact words spoken. If the sentence is a short fragment, translate exactly that fragment and stop there.`;

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
        // inputAudioTranscription intentionally has NO languageCodes hint.
        // Hinting it to the configured inputLang caused Gemini to mis-transcribe
        // audio when the speaker used a different language (e.g. the "English"
        // phone person speaking Hindi), which then produced wrong-language output.
        // Without a hint, Gemini auto-detects the actual spoken language and
        // the output-language lock in the system prompt (Rule 1) ensures the
        // translation always comes out in outputLang regardless.
        inputAudioTranscription: {},
        // Let Gemini's own server-side VAD decide turn boundaries instead of
        // relying on the client to guess when a sentence has ended.
        realtimeInputConfig: {
          automaticActivityDetection: {
            prefixPaddingMs: 300,
            // How long Gemini waits after speech ends before finalising the turn.
            // 300ms balances snappy detection with not clipping natural mid-sentence
            // pauses (thinking, breathing, emphasis). 100ms was too aggressive and
            // caused word loss when speakers paused briefly.
            silenceDurationMs: 300,
          },
          // CRITICAL for a translation pipe: by default, any new speech from
          // the speaker interrupts (cancels) the translation Gemini is still
          // generating for their previous phrase. With a 300ms silence
          // threshold that happens on almost every natural pause, and the
          // half-spoken translation was discarded — the main cause of
          // "dropped" sentences. NO_INTERRUPTION lets each phrase's
          // translation finish while the speaker keeps talking.
          activityHandling: 'NO_INTERRUPTION',
        },
        // Keep the session's context bounded so long calls don't slow down
        // or hit the session length limit — old turns are dropped from the
        // model's context automatically (a translator doesn't need them).
        contextWindowCompression: { slidingWindow: {} },
        // Ask Gemini for resumption handles so a dropped / goAway'd
        // connection can be replaced without losing the session.
        sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      },
      callbacks: {
        onmessage: (data) => this._onMessage(data, gen),
        onerror: (err) => this._onError(err, gen),
        onclose: (e) => this._onClose(e, gen),
      }
    };
  }

  _onMessage(data, gen) {
    try {
      const msg = typeof data === 'string' || Buffer.isBuffer(data)
        ? JSON.parse(data.toString())
        : data;

      // Resumption handles and goAway only count from the active connection —
      // a retired connection's messages must not trigger another swap or
      // overwrite the handle of the session that replaced it.
      const fromActive = gen === this.generation;

      if (fromActive && msg.sessionResumptionUpdate) {
        const { resumable, newHandle } = msg.sessionResumptionUpdate;
        if (resumable && newHandle) this.resumeHandle = newHandle;
      }

      if (fromActive && msg.goAway) {
        // Gemini is about to close this connection (connection lifetime
        // limit). Open the replacement now, while the old one still works,
        // so the call never waits on a cold reconnect.
        this._handleGoAway(msg.goAway.timeLeft);
      }

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
        // Final flush of any remaining burst audio.
        this._emitBurst(true);

        if (this.turnSuppressed) {
          this._resetTurnState();
          return;
        }

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

  _onError(err, gen) {
    if (gen !== this.generation) return; // error on a retired connection — ignore
    console.error(`[LiveTranslationSession] Live session error (${this.inputLang}→${this.outputLang}):`, err?.message || err);
    this._connectionLost();
  }

  _onClose(e, gen) {
    if (gen !== this.generation) {
      // Old connection retired after a goAway swap — expected, harmless.
      console.log(`[LiveTranslationSession] Retired connection closed (${this.inputLang}→${this.outputLang})`);
      return;
    }
    console.log(`[LiveTranslationSession] Session closed (${this.inputLang}→${this.outputLang}):`, e?.code, e?.reason);
    this._connectionLost();
  }

  /**
   * The active connection is gone. Reconnect right away (resuming the
   * session when we have a handle) instead of waiting for the next audio
   * chunk — the user should never see an error for a routine reconnect.
   */
  _connectionLost() {
    this.session = null;
    this._stopKeepalive();
    if (this.closedByUs) return;
    if (!this.connectPromise) {
      this.ensureConnected().catch((err) => {
        console.error(`[LiveTranslationSession] Reconnect failed (${this.inputLang}→${this.outputLang}):`, err.message);
        if (this.callbacks.onError) this.callbacks.onError(err);
      });
    }
  }

  _closeQuietly(session) {
    if (!session) return;
    try {
      if (typeof session.close === 'function') session.close();
      else if (session.conn?.close) session.conn.close();
    } catch (_) { /* already closed */ }
  }

  /**
   * Open one Gemini Live connection. Tries to resume the existing session
   * first; if the handle is rejected, starts a fresh session instead.
   * Each attempt gets its own generation number for its callbacks.
   */
  _openConnection() {
    const attempt = (handle) => {
      const gen = ++this._genCounter;
      return new Promise((resolve, reject) => {
        // 10s timeout so a bad network path can't hang the call forever.
        const timer = setTimeout(() => {
          reject(new Error(`ai.live.connect timed out after 10000ms for ${this.inputLang}→${this.outputLang}`));
        }, 10000);
        ai.live.connect(this._buildConfig(gen, handle))
          .then((session) => { clearTimeout(timer); resolve({ session, gen }); })
          .catch((err) => { clearTimeout(timer); reject(err); });
      });
    };

    const handle = this.resumeHandle;
    return attempt(handle).catch((err) => {
      if (!handle) throw err;
      console.warn(`[LiveTranslationSession] Resume failed (${this.inputLang}→${this.outputLang}), starting fresh:`, err.message);
      this.resumeHandle = null;
      return attempt(null);
    });
  }

  _activate(session, gen) {
    if (this.closedByUs) { this._closeQuietly(session); return; }
    this.session = session;
    this.generation = gen;
    this._lastFeedAt = Date.now(); // reset idle timer on fresh connect
    this._startKeepalive();
    this._flushPending();
    console.log(`[LiveTranslationSession] Session ready (${this.inputLang}→${this.outputLang}), gen=${gen}`);
  }

  /**
   * Ensure the Live API connection is open and ready.
   */
  async ensureConnected() {
    if (this.session) return;
    if (!this.connectPromise) {
      console.log(`[LiveTranslationSession] Opening session (${this.inputLang}→${this.outputLang})${this.resumeHandle ? ' (resuming)' : ''}...`);
      this.connectPromise = this._openConnection()
        .then(({ session, gen }) => this._activate(session, gen))
        .catch((err) => {
          this._retryAfter = Date.now() + 1000; // back off so every chunk doesn't retry
          throw err;
        })
        .finally(() => { this.connectPromise = null; });
    }
    await this.connectPromise;
  }

  /**
   * goAway: swap in a new connection while the old one still works. Audio
   * keeps flowing to the old connection until the new one is ready; the old
   * one is then given a few seconds to finish any translation it's still
   * speaking before it is closed.
   */
  _handleGoAway(timeLeft) {
    if (this.closedByUs || this.connectPromise) return;
    console.log(`[LiveTranslationSession] goAway received (${this.inputLang}→${this.outputLang}), timeLeft=${timeLeft} — swapping connection`);
    const old = this.session;
    this.connectPromise = this._openConnection()
      .then(({ session, gen }) => {
        this._activate(session, gen);
        setTimeout(() => this._closeQuietly(old), 5000);
      })
      .catch((err) => {
        console.error(`[LiveTranslationSession] goAway swap failed (${this.inputLang}→${this.outputLang}):`, err.message);
        // The old connection will close shortly; _onClose then reconnects.
      })
      .finally(() => { this.connectPromise = null; });
  }

  _flushPending() {
    if (!this.session) return;
    const queued = this.pendingAudio;
    this.pendingAudio = [];
    if (queued.length) {
      console.log(`[LiveTranslationSession] Flushing ${queued.length} queued chunks (${this.inputLang}→${this.outputLang})`);
    }
    for (const { audioBase64, mimeType } of queued) {
      this.session.sendRealtimeInput({ audio: { data: audioBase64, mimeType } });
    }
  }

  /**
   * Feed one small chunk of continuously-streamed raw PCM audio into the
   * session. Sends immediately when connected; otherwise queues the chunk
   * (in order, capped at ~3s) and kicks off a reconnect.
   */
  feedAudio(audioBase64, mimeType) {
    // Keep the most recent ~30s of input for the per-turn recording.
    const MAX_INPUT_BUFFERS = 200;
    // ~3s of audio at 150ms chunks — older queued audio is dropped first.
    const MAX_PENDING = 20;

    this.lastFeedAudioAt = Date.now();
    this._lastFeedAt = Date.now(); // update idle timer for keepalive

    this.inputAudioBuffers.push(Buffer.from(audioBase64, 'base64'));
    if (this.inputAudioBuffers.length > MAX_INPUT_BUFFERS) this.inputAudioBuffers.shift();

    if (this.session && typeof this.session.sendRealtimeInput === 'function') {
      try {
        this.session.sendRealtimeInput({ audio: { data: audioBase64, mimeType } });
        return;
      } catch (err) {
        console.warn(`[LiveTranslationSession] send failed (${this.inputLang}→${this.outputLang}), queueing:`, err.message);
        this.session = null;
      }
    }

    this.pendingAudio.push({ audioBase64, mimeType });
    if (this.pendingAudio.length > MAX_PENDING) this.pendingAudio.shift();

    if (!this.connectPromise && !this.closedByUs && Date.now() >= this._retryAfter) {
      this.ensureConnected().catch((err) => {
        console.error(`[LiveTranslationSession] Connect failed (${this.inputLang}→${this.outputLang}):`, err.message);
        if (this.callbacks.onError) this.callbacks.onError(err);
      });
    }
  }

  /**
   * Gracefully close the session and free resources.
   */
  close() {
    this.closedByUs = true;
    this._stopKeepalive();
    this._closeQuietly(this.session);
    this.session = null;
    this.connectPromise = null;
    this.pendingAudio = [];
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
  try {
    liveSession.feedAudio(audioBase64, mimeType);
  } catch (err) {
    console.error(`[geminiService] feedAudio failed for ${role} in ${sessionId}:`, err.message);
  }
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
