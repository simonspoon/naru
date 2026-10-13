// Pure logic of the Agent watcher page (naru task 1909, docs/agent-watcher.md).
// Every rule that decides what a bar means lives here so it is vitest-covered;
// AgentWatcherView.tsx only draws what these return.

import { ccSessionHref } from './ccOrigin'
import { modelColor } from './sessionDetail'
import type { AgentWatchRow } from './types/AgentWatchRow'

/** The window toggle, in minutes. */
export const WINDOWS = [5, 15, 60]

/** A thread with no event for this long is quiet. Mirrors the server's
 *  `cc::THREAD_IDLE_GAP_SECS`, which coalesces runs with the same gap. */
export const QUIET_GAP_S = 60

/** A shell whose output file has not been written for this long has stalled. */
export const SHELL_STALL_S = 60

/** Everything quiet or waiting for this long raises the page's banner. */
export const ALL_QUIET_ALERT_S = 300

/** A segment never draws narrower than this share of the track, so an instant
 *  still shows (the session timeline's `rect()` rule). */
const MIN_SEGMENT_PCT = 0.3

export type SegmentState = 'active' | 'waiting' | 'quiet' | 'output' | 'stalled'

export interface Segment {
  from: number
  to: number
  state: SegmentState
}

export interface OrderedRow {
  row: AgentWatchRow
  /** 0 for a session, 1 for its subagents and shells. */
  depth: 0 | 1
}

