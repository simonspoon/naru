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

/** One drawn tool-call bar: a single call, or adjacent short calls merged so a
 *  burst stays readable. */
export interface ToolBar {
  from: number
  to: number
  /** Calls folded into this bar. */
  count: number
  /** Summed call durations in seconds (not the bar's span). */
  busy: number
  /** Tool names with their call counts, most frequent first. */
  names: [string, number][]
}

/** Calls whose gap is under this share of the window merge into one bar. */
const TOOL_MERGE_PCT = 0.5

/** A call's `end` while its result has not arrived (matches the server). */
export const TOOL_OPEN = -1

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

/** The tool-call bars of one row across `[windowStart, now]`. Calls are
 *  clipped to the window; one with no result yet runs to now (or to the row's
 *  last event once it is finished). Calls closer together than
 *  `TOOL_MERGE_PCT` of the window merge, so many short calls stay a few bars. */
export function toolBars(row: AgentWatchRow, now: number, windowStart: number): ToolBar[] {
  const hi = row.finished ? Math.min(now, row.lastEventAt ?? now) : now
  const calls = (row.tools ?? [])
    .map(([a, b, name]): [number, number, number, string] => {
      const end = b === TOOL_OPEN ? hi : b
      return [Math.max(a, windowStart), Math.min(end, now), Math.max(0, end - a), name]
    })
    .filter(([a, b]) => b >= a)
    .sort((x, y) => x[0] - y[0])
  const gap = ((now - windowStart) * TOOL_MERGE_PCT) / 100
  const out: ToolBar[] = []
  const counts: Map<string, number>[] = []
  for (const [a, b, dur, name] of calls) {
    const last = out[out.length - 1]
    if (last && a - last.to <= gap) {
      last.to = Math.max(last.to, b)
      last.count += 1
      last.busy += dur
      const m = counts[counts.length - 1]
      m.set(name, (m.get(name) ?? 0) + 1)
    } else {
      out.push({ from: a, to: b, count: 1, busy: dur, names: [] })
      counts.push(new Map([[name, 1]]))
    }
  }
  out.forEach((bar, i) => {
    bar.names = [...counts[i].entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
  })
  return out
}

/** `850ms`, `4s`, `2m05s`. */
export function formatDuration(s: number): string {
  if (s < 1) return '<1s'
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, '0')}s`
}

/** The hover text of a tool bar: `Read · 3s`, or `5 calls: Read×3, Edit×2 · busy 12s`. */
export function toolLabel(bar: ToolBar): string {
  if (bar.count === 1) return `${bar.names[0][0]} · ${formatDuration(bar.busy)}`
  const names = bar.names.map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', ')
  return `${bar.count} calls: ${names} · busy ${formatDuration(bar.busy)}`
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
