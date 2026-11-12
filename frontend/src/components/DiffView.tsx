import { Fragment, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DIFF_MODE_KEY,
  TRUNCATED_NOTICE,
  changeStarts,
  emptyDiffReason,
  highlightRows,
  initialDiffMode,
  inlineLines,
  isRichDiff,
  markSegs,
  parseDiff,
  segStyle,
  stripCr,
  wordDiff,
} from '../diffModel'
import type { DiffMode, Range, Seg, Side } from '../diffModel'
import { usePhoneTier } from '../phoneTier'
import {
  grammarForPath,
  highlightLines,
  usePrismStyle,
} from '../syntaxHighlighter'

type Palette = ReturnType<typeof usePrismStyle>

/** One line's text: syntax-coloured where `segs` is given, with the spans in
 * `marks` wrapped as word-level changes. Every piece is a plain text node. */
function LineText({
  cell,
  segs,
  marks,
  palette,
  crMark,
}: {
  cell: Side
  segs: Seg[] | undefined
  marks: Range[] | undefined
  palette: Palette
  crMark: boolean
}) {
  const { text } = stripCr(cell.text)
  const pieces = markSegs(segs ?? [{ text, classes: [] }], marks ?? [])
  return (
    <>
      {pieces.map((p, i) => {
        const style = segStyle(p.classes, palette)
        if (!style && !p.marked) return p.text
        return (
          <span
            key={i}
            className={p.marked ? 'diff-view-word' : undefined}
            style={style}
          >
            {p.text}
          </span>
        )
      })}
      {crMark && <span className="diff-view-eol"> CR</span>}
      {cell.noEol && (
        <span className="diff-view-eol"> No newline at end of file</span>
      )}
    </>
  )
}

/**
 * The Git tab's diff view (naru task 2734): one file's unified diff as a
 * split (old | new) or inline grid with both versions' line numbers, syntax
 * colour by file extension, word-level marks inside a changed line pair,
 * quiet hunk separators, a sticky header (path, +/- counts, previous/next
 * change, the Split | Inline pick) and a named state for every diff that has
 * no hunks.
 *
 * It renders from the same parser as the Files tab's `SideBySideDiff`
 * (`diffModel.ts`). Diff text, like the path, is untrusted data: it reaches
 * the page only as text nodes, and the classes and inline colours around it
 * come from the parser and the Prism palette, never from the text.
 *
 * Above `RICH_MAX_LINES` / `RICH_MAX_CHARS` the syntax and word passes are
 * skipped and the lines render plain. Mount it with a `key` per file, so the
 * change position does not carry from one diff to the next.
 */