const byStart = (a: AgentWatchRow, b: AgentWatchRow) =>
  (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.key.localeCompare(b.key)

/** Sessions oldest first, each followed by its subagents then its shells. */
export function orderRows(rows: AgentWatchRow[]): OrderedRow[] {
  const sessions = rows.filter((r) => r.kind === 'session').sort(byStart)
  const out: OrderedRow[] = []
  for (const s of sessions) {
    out.push({ row: s, depth: 0 })
    const kids = rows.filter((r) => r.parent === s.key)
    for (const kind of ['subagent', 'shell'] as const) {
      for (const k of kids.filter((r) => r.kind === kind).sort(byStart)) {
        out.push({ row: k, depth: 1 })
      }
    }
  }
  return out
}

/** The children of a session row (empty for any other row). */
export function childrenOf(rows: AgentWatchRow[], row: AgentWatchRow): AgentWatchRow[] {
  return row.kind === 'session' ? rows.filter((r) => r.parent === row.key) : []
}

function mergeIntervals(iv: [number, number][], keepInstants = false): [number, number][] {
  const sorted = iv.filter(([a, b]) => b > a || (keepInstants && b === a)).sort((x, y) => x[0] - y[0])
  const out: [number, number][] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** The bar of one row across `[windowStart, now]`. `children` matters only for
 *  a session row: a gap a running child covers is `waiting`, not `quiet`. */
export function rowSegments(
  row: AgentWatchRow,
  children: AgentWatchRow[],
  now: number,
  windowStart: number,
): Segment[] {
  if (row.kind === 'shell') return shellSegments(row, now, windowStart)

  const firstRunStart = row.runs.length > 0 ? row.runs[0][0] : null
  const lo = Math.max(
    windowStart,
    row.startedAt ?? firstRunStart ?? windowStart,
    row.historyFrom ?? -Infinity,
  )
  const hi = row.finished ? Math.min(now, row.lastEventAt ?? now) : now
  if (hi <= lo) return []

  const runs: [number, number][] = []
  for (const [a, b] of row.runs) {
    const from = Math.max(a, lo)
    let to = Math.min(b, hi)
    if (to < from) continue
    // A run that ended a moment ago is still going: the thread has not been
    // quiet for QUIET_GAP_S yet.
    if (!row.finished && hi - to < QUIET_GAP_S) to = hi
    runs.push([from, to])
  }
  const active = mergeIntervals(
    runs.map(([a, b]) => [a, Math.max(b, a)]),
    true,
  )

  const covers = mergeIntervals(
    children.flatMap((c): [number, number][] => {
      if (c.startedAt === null) return []
      if (c.kind === 'subagent') {
        return [[c.startedAt, c.finished ? (c.lastEventAt ?? now) : now]]
      }
      return [[c.startedAt, now]]
    }),
  )

  // Walk the window: active runs, and in every gap the covered parts waiting.
  const out: Segment[] = []
  const push = (from: number, to: number, state: SegmentState) => {
    if (to < from) return
    const last = out[out.length - 1]
    if (last && last.state === state && last.to === from) last.to = to
    else out.push({ from, to, state })
  }
  const fillGap = (from: number, to: number) => {
    let cursor = from
    for (const [a, b] of covers) {
      if (b <= cursor || a >= to) continue
      const ca = Math.max(a, cursor)
      const cb = Math.min(b, to)
      push(cursor, ca, 'quiet')
      push(ca, cb, 'waiting')
      cursor = cb
    }
    push(cursor, to, 'quiet')
  }
  let cursor = lo
  for (const [a, b] of active) {
    if (a > cursor) fillGap(cursor, a)
    push(a, b, 'active')
    cursor = Math.max(cursor, b)
  }
  if (cursor < hi) fillGap(cursor, hi)
  return out.filter((s) => s.to > s.from || s.state === 'active')
}

function shellSegments(row: AgentWatchRow, now: number, windowStart: number): Segment[] {
  const lo = Math.max(windowStart, row.startedAt ?? windowStart)
  if (now <= lo) return []
  // No output signal: never paint a stall we cannot see.
  if (row.outputAt === null) return [{ from: lo, to: now, state: 'quiet' }]
  const at = Math.min(now, Math.max(lo, row.outputAt))
  const tail: SegmentState = now - row.outputAt < SHELL_STALL_S ? 'output' : 'stalled'
  const out: Segment[] = []
  if (at > lo) out.push({ from: lo, to: at, state: 'output' })
  if (now > at) {
    const last = out[out.length - 1]
    if (last && last.state === tail) last.to = now
    else out.push({ from: at, to: now, state: tail })
  }
  return out
}

/** Whether a row is doing work right now. */
export function isWorking(row: AgentWatchRow, now: number): boolean {
  if (row.kind === 'shell') {
    return row.outputAt !== null && now - row.outputAt < SHELL_STALL_S
  }
  return !row.finished && row.lastEventAt !== null && now - row.lastEventAt < QUIET_GAP_S
}

/** Since when nobody has been working: the newest work time among the
 *  unfinished rows, or `null` when something works, nothing runs, or a shell's
 *  output is unreadable (then silence cannot be told from a long quiet build). */
export function allQuietSince(rows: AgentWatchRow[], now: number): number | null {
  const live = rows.filter((r) => !r.finished)
  if (live.length === 0) return null
  let since: number | null = null
  for (const r of live) {
    if (isWorking(r, now)) return null
    if (r.kind === 'shell' && r.outputAt === null) return null
    const at = r.kind === 'shell' ? r.outputAt : (r.lastEventAt ?? r.startedAt)
    if (at !== null && (since === null || at > since)) since = at
  }
  return since
}

export function shouldAlert(rows: AgentWatchRow[], now: number): boolean {
  const since = allQuietSince(rows, now)
  return since !== null && now - since >= ALL_QUIET_ALERT_S
}

/** Where `t` sits on the track, 0-100. */
export function pct(t: number, windowStart: number, now: number): number {
  const span = now - windowStart
  if (span <= 0) return 0
  return Math.min(100, Math.max(0, ((t - windowStart) / span) * 100))
}

/** A segment's left edge and width in percent, never narrower than an instant
 *  that still shows, nudged left rather than shrunk at the right edge. */
export function segmentBox(
  seg: Segment,
  windowStart: number,
  now: number,
): { left: number; width: number } {
  const left = pct(seg.from, windowStart, now)
  const width = Math.max(MIN_SEGMENT_PCT, pct(seg.to, windowStart, now) - left)
  return { left: Math.min(left, 100 - width), width }
}

export interface Tick {
  label: string
  pct: number
}

/** Axis ticks: `-15m -10m -5m now` for the 15 minute window. */
export function ticks(minutes: number): Tick[] {
  const step = minutes <= 5 ? 1 : minutes <= 15 ? 5 : 15
  const out: Tick[] = []
  for (let m = minutes; m > 0; m -= step) {
    out.push({ label: `-${m}m`, pct: (1 - m / minutes) * 100 })
  }
  out.push({ label: 'now', pct: 100 })
  return out
}

export function rowColor(row: AgentWatchRow): string {
  return modelColor(row.model)
}

export function rowHref(row: AgentWatchRow): string {
  return ccSessionHref(row.sessionId, null)
}
