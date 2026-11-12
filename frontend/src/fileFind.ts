// Find-in-file for the Files tab (mesa task 809): every decision the find bar
// makes about *where* the matches are, kept out of the components that paint
// them. It lives here for the reason the other pure modules do — an off-by-one
// in "3 of 7", a whole-word rule that eats `don` out of `don't`, or a wrap-
// around that skips the first match are all invisible in a screenshot and
// obvious in a unit test.
//
// Two callers, one enumeration: the read-only pane paints every match as a
// highlight layer over the code, and the editor selects one match at a time in
// its textarea. Both work in **offsets into the same string**, which is why
// nothing here knows about lines, DOM nodes or Prism markup.
//
// The search is a literal substring scan unless the user turns the regex toggle
// on (naru task 2743). A query is a user's typing, not a pattern language:
// treating it as a `RegExp` by default would turn `(` into a syntax error and
// `.*` into a surprise. With the toggle on the query *is* a pattern, an invalid
// one is reported (`FindResult.error`) rather than thrown, and the matches are
// still plain offset ranges, so everything downstream is unchanged.
//
// Replace (naru task 2743) is decided here too, as a list of edits against the
// searched text (`replaceEdits`); the editor applies them as one transaction.

/** One hit, as a half-open offset range into the searched text. */
export interface FindMatch {
  start: number
  end: number
}

/** The toggles the bar offers. All off is the plain case. `regex` is optional
 * so a caller with no such toggle (the project search panel) need not say. */
export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex?: boolean
}

/** What `findMatches` answers: the hits, and whether it stopped early. */
export interface FindResult {
  matches: FindMatch[]
  /** True when the file holds more matches than were returned. */
  capped: boolean
  /** Set when the query is not a valid regular expression (regex mode only). */
  error?: string
}

/** The most matches one search reports.
 *
 * Not a performance guess: the read-only pane renders one element per match,
 * and a single-letter query against a 256 KiB file (the content route's own
 * ceiling) is tens of thousands of them — enough DOM to lock the tab up for
 * seconds on a keystroke that was probably a typo on the way to a longer word.
 * Stopping is the honest answer, and `capped` is how the label says so ("1 of
 * 2000+") rather than quietly claiming the file has exactly this many. */
export const MAX_FIND_MATCHES = 2000

/** The word characters a whole-word boundary is drawn against — ASCII letters,
 * digits and `_`, the same set every editor's "Whole Word" toggle uses. Not
 * `\w` on a unicode-aware class: widening it would change which matches a
 * stored preference finds, and this is a code browser. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch)
}

/** True when `a` and `b` are the same character under the chosen case rule.
 *
 * Folded per character rather than by lowercasing the whole file, and that is
 * load-bearing: `'İ'.toLowerCase()` is *two* code units, so a lowercased copy
 * of the text is not offset-for-offset the original, and every match found in
 * it would point at the wrong place in the string the caller is about to
 * highlight. Folding one character at a time can only ever answer "these two
 * are the same or they are not", so the offsets stay exact. (The cost is that
 * a case-expanding character never matches its lowercase form — a fair trade
 * against silently misplaced highlights.) */
function sameChar(a: string, b: string, caseSensitive: boolean): boolean {
  if (a === b) return true
  if (caseSensitive) return false
  return a.toLowerCase() === b.toLowerCase()
}

function matchesAt(
  text: string,
  query: string,
  at: number,
  caseSensitive: boolean,
): boolean {
  for (let i = 0; i < query.length; i++) {
    if (!sameChar(text[at + i], query[i], caseSensitive)) return false
  }
  return true
}

