/** Zoom and pan for an image shown in the Files tab (naru task 2731).
 *
 * Every decision lives here — the fit scale, zooming about a point, the zoom
 * range and how far the image may be panned — so `FileImageBody` only feeds it
 * sizes and events and applies the view it answers. All sizes are CSS pixels.
 *
 * A view is the scale (1 = one image pixel per CSS pixel) and the offset of the
 * image's top-left corner from the stage's top-left corner. `null` stands for
 * "fit": it is not frozen to numbers, so a fitted image stays fitted when the
 * pane is resized or split. */

export interface Size {
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface ZoomView {
  scale: number
  x: number
  y: number
}

/** Highest zoom: 3200%, enough to count the pixels of a 16px icon. */
export const MAX_ZOOM = 32
/** Lowest zoom for an image that fits at a larger scale: 10%. An image whose
 * fit is smaller still (a very large one) can always go down to its fit. */
export const MIN_ZOOM = 0.1
/** One step of the toolbar buttons and the `+` / `-` keys. */
export const ZOOM_STEP = 1.25

function usable(s: Size): boolean {
  return s.w > 0 && s.h > 0 && Number.isFinite(s.w) && Number.isFinite(s.h)
}

/** The scale at which the whole image is visible in the stage, never above
 * 100%: a small image is shown at its own size, not blown up. */
export function fitScale(img: Size, stage: Size): number {
  if (!usable(img) || !usable(stage)) return 1
  return Math.min(1, stage.w / img.w, stage.h / img.h)
}

/** The zoom range for this image in this stage. */
export function scaleBounds(img: Size, stage: Size): { min: number; max: number } {
  return { min: Math.min(MIN_ZOOM, fitScale(img, stage)), max: MAX_ZOOM }
}

export function clampScale(scale: number, img: Size, stage: Size): number {
  const { min, max } = scaleBounds(img, stage)
  if (!Number.isFinite(scale)) return min
  return Math.min(max, Math.max(min, scale))
}

/** One axis of the pan bound: an image narrower than the stage is centred, a
 * wider one may move only until its edge meets the stage's edge — so it can
 * never be panned out of view, and never leaves an empty gap on one side. */
function clampAxis(offset: number, imgLen: number, stageLen: number): number {
  if (imgLen <= stageLen) return (stageLen - imgLen) / 2
  return Math.min(0, Math.max(stageLen - imgLen, offset))
}

/** The view with its scale in range and its offset bounded. Idempotent, and
 * applied on every render, so a pane that shrinks or grows under a zoomed
 * image re-bounds it rather than stranding it. */
export function clampView(view: ZoomView, img: Size, stage: Size): ZoomView {
  const scale = clampScale(view.scale, img, stage)
  return {
    scale,
    x: clampAxis(view.x, img.w * scale, stage.w),
    y: clampAxis(view.y, img.h * scale, stage.h),
  }
}

/** The fitted view: the fit scale, centred. */
export function fitView(img: Size, stage: Size): ZoomView {
  return clampView({ scale: fitScale(img, stage), x: 0, y: 0 }, img, stage)
}

/** The view actually on screen for a stored one (`null` = fit). */
export function resolveView(view: ZoomView | null, img: Size, stage: Size): ZoomView {
  return view === null ? fitView(img, stage) : clampView(view, img, stage)
}

/** Zoom to `scale` keeping the image point under `at` (stage coordinates)
 * where it is — the point under the pointer, or the pane's centre for a key or
 * a button. The bound may still nudge it when the zoom reaches an edge. */
export function zoomAt(view: ZoomView, scale: number, at: Point, img: Size, stage: Size): ZoomView {
  const next = clampScale(scale, img, stage)
  const k = next / view.scale
  return clampView(
    { scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k },
    img,
    stage,
  )
}

/** Pan by a pointer or wheel delta, within the bound. */
export function panBy(view: ZoomView, dx: number, dy: number, img: Size, stage: Size): ZoomView {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, img, stage)
}

/** A two-finger pinch, from the view at the gesture's start: scale by how far
 * the fingers spread, keep the image point that was under their first centre
 * under their centre now (so moving both fingers pans as well). */
export function pinchView(
  start: ZoomView,
  startDistance: number,
  distance: number,
  startCentre: Point,
  centre: Point,
  img: Size,
  stage: Size,
): ZoomView {
  const ratio = startDistance > 0 ? distance / startDistance : 1
  const next = clampScale(start.scale * ratio, img, stage)
  const k = next / start.scale
  return clampView(
    {
      scale: next,
      x: centre.x - (startCentre.x - start.x) * k,
      y: centre.y - (startCentre.y - start.y) * k,
    },
    img,
    stage,
  )
}

/** The zoom factor for one Ctrl/Cmd + wheel event (a trackpad pinch arrives
 * as exactly that). Exponential in the delta so a trackpad's many small deltas
 * and a mouse wheel's few large ones zoom at the same rate per distance, and
 * capped per event so one coarse notch cannot leap the whole range. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  // deltaMode 1 = lines, 2 = pages; normalise to pixels.
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  // 25px caps a mouse notch (100px in Chrome) at about x1.28; a trackpad
  // pinch sends many deltas well under the cap, so it stays smooth.
  const capped = Math.max(-25, Math.min(25, px))
  return Math.exp(-capped * 0.01)
}

/** The toolbar's step: the next scale up (`dir = 1`) or down (`-1`). */
export function stepScale(scale: number, dir: 1 | -1): number {
  return dir === 1 ? scale * ZOOM_STEP : scale / ZOOM_STEP
}

export type ZoomKeyAction = 'in' | 'out' | 'fit' | 'actual'

/** What a key pressed on the focused image stage does, or `null` for nothing
 * (the key is left alone). `=` is `+` without Shift. Modified keys are not
 * ours: Cmd/Ctrl + `+` is the browser's own zoom outside the stage, and stays
 * so inside it. */
export function zoomKeyAction(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): ZoomKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  switch (e.key) {
    case '+':
    case '=':
      return 'in'
    case '-':
    case '_':
      return 'out'
    case '0':
      return 'fit'
    case '1':
      return 'actual'
    default:
      return null
  }
}

/** The toolbar's percent readout. */
export function zoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

/** Whether the view is (within rounding) the fitted one — what a double-click
 * toggles away from. */
export function isFit(view: ZoomView, img: Size, stage: Size): boolean {
  return Math.abs(view.scale - fitScale(img, stage)) < 1e-6
}
