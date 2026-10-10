// Speaker-enrollment recording (naru task 1744, docs/voice-enrollment.md): the
// pure logic behind Settings > Voice's "Voice guard enrollment" section — what
// to read and when, how loud the take was, what the status line says. The
// component only wires this to the microphone.
import type { VoiceEnrollment } from './types/VoiceEnrollment'

/** The Mac app's `enroll(wavURLs:)` and the server need at least this much audio. */
export const MIN_SECONDS = 8
/** Stop enables here: wall-clock runs ahead of captured samples, so keep a margin over MIN_SECONDS. */
export const STOP_SECONDS = 9
/** Recording stops by itself here. */
export const TARGET_SECONDS = 12
/** A take whose loudest sample is below this barely picked anything up. */
export const NEAR_SILENT_DB = -40

/** Two natural sentences, 24 words: about 9.6 s at 150 wpm, inside the 12 s auto-stop. */
export const READ_ALOUD =
  'Every morning I make coffee and look over the day ahead. Some days are quiet, ' +
  'with a few messages and a walk at lunch.'

/** Whether Stop is enabled yet. */
export function canStop(elapsed: number): boolean {
  return elapsed >= STOP_SECONDS
}

/** Whether the recording should end by itself. */
export function shouldAutoStop(elapsed: number): boolean {
  return elapsed >= TARGET_SECONDS
}

/** Peak level of `samples` (floats in -1..1) in dBFS; -120 for silence. */
export function peakDb(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  return peak === 0 ? -120 : Math.max(-120, 20 * Math.log10(peak))
}

export function nearSilent(db: number): boolean {
  return db < NEAR_SILENT_DB
}

/** A live meter fill, 0..1, for an RMS level (-60 dBFS .. 0 dBFS). */
export function meterFraction(rms: number): number {
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db + 60) / 60))
}

/**
 * The next meter value: jumps up to `target`, falls back gradually. A worklet
 * frame is ~3-8 ms, so a tick that sampled just the newest frame read silence
 * between the pulses of speech (or a test beep); `target` is the loudest frame
 * since the last tick and the fall-off keeps a pulse visible.
 */
export function meterStep(prev: number, target: number): number {
  return Math.max(target, prev * 0.8)
}

/** `m:ss`. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The one-line state of the enrollment. */
export function statusLine(e: VoiceEnrollment | null): string {
  if (!e) return 'Checking…'
  if (e.current && e.enrolled_at) return `Enrolled ${e.enrolled_at.slice(0, 10)}`
  if (e.sample) return 'Sample saved — waiting for the Naru Mac app to build the enrollment'
  return 'Not enrolled'
}

/** Whether the status page should keep polling for the Mac app's file. */
export function awaitingMacApp(e: VoiceEnrollment | null): boolean {
  return !!e && !!e.sample && !e.current
}
