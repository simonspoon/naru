// The pieces of the code editor's keyboard and text handling that are this
// app's own decisions rather than CodeMirror's (mesa task 809, trimmed to these
// in naru task 2742 when `CodeEditor.tsx` moved onto CodeMirror 6): how a file
// is indented, when a Tab is a focus move instead of an indent, and the one
// contiguous edit between two versions of a text. Indenting, auto-indent on
// Enter, auto-closed pairs and typing over them are CodeMirror's now.
//
// It is a pure module for the reason `navOrder.ts`, `fileTabs.ts` and
// `newFile.ts` are: the part that ships wrong is what an input *resolves to*,
// and that is reachable by vitest, whereas nothing about it is visible in a
// screenshot. Every function is total and side-effect-free.

/** Two spaces — the fallback unit, used for a file that has no indentation to
 * learn from (a new file, a flat config). One unit, not a tab-stop calculation:
 * a tab stop only differs from a fixed unit when the caret sits
 * mid-indentation, which is the case nobody types into. */
export const INDENT_UNIT = '  '

/** How many lines of a file are worth reading to decide how it is indented.
 * A whole 256 KiB file per keystroke would be a scan nobody asked for, and a
 * file whose first two hundred lines say nothing about its indentation is not
 * going to be settled by its last two hundred either. */
const DETECT_LINES = 200

/**
 * The indent unit *this file* is written with — one tab, or the run of spaces
 * its own lines are indented in multiples of.
 *
 * This exists because the editor browses arbitrary repos, not this one: mesa's
 * own `src/*.rs` is four spaces and `scripts/*.sh` is tabs, and a hardcoded two
 * spaces means Tab inserts the wrong width in both. Worse than wrong is
 * *mixed*: a new line after `{` gets the line's existing whitespace plus one
 * unit, so a fixed two spaces turns a tab-indented block into
 * tabs-then-spaces — mixed indentation written back to disk by a tool the user
 * opened to change one line.
 *
 * The rule is the cheap version of what every editor does: tally the leading
 * whitespace of the first `DETECT_LINES` indented lines, and answer whichever
 * width occurred most often, ties going to the narrower (a 2-space file has
 * plenty of 4-column continuation lines; a 4-space file has almost no 2s). A
 * tab anywhere in the leading whitespace is a vote for tabs, and tabs win
 * outright when they outnumber every single space width — a file cannot be
 * indented with both, and a stray aligned comment must not turn a tab file into
 * a space file.
 *
 * A heuristic, deliberately: it decides what a *new* indent looks like and
 * never rewrites indentation that is already there, so the worst a wrong answer
 * does is insert a two-space indent in a four-space file — which is what
 * shipped before this function existed.
 */
export function detectIndentUnit(value: string): string {
  const widths = new Map<number, number>()
  let tabs = 0
  let seen = 0
  let at = 0
  while (at <= value.length && seen < DETECT_LINES) {
    const brk = value.indexOf('\n', at)
    const line = value.slice(at, brk === -1 ? value.length : brk)
    at = (brk === -1 ? value.length : brk) + 1
    const indent = line.match(/^[ \t]+/)?.[0]
    // A line with no indentation says nothing, and a blank line's whitespace is
    // trailing whitespace rather than an indent.
    if (indent === undefined || indent.length === line.length) {
      if (brk === -1) break
      continue
    }
    seen++
    if (indent.includes('\t')) tabs++
    else widths.set(indent.length, (widths.get(indent.length) ?? 0) + 1)
    if (brk === -1) break
  }
  let best = 0
  let bestVotes = 0
  for (const [width, votes] of widths) {
    if (votes > bestVotes || (votes === bestVotes && width < best)) {
      best = width
      bestVotes = votes
    }
  }
  if (tabs > bestVotes) return '\t'
  if (best === 0) return INDENT_UNIT
  // Eight is where an indent stops being an indent and starts being alignment;
  // anything wider is far more likely to be a continuation line than a unit.
  return ' '.repeat(Math.min(best, 8))
}

/** Keys that are held rather than typed. They must not disarm the hatch below,
 * or Escape-then-**Shift**+Tab would be disarmed by the Shift itself. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

/**
 * Whether the *next* Tab should move focus instead of indenting, given whether
 * it already should and the key that was just pressed.
 *
 * The editor takes Tab and Shift+Tab away from the browser, which takes away
 * the keyboard route out of the box: one indents and the other dedents. That
 * is a keyboard trap (WCAG 2.1.2), and it is worst on the Scripts page, where this
 * editor is one field of a form whose other controls sit below it and nothing
 * binds Escape at all.
 *
 * So Escape arms one Tab as a plain focus move — CodeMirror's and VS Code's
 * convention, and the one that costs nothing anywhere else: any other typed key
 * disarms it, so a user who presses Escape and keeps typing never notices, and
 * a caller that also acts on Escape (the Files tab discards the edit) is
 * unaffected because its editor is gone by then.
 */
export function tabEscapeAfter(armed: boolean, key: string): boolean {
  if (MODIFIER_KEYS.has(key)) return armed
  return key === 'Escape'
}

/** The single contiguous edit that turns `before` into `after`, as the range to
 * replace and the text to put there.
 *
 * This is how a `value` handed down from outside is applied to the editor
 * (`CodeEditor.tsx`): replacing the whole document would throw the caret to
 * the end and every fold open, while a change confined to the span that really
 * differs lets the editor map the caret, the selection and its undo history
 * through it. Common prefix and suffix give that span, and it is exact for
 * the edits that actually arrive this way — the other pane of a split typing
 * into the same draft is one contiguous insertion or deletion. */
export function replacementRange(
  before: string,
  after: string,
): { start: number; end: number; text: string } {
  const shortest = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < shortest && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }
  return {
    start: prefix,
    end: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
  }
}
