// Speaker-enrollment recording (naru task 1744, docs/voice-enrollment.md): the
// pure logic behind Settings > Voice's "Voice guard enrollment" section — what
// to read and when, how loud the take was, what the status line says. The
// component only wires this to the microphone.
import type { VoiceEnrollment } from './types/VoiceEnrollment'

/** The Mac app's `enroll(wavURLs:)` needs at least this much speech. */
export const MIN_SECONDS = 20
/** Recording stops by itself here. */
export const TARGET_SECONDS = 90
/** A take whose loudest sample is below this barely picked anything up. */
export const NEAR_SILENT_DB = -40

/** One natural paragraph at a normal pace (~50 s). */
export const READ_ALOUD =
  'Every morning I make a cup of coffee and look over the day ahead. Some days ' +
  'are quiet, with a few messages to answer and a walk around the block at lunch. ' +
  'Other days the calendar fills up before I have even sat down, and I have to ' +
  'decide what really matters. I like to keep a notebook nearby, because ideas ' +
  'arrive at odd moments, usually when my hands are full. When the weather is ' +
  'good I open the window and listen to the street: a bicycle bell, a neighbour ' +
  'calling to a dog, the soft rattle of a delivery truck turning the corner. By ' +
  'evening the house settles down, the lights come on one by one, and I read ' +
  'until my eyes get heavy. It is not a remarkable routine, but it is mine, and ' +
  'I would not trade it for anything.'

/** Seconds the paragraph is on screen before the one-word replies start. */
export const SCRIPT_SECONDS = 48
/** Seconds each one-word reply prompt stays up. */
export const PROMPT_SECONDS = 3.5

export const REPLY_PROMPTS: readonly string[] = [
  'Say: yes',
  'Say: no',
  'Say a number: seven',
  'Say: okay',
  'Say a number: forty-two',
  'Say: stop',
  'Say: go ahead',
  'Say a number: three',
  'Say: not now',
  'Say a number: nineteen',
  'Say: sounds good',
  'Say a number: zero',
]

export type EnrollPrompt =
  | { kind: 'script'; text: string }
  | { kind: 'reply'; text: string; index: number }
  | { kind: 'done'; text: string }

/** What to show `elapsed` seconds into the recording. */
export function promptAt(elapsed: number): EnrollPrompt {
  if (elapsed < SCRIPT_SECONDS) return { kind: 'script', text: READ_ALOUD }
  const index = Math.floor((elapsed - SCRIPT_SECONDS) / PROMPT_SECONDS)
  if (index < REPLY_PROMPTS.length) {
    return { kind: 'reply', text: REPLY_PROMPTS[index], index }
  }
  return { kind: 'done', text: 'That is plenty — you can stop now.' }
}

/** Whether Stop is enabled yet. */
export function canStop(elapsed: number): boolean {
  return elapsed >= MIN_SECONDS
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