export function DiffView({ diff, path }: { diff: string; path: string }) {
  const phone = usePhoneTier()
  const [picked, setPicked] = useState(() => localStorage.getItem(DIFF_MODE_KEY))
  const mode = initialDiffMode(picked, phone)
  const pick = (next: DiffMode) => {
    localStorage.setItem(DIFF_MODE_KEY, next)
    setPicked(next)
  }

  const palette = usePrismStyle()
  const parsed = useMemo(() => parseDiff(diff), [diff])
  const { rows } = parsed
  const rich = useMemo(() => isRichDiff(diff), [diff])
  const grammar = rich ? grammarForPath(path) : undefined
  const syntax = useMemo(
    () =>
      grammar !== undefined
        ? highlightRows(rows, (code) => highlightLines(code, grammar))
        : null,
    [rows, grammar],
  )
  // Word-level marks and the carriage-return flag, per changed row.
  const pairs = useMemo(
    () =>
      rows.map((row) => {
        if (row.kind !== 'chg' || !row.left || !row.right) return null
        const l = stripCr(row.left.text)
        const r = stripCr(row.right.text)
        return {
          words: rich ? wordDiff(l.text, r.text) : null,
          // Only a line-ending change is worth a marker; a CRLF file's every
          // line ends in CR.
          crLeft: l.cr && !r.cr,
          crRight: r.cr && !l.cr,
        }
      }),
    [rows, rich],
  )
  const starts = useMemo(() => changeStarts(rows), [rows])
  const changeOfRow = useMemo(
    () => new Map(starts.map((row, n) => [row, n])),
    [starts],
  )

  // Clamped: a refetch of the same file can come back with fewer changes.
  const [stepped, setCurrent] = useState(-1)
  const current = Math.min(stepped, starts.length - 1)
  const root = useRef<HTMLDivElement>(null)
  const go = (n: number) => {
    setCurrent(n)
    root.current
      ?.querySelector(`[data-change="${n}"]`)
      ?.scrollIntoView({ block: 'center' })
  }

  const text = (rowIndex: number, side: 'left' | 'right', cell: Side) => (
    <LineText
      cell={cell}
      segs={syntax?.[side][rowIndex]}
      marks={side === 'left' ? pairs[rowIndex]?.words?.old : pairs[rowIndex]?.words?.new}
      palette={palette}
      crMark={
        (side === 'left' ? pairs[rowIndex]?.crLeft : pairs[rowIndex]?.crRight) ??
        false
      }
    />
  )
  const full = (key: number, kind: 'hunk' | 'meta', line: string) => (
    <span key={key} className={`diff-view-full diff-view-${kind}`}>
      {kind === 'meta' && line === TRUNCATED_NOTICE
        ? 'Diff truncated here: the rest of this file’s changes is not shown.'
        : line}
    </span>
  )
  // The first cell of each change carries its number (the scroll target) and,
  // when it is the one last stepped to, the marker.
  const lead = (rowIndex: number) => {
    const n = changeOfRow.get(rowIndex)
    return {
      'data-change': n,
      className: n !== undefined && n === current ? ' diff-view-current' : '',
    }
  }

  let body: ReactNode
  const reason = emptyDiffReason(parsed)
  if (diff === '') {
    body = <p className="muted diff-view-note">No diff.</p>
  } else if (reason !== null) {
    body = <p className="muted diff-view-note">{reason}</p>
  } else if (rows.length === 0) {
    body = <pre className="git-diff-text diff-view-raw">{diff}</pre>
  } else if (mode === 'split') {
    body = (
      <div className="diff-view-grid diff-view-split">
        {rows.map((row, i) => {
          if (row.kind === 'hunk' || row.kind === 'meta') {
            return full(i, row.kind, row.text)
          }
          const l = row.kind === 'ctx' ? 'ctx' : row.left ? 'del' : 'empty'
          const r = row.kind === 'ctx' ? 'ctx' : row.right ? 'add' : 'empty'
          const { className, ...target } = lead(i)
          return (
            <Fragment key={i}>
              <span
                {...target}
                className={`diff-view-no diff-view-${l}${className}`}
              >
                {row.left?.no ?? ''}
              </span>
              <span className={`diff-view-text diff-view-${l}`}>
                {row.left && text(i, 'left', row.left)}
              </span>
              <span className={`diff-view-no diff-view-${r}`}>
                {row.right?.no ?? ''}
              </span>
              <span className={`diff-view-text diff-view-${r}`}>
                {row.right && text(i, 'right', row.right)}
              </span>
            </Fragment>
          )
        })}
      </div>
    )
  } else {
    // A change's first inline line is its first removed line, or its first
    // added line when it removes nothing — the first line emitted for its
    // starting row either way.
    const seen = new Set<number>()
    body = (
      <div className="diff-view-grid diff-view-inline">
        {inlineLines(rows).map((line, i) => {
          if (line.kind === 'hunk' || line.kind === 'meta') {
            return full(i, line.kind, line.text)
          }
          const first = !seen.has(line.row)
          seen.add(line.row)
          const { className, ...target } = first
            ? lead(line.row)
            : { className: '' }
          return (
            <Fragment key={i}>
              <span
                {...target}
                className={`diff-view-no diff-view-${line.kind}${className}`}
              >
                {line.oldNo ?? ''}
              </span>
              <span className={`diff-view-no diff-view-${line.kind}`}>
                {line.newNo ?? ''}
              </span>
              <span className={`diff-view-text diff-view-${line.kind}`}>
                {text(line.row, line.side, line.cell)}
              </span>
            </Fragment>
          )
        })}
      </div>
    )
  }

  const f = parsed.file
  return (
    <div className="diff-view" ref={root}>
      <div className="diff-view-head">
        <span className="diff-view-path">{path}</span>
        {f.binary && <span className="badge">binary</span>}
        {f.isNew && <span className="badge">new file</span>}
        {f.deleted && <span className="badge">deleted</span>}
        {f.renameFrom !== null && (
          <span className="badge diff-view-badge-text">
            renamed from {f.renameFrom}
          </span>
        )}
        {f.oldMode !== null && f.newMode !== null && (
          <span className="badge">
            mode {f.oldMode} → {f.newMode}
          </span>
        )}
        <span className="diff-view-counts">
          <span className="diff-view-added">+{parsed.added}</span>{' '}
          <span className="diff-view-removed">−{parsed.removed}</span>
        </span>
        <span className="diff-view-nav">
          <button
            type="button"
            aria-label="Previous change"
            title="Previous change"
            disabled={current <= 0}
            onClick={() => go(current - 1)}
          >
            ↑
          </button>
          <span className="muted diff-view-position">
            {starts.length === 0 ? '0' : `${current + 1} / ${starts.length}`}
          </span>
          <button
            type="button"
            aria-label="Next change"
            title="Next change"
            disabled={current >= starts.length - 1}
            onClick={() => go(current + 1)}
          >
            ↓
          </button>
        </span>
        <span className="diff-view-mode">
          <button
            type="button"
            className={mode === 'split' ? 'active' : ''}
            aria-pressed={mode === 'split'}
            onClick={() => pick('split')}
          >
            Split
          </button>
          <button
            type="button"
            className={mode === 'inline' ? 'active' : ''}
            aria-pressed={mode === 'inline'}
            onClick={() => pick('inline')}
          >
            Inline
          </button>
        </span>
        {parsed.truncated && (
          <span className="diff-view-warning">
            Diff truncated at 256 KiB; only the first part is shown.
          </span>
        )}
        {!rich && (
          <span className="muted diff-view-plain-note">
            Large diff: syntax colour and word marks are off.
          </span>
        )}
      </div>
      {body}
    </div>
  )
}