/**
 * Every match of `query` in `text`, in order, never overlapping.
 *
 * An empty query is "no matches", not "every position": the bar is live as the
 * user types, and the moment before the first character is the moment the whole
 * file would otherwise light up.
 *
 * Whole-word asks for a boundary only on the sides where the *query itself*
 * ends in a word character — searching `(x` with the toggle on still finds
 * `f(x)`, because a `(` has no word boundary to demand. That is what VS Code
 * does, and the alternative (always demanding one) makes the toggle silently
 * useless for anything but bare identifiers.
 *
 * Termination is structural: the scan index only ever moves forward, by one
 * position on a miss and by the whole (non-empty) query on a hit, so no input
 * can loop.
 */
export function findMatches(
  text: string,
  query: string,
  options: FindOptions,
  limit: number = MAX_FIND_MATCHES,
): FindResult {
  if (query === '') return { matches: [], capped: false }
  if (options.regex) return findRegexMatches(text, query, options, limit)
  const matches: FindMatch[] = []
  const headIsWord = isWordChar(query[0])
  const tailIsWord = isWordChar(query[query.length - 1])
  for (let i = 0; i + query.length <= text.length; i++) {
    if (!matchesAt(text, query, i, options.caseSensitive)) continue
    const end = i + query.length
    if (options.wholeWord) {
      if (headIsWord && isWordChar(text[i - 1])) continue
      if (tailIsWord && isWordChar(text[end])) continue
    }
    matches.push({ start: i, end })
    // One past the cap is what proves there *are* more — reporting `capped`
    // off a full array alone would flag a file holding exactly the cap.
    if (matches.length > limit) {
      matches.pop()
      return { matches, capped: true }
    }
    i = end - 1
  }
  return { matches, capped: false }
}

/** The query as a pattern, or the reason it is not one. `m` so `^`/`$` are
 * per line, which is what a find over a file means by them. */
function compileQuery(query: string, caseSensitive: boolean, sticky: boolean): RegExp | string {
  try {
    return new RegExp(query, `${sticky ? 'y' : 'g'}m${caseSensitive ? '' : 'i'}`)
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid regular expression'
  }
}

/** Whether `[start, end)` passes the whole-word rule — the literal scan's rule,
 * asked of the matched text: a boundary only on the sides that end in a word
 * character. */
function wordBounded(text: string, start: number, end: number): boolean {
  if (isWordChar(text[start]) && isWordChar(text[start - 1])) return false
  if (isWordChar(text[end - 1]) && isWordChar(text[end])) return false
  return true
}

/**
 * `findMatches` for a regex query. Same contract: in order, never overlapping,
 * capped one past `limit`.
 *
 * An empty match (`a*` between letters, a bare `^`) is skipped, not reported:
 * there is nothing to highlight or replace in it, and stepping past it by one
 * is also what keeps the scan moving forward on every iteration.
 */
function findRegexMatches(
  text: string,
  query: string,
  options: FindOptions,
  limit: number,
): FindResult {
  const re = compileQuery(query, options.caseSensitive, false)
  if (typeof re === 'string') return { matches: [], capped: false, error: re }
  const matches: FindMatch[] = []
  let hit: RegExpExecArray | null
  while ((hit = re.exec(text)) !== null) {
    const start = hit.index
    const end = start + hit[0].length
    if (end === start || (options.wholeWord && !wordBounded(text, start, end))) {
      re.lastIndex = start + 1
      continue
    }
    matches.push({ start, end })
    if (matches.length > limit) {
      matches.pop()
      return { matches, capped: true }
    }
  }
  return { matches, capped: false }
}

/** One replacement: `[start, end)` of the searched text becomes `text`. */
export interface TextEdit {
  start: number
  end: number
  text: string
}

/**
 * A regex replacement template with its `$` forms filled in: `$1`..`$99` are
 * capture groups, `$&` the whole match, `$$` a literal dollar. `groups` is the
 * match array (`groups[0]` the whole match). A number naming no group is left
 * as typed, the way `String.prototype.replace` leaves it; a group that did not
 * take part in the match is empty.
 */
