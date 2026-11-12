// The pure half of the diff views (naru task 2734): the unified-diff parser
// `SideBySideDiff` (Files tab) and `DiffView` (Git tab) both render from, plus
// the word-level diff, the syntax-token plumbing and the small decisions the
// Git tab's view makes. No DOM, no React — everything here is covered by
// `diffModel.test.ts`.

import type { CSSProperties } from 'react'

/** One side of one rendered row: the line's number in that version of the
 * file, and its text with the unified-diff marker already stripped. `noEol`
 * marks a line git annotated with "\ No newline at end of file". */
export type Side = { no: number; text: string; noEol?: true }

/** A row of the side-by-side rendering. `hunk`/`meta` span the full width
 * (a `@@ … @@` header, or a line the parser can't place — e.g. the
 * `[diff truncated]` notice the server appends past DIFF_CAP); the rest
 * carry an old-side and/or new-side cell. */
export type DiffRow =
  // `hunk` and `meta` are separate members rather than one with a two-literal
  // `kind`, so TypeScript can subtract them one at a time and narrow the
  // remaining member in the `else` branch of a render.
  | { kind: 'hunk'; text: string }
  | { kind: 'meta'; text: string }
  | {
      kind: 'ctx' | 'chg' | 'del' | 'add'
      left: Side | null
      right: Side | null
    }

/** What the lines before the first hunk say about the file as a whole. */
export type DiffFileInfo = {
  /** "Binary files … differ" or a `GIT binary patch`: no text diff exists. */
  binary: boolean
  isNew: boolean
  deleted: boolean
  renameFrom: string | null
  renameTo: string | null
  /** Set by a mode-only change (`old mode` / `new mode` lines). */
  oldMode: string | null
  newMode: string | null
}

export type ParsedDiff = {
  rows: DiffRow[]
  file: DiffFileInfo
  /** Lines added / removed across every hunk. */
  added: number
  removed: number
  /** The server cut the diff at its cap and appended its notice. */
  truncated: boolean
}

/** The line `git.rs::capped` appends when it cuts a diff at DIFF_CAP. */
export const TRUNCATED_NOTICE = '[diff truncated]'

/**
 * Parses a unified diff into aligned old|new rows.
 *
 * Runs of `-` and `+` lines inside a hunk are buffered and flushed together
 * so the i-th deletion sits opposite the i-th addition (`chg`), with the
 * longer run's leftover lines rendered against an empty cell (`del`/`add`) —
 * the standard split-diff pairing. Line numbers come from each hunk's
 * `@@ -a,b +c,d @@` header and advance per side, so they stay the file's
 * real numbers rather than row indices.
 *
 * Everything before the first hunk header (`diff --git`, `index`, `---`,
 * `+++`, mode/rename lines) produces no row: the pane already names the file,
 * and those lines would otherwise be misread as content by the `-`/`+` prefix
 * checks. They are read for `file` instead. A diff with no hunk at all
 * therefore parses to no rows — a binary file, a mode-only change, a rename
 * without a content change, an empty file — and `emptyDiffReason` names which.
 */
export function parseDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = []
  const file: DiffFileInfo = {
    binary: false,
    isNew: false,
    deleted: false,
    renameFrom: null,
    renameTo: null,
    oldMode: null,
    newMode: null,
  }
  let added = 0
  let removed = 0
  let truncated = false
  const lines = diff.split('\n')
  // `split('\n')` on text ending in a newline yields a trailing '' that is
  // not a line of the diff.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  let leftNo = 0
  let rightNo = 0
  let started = false
  let dels: Omit<Side, 'no'>[] = []
  let adds: Omit<Side, 'no'>[] = []
  // The line a "\ No newline at end of file" annotation would attach to.
  let last: 'del' | 'add' | 'ctx' | null = null

  function flush() {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) {
      const left = i < dels.length ? { no: leftNo++, ...dels[i] } : null
      const right = i < adds.length ? { no: rightNo++, ...adds[i] } : null
      rows.push({
        kind: left && right ? 'chg' : left ? 'del' : 'add',
        left,
        right,
      })
    }
    removed += dels.length
    added += adds.length
    dels = []
    adds = []
  }

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush()
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        leftNo = Number(m[1])
        rightNo = Number(m[2])
      }
      rows.push({ kind: 'hunk', text: line })
      started = true
      last = null
      continue
    }
    if (!started) {
      if (line === TRUNCATED_NOTICE) truncated = true
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch')
        file.binary = true
      else if (line.startsWith('new file mode ')) file.isNew = true
      else if (line.startsWith('deleted file mode ')) file.deleted = true
      else if (line.startsWith('old mode ')) file.oldMode = line.slice(9)
      else if (line.startsWith('new mode ')) file.newMode = line.slice(9)
      else if (line.startsWith('rename from ')) file.renameFrom = line.slice(12)
      else if (line.startsWith('rename to ')) file.renameTo = line.slice(10)
      continue
    }
    // "\ No newline at end of file" annotates the preceding line; it is not
    // a line of either version.
    if (line.startsWith('\\')) {
      if (last === 'del' && dels.length > 0) dels[dels.length - 1].noEol = true
      else if (last === 'add' && adds.length > 0)
        adds[adds.length - 1].noEol = true
      else if (last === 'ctx') {
        const row = rows[rows.length - 1]
        if (row.kind === 'ctx' && row.left && row.right) {
          row.left.noEol = true
          row.right.noEol = true
        }
      }
      continue
    }
    if (line.startsWith('+')) {
      adds.push({ text: line.slice(1) })
      last = 'add'
      continue
    }
    if (line.startsWith('-')) {
      dels.push({ text: line.slice(1) })
      last = 'del'
      continue
    }
    if (line.startsWith(' ') || line === '') {
      flush()
      const text = line.slice(1)
      rows.push({
        kind: 'ctx',
        left: { no: leftNo++, text },
        right: { no: rightNo++, text },
      })
      last = 'ctx'
      continue
    }
    // Anything else inside a hunk isn't diff content — the truncation
    // notice, or the header of a second file in a multi-file diff.
    flush()
    if (line === TRUNCATED_NOTICE) truncated = true
    rows.push({ kind: 'meta', text: line })
    last = null
  }
  flush()
  return { rows, file, added, removed, truncated }
}

