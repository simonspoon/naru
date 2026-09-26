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
const BOARD_COLLAPSED_KEY = 'mesa-live-board-collapsed'
const CHAT_COLLAPSED_KEY = 'mesa-live-chat-collapsed'

export const DEFAULT_ARRANGEMENT: LiveArrangement = 'stacked'

/** The board's share of the panel when both sections are showing — the
 *  divider's own position. An even split until the person drags it. */
export const DEFAULT_LIVE_LAYOUT_RATIO = 0.5

/** Neither section may be dragged away to nothing: each end of the divider's
 *  travel still leaves the section on that side a usable sliver rather than a
 *  header strip with no body under it (folding it is how you get that). */
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
  // the state every fresh browser already starts in.
  if (value) localStorage.setItem(key, 'true')
  else localStorage.removeItem(key)
}

export function loadBoardCollapsed(): boolean {
  return loadFlag(BOARD_COLLAPSED_KEY)
}

export function saveBoardCollapsed(collapsed: boolean): void {
  saveFlag(BOARD_COLLAPSED_KEY, collapsed)
}

export function loadChatCollapsed(): boolean {
  return loadFlag(CHAT_COLLAPSED_KEY)
}

export function saveChatCollapsed(collapsed: boolean): void {
  saveFlag(CHAT_COLLAPSED_KEY, collapsed)
}

/** Every persisted layout preference, read once at mount. */
export interface LiveLayoutPrefs {
  arrangement: LiveArrangement
  ratio: number
  boardCollapsed: boolean
  chatCollapsed: boolean
}

export function loadLiveLayout(): LiveLayoutPrefs {
  return {
    arrangement: loadLiveArrangement(),
    ratio: loadLiveLayoutRatio(),
    boardCollapsed: loadBoardCollapsed(),
    chatCollapsed: loadChatCollapsed(),
  }
}
