/**
 * Server-side echo guard (second line of defence after the phone's own
 * echo cancellation).
 *
 * Problem: on loudspeaker, part of the translation a phone plays leaks back
 * into that phone's mic. Gemini Live Translate hears it as new speech and
 * translates it again, so the partner hears their own sentence come back.
 *
 * The server knows exactly when it is playing translation to each listener,
 * so while that audio is playing (plus a tail for network + phone buffering)
 * the listener's mic is replaced with silence before it reaches Gemini —
 * unless the listener is clearly talking over it (barge-in), which is much
 * louder at the mic than the leaked echo.
 *
 * Tunables (env):
 *   ECHO_GUARD=off            disable the guard entirely
 *   ECHO_GUARD_TAIL_MS=700    how long after the last translated audio the
 *                             mic stays guarded (network + jitter buffer +
 *                             speaker delay)
 *   ECHO_GUARD_BARGE_RMS=2500 absolute minimum mic level (int16 RMS) that
 *                             counts as the listener really talking
 *   ECHO_GUARD_BARGE_RATIO=3  ...and it must also be this many times louder
 *                             than the echo level measured during playback
 */

const ENABLED = process.env.ECHO_GUARD === 'on';
const TAIL_MS = Number(process.env.ECHO_GUARD_TAIL_MS || 300);
const BARGE_RMS = Number(process.env.ECHO_GUARD_BARGE_RMS || 1200);
const BARGE_RATIO = Number(process.env.ECHO_GUARD_BARGE_RATIO || 2.0);
// Barge-in must last this long before the mic opens.
const BARGE_HOLD_MS = 100;
// Translated audio quieter than this (int16 RMS per 20ms) is treated as silence.
const AUDIBLE_RMS = Number(process.env.ECHO_GUARD_AUDIBLE_RMS || 300);
const MAX_ECHO_LEVEL = 800;

function rmsOf(pcm) {
  const n = pcm.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  return Math.sqrt(sum / n);
}

class EchoGuard {
  constructor(label, { now = () => Date.now() } = {}) {
    this.label = label;
    this.now = now;
    this.playEndAt = 0;   // when everything queued for this listener finishes playing (server clock)
    this.audibleEndAt = 0; // when the last AUDIBLE part of it finishes — this is what guards the mic
    this.echoLevel = 0;   // running estimate of leaked echo at the mic (int16 RMS)
    this.loudSince = 0;   // start of the current loud stretch during playback
    this.held = [];       // loud frames held back until barge-in is confirmed
    this.stats = { guarded: 0, passedBargeIn: 0 };
    this.lastLogAt = 0;
  }

  /**
   * Call with each chunk of translated audio queued for this listener
   * (Int16Array samples at `rate` Hz). Chunks play back to back, so the chunk
   * starts when the previous one ends; only its audible part extends the guard.
   */
  onPlayback(samples, rate) {
    const start = Math.max(this.playEndAt, this.now());
    const frame = Math.max(1, Math.round(rate * 0.02));
    let lastAudibleEnd = -1;
    for (let i = 0; i < samples.length; i += frame) {
      const end = Math.min(samples.length, i + frame);
      let sum = 0;
      for (let j = i; j < end; j++) sum += samples[j] * samples[j];
      if (Math.sqrt(sum / (end - i)) > AUDIBLE_RMS) lastAudibleEnd = end;
    }
    this.playEndAt = start + (samples.length / rate) * 1000;
    if (lastAudibleEnd >= 0) {
      this.audibleEndAt = Math.max(this.audibleEndAt, start + (lastAudibleEnd / rate) * 1000);
    }
  }

  isGuarding() {
    return ENABLED && this.now() < this.audibleEndAt + TAIL_MS;
  }

  /**
   * Filter one mic frame (16-bit PCM Buffer). Returns the frame to send to
   * Gemini: the original, or silence of the same length.
   */
  filter(pcm) {
    if (!this.isGuarding()) {
      this.loudSince = 0;
      if (this.held.length) { const out = Buffer.concat([...this.held, pcm]); this.held = []; return out; }
      return pcm;
    }

    const rms = rmsOf(pcm);
    const threshold = Math.max(BARGE_RMS, this.echoLevel * BARGE_RATIO);
    const t = this.now();

    if (rms >= threshold) {
      if (!this.loudSince) this.loudSince = t;
      if (t - this.loudSince >= BARGE_HOLD_MS) {
        this.stats.passedBargeIn++;
        if (this.held.length) { const out = Buffer.concat([...this.held, pcm]); this.held = []; return out; }
        return pcm;
      }
      this.held.push(pcm);
      return Buffer.alloc(0);
    } else {
      this.loudSince = 0;
      if (this.held.length) { const out = Buffer.alloc(this.held.reduce((n, b) => n + b.length, 0) + pcm.length); this.held = []; this.stats.guarded++; return out; }
      const newEcho = rms > this.echoLevel ? 0.5 * this.echoLevel + 0.5 * rms : 0.98 * this.echoLevel + 0.02 * rms;
      this.echoLevel = Math.min(MAX_ECHO_LEVEL, newEcho);
    }

    this.stats.guarded++;
    if (t - this.lastLogAt > 10000) {
      this.lastLogAt = t;
      console.log(`[echoGuard] ${this.label}: guarded ${this.stats.guarded} mic frames during playback, let ${this.stats.passedBargeIn} barge-in frames through (echo level ~${Math.round(this.echoLevel)})`);
    }
    return Buffer.alloc(pcm.length);
  }
}

module.exports = { EchoGuard, rmsOf, TAIL_MS, BARGE_RMS };
