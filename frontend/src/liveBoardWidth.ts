// Persisted width of the live conversation panel *while its board section is
// showing* (mesa task 1078; repurposed by mesa task 1447 when the whiteboard
// moved from a floating overlay of its own into a section of that panel) —
// modelled on `filesTreeWidth.ts`, with one difference that runs through the
// whole module: "nothing chosen" is `null`, not a number.
//
// The panel needs more room once it is also holding a board than while it
// holds only the conversation (`liveSidebarWidth.ts`'s own key, unchanged, is
// that narrower default) — so this is the panel's *second* stored width, and
// `LiveHub`'s one resize handle edits whichever of the two is showing. The
// default is a CSS *expression* — `min(56rem, 60vw)` in App.css's
// `.live-sidebar.board-open` — which is a rule rather than a length: it is
// wider on a laptop and wider still on a 3440px monitor, and no single number
// this module could return would be right on both. So an unset width is
// `null`, the component sets no inline `--live-sidebar-width` at all, and the
// stylesheet's own value stands. A number here always means the person
// dragged the panel's edge while the board section was showing.
//
// The clamp lives here rather than in `LiveHub` because a stored value is as
// untrusted as a mid-drag pointer position — a hand-edited key, or a width
// chosen on a 3440px monitor and reloaded on a laptop. The ceiling is the
// live room in `.shell-body`'s row, which only the caller can measure, so it
// is an argument rather than a constant.

const WIDTH_KEY = 'mesa-live-board-width'

/** Nothing stored: let App.css's `.live-sidebar.board-open` rule decide,
 * since it decides differently per window and this module cannot see one. */
export const DEFAULT_LIVE_BOARD_WIDTH = null

/** Narrower than this and a mockup is a strip rather than a picture — which is
 * the complaint this width exists to answer, so the floor is generous. Folding
 * the board section, not the drag, is how you get less than a readable one. */
export const MIN_LIVE_BOARD_WIDTH = 384

/** Clamp a candidate width into range. `max` is measured live off the layout
 * by the caller (the room left in `.shell-body`'s row, `LiveHub`'s own resize
 * effect), so it is not a constant here; a `max` at or below the floor means
 * the window has no room to give, and the floor wins — never a max below the
 * min.
 *
 * A non-finite width answers the floor rather than a default, because there is
 * no numeric default to fall back to: `null` means "the stylesheet decides",
 * and this function's contract is a number. It only ever arises from a corrupt
 * pointer position, where the narrowest renderable panel is the safe answer. */
export function clampLiveBoardWidth(width: number, max: number): number {
  const ceiling = Math.max(MIN_LIVE_BOARD_WIDTH, max)
  if (!Number.isFinite(width)) return MIN_LIVE_BOARD_WIDTH
  return Math.max(MIN_LIVE_BOARD_WIDTH, Math.min(width, ceiling))
}

/** The stored width, or `null` when nothing is stored, the value isn't a
 * finite number, or it is below the floor — all three being "this browser has
 * no opinion", which is what the CSS default is for. A stored value *above*
 * the floor is returned as-is: the live ceiling depends on the current window,
 * which this module can't see, and the next drag pulls it in. */
export function loadLiveBoardWidth(): number | null {
  const raw = localStorage.getItem(WIDTH_KEY)
  if (raw === null) return DEFAULT_LIVE_BOARD_WIDTH
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < MIN_LIVE_BOARD_WIDTH) {
    return DEFAULT_LIVE_BOARD_WIDTH
  }
  return parsed
}

export function saveLiveBoardWidth(width: number): void {
  localStorage.setItem(WIDTH_KEY, String(width))
}

/** Double-clicking the handle goes back to the default — which means
 * forgetting the stored value, not storing 640: the default is a CSS
 * expression that answers differently per window, and a number pinned here
 * would stop it doing that (the nav's and the file tree's rule). */
export function clearLiveBoardWidth(): void {
  localStorage.removeItem(WIDTH_KEY)
}
