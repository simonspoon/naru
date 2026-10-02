// The keyboard bridge out of an `html` live whiteboard (mesa task 1599).
//
// An html board is an `<iframe sandbox="allow-scripts">` served under
// `RENDER_CSP` — an opaque-origin document, so a keydown inside it never
// reaches the app's `window` listeners and every global shortcut (the listen
// switch, the discard key, the palette) goes dead while focus sits in the
// board. The render route therefore appends a tiny relay script to html
// boards (`BOARD_KEY_RELAY` in `src/api.rs`) that posts each keydown to its
// parent; the hub re-dispatches it on `window`. These are the pure halves:
// the strict shape check on what the frame sends, and which bare function
// keys the keymap binds (the set the parent hands the frame so it can
// `preventDefault` them — a rebound F5 must not also reload the tab, while an
// unbound F-key keeps its browser default).

import { parseChord, type Keymap } from './keymap'

/** What a frame posts for one keystroke — exactly the fields a
 *  `KeyboardEvent` needs for `matchesShortcut` to judge it. */
export interface BoardKey {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
}

/** `keymap.ts`/`keyboardScope.ts`'s function-key family, F1 through F24. */
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/

/** The frame's message, or `null` for anything that is not exactly one (or is
 *  a key the relay would never forward). The
 *  sender is an untrusted document, so every field is type-checked and the
 *  strings bounded. */
export function parseBoardKey(data: unknown): BoardKey | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.naru !== 'board-key') return null
  if (typeof d.key !== 'string' || d.key === '' || d.key.length > 32) return null
  if (typeof d.code !== 'string' || d.code.length > 32) return null
  for (const f of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'repeat'] as const) {
    if (typeof d[f] !== 'boolean') return null
  }
  // The relay's own filter, applied again: a board's script can post this
  // message too, and a forged bare `Escape` or `a` must not reach the app's
  // shortcuts — only a function key or a Meta/Ctrl/Alt chord ever does.
  if (!FUNCTION_KEY.test(d.key) && !(d.metaKey || d.ctrlKey || d.altKey)) return null
  return {
    key: d.key,
    code: d.code,
    metaKey: d.metaKey as boolean,
    ctrlKey: d.ctrlKey as boolean,
    altKey: d.altKey as boolean,
    shiftKey: d.shiftKey as boolean,
    repeat: d.repeat as boolean,
  }
}

/** Every bare (no-modifier) function key some action in the keymap binds,
 *  sorted and de-duplicated — the frame's `preventDefault` set. */
export function boundFunctionKeys(keymap: Keymap): string[] {
  const keys = new Set<string>()
  for (const chords of Object.values(keymap)) {
    for (const chord of chords) {
      const p = parseChord(chord)
      if (p && !p.mod && !p.alt && !p.shift && FUNCTION_KEY.test(p.key)) keys.add(p.key)
    }
  }
  return [...keys].sort()
}
