/**
 * The speech speed setting's pure half (mesa task 1560): its bounds, how a
 * value is read and shown, and how it is put on an `<audio>` element.
 *
 * Speed is applied by the **page**, never the engine — only kokoro honours a
 * `speed` request field, qwen ignores it and other daemon models reject it —
 * so the server stores one number and every player scales its own audio
 * without moving the pitch: an element through `playbackRate` +
 * `preservesPitch`, the decoded Web Audio path through `timeStretch.ts`.
 * Mirrors `core::config`'s `SPEECH_SPEED_*`.
 */

export const SPEED_MIN = 0.75
export const SPEED_MAX = 1.5
export const SPEED_STEP = 0.05
export const SPEED_DEFAULT = 1

/** A usable speed: the number clamped into range and snapped to the step,
 *  or the default for anything that is not a finite number. */
export function normalizeSpeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SPEED_DEFAULT
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, value))
  return Number((Math.round(clamped / SPEED_STEP) * SPEED_STEP).toFixed(2))
}

/** "1.25×" — the slider's readout. */
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}×`
}

/** The part of an `HTMLMediaElement` speed touches, so a test can fake it. */
export interface SpeedTarget {
  playbackRate: number
  defaultPlaybackRate: number
  preservesPitch: boolean
}

/**
 * Puts `speed` on an element. `defaultPlaybackRate` too: loading a new `src`
 * resets `playbackRate` to it, and every player here sets `src` per item.
 * `preservesPitch` is the browser default, set explicitly because the whole
 * feature is wrong without it.
 */
export function applyElementSpeed(el: SpeedTarget, speed: number): void {
  const rate = normalizeSpeed(speed)
  el.defaultPlaybackRate = rate
  el.playbackRate = rate
  el.preservesPitch = true
}
