import type { LiveIndicator } from './liveIndicator'

/**
 * The floating Naru orb's logic (mesa task 1553): the animated mark lifted out
 * of the panel head into a draggable panel above every page. Everything that
 * can be decided without a DOM lives here — where a release comes to rest, how
 * a remembered position is read back, how bright a state is, which mute icon to
 * show — so `components/LiveOrb.tsx` is left with only pointers and paint.
 */

/** Orb body diameter, px. */
export const ORB_SIZE = 116
/** Gap between the orb and the viewport edge at an anchor — wide enough that
 *  the hover pie, which blooms past the body, is never clipped. */
export const ORB_MARGIN = 36

/** localStorage key for the remembered position (machine-local, per browser). */
export const ORB_STORAGE_KEY = 'naru.live-orb'

export interface Point {
  x: number
  y: number
}

/** A release within this many px of the top edge docks the orb there. */
export const DOCK_ZONE = 80
/** Top of a docked orb: the window's top edge, so the shrunk orb's centre sits
 *  inside the title bar (mesa task 1563). The pie's top segments bloom past
 *  the edge and clip while it is docked and hovered. */
export const DOCK_Y = 0

/** Where the orb rests: its top-left, and whether it is docked to the top
 *  edge (drawn shrunk until hovered). Anywhere else is exactly where it was
 *  dropped. */
export interface Placement extends Point {
  docked: boolean
}

/** Where a fresh install puts it: the bottom-right corner, clear of the
 *  header's conversation controls the top-right pie would cover. */
export function defaultPlacement(vw: number, vh: number): Placement {
  return clampPlacement({ x: vw - ORB_SIZE - ORB_MARGIN, y: vh - ORB_SIZE - ORB_MARGIN, docked: false }, vw, vh)
}

/** Keeps a top-left inside the viewport (never leave the page). */
export function clampPoint(p: Point, vw: number, vh: number): Point {
  const maxX = Math.max(0, vw - ORB_SIZE)
  const maxY = Math.max(0, vh - ORB_SIZE)
  return { x: Math.min(maxX, Math.max(0, p.x)), y: Math.min(maxY, Math.max(0, p.y)) }
}

/** A placement clamped to the viewport; a docked one sits at the top-edge y. */
export function clampPlacement(p: Placement, vw: number, vh: number): Placement {
  const c = clampPoint(p, vw, vh)
  return p.docked ? { x: c.x, y: Math.min(DOCK_Y, Math.max(0, vh - ORB_SIZE)), docked: true } : { ...c, docked: false }
}

/** Where a release at top-left `p` comes to rest: exactly there, clamped —
 *  except near the top edge, which docks it. The only snap there is. */
export function settle(p: Point, vw: number, vh: number): Placement {
  const c = clampPoint(p, vw, vh)
  return c.y < DOCK_ZONE ? clampPlacement({ ...c, docked: true }, vw, vh) : { ...c, docked: false }
}

/** Reads a stored placement back; anything unusable (missing, bad JSON,
 *  non-finite numbers — including the old `{col,row}` anchors) is the
 *  default rather than an error. */
export function parsePlacement(raw: string | null, vw: number, vh: number): Placement {
  if (raw === null) return defaultPlacement(vw, vh)
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return defaultPlacement(vw, vh)
    const { x, y, docked } = v as { x?: unknown; y?: unknown; docked?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return defaultPlacement(vw, vh)
    }
    return clampPlacement({ x, y, docked: docked === true }, vw, vh)
  } catch {
    return defaultPlacement(vw, vh)
  }
}

export function serializePlacement(p: Placement): string {
  return JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y), docked: p.docked })
}

/** How far the pie blooms past the body, px. */
export const ORB_PIE_BLEED = 34

/** The viewport height the orb may use: on the phone tier the tab bar (`tabbar`
 *  px tall, 0 elsewhere) owns the bottom edge, and the pie blooms past the
 *  body, so the body stops a bleed above it. Pass the result as `vh` to the
 *  placement functions so drop, clamp and default all agree. */
export function usableHeight(vh: number, tabbar: number): number {
  return tabbar > 0 ? Math.max(0, vh - tabbar - ORB_PIE_BLEED) : vh
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