export function expandReplacement(
  template: string,
  groups: readonly (string | undefined)[],
): string {
  return template.replace(/\$(\$|&|\d{1,2})/g, (whole, token: string) => {
    if (token === '$') return '$'
    if (token === '&') return groups[0] ?? ''
    // Two digits when that group exists, else the first digit alone.
    if (token.length === 2 && Number(token) >= 1 && Number(token) < groups.length) {
      return groups[Number(token)] ?? ''
    }
    const one = Number(token[0])
    if (one >= 1 && one < groups.length) return (groups[one] ?? '') + token.slice(1)
    return whole
  })
}

/**
 * The edits that replace matches of `query` in `text` with `replacement` —
 * every match, or just `only` (the one the bar is on).
 *
 * Every match means **every** match: the scan is not held to
 * `MAX_FIND_MATCHES`, which exists for the highlight layer's DOM and has no
 * bearing on rewriting a string. Replacing the first 2000 of 5000 and stopping
 * would leave a file half-changed behind a label that said "all".
 *
 * `only` is looked up among the real matches rather than trusted, so a match
 * that is stale (the text moved under it) replaces nothing instead of the
 * wrong characters. In regex mode the template's `$1` forms are filled from
 * that match's own groups; in literal mode the replacement is verbatim.
 */
export function replaceEdits(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions,
  only?: FindMatch,
): { edits: TextEdit[]; error?: string } {
  const { matches, error } = findMatches(text, query, options, Infinity)
  if (error !== undefined) return { edits: [], error }
  const targets =
    only === undefined
      ? matches
      : matches.filter((m) => m.start === only.start && m.end === only.end)
  if (!options.regex) {
    return { edits: targets.map((m) => ({ ...m, text: replacement })) }
  }
  const re = compileQuery(query, options.caseSensitive, true)
  if (typeof re === 'string') return { edits: [], error: re }
  const edits: TextEdit[] = []
  for (const m of targets) {
    re.lastIndex = m.start
    const groups = re.exec(text)
    // The sticky pattern matches here by construction (the scan found it);
    // the whole match is the fallback only so a miss cannot throw.
    edits.push({ ...m, text: expandReplacement(replacement, groups ?? [text.slice(m.start, m.end)]) })
  }
  return { edits }
}

/** `text` with `edits` applied — ordered, non-overlapping, offsets into `text`
 * itself (what `replaceEdits` returns, and what the editor's transaction takes). */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = ''
  let at = 0
  for (const edit of edits) {
    out += text.slice(at, edit.start) + edit.text
    at = edit.end
  }
  return out + text.slice(at)
}

/**
 * The match a fresh search should land on, given where the caret is: the first
 * one at or after `offset` going forward, the last one before it going back —
 * and, with none in that direction, the one at the far end, because a find bar
 * that reported "no results" for a file full of matches merely because the
 * caret sat past the last one would be lying.
 *
 * `-1` when there is nothing to land on. That is the only case: the wrap makes
 * every other input answer with a real index.
 */
export function matchIndexFrom(
  matches: FindMatch[],
  offset: number,
  forward: boolean,
): number {
  if (matches.length === 0) return -1
  if (forward) {
    const i = matches.findIndex((m) => m.start >= offset)
    return i === -1 ? 0 : i
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].start < offset) return i
  }
  return matches.length - 1
}

/**
 * Next/previous from the match currently shown, wrapping at both ends — Enter
 * on the last match goes back to the first, which is what every editor does and
 * what makes Enter-Enter-Enter a way to walk a file rather than a way to get
 * stuck at the bottom of it.
 *
 * An index that is not a real match (nothing selected yet, or a list that
 * shrank under it as the query grew) enters at the near end for the direction
 * asked, rather than being treated as position zero.
 */
export function stepMatch(
  matches: FindMatch[],
  index: number,
  forward: boolean,
): number {
  const total = matches.length
  if (total === 0) return -1
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    return forward ? 0 : total - 1
  }
  return forward ? (index + 1) % total : (index - 1 + total) % total
}

