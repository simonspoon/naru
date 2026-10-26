/**
 * The live whiteboard's zoom (naru task 2314): the pure arithmetic behind the
 * wheel, the + / − buttons and the drag-to-pan in `LiveBoardPanel`. The zoom
 * is a CSS `zoom` on the board's content (re-laid out, so text stays crisp),
 * and the pan is the content box's own scroll — so zooming toward a point is
 * a matter of moving the scroll by the right amount.
 */

export const MIN_BOARD_ZOOM = 0.25
export const MAX_BOARD_ZOOM = 4
/** One press of + or −. */
export const BOARD_ZOOM_STEP = 1.25
/** How far a press must travel before it is a pan rather than a click. */
export const PAN_THRESHOLD_PX = 4

export function clampBoardZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_BOARD_ZOOM, Math.max(MIN_BOARD_ZOOM, zoom))
}

/** The zoom one + (`dir` 1) or − (`dir` -1) press lands on; a step passing
 *  through 100% snaps to it, so the default view is always one press away. */
export function stepBoardZoom(zoom: number, dir: 1 | -1): number {
  const next = clampBoardZoom(zoom * BOARD_ZOOM_STEP ** dir)
  if ((zoom < 1 && next > 1) || (zoom > 1 && next < 1)) return 1
  return next
}

/**
 * Whether a wheel zooms the board rather than scrolls it (naru task 2358): Cmd
 * or Option (Ctrl elsewhere) held, and a trackpad pinch, which browsers report
 * as a ctrl-wheel. A plain wheel scrolls the board like a page.
 */
export function isZoomWheel(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey || e.altKey
}

/**
 * The zoom one zooming wheel event lands on (`isZoomWheel`): a notch of a
 * mouse wheel (~100px) about 15%; a trackpad pinch arrives as a ctrl-wheel of small deltas and gets a stronger gain so it tracks the
 * fingers. Line and page deltas are turned into pixels first.
 */
export function wheelBoardZoom(
  zoom: number,
  deltaY: number,
  deltaMode: number,
  pinch: boolean,
): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY
  const gain = pinch ? 0.01 : 0.0015
  return clampBoardZoom(zoom * Math.exp(-px * gain))
}

/** The scroll offset that keeps the content under `cursor` (an offset inside
 *  the scroll box) where it is when the zoom goes `from` → `to`. */
export function scrollForZoom(scroll: number, cursor: number, from: number, to: number): number {
  return Math.max(0, ((scroll + cursor) * to) / from - cursor)
}

/** Whether a press has moved far enough to be a pan. */
export function isPan(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= PAN_THRESHOLD_PX
}

/** The zoom as the label on its reset button. */
export function boardZoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}
