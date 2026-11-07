import type { LiveIndicator } from './liveIndicator'

/**
 * The header equalizer (naru task 2610, replacing the window-edge mood light
 * of mesa task 1557): a thin row of bars along the page header's bottom
 * border, lit only while something is happening. Who is active picks the
 * colour — the person being heard cyan, Naru speaking violet, Naru working or
 * resting amber — and listening, paused and no conversation draw nothing.
 */
export type EqMode = 'user' | 'naru' | 'think'

export function eqMode(state: LiveIndicator | null): EqMode | null {
  if (state === 'hearing') return 'user'
  if (state === 'speaking') return 'naru'
  if (state === 'working' || state === 'resting') return 'think'
  return null
}

/** The theme token each mode is drawn in. */
export const EQ_COLOR_VAR: Record<EqMode, string> = { user: '--cyan', naru: '--violet', think: '--amber' }

/** Bar width and gap, CSS px. */
export const EQ_BAR_PX = 3
export const EQ_GAP_PX = 3

/** How many bars fit across `width` CSS px. */
export function eqBarCount(width: number): number {
  return Math.max(0, Math.floor((width + EQ_GAP_PX) / (EQ_BAR_PX + EQ_GAP_PX)))
}

/** A bar's fixed pseudo-random 0..1 seed, so neighbours move out of step. */
function seed(i: number, k: number): number {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
  return x - Math.floor(x)
}

/**
 * Bar `i`'s height factor 0..1 at `t` seconds. Speaking (either side) scales
 * a per-bar wobble by the real, smoothed `level` 0..1, so silence between
 * words drops the row flat; thinking ignores level and breathes the whole row
 * slowly (2.6s) between 0.12 and 0.5 with a small travelling offset.
 */
export function eqBarHeight(mode: EqMode, i: number, t: number, level: number): number {
  if (mode === 'think') {
    return 0.12 + 0.38 * (0.5 - 0.5 * Math.cos(((t / 2.6) * 2 - i * 0.02) * Math.PI))
  }
  const speed = 4 + 5 * seed(i, 1)
  const wobble = 0.5 + 0.5 * Math.sin(t * speed + seed(i, 2) * Math.PI * 2)
  return Math.min(1, level * (0.3 + 0.7 * wobble))
}

/** The row's overall gain eases toward 1 while active and 0 after, so the bars
 *  fade in and out rather than snap; `dt` in seconds. */
export function eqGain(prev: number, active: boolean, dt: number): number {
  const target = active ? 1 : 0
  return prev + (target - prev) * (1 - Math.exp(-dt / 0.15))
}

/** Below this an inactive row is finished: the loop stops and nothing is drawn. */
export const EQ_GAIN_FLOOR = 0.01