/**
 * Where the *next* search should start from, once the user has stepped onto a
 * match: that match's own start, or the anchor they had if there is no match to
 * take one from.
 *
 * The anchor a search runs from is captured when the bar opens, so that growing
 * a query walks forward from what the user was looking at rather than jumping
 * about as the caret follows each selection. That is right for the first few
 * characters and wrong the moment a step has happened: search `foo`, press
 * Enter four times to reach a match 800 lines down, then type one more
 * character to narrow it to `foobar`, and a fixed anchor teleports you back to
 * the first `foobar` at or after where you *started*. Every editor re-anchors
 * on the current match so that refining a query narrows in place, and this is
 * that rule — it moves only on a step, so a freshly opened bar still anchors
 * where it always did.
 */
export function anchorAfterStep(
  matches: FindMatch[],
  index: number,
  fallback: number,
): number {
  if (!Number.isInteger(index) || index < 0 || index >= matches.length) {
    return fallback
  }
  return matches[index].start
}

/**
 * The counter beside the query box.
 *
 * "No results" rather than "0 of 0" for the empty case: zero of zero reads as a
 * broken counter, and this is the one state the user needs to recognise at a
 * glance. An index outside the list is clamped rather than shown as `0 of N` —
 * with matches on screen there is always one of them current.
 */
export function matchLabel(
  index: number,
  total: number,
  capped: boolean,
): string {
  if (total <= 0) return 'No results'
  const shown = Math.min(Math.max(Math.trunc(index), 0), total - 1)
  return `${shown + 1} of ${total}${capped ? '+' : ''}`
}

/** A run of the searched text: plain when `match` is `-1`, otherwise the index
 * of the match it is. */
export interface FindSegment {
  text: string
  match: number
}

/**
 * `text` cut into alternating plain and matched runs, ready to be painted as
 * one element per run.
 *
 * This exists so the highlight layer is built from the *same string* the search
 * ran over and never from the syntax-highlighted markup beside it: Prism's
 * output is a tree of nested spans whose text nodes cut across match
 * boundaries, and splicing highlights into it would mean rewriting somebody
 * else's DOM by offset — one bad boundary and the colouring is corrupt. A flat
 * list of runs, rendered as its own inert layer over an untouched Prism tree,
 * cannot corrupt anything: the worst a bug here can do is misplace a
 * background.
 *
 * Defensive about its input (out-of-range, empty or out-of-order ranges are
 * skipped) because a match list and the text it came from can disagree for one
 * render while a draft is being typed.
 */
export function findSegments(text: string, matches: FindMatch[]): FindSegment[] {
  const out: FindSegment[] = []
  let at = 0
  matches.forEach((m, i) => {
    const start = Math.max(m.start, at)
    const end = Math.min(m.end, text.length)
    if (end <= start) return
    if (start > at) out.push({ text: text.slice(at, start), match: -1 })
    out.push({ text: text.slice(start, end), match: i })
    at = end
  })
  if (at < text.length) out.push({ text: text.slice(at), match: -1 })
  return out
}

/**
 * The scroll offset that brings a **measured** box into a viewport, moving as
 * little as possible — the "reveal" every editor does when a search lands off
 * screen, and nothing when the box is already visible (stepping between two
 * matches on screen must not jump the view). A missing or nonsensical
 * measurement leaves the scroll alone rather than jumping to the start.
 *
 * Its caller is the sideways reveal below. (The editor reveals a match through
 * CodeMirror's own scroll-into-view, and the viewer's *vertical* reveal is a
 * real `scrollIntoView` on the current `<mark>`.)
 */
export function scrollTopForBox(
  top: number,
  height: number,
  viewportHeight: number,
  scrollTop: number,
): number {
  if (!Number.isFinite(top) || !Number.isFinite(height)) return scrollTop
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return scrollTop
  const bottom = top + Math.max(height, 0)
  if (top < scrollTop) return Math.max(top, 0)
  if (bottom > scrollTop + viewportHeight) {
    return Math.max(bottom - viewportHeight, 0)
  }
  return scrollTop
}

