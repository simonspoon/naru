import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { DEFAULT_MAX_LANES, collapseRefs, layout, relativeTime } from '../gitGraph'
import type { GraphRow } from '../gitGraph'
import {
  NODE_R,
  edgePath,
  graphWidth,
  laneX,
  orderRefs,
  refClass,
  refText,
  rowLabel,
  subjectOrPlaceholder,
} from '../gitHistory'
import type { GitCommit } from '../types/GitCommit'

const MAX_BADGES = 2

// One shared minute ticker for every visible date, so the tick re-renders only
// the tiny <RelTime> leaves, never a whole row (and its SVG).
const tickListeners = new Set<() => void>()
let tickTimer: ReturnType<typeof setInterval> | undefined
function subscribeMinute(cb: () => void): () => void {
  tickListeners.add(cb)
  if (tickTimer === undefined) {
    tickTimer = setInterval(() => tickListeners.forEach((l) => l()), 60_000)
  }
  return () => {
    tickListeners.delete(cb)
    if (tickListeners.size === 0 && tickTimer !== undefined) {
      clearInterval(tickTimer)
      tickTimer = undefined
    }
  }
}
const currentMinute = () => Math.floor(Date.now() / 60_000)

function RelTime({ iso }: { iso: string }) {
  const minute = useSyncExternalStore(subscribeMinute, currentMinute)
  const exact = Number.isNaN(Date.parse(iso)) ? iso : new Date(iso).toLocaleString()
  return (
    <time className="git-commit-date muted" dateTime={iso} title={exact}>
      {relativeTime(iso, new Date(minute * 60_000))}
    </time>
  )
}

/** One row's lane cell: inline SVG, colours from `.lane-cN` classes only. */
function GraphCell({
  row,
  width,
  height,
  merge,
  head,
}: {
  row: GraphRow | undefined
  width: number
  height: number
  merge: boolean
  head: boolean
}) {
  if (!row) return <svg className="git-graph-svg" width={width} height={height} aria-hidden="true" />
  const cy = height / 2
  return (
    <svg
      className="git-graph-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {row.edges.map((e, i) => (
        <path key={i} d={edgePath(e, height)} className={`git-edge lane-c${e.color}`} />
      ))}
      {head && (
        <circle cx={laneX(row.col)} cy={cy} r={NODE_R + 2.5} className="git-node-head" />
      )}
      <circle
        cx={laneX(row.col)}
        cy={cy}
        r={NODE_R}
        className={`git-node lane-c${row.color}${merge ? ' merge' : ''}`}
      />
      {row.overflow && (
        <text x={width - 3} y={cy + 4} textAnchor="end" className="git-graph-more">
          <title>More lanes hidden</title>…
        </text>
      )}
    </svg>
  )
}

function RefBadges({ commit }: { commit: GitCommit }) {
  if (commit.refs.length === 0) return null
  const ordered = orderRefs(commit.refs)
  const { shown, hidden } = collapseRefs(ordered, MAX_BADGES)
  return (
    <span className="git-ref-badges">
      {shown.map((r) => (
        <span key={`${r.kind}:${r.name}`} className={`badge git-ref git-ref-${refClass(r)}`} title={r.name}>
          {refText(r)}
        </span>
      ))}
      {hidden > 0 && (
        <span
          className="badge git-ref git-ref-more"
          title={ordered.slice(shown.length).map((r) => r.name).join('\n')}
        >
          +{hidden}
        </span>
      )}
    </span>
  )
}

const CommitRow = memo(function CommitRow({
  commit,
  row,
  width,
  height,
  selected,
  onSelect,
}: {
  commit: GitCommit
  row: GraphRow | undefined
  width: number
  height: number
  selected: boolean
  onSelect: (c: GitCommit) => void
}) {
  const subject = subjectOrPlaceholder(commit.subject)
  const exact = Number.isNaN(Date.parse(commit.date))
    ? commit.date
    : new Date(commit.date).toLocaleString()
  return (
    <li>
      <button
        type="button"
        className={`git-commit-row${selected ? ' selected' : ''}`}
        style={{ height }}
        aria-current={selected ? 'true' : undefined}
        aria-label={rowLabel(commit, exact)}
        data-git-item=""
        data-hash={commit.hash}
        onClick={() => onSelect(commit)}
      >
        <GraphCell
          row={row}
          width={width}
          height={height}
          merge={commit.parents.length > 1}
          head={commit.refs.some((r) => r.is_head)}
        />
        <RefBadges commit={commit} />
        <span className={`git-commit-subject${subject.empty ? ' muted' : ''}`} title={subject.text}>
          {subject.text}
        </span>
        <span className="git-commit-author muted" title={commit.author}>
          {commit.author}
        </span>
        <RelTime iso={commit.date} />
        <code className="git-sha">{commit.short_hash}</code>
      </button>
    </li>
  )
})

