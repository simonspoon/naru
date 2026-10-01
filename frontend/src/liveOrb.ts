import type { LiveIndicator } from './liveIndicator'

/**
 * The floating Naru orb's logic (mesa task 1553): the animated mark lifted out
 * of the panel head into a draggable panel above every page. Everything that
 * can be decided without a DOM lives here — where a release snaps to, how a
 * remembered position is read back, how bright a state is, which mute icon to
 * show — so `components/LiveOrb.tsx` is left with only pointers and paint.
 */

/** Orb body diameter, px. */
export const ORB_SIZE = 116
/** Gap between the orb and the viewport edge at an anchor — wide enough that
 *  the hover pie, which blooms past the body, is never clipped. */
export const ORB_MARGIN = 36

/** localStorage key for the remembered anchor (machine-local, per browser). */
export const ORB_STORAGE_KEY = 'naru.live-orb'

/** One of the eight resting places: a corner or an edge midpoint. `col`/`row`
 *  are 0 (left/top), 1 (middle) or 2 (right/bottom); (1, 1) — the centre of
 *  the page — is not one. */
export interface OrbAnchor {
  col: 0 | 1 | 2
  row: 0 | 1 | 2
}

/** Where a fresh install puts it: the bottom-right corner, clear of the
 *  header's conversation controls the top-right pie would cover. */
export const DEFAULT_ANCHOR: OrbAnchor = { col: 2, row: 2 }

export const ANCHORS: OrbAnchor[] = [
  { col: 0, row: 0 },
  { col: 1, row: 0 },
  { col: 2, row: 0 },
  { col: 0, row: 1 },
  { col: 2, row: 1 },
  { col: 0, row: 2 },
  { col: 1, row: 2 },
  { col: 2, row: 2 },
]

export interface Point {
  x: number
  y: number
}

function axis(index: number, extent: number): number {
  const span = Math.max(0, extent - ORB_SIZE - 2 * ORB_MARGIN)
  return ORB_MARGIN + (span * index) / 2
}

/** Top-left of the orb at an anchor, in a viewport of `vw` x `vh`. */
export function anchorPosition(a: OrbAnchor, vw: number, vh: number): Point {
  return { x: axis(a.col, vw), y: axis(a.row, vh) }
}

/** Keeps a dragged top-left inside the viewport (a drag may use the margin,
 *  but never leave the page). */
export function clampPoint(p: Point, vw: number, vh: number): Point {
  const maxX = Math.max(0, vw - ORB_SIZE)
  const maxY = Math.max(0, vh - ORB_SIZE)
  return { x: Math.min(maxX, Math.max(0, p.x)), y: Math.min(maxY, Math.max(0, p.y)) }
}

/** The anchor nearest to where the orb was let go (its top-left `p`). */
export function snapAnchor(p: Point, vw: number, vh: number): OrbAnchor {
  let best = DEFAULT_ANCHOR
  let bestD = Infinity
  for (const a of ANCHORS) {
    const at = anchorPosition(a, vw, vh)
    const d = (at.x - p.x) ** 2 + (at.y - p.y) ** 2
    if (d < bestD) {
      bestD = d
      best = a
    }
  }
  return best
}

function isIndex(v: unknown): v is 0 | 1 | 2 {
  return v === 0 || v === 1 || v === 2
}

/** Reads a stored anchor back; anything unusable (missing, bad JSON, the
 *  centre, out-of-range) is the default rather than an error. */
export function parseAnchor(raw: string | null): OrbAnchor {
  if (raw === null) return DEFAULT_ANCHOR
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return DEFAULT_ANCHOR
    const { col, row } = v as { col?: unknown; row?: unknown }
    if (!isIndex(col) || !isIndex(row)) return DEFAULT_ANCHOR
    if (col === 1 && row === 1) return DEFAULT_ANCHOR
    return { col, row }
  } catch {
    return DEFAULT_ANCHOR
  }
}

export function serializeAnchor(a: OrbAnchor): string {
  return JSON.stringify({ col: a.col, row: a.row })
}

/** `bright` states are the ones something is happening in — Naru speaking or
 *  working, or the person actually being heard; `dim` is the unobtrusive rest:
 *  nothing to report, paused, or listening (the mic open and nobody talking,
 *  which is most of a session). */
export function orbBrightness(state: LiveIndicator | null): 'bright' | 'dim' {
  return state === null || state === 'paused' || state === 'listening' ? 'dim' : 'bright'
}

/** Which mute badge the orb wears: the microphone's, the voice's, both, or
 *  none. `micMuted` must already mean "the microphone is the way in and is
 *  off" — a browser that cannot capture is not "muted". */
export type MuteIcon = 'mic' | 'speaker' | 'both' | null

export function muteIcon(micMuted: boolean, speechMuted: boolean): MuteIcon {
  if (micMuted && speechMuted) return 'both'
  if (micMuted) return 'mic'
  if (speechMuted) return 'speaker'
  return null
}

/** Pixels the pointer must travel before a press is a drag, not a tap. */
export const DRAG_THRESHOLD = 5

export function isDrag(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > DRAG_THRESHOLD
}