/**
 * Whether a measured box has to be scrolled to at all: true when it falls
 * outside the *readable* band of a viewport, false when it is already inside
 * it.
 *
 * The viewer reveals a match by handing the mark to `scrollIntoView({block:
 * 'center'})`, which has no "already visible" case — it re-centres
 * unconditionally, so stepping between two matches a few lines apart threw the
 * file up or down by half a pane on every Enter, while the editor beside it (via
 * `scrollTopForBox`, which returns the current scroll for a box already in view)
 * did not move at all. Two panes, one keystroke, two behaviours, and the rule
 * this module already states — "nothing when the line is already visible" — was
 * implemented on only one of them. This is that test, for the caller that cannot
 * express it as a scroll offset.
 *
 * The band is not the scrollport: `.files-content-top` (header + find bar) is
 * pinned over its top and the status bar over its bottom, so a match under
 * either is *painted* and not *readable*, and reporting it as visible is the
 * same class of mistake `scrollLeftForBox`'s lead-in exists for on the other
 * axis. Callers pass the band, in the same coordinate space as the box, rather
 * than the function knowing about any of those elements.
 *
 * A measurement it cannot use — a non-finite number, or a band with no height
 * because the pane is not laid out yet — answers "reveal it": scrolling to a
 * match that was already on screen is a jump, but skipping one that was not is
 * the silent "the counter stepped and the view sat still" failure.
 */
export function boxNeedsReveal(
  top: number,
  height: number,
  bandTop: number,
  bandBottom: number,
): boolean {
  if (!Number.isFinite(top) || !Number.isFinite(height)) return true
  if (!Number.isFinite(bandTop) || !Number.isFinite(bandBottom)) return true
  if (bandBottom <= bandTop) return true
  return top < bandTop || top + Math.max(height, 0) > bandBottom
}

/**
 * The same reveal sideways: the `scrollLeft` that brings a measured box into a
 * horizontal scrollport whose leftmost `obscuredLeft` pixels are painted over.
 *
 * A separate function rather than a second call to `scrollTopForBox` because
 * the horizontal viewport is not the whole box. A line-number gutter is an
 * opaque layer over the left edge of the same scrollport — absolutely
 * positioned in the editor's stack, `position: sticky` in the viewer's row —
 * so a reveal that merely brought a match to `scrollLeft` would put it exactly
 * *under* the numbers and report success. Nothing vertical has an equivalent —
 * the header, the find bar and the status bar are outside both boxes — which is
 * why the lead-in lives here and not in the function above.
 *
 * **Both panes need it**, which is why the lead-in is a parameter rather than
 * the editor's own constant. In the editor sideways matters at all only because
 * the reveal deliberately leaves the textarea unfocused while the find bar steps
 * (`CodeEditor.reveal`), so the browser never scrolls the selection into view by
 * itself. The viewer *has* an element to scroll to and uses `scrollIntoView` for
 * the vertical half — but `inline: 'nearest'` aligns a match lying left of the
 * view flush to the scrollport's left edge, i.e. behind the sticky gutter, since
 * nothing tells the browser that band is covered. One pane arrives here from
 * arithmetic it cannot do and the other from a call that does not know about
 * overlays; the answer is the same either way.
 *
 * *Measured* from the find layer's mark rather than calculated from a column,
 * because a column offset is not a pixel offset once a tab or a wide glyph is in
 * the line.
 */
export function scrollLeftForBox(
  left: number,
  width: number,
  viewportWidth: number,
  scrollLeft: number,
  obscuredLeft: number,
): number {
  const lead =
    Number.isFinite(obscuredLeft) && obscuredLeft > 0 ? obscuredLeft : 0
  // Shifting the box left by the lead-in and growing it by the same amount is
  // exactly "keep it inside the *unobscured* band": the left test then fires
  // while the box is still under the gutter, and the right edge is unchanged.
  return scrollTopForBox(left - lead, width + lead, viewportWidth, scrollLeft)
}