/**
 * The scrolling commit list with its lane graph. Rows are `<button>`s (native
 * Tab/Enter); an IntersectionObserver sentinel at the end of the list, rooted
 * at the list itself, asks for the next page, and a "Load more" button stays
 * as the fallback. All repo text is rendered as text nodes.
 */
export function CommitList({
  commits,
  selectedHash,
  phone,
  dim,
  hasMore,
  loadingMore,
  moreError,
  onSelect,
  onLoadMore,
  unlinked = false,
}: {
  commits: GitCommit[]
  selectedHash: string | null
  phone: boolean
  dim: boolean
  hasMore: boolean
  loadingMore: boolean
  moreError: string | null
  onSelect: (c: GitCommit) => void
  onLoadMore: () => void
  /** A filtered list: a row's parents are mostly not in it, so draw each
   * commit as a lone node in one column instead of a lane per row. */
  unlinked?: boolean
}) {
  const height = phone ? 44 : 34
  const maxLanes = phone ? 4 : DEFAULT_MAX_LANES
  const rows = useMemo(() => {
    const m = new Map<string, GraphRow>()
    const input = unlinked ? commits.map((c) => ({ ...c, parents: [] })) : commits
    for (const r of layout(input, { maxLanes })) m.set(r.hash, r)
    return m
  }, [commits, maxLanes, unlinked])
  const width = useMemo(() => {
    let lanes = 1
    for (const r of rows.values()) if (r.lanes > lanes) lanes = r.lanes
    return graphWidth(Math.min(lanes, maxLanes))
  }, [rows, maxLanes])

  const listRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadRef = useRef(onLoadMore)
  useEffect(() => {
    loadRef.current = onLoadMore
  })
  const canAuto = hasMore && !loadingMore && moreError === null
  // Auto-load cannot chain: one auto-load disarms it, and only a scroll event
  // on the list re-arms it. A list that is not height-bound (sentinel always in
  // view) therefore loads one page, not the whole history; "Load more" remains.
  const armed = useRef(true)
  // Re-created whenever the row count changes so a sentinel that is still in
  // view after a short page can fire again once re-armed.
  useEffect(() => {
    const el = sentinelRef.current
    const list = listRef.current
    if (!canAuto || !el || !list || typeof IntersectionObserver === 'undefined') return
    const fire = () => {
      if (!armed.current) return
      armed.current = false
      loadRef.current()
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fire()
      },
      { root: list, rootMargin: '120px' },
    )
    io.observe(el)
    const onScroll = () => {
      armed.current = true
      if (el.getBoundingClientRect().top <= list.getBoundingClientRect().bottom + 120) fire()
    }
    list.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      io.disconnect()
      list.removeEventListener('scroll', onScroll)
    }
  }, [canAuto, commits.length])

  return (
    <div
      className={`git-graph-list${dim ? ' dim' : ''}`}
      ref={listRef}
      style={{ ['--git-row-h' as string]: `${height}px` }}
    >
      <ul className="git-commit-list" data-git-list="commits">
        {commits.map((c) => (
          <CommitRow
            key={c.hash}
            commit={c}
            row={rows.get(c.hash)}
            width={width}
            height={height}
            selected={c.hash === selectedHash}
            onSelect={onSelect}
          />
        ))}
      </ul>
      {hasMore && (
        <div className="git-load-more" ref={sentinelRef}>
          {moreError !== null && <p className="error">{moreError}</p>}
          <button type="button" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading…' : moreError !== null ? 'Retry' : 'Load more'}
          </button>
        </div>
      )}
      {!hasMore && commits.length > 0 && <p className="muted git-history-end">Start of history</p>}
    </div>
  )
}
