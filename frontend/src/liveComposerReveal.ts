/**
 * The chat input that hides itself (naru task 2311). The composer is shown
 * while the mouse is near the bottom of the chat, while it has focus, and
 * while it holds something unsent; otherwise it folds away so the transcript
 * takes the room. Pure decisions — the component owns the timer and the
 * rects, and only CSS decides whether a device without hover hides it at all.
 */

/** How tall the hover strip at the chat's bottom edge is while the box is
 *  hidden, in CSS pixels — roughly the box's own height. */
export const COMPOSER_REVEAL_ZONE = 72

/** How long after the mouse leaves before the box folds away again. */
export const COMPOSER_HIDE_DELAY_MS = 1000

/** Whether the composer is shown. */
export function composerShown(opts: {
  hovered: boolean
  focused: boolean
  draft: string
  staged: boolean
}): boolean {
  return opts.hovered || opts.focused || opts.draft !== '' || opts.staged
}

/**
 * Whether a pointer at `y` is in the reveal zone: the bottom
 * `COMPOSER_REVEAL_ZONE` pixels of the chat, or — while the box is shown —
 * anywhere over the box itself, however tall it has grown.
 */
export function inRevealZone(opts: {
  y: number
  /** The chat's bottom edge. */
  bottom: number
  /** The shown box's top edge, or null while it is hidden. */
  composerTop: number | null
}): boolean {
  if (opts.y > opts.bottom) return false
  const top = Math.min(opts.bottom - COMPOSER_REVEAL_ZONE, opts.composerTop ?? Infinity)
  return opts.y >= top
}