/**
 * What to say in place of a grid when a diff has no hunk, or `null` when the
 * shape is not one this knows (the caller then shows the server's text
 * verbatim, so nothing is ever hidden). Binary wins over the rest: a new
 * binary file is "binary", not "empty".
 */
export function emptyDiffReason(parsed: ParsedDiff): string | null {
  if (parsed.rows.some((r) => r.kind !== 'meta')) return null
  const f = parsed.file
  if (f.binary) return 'Binary file, no text diff.'
  if (f.renameFrom !== null && f.renameTo !== null)
    return 'Renamed without content changes.'
  if (f.oldMode !== null && f.newMode !== null)
    return `File mode changed from ${f.oldMode} to ${f.newMode}, no content change.`
  if (f.isNew) return 'Empty file added.'
  if (f.deleted) return 'Empty file deleted.'
  return null
}

/** A line's text without its trailing carriage return, and whether it had
 * one — a CRLF file's lines all end in `\r`, which is not content to colour
 * or to word-diff. */
export function stripCr(text: string): { text: string; cr: boolean } {
  return text.endsWith('\r')
    ? { text: text.slice(0, -1), cr: true }
    : { text, cr: false }
}

// ── Size limits ────────────────────────────────────────────────────────────

/** Above either of these a diff renders as plain lines: no syntax colour, no
 * word-level marks. A 5,000-line diff is past the line limit, so it costs one
 * pass of the parser and one grid of text cells. */
export const RICH_MAX_LINES = 2000
export const RICH_MAX_CHARS = 150_000
/** A single line longer than this (a minified bundle) gets neither, whatever
 * the size of the diff around it. */
export const RICH_MAX_LINE_CHARS = 2000

export function isRichDiff(diff: string): boolean {
  if (diff.length > RICH_MAX_CHARS) return false
  let lines = 1
  for (let i = diff.indexOf('\n'); i !== -1; i = diff.indexOf('\n', i + 1)) {
    if (++lines > RICH_MAX_LINES) return false
  }
  return true
}

// ── Word-level diff ────────────────────────────────────────────────────────

/** A half-open `[start, end)` span of a line's text, in UTF-16 units. */
export type Range = [number, number]

export type WordDiff = { old: Range[]; new: Range[] }

/** A word (letters, digits, `_`), a run of whitespace, or one other code
 * point. The `u` flag keeps an astral character whole. */
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu
const WORD = /[\p{L}\p{N}_]/u

/** Below this share of common (non-space) text, a pair is treated as two
 * different lines rather than an edit of one. */
const WORD_DIFF_MIN_SHARED = 0.25

/** The LCS table is `(n + 1) * (m + 1)` cells; past this the changed middle
 * is marked whole instead. */
const WORD_DIFF_MAX_CELLS = 250_000

function ranges(tokens: string[], changed: boolean[], offset: number): Range[] {
  const out: Range[] = []
  let pos = offset
  for (let i = 0; i < tokens.length; i++) {
    const end = pos + tokens[i].length
    if (changed[i]) {
      const prev = out[out.length - 1]
      if (prev && prev[1] === pos) prev[1] = end
      else out.push([pos, end])
    }
    pos = end
  }
  return out
}

