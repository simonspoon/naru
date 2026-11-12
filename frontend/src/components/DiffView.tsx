import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react'
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
import type { Verb } from '../gitActions'
import {
  applyRange,
  hunkOfRow,
  lineIndex,
  parseHunks,
  picksFor,
  picksSubject,
  toggle,
  wholeHunk,
} from '../gitHunks'
import type { HunkModel, HunkPick, PickLine } from '../gitHunks'
import { usePhoneTier } from '../phoneTier'
import {
  grammarForPath,
  highlightLines,
  usePrismStyle,
} from '../syntaxHighlighter'

type Palette = ReturnType<typeof usePrismStyle>

const NOT_AVAILABLE =
  'Hunk and line staging is not available for this file; stage the whole file from the list.'
const NO_LINES: ReadonlySet<string> = new Set()

/** Opt-in hunk and line staging (naru task 2739, the working-tree diff only).
 * Absent = the diff is exactly the read-only view. */
export type DiffStaging = {
  /** The side shown: true = staged (Unstage), false = changes (Stage, Discard). */
  staged: boolean
  /** The diff's `digest`; null = the file is not eligible, so no controls. */
  digest: string | null
  /** A write is in flight, or the shown diff is being reloaded. */
  disabled: boolean
  /** The tooltip / aria-label of a control; names the worktree. */
  label: (verb: Verb, subject: string) => string
  onHunk: (verb: 'stage' | 'unstage' | 'discard', hunk: number, model: HunkModel) => void
  onLines: (verb: 'stage' | 'unstage', picks: HunkPick[]) => void
  /** Called with a function that clears the line selection (true = it had
   * one), and with null when the view goes away. */
  registerClear?: (clear: (() => boolean) | null) => void
}

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
export function DiffView({
  diff,
  path,
  staging,
}: {
  diff: string
  path: string
  staging?: DiffStaging
}) {
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

  // Hunk and line staging: only when the server named the file eligible.
  const active = staging !== undefined && staging.digest !== null
  const model = useMemo(() => parseHunks(active ? diff : ''), [active, diff])
  const hunkAt = useMemo(() => hunkOfRow(rows), [rows])
  const lookup = useMemo(() => lineIndex(model), [model])
  const [selState, setSelState] = useState<{ diff: string; keys: ReadonlySet<string> }>({
    diff,
    keys: NO_LINES,
  })
  // A selection belongs to the diff text it was made on.
  const keys = selState.diff === diff ? selState.keys : NO_LINES
  const setKeys = (next: ReadonlySet<string>) => setSelState({ diff, keys: next })
  const keysRef = useRef(keys)
  useEffect(() => {
    keysRef.current = keys
  })
  const registerClear = staging?.registerClear
  useEffect(() => {
    registerClear?.(() => {
      if (keysRef.current.size === 0) return false
      setSelState({ diff, keys: NO_LINES })
      return true
    })
    return () => registerClear?.(null)
  }, [registerClear, diff])
  const drag = useRef<{ anchor: string; base: ReadonlySet<string>; add: boolean } | null>(null)
  const last = useRef<string | null>(null)
  const skipClick = useRef(false)
  useEffect(() => {
    const end = () => {
      drag.current = null
      // The click that follows a mouse press has already been handled by then.
      setTimeout(() => {
        skipClick.current = false
      }, 0)
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [])
  // One set of handlers on the grid, not one per gutter cell: a cell says
  // which line it is by `data-line-pick`.
  const keyOf = (e: { target: EventTarget }): string | null =>
    e.target instanceof Element
      ? (e.target.closest('[data-line-pick]')?.getAttribute('data-line-pick') ?? null)
      : null
  const pickToggle = (key: string) => {
    setKeys(toggle(keys, key))
    last.current = key
  }
  const onGridDown = (e: PointerEvent) => {
    const key = keyOf(e)
    // Touch taps toggle through `click` (no drag: the pane scrolls on touch).
    if (key === null || e.pointerType === 'touch' || e.button !== 0) return
    skipClick.current = true
    if (e.shiftKey && last.current !== null) {
      setKeys(applyRange(keys, model, last.current, key, true))
    } else {
      const add = !keys.has(key)
      drag.current = { anchor: key, base: keys, add }
      setKeys(applyRange(keys, model, key, key, add))
    }
    last.current = key
  }
  const onGridOver = (e: PointerEvent) => {
    const key = keyOf(e)
    const d = drag.current
    if (key !== null && d) setKeys(applyRange(d.base, model, d.anchor, key, d.add))
  }
  const onGridClick = (e: MouseEvent) => {
    const key = keyOf(e)
    if (key === null) return
    if (skipClick.current) skipClick.current = false
    else pickToggle(key)
  }
  const onGridKey = (e: KeyboardEvent) => {
    const key = keyOf(e)
    if (key === null || (e.key !== ' ' && e.key !== 'Enter')) return
    e.preventDefault()
    e.stopPropagation()
    pickToggle(key)
  }
  /** Attributes and class of a gutter cell that selects `l`; none for any other cell. */
  const pickCell = (l: PickLine | undefined) => {
    if (!active || !l) return { cls: '', props: {} }
    const on = keys.has(l.key)
    return {
      cls: ` diff-view-pickable${on ? ' diff-view-picked' : ''}`,
      props: {
        role: 'button',
        tabIndex: -1,
        'aria-pressed': on,
        'aria-label': `Select ${l.kind === '+' ? 'added' : 'removed'} line ${l.no}`,
        'data-line-pick': l.key,
      },
    }
  }
  const pickedText = (l: PickLine | undefined) =>
    active && l && keys.has(l.key) ? ' diff-view-picked' : ''
  const subjectOf = (picks: HunkPick[]) => picksSubject(path, picks)

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
  const full = (key: number, kind: 'hunk' | 'meta', line: string, rowIndex: number) => {
    const hunk = hunkAt.get(rowIndex)
    if (active && staging && kind === 'hunk' && hunk !== undefined) {
      const btn = (verb: 'stage' | 'unstage' | 'discard', word: string, danger = false) => {
        const label = staging.label(verb, subjectOf(wholeHunk(hunk)))
        return (
          <button
            type="button"
            className={`git-wt-act${danger ? ' danger' : ''}`}
            aria-label={label}
            title={label}
            disabled={staging.disabled}
            data-hunk-action={verb}
            onClick={() => staging.onHunk(verb, hunk, model)}
          >
            {word}
          </button>
        )
      }
      return (
        <span
          key={key}
          className="diff-view-full diff-view-hunk diff-view-hunk-bar"
          data-hunk-index={hunk}
        >
          <span className="diff-view-hunk-text">{line}</span>
          <span className="diff-view-hunk-actions">
            {staging.staged
              ? btn('unstage', 'Unstage hunk')
              : [
                  <Fragment key="s">{btn('stage', 'Stage hunk')}</Fragment>,
                  <Fragment key="d">{btn('discard', 'Discard hunk', true)}</Fragment>,
                ]}
          </span>
        </span>
      )
    }
    return (
      <span key={key} className={`diff-view-full diff-view-${kind}`}>
        {kind === 'meta' && line === TRUNCATED_NOTICE
          ? 'Diff truncated here: the rest of this file’s changes is not shown.'
          : line}
      </span>
    )
  }
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
      <div
        className="diff-view-grid diff-view-split"
        onPointerDown={active ? onGridDown : undefined}
        onPointerOver={active ? onGridOver : undefined}
        onClick={active ? onGridClick : undefined}
        onKeyDown={active ? onGridKey : undefined}
      >
        {rows.map((row, i) => {
          if (row.kind === 'hunk' || row.kind === 'meta') {
            return full(i, row.kind, row.text, i)
          }
          const l = row.kind === 'ctx' ? 'ctx' : row.left ? 'del' : 'empty'
          const r = row.kind === 'ctx' ? 'ctx' : row.right ? 'add' : 'empty'
          const { className, ...target } = lead(i)
          const ll = active && row.kind !== 'ctx' && row.left ? lookup('left', row.left.no) : undefined
          const rl = active && row.kind !== 'ctx' && row.right ? lookup('right', row.right.no) : undefined
          const lp = pickCell(ll)
          const rp = pickCell(rl)
          return (
            <Fragment key={i}>
              <span
                {...target}
                {...lp.props}
                className={`diff-view-no diff-view-${l}${className}${lp.cls}`}
              >
                {row.left?.no ?? ''}
              </span>
              <span className={`diff-view-text diff-view-${l}${pickedText(ll)}`}>
                {row.left && text(i, 'left', row.left)}
              </span>
              <span {...rp.props} className={`diff-view-no diff-view-${r}${rp.cls}`}>
                {row.right?.no ?? ''}
              </span>
              <span className={`diff-view-text diff-view-${r}${pickedText(rl)}`}>
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
      <div
        className="diff-view-grid diff-view-inline"
        onPointerDown={active ? onGridDown : undefined}
        onPointerOver={active ? onGridOver : undefined}
        onClick={active ? onGridClick : undefined}
        onKeyDown={active ? onGridKey : undefined}
      >
        {inlineLines(rows).map((line, i) => {
          if (line.kind === 'hunk' || line.kind === 'meta') {
            return full(i, line.kind, line.text, line.row)
          }
          const pl =
            active && line.kind !== 'ctx'
              ? lookup(line.side, line.cell.no)
              : undefined
          const pc = pickCell(pl)
          const first = !seen.has(line.row)
          seen.add(line.row)
          const { className, ...target } = first
            ? lead(line.row)
            : { className: '' }
          return (
            <Fragment key={i}>
              <span
                {...target}
                {...(line.kind === 'del' ? pc.props : {})}
                className={`diff-view-no diff-view-${line.kind}${className}${line.kind === 'del' ? pc.cls : ''}`}
              >
                {line.oldNo ?? ''}
              </span>
              <span
                {...(line.kind === 'add' ? pc.props : {})}
                className={`diff-view-no diff-view-${line.kind}${line.kind === 'add' ? pc.cls : ''}`}
              >
                {line.newNo ?? ''}
              </span>
              <span className={`diff-view-text diff-view-${line.kind}${pickedText(pl)}`}>
                {text(line.row, line.side, line.cell)}
              </span>
            </Fragment>
          )
        })}
      </div>
    )
  }

  const f = parsed.file
  const picks = active ? picksFor(model, keys) : []
  const nPicked = picks.reduce((n, p) => n + (p.lines?.length ?? 0), 0)
  const linesVerb = staging?.staged ? 'unstage' : 'stage'
  const linesLabel = staging?.label(linesVerb, subjectOf(picks)) ?? ''
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
        {staging && !active && rows.some((r) => r.kind === 'hunk') && (
          <span className="muted diff-view-hunk-note" data-hunk-note="">
            {NOT_AVAILABLE}
          </span>
        )}
        {/* Always there while lines can be picked: a bar that appeared with
            the first pick would push the lines down under a drag. */}
        {staging && active && (
          <span
            className="diff-view-lines-bar"
            role="group"
            aria-label="Line selection"
            data-lines-bar=""
            data-lines-count={nPicked}
          >
            <span className={`diff-view-lines-count${nPicked === 0 ? ' muted' : ''}`}>
              {nPicked === 0
                ? 'Click or drag line numbers to select lines'
                : `${nPicked} ${nPicked === 1 ? 'line' : 'lines'} selected`}
            </span>
            <button
              type="button"
              className="git-wt-act"
              aria-label={linesLabel}
              title={linesLabel}
              disabled={staging.disabled || nPicked === 0}
              data-lines-action={linesVerb}
              onClick={() => staging.onLines(linesVerb, picks)}
            >
              {staging.staged ? 'Unstage selected lines' : 'Stage selected lines'}
            </button>
            <button
              type="button"
              className="git-wt-act"
              data-lines-action="clear"
              disabled={nPicked === 0}
              onClick={() => setKeys(NO_LINES)}
            >
              Clear
            </button>
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
