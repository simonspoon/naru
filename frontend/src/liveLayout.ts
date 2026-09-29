// Persisted layout of the live conversation panel's two sections (mesa task
// 1447) — the board and the chat, once the whiteboard moved from a floating
// overlay into the panel itself. Modelled on `liveSidebarWidth.ts`'s
// conventions: one localStorage key per preference, a load that falls back to
// the built-in default on anything unusable, and a clamp for the one value
// that is a continuous number rather than a flag.

/** Board above chat with a horizontal divider, or board left of chat with a
 *  vertical one. */
export type LiveArrangement = 'stacked' | 'side'

const ARRANGEMENT_KEY = 'mesa-live-arrangement'
const RATIO_KEY = 'mesa-live-panel-ratio'
// Hidden, not "collapsed": the fold arrows (mesa task 1474's rail) are gone
// (mesa task 1483), so the two old `-collapsed` keys are deliberately not read
// — a pane folded under the old scheme comes back showing rather than
// vanishing under a control that no longer says why.
const BOARD_HIDDEN_KEY = 'mesa-live-board-hidden'
const CHAT_HIDDEN_KEY = 'mesa-live-chat-hidden'
const SWAPPED_KEY = 'mesa-live-swapped'

export const DEFAULT_ARRANGEMENT: LiveArrangement = 'stacked'

/** The board's share of the panel when both sections are showing — the
 *  divider's own position. An even split until the person drags it. */
export const DEFAULT_LIVE_LAYOUT_RATIO = 0.5

/** Neither section may be dragged away to nothing: each end of the divider's
 *  travel still leaves the section on that side a usable sliver (hiding it,
 *  from the toolbar, is how you get rid of one). */
export const MIN_LIVE_LAYOUT_RATIO = 0.15
export const MAX_LIVE_LAYOUT_RATIO = 0.85

/** Clamp a candidate ratio into range; a non-finite value (a corrupt stored
 * string, a stray pointer reading) answers the even split rather than an end
 * of the range, since neither end is a more likely intent than the other. */
export function clampLiveLayoutRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_LIVE_LAYOUT_RATIO
  return Math.max(MIN_LIVE_LAYOUT_RATIO, Math.min(MAX_LIVE_LAYOUT_RATIO, ratio))
}

/** The stored arrangement, or the built-in default for anything else — no
 *  stored value, or a hand-edited one that is neither of the two words. */
export function loadLiveArrangement(): LiveArrangement {
  return localStorage.getItem(ARRANGEMENT_KEY) === 'side' ? 'side' : DEFAULT_ARRANGEMENT
}

export function saveLiveArrangement(arrangement: LiveArrangement): void {
  localStorage.setItem(ARRANGEMENT_KEY, arrangement)
}

/** The stored ratio, clamped — an invalid or corrupt value reads back as the
 *  default rather than as whatever `Number()` makes of it. */
export function loadLiveLayoutRatio(): number {
  const raw = localStorage.getItem(RATIO_KEY)
  // `Number('')` is `0`, a finite value that would otherwise clamp to the
  // floor rather than answering "nothing usable was stored".
  if (raw === null || raw.trim() === '') return DEFAULT_LIVE_LAYOUT_RATIO
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? clampLiveLayoutRatio(parsed) : DEFAULT_LIVE_LAYOUT_RATIO
}

export function saveLiveLayoutRatio(ratio: number): void {
  localStorage.setItem(RATIO_KEY, String(clampLiveLayoutRatio(ratio)))
}

function loadFlag(key: string): boolean {
  return localStorage.getItem(key) === 'true'
}

function saveFlag(key: string, value: boolean): void {
  // `removeItem` rather than storing `'false'`: an absent key and an explicit
  // false read identically on load, so there is no reason to write bytes for
  // the state every fresh browser starts in.
  if (value) localStorage.setItem(key, 'true')
  else localStorage.removeItem(key)
}

export function loadBoardHidden(): boolean {
  return loadFlag(BOARD_HIDDEN_KEY)
}

export function saveBoardHidden(hidden: boolean): void {
  saveFlag(BOARD_HIDDEN_KEY, hidden)
}

export function loadChatHidden(): boolean {
  return loadFlag(CHAT_HIDDEN_KEY)
}

export function saveChatHidden(hidden: boolean): void {
  saveFlag(CHAT_HIDDEN_KEY, hidden)
}

/** Whether the chat comes first (above / left of) the board. */
export function loadLiveSwapped(): boolean {
  return loadFlag(SWAPPED_KEY)
}

export function saveLiveSwapped(swapped: boolean): void {
  saveFlag(SWAPPED_KEY, swapped)
}

/** Every persisted layout preference, read once at mount. */
export interface LiveLayoutPrefs {
  arrangement: LiveArrangement
  ratio: number
  boardHidden: boolean
  chatHidden: boolean
  swapped: boolean
}

export function loadLiveLayout(): LiveLayoutPrefs {
  return {
    arrangement: loadLiveArrangement(),
    ratio: loadLiveLayoutRatio(),
    boardHidden: loadBoardHidden(),
    chatHidden: loadChatHidden(),
    swapped: loadLiveSwapped(),
  }
}

export type LivePane = 'board' | 'chat'

/** Which panes are on screen. The board needs a history to show at all, and
 *  the conversation is never absent with nothing else to show — so a stored
 *  "chat hidden" with no board (or a hand-edited both-hidden) still answers
 *  with the chat, rather than an empty panel. */
export function visiblePanes(
  prefs: Pick<LiveLayoutPrefs, 'boardHidden' | 'chatHidden'>,
  hasBoards: boolean,
): { board: boolean; chat: boolean } {
  const board = hasBoards && !prefs.boardHidden
  return { board, chat: !prefs.chatHidden || !board }
}

/** The toolbar's show/hide toggle for one pane. Hiding the last visible pane
 *  is not a state: it shows the other one instead, so the press swaps which
 *  one is up rather than emptying the panel. With no board history the
 *  conversation is the only pane and its toggle changes nothing. */
export function togglePane<T extends Pick<LiveLayoutPrefs, 'boardHidden' | 'chatHidden'>>(
  prefs: T,
  pane: LivePane,
  hasBoards: boolean,
): T {
  if (!hasBoards) return prefs
  const shown = visiblePanes(prefs, hasBoards)
  const hide = shown[pane]
  const other: LivePane = pane === 'board' ? 'chat' : 'board'
  const next = { ...prefs }
  const set = (p: LivePane, hidden: boolean) => {
    if (p === 'board') next.boardHidden = hidden
    else next.chatHidden = hidden
  }
  set(pane, hide)
  if (hide && !shown[other]) set(other, false)
  return next
}

/** The panes in the order they are laid out, first = above / left. */
export function paneOrder(swapped: boolean): [LivePane, LivePane] {
  return swapped ? ['chat', 'board'] : ['board', 'chat']
}

/** The stored ratio is always the *board's* share; a drag measures the first
 *  pane's, which is the chat's once the panes are swapped. */
export function dividerToRatio(fraction: number, swapped: boolean): number {
  return clampLiveLayoutRatio(swapped ? 1 - fraction : fraction)
}