/**
 * The spans that differ between the old and new text of one changed line
 * pair, by a longest-common-subsequence over word tokens.
 *
 * `null` means "do not mark": a line is empty or over `RICH_MAX_LINE_CHARS`,
 * or the two share no word (punctuation alone does not count) or less than a
 * quarter of their text — then the pair is two unrelated lines the parser
 * happened to put side by side, and the line tint already says so.
 */
export function wordDiff(oldText: string, newText: string): WordDiff | null {
  if (oldText === '' || newText === '') return null
  if (
    oldText.length > RICH_MAX_LINE_CHARS ||
    newText.length > RICH_MAX_LINE_CHARS
  )
    return null
  const a = oldText.match(TOKEN) ?? []
  const b = newText.match(TOKEN) ?? []

  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++

  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  const aChanged: boolean[] = new Array(am.length).fill(true)
  const bChanged: boolean[] = new Array(bm.length).fill(true)
  const n = am.length
  const m = bm.length
  const shared = a.slice(0, pre).concat(a.slice(a.length - suf))

  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= WORD_DIFF_MAX_CELLS) {
    const w = m + 1
    const t = new Uint16Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] =
          am[i] === bm[j]
            ? t[(i + 1) * w + j + 1] + 1
            : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        aChanged[i] = false
        bChanged[j] = false
        shared.push(am[i])
        i++
        j++
      } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++
      else j++
    }
  }

  if (!shared.some((tok) => WORD.test(tok))) return null
  // Mostly different: marking nearly everything says nothing the line tint
  // does not, and reads as noise.
  const solid = (tokens: string[]) =>
    tokens.reduce((n, tok) => (tok.trim() === '' ? n : n + tok.length), 0)
  if (solid(shared) < WORD_DIFF_MIN_SHARED * Math.max(solid(a), solid(b)))
    return null

  const offset = a.slice(0, pre).join('').length
  return {
    old: ranges(am, aChanged, offset),
    new: ranges(bm, bChanged, offset),
  }
}

// ── Syntax tokens ──────────────────────────────────────────────────────────

/** A run of one line's text and the Prism token classes it sits inside,
 * outermost first (`token` itself dropped). */
export type Seg = { text: string; classes: string[] }

