import type { LiveIndicator } from './liveIndicator'

/**
 * The Naru waveform mark's behaviour (mesa task 1544), replacing the aperture
 * canvas and the head's text title. The mark is the favicon's seven bars; what
 * changes between states is colour, scale and how the bars move. Everything
 * arithmetic lives here so it can be tested without a DOM; `components/NaruMark.tsx` only
 * writes the numbers into SVG attributes once a frame.
 *
 * The numbers are the approved mockup's (`naru-icon-states.html`), ported
 * rather than re-derived: the palettes, the scale/bar formulas per state and
 * the thinking shimmer. The one deliberate difference is the level: the
 * mockup invented one, here it is the real microphone level while hearing and
 * the real playback level while speaking.
 */

/** The five looks the mark can take. `paused` is not in the mockup. */
export type MarkMode = 'idle' | 'hear' | 'speak' | 'think' | 'paused' | 'offer'

/** Which look each ranked indicator state wears. `null` (nothing to report)
 *  is idle: the mark is always there, it just rests. */
export function markMode(state: LiveIndicator | null, offer = false): MarkMode {
  // An overheard "can help" offer (naru task 1700): the resting mark turns
  // gold, but only while nothing else has anything to report.
  if (offer && state === null) return 'offer'
  if (state === 'speaking') return 'speak'
  if (state === 'hearing') return 'hear'
  if (state === 'working' || state === 'resting') return 'think'
  if (state === 'paused') return 'paused'
  return 'idle'
}

export type Rgb = [number, number, number]

/** The favicon's bar index → palette slot (outer, mid, inner, centre). */
export const BAR_SLOT = [0, 1, 2, 3, 2, 1, 0]

/** Colours per look, from the mockup's `P`. `glow` is the drop-shadow colour
 *  (alpha applied separately, so it can be eased to nothing for idle). */
export const PALETTES: Record<'idle' | 'hear' | 'speak' | 'think' | 'offer', { bars: string[]; glow: string }> = {
  idle: { bars: ['#3b3550', '#4a4366', '#5b537c', '#6d6592'], glow: '#6d6592' },
  hear: { bars: ['#1f7fff', '#1fb6ff', '#29e6ff', '#b8f6ff'], glow: '#29e6ff' },
  speak: { bars: ['#ff5a3c', '#ff8a2b', '#ffb02b', '#ffe2a8'], glow: '#ffa02b' },
  think: { bars: ['#6a2bff', '#8a4bff', '#b06bff', '#e6d1ff'], glow: '#b06bff' },
  offer: { bars: ['#d98a14', '#f0a820', '#ffc23d', '#fff0c2'], glow: '#ffc23d' },
}

/** The mockup's glow alpha (`aa`). */
export const GLOW_ALPHA = 0xaa / 255

/** Paused wears idle's palette; its stillness and dimness are what say so. */
export function paletteFor(mode: MarkMode): { bars: string[]; glow: string } {
  return PALETTES[mode === 'paused' ? 'idle' : mode]
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Exponential ease toward a target: frame-rate independent, never snaps.
 *  `rate` is per second (about how many 1/e steps a second). */
export function easeToward(prev: number, target: number, dt: number, rate: number): number {
  return prev + (target - prev) * (1 - Math.exp(-rate * Math.max(0, dt)))
}

export function easeRgb(prev: Rgb, target: Rgb, dt: number, rate: number): Rgb {
  return [
    easeToward(prev[0], target[0], dt, rate),
    easeToward(prev[1], target[1], dt, rate),
    easeToward(prev[2], target[2], dt, rate),
  ]
}

/**
 * Raw RMS (0..~0.3 for speech) → 0..1 drawing level. A square-root curve so
 * ordinary speech reaches most of the range instead of hugging the floor, and
 * a floor so room hiss does not twitch the mark. Used for the microphone and
 * the playback tap alike, so both sides of a conversation read the same.
 */
export function levelFromRms(rms: number): number {
  if (!(rms > 0.004)) return 0
  return Math.min(1, Math.sqrt(rms) * 2)
}

/** The thinking shimmer: a soft highlight sweeping left to right across the
 *  bars, as a bar's height factor in 0.55..1. */
export function shimmer(t: number, i: number): number {
  const ph = ((t * 1.4) % 2.2) - i * 0.18
  return 0.55 + 0.45 * Math.exp(-Math.pow((ph - 0.1) * 4, 2))
}

/** What to draw this frame: whole-mark scale, glow strength 0..1, each bar's
 *  height factor, the white core's opacity and the mark's own opacity. */
export interface MarkFrame {
  scale: number
  glow: number
  bars: number[]
  core: number
  opacity: number
}

const BAR_COUNT = 7
const flat = (v: number): number[] => new Array<number>(BAR_COUNT).fill(v)

/**
 * One frame's targets. `lv` is the 0..1 level for this mode's side of the
 * conversation (mic for `hear`, playback for `speak`); the other modes ignore
 * it. `reduced` halves the clock — the half-speed rule every state already
 * follows — and changes nothing else.
 */
export function markFrame(mode: MarkMode, time: number, lv: number, reduced: boolean): MarkFrame {
  const t = reduced ? time * 0.5 : time
  const level = Math.min(1, Math.max(0, lv))
  if (mode === 'paused') {
    // Still and muted: no breathe, bars held low, dimmed.
    return { scale: 0.9, glow: 0, bars: flat(0.6), core: 0.35, opacity: 0.5 }
  }
  if (mode === 'hear') {
    return {
      scale: 0.86 + 0.3 * level,
      glow: level,
      bars: Array.from({ length: BAR_COUNT }, (_, i) =>
        0.45 + 0.55 * Math.min(1, level * (0.7 + 0.6 * Math.abs(Math.sin(t * 9 + i * 1.7)))),
      ),
      core: 1,
      opacity: 1,
    }
  }
  if (mode === 'speak') {
    return {
      scale: 0.88 + 0.26 * level,
      glow: level,
      bars: Array.from({ length: BAR_COUNT }, (_, i) =>
        0.55 + 0.45 * Math.min(1, level * (0.8 + 0.4 * Math.sin(t * 7 - i * 0.9))),
      ),
      core: 1,
      opacity: 1,
    }
  }
  if (mode === 'offer') {
    // A slow, unmistakable gold pulse; reduced motion halves the clock.
    return {
      scale: 1 + 0.08 * Math.sin(t * 4),
      glow: 0.7 + 0.3 * Math.sin(t * 4),
      bars: Array.from({ length: BAR_COUNT }, (_, i) => 0.75 + 0.25 * Math.sin(t * 4 - i * 0.5)),
      core: 1,
      opacity: 1,
    }
  }
  if (mode === 'think') {
    return {
      scale: 0.95 + 0.03 * Math.sin(t * 3),
      glow: 0.45 + 0.25 * Math.sin(t * 3),
      bars: Array.from({ length: BAR_COUNT }, (_, i) => shimmer(t, i)),
      core: 1,
      opacity: 1,
    }
  }
  return { scale: 0.9 + 0.05 * Math.sin(t * 1.6), glow: 0, bars: flat(1), core: 0.35, opacity: 1 }
}

/** Whether a frame's painted numbers moved by less than `eps` each against the
 *  last painted ones — a settled mark (paused, idle-flat) skips its style writes. */
export function isSettled(prev: readonly number[] | null, next: readonly number[], eps: number): boolean {
  if (prev === null || prev.length !== next.length) return false
  return next.every((v, i) => Math.abs(v - prev[i]) < eps)
}
