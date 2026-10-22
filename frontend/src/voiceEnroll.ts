// Voice-clip recording (naru tasks 1744, 2262, docs/voice-enrollment.md): the
// pure logic behind recording a clip in Settings > Voice — what
// to read and when, how loud the take was. The
// component only wires this to the microphone.
import type { EnrollStatus, NativeHost } from './nativeHost'

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

/** Inside the Mac app the host records (naru-audio enrolls only from the mic); a plain browser records itself. */
export function enrollPath(host: NativeHost | null): 'native' | 'browser' {
  return host ? 'native' : 'browser'
}

/** The native path's start for one person in the library: one bridge message, no `getUserMedia` (naru task 2259). */
export function startNativeEnroll(host: NativeHost, person: number): void {
  host.post({ type: 'enroll', op: 'start', person })
}

/** The one-line state inside the Mac app, from the host's last `enrollStatus`. */
export function nativeStatusLine(s: EnrollStatus | null): string {
  if (!s) return 'Waiting for the Naru Mac app…'
  if (s.note) return s.note
  if (s.enrolling) return `Recording — speak for ${s.seconds} s`
  return s.enrolled ? 'Enrolled' : 'Not enrolled'
}