/** The slice of a hast tree this reads — what `refractor.highlight` returns. */
export type HastNode = {
  type: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

/** Flattens a highlighted tree into lines of segments. The text is exactly
 * the highlighter's input, so the result has one entry per input line. */
export function hastLines(root: HastNode): Seg[][] {
  const lines: Seg[][] = [[]]
  function walk(node: HastNode, classes: string[]) {
    if (node.type === 'text') {
      const parts = (node.value ?? '').split('\n')
      parts.forEach((part, i) => {
        if (i > 0) lines.push([])
        if (part !== '') lines[lines.length - 1].push({ text: part, classes })
      })
      return
    }
    let inner = classes
    const own = node.properties?.className
    if (Array.isArray(own)) {
      const extra = own.filter(
        (c): c is string =>
          typeof c === 'string' && c !== 'token' && !classes.includes(c),
      )
      if (extra.length > 0) inner = classes.concat(extra)
    }
    for (const child of node.children ?? []) walk(child, inner)
  }
  walk(root, [])
  return lines
}

/** Per-row syntax segments for each side; an absent entry renders plain. */
export type RowSyntax = { left: (Seg[] | undefined)[]; right: (Seg[] | undefined)[] }

/**
 * Highlights each hunk's old side and new side as two blocks of text, so a
 * token that spans lines (a block comment, a template string) is coloured as
 * long as it starts inside the hunk. `highlight` returns one `Seg[]` per
 * input line; a hunk it throws on, or answers with the wrong line count, or
 * that holds a line over `RICH_MAX_LINE_CHARS`, stays plain.
 */
export function highlightRows(
  rows: DiffRow[],
  highlight: (code: string) => Seg[][],
): RowSyntax {
  const out: RowSyntax = { left: [], right: [] }
  let start = 0
  function block(end: number, side: 'left' | 'right') {
    const idx: number[] = []
    const texts: string[] = []
    for (let i = start; i < end; i++) {
      const row = rows[i]
      if (row.kind === 'hunk' || row.kind === 'meta') continue
      const cell = row[side]
      if (cell === null) continue
      const text = stripCr(cell.text).text
      if (text.length > RICH_MAX_LINE_CHARS) return
      idx.push(i)
      texts.push(text)
    }
    if (idx.length === 0) return
    let lines: Seg[][]
    try {
      lines = highlight(texts.join('\n'))
    } catch {
      return
    }
    if (lines.length !== idx.length) return
    idx.forEach((rowIndex, k) => {
      out[side][rowIndex] = lines[k]
    })
  }
  for (let i = 0; i <= rows.length; i++) {
    if (i === rows.length || rows[i].kind === 'hunk') {
      block(i, 'left')
      block(i, 'right')
      start = i + 1
    }
  }
  return out
}

/** A piece of a line ready to render: its text, its token classes, and
 * whether it lies inside a word-level change. */
export type Piece = Seg & { marked: boolean }

/** Cuts a line's segments at the boundaries of `marks` (sorted, disjoint), so
 * each piece is wholly inside or wholly outside a mark. */
export function markSegs(segs: Seg[], marks: Range[]): Piece[] {
  const out: Piece[] = []
  let pos = 0
  let k = 0
  for (const seg of segs) {
    let at = 0
    while (at < seg.text.length) {
      while (k < marks.length && marks[k][1] <= pos + at) k++
      const mark = marks[k]
      const abs = pos + at
      let end = seg.text.length
      let marked = false
      if (mark) {
        if (mark[0] <= abs) {
          marked = true
          end = Math.min(end, mark[1] - pos)
        } else {
          end = Math.min(end, mark[0] - pos)
        }
      }
      out.push({ text: seg.text.slice(at, end), classes: seg.classes, marked })
      at = end
    }
    pos += seg.text.length
  }
  return out
}

/** The inline style a token's classes resolve to in a Prism palette — colour
 * and font only, so a palette's own token backgrounds never paint over the
 * add/delete tint. Inner classes win, as nested elements would in CSS. */
export function segStyle(
  classes: string[],
  palette: { [key: string]: CSSProperties },
): CSSProperties | undefined {
  let style: CSSProperties | undefined
  for (const c of classes) {
    const s = palette[c]
    if (!s) continue
    style ??= {}
    if (s.color !== undefined) style.color = s.color
    if (s.fontStyle !== undefined) style.fontStyle = s.fontStyle
    if (s.fontWeight !== undefined) style.fontWeight = s.fontWeight
  }
  return style
}

// ── Layout decisions ───────────────────────────────────────────────────────

/** Row indices where a change begins: the first row of each run of
 * added/removed/changed rows. These are the stops of previous/next change. */
export function changeStarts(rows: DiffRow[]): number[] {
  const out: number[] = []
  let inRun = false
  rows.forEach((row, i) => {
    const changed = row.kind === 'chg' || row.kind === 'del' || row.kind === 'add'
    if (changed && !inRun) out.push(i)
    inRun = changed
  })
  return out
}

/** One line of the inline (unified) rendering. `row` is the index of the
 * parsed row it came from, `side` which half of that row; a number is `null`
 * where that version of the file has no such line. */
export type InlineLine =
  | { kind: 'hunk'; text: string; row: number }
  | { kind: 'meta'; text: string; row: number }
  | {
      kind: 'ctx' | 'del' | 'add'
      side: 'left' | 'right'
      cell: Side
      oldNo: number | null
      newNo: number | null
      row: number
    }

/** The paired rows re-ordered for one column: within a run of changes, every
 * removed line first, then every added line — the order `git diff` prints. */
export function inlineLines(rows: DiffRow[]): InlineLine[] {
  const out: InlineLine[] = []
  let pending: InlineLine[] = []
  rows.forEach((row, i) => {
    if (row.kind === 'hunk' || row.kind === 'meta' || row.kind === 'ctx') {
      out.push(...pending)
      pending = []
      if (row.kind === 'hunk') out.push({ kind: 'hunk', text: row.text, row: i })
      else if (row.kind === 'meta')
        out.push({ kind: 'meta', text: row.text, row: i })
      else if (row.left && row.right)
        out.push({
          kind: 'ctx',
          side: 'right',
          cell: row.right,
          oldNo: row.left.no,
          newNo: row.right.no,
          row: i,
        })
      return
    }
    if (row.left)
      out.push({
        kind: 'del',
        side: 'left',
        cell: row.left,
        oldNo: row.left.no,
        newNo: null,
        row: i,
      })
    if (row.right)
      pending.push({
        kind: 'add',
        side: 'right',
        cell: row.right,
        oldNo: null,
        newNo: row.right.no,
        row: i,
      })
  })
  out.push(...pending)
  return out
}

export type DiffMode = 'split' | 'inline'

/** localStorage key of the Split | Inline pick. */
export const DIFF_MODE_KEY = 'naru-git-diff-mode'

/** The mode to open in: the remembered pick, else Inline on a phone-width
 * screen (two columns of code do not fit) and Split everywhere else. */
export function initialDiffMode(stored: string | null, phone: boolean): DiffMode {
  if (stored === 'split' || stored === 'inline') return stored
  return phone ? 'inline' : 'split'
}
