import { describe, expect, it } from 'vitest'
import {
  ALL_QUIET_ALERT_S,
  QUIET_GAP_S,
  SHELL_STALL_S,
  allQuietSince,
  isWorking,
  orderRows,
  pct,
  rowHref,
  rowSegments,
  segmentBox,
  shouldAlert,
  formatDuration,
  toolBars,
  toolLabel,
  ticks,
} from './agentWatch'
import type { AgentWatchRow } from './types/AgentWatchRow'

const NOW = 10_000
const WS = NOW - 900

function row(over: Partial<AgentWatchRow> & { key: string }): AgentWatchRow {
  return {
    kind: 'session',
    sessionId: over.key.split('/')[0],
    parent: null,
    label: over.key,
    detail: null,
    model: 'claude-opus-5',
    startedAt: WS - 100,
    runs: [],
    lastEventAt: null,
    historyFrom: null,
    outputAt: null,
    finished: false,
    tools: [],
    ...over,
  }
}

describe('orderRows', () => {
  it('puts sessions by start, each followed by subagents then shells', () => {
    const rows = [
      row({ key: 'b', startedAt: 20 }),
      row({ key: 'a/sh', kind: 'shell', parent: 'a', startedAt: 5 }),
      row({ key: 'a/s2', kind: 'subagent', parent: 'a', startedAt: 9 }),
      row({ key: 'a', startedAt: 10 }),
      row({ key: 'a/s1', kind: 'subagent', parent: 'a', startedAt: 7 }),
    ]
    const o = orderRows(rows)
    expect(o.map((x) => x.row.key)).toEqual(['a', 'a/s1', 'a/s2', 'a/sh', 'b'])
    expect(o.map((x) => x.depth)).toEqual([0, 1, 1, 1, 0])
  })
})

describe('rowSegments', () => {
  it('extends a run ending near now to now', () => {
    const r = row({ key: 'a', runs: [[WS + 100, NOW - 20]], lastEventAt: NOW - 20 })
    const segs = rowSegments(r, [], NOW, WS)
    expect(segs[segs.length - 1]).toEqual({ from: WS + 100, to: NOW, state: 'active' })
  })

  it('marks a gap covered by a running subagent waiting, otherwise quiet', () => {
    const parent = row({ key: 'a', runs: [[WS, WS + 100]], startedAt: WS })
    const sub = row({ key: 'a/x', kind: 'subagent', parent: 'a', startedAt: WS + 200, finished: false })
    const segs = rowSegments(parent, [sub], NOW, WS)
    expect(segs).toEqual([
      { from: WS, to: WS + 100, state: 'active' },
      { from: WS + 100, to: WS + 200, state: 'quiet' },
      { from: WS + 200, to: NOW, state: 'waiting' },
    ])
    expect(rowSegments(parent, [], NOW, WS).map((s) => s.state)).toEqual(['active', 'quiet'])
  })

  it('ends a finished subagent bar at its last event', () => {
    const r = row({
      key: 'a/x',
      kind: 'subagent',
      parent: 'a',
      startedAt: WS + 10,
      runs: [[WS + 10, WS + 50]],
      lastEventAt: WS + 50,
      finished: true,
    })
    const segs = rowSegments(r, [], NOW, WS)
    expect(segs[segs.length - 1].to).toBe(WS + 50)
  })

  it('keeps a single-event run as an instant', () => {
    const r = row({ key: 'a/x', kind: 'subagent', parent: 'a', startedAt: WS + 10, finished: true, lastEventAt: WS + 200, runs: [[WS + 100, WS + 100]] })
    expect(rowSegments(r, [], NOW, WS).filter((s) => s.state === 'active')).toEqual([
      { from: WS + 100, to: WS + 100, state: 'active' },
    ])
  })

  it('clips to historyFrom', () => {
    const r = row({ key: 'a', startedAt: WS - 100, historyFrom: WS + 300, runs: [[WS + 300, WS + 400]] })
    expect(rowSegments(r, [], NOW, WS)[0].from).toBe(WS + 300)
  })

  it('paints a shell with no output signal all quiet', () => {
    const r = row({ key: 'a/pid:1', kind: 'shell', parent: 'a', startedAt: WS + 10 })
    expect(rowSegments(r, [], NOW, WS)).toEqual([{ from: WS + 10, to: NOW, state: 'quiet' }])
  })

  it('stalls a shell exactly at SHELL_STALL_S', () => {
    const mk = (age: number) =>
      row({ key: 'a/pid:1', kind: 'shell', parent: 'a', startedAt: WS, outputAt: NOW - age })
    const flowing = rowSegments(mk(SHELL_STALL_S - 1), [], NOW, WS)
    expect(flowing.map((s) => s.state)).toEqual(['output'])
    const stalled = rowSegments(mk(SHELL_STALL_S), [], NOW, WS)
    expect(stalled.map((s) => s.state)).toEqual(['output', 'stalled'])
  })
})

describe('alerts', () => {
  const quietSession = (age: number) => row({ key: 'a', lastEventAt: NOW - age })

  it('fires at ALL_QUIET_ALERT_S, not before', () => {
    expect(shouldAlert([quietSession(ALL_QUIET_ALERT_S - 1)], NOW)).toBe(false)
    expect(shouldAlert([quietSession(ALL_QUIET_ALERT_S)], NOW)).toBe(true)
  })

  it('is suppressed by anyone working', () => {
    const rows = [quietSession(900), row({ key: 'b', lastEventAt: NOW - (QUIET_GAP_S - 1) })]
    expect(allQuietSince(rows, NOW)).toBeNull()
    expect(isWorking(rows[1], NOW)).toBe(true)
  })

  it('is suppressed by a shell with unknown output', () => {
    const sh = row({ key: 'a/pid:1', kind: 'shell', parent: 'a' })
    expect(shouldAlert([quietSession(900), sh], NOW)).toBe(false)
  })

  it('ignores finished subagents and empty lists', () => {
    const done = row({ key: 'a/x', kind: 'subagent', parent: 'a', finished: true, lastEventAt: NOW - 1 })
    expect(shouldAlert([quietSession(900), done], NOW)).toBe(true)
    expect(shouldAlert([], NOW)).toBe(false)
  })
})

describe('geometry', () => {
  it('clamps pct to the track', () => {
    expect(pct(WS - 50, WS, NOW)).toBe(0)
    expect(pct(NOW + 50, WS, NOW)).toBe(100)
    expect(pct(WS + 450, WS, NOW)).toBe(50)
  })

  it('keeps an instant visible at the right edge', () => {
    const b = segmentBox({ from: NOW, to: NOW, state: 'active' }, WS, NOW)
    expect(b.width).toBeGreaterThan(0)
    expect(b.left + b.width).toBeLessThanOrEqual(100)
  })

  it('ticks the 15 minute window', () => {
    expect(ticks(15).map((t) => t.label)).toEqual(['-15m', '-10m', '-5m', 'now'])
  })

  it('links a row to its session detail', () => {
    expect(rowHref(row({ key: 'a/x', sessionId: 'a' }))).toBe('#/cc/sessions/a')
  })
})

describe('toolBars', () => {
  it('draws a single call with its duration', () => {
    const r = row({ key: 'a', tools: [[WS + 100, WS + 103, 'Read']] })
    const bars = toolBars(r, NOW, WS)
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({ from: WS + 100, to: WS + 103, count: 1, busy: 3 })
    expect(toolLabel(bars[0])).toBe('Read · 3s')
  })

  it('merges adjacent short calls and keeps distant ones apart', () => {
    const r = row({
      key: 'a',
      tools: [
        [WS + 100, WS + 101, 'Read'],
        [WS + 102, WS + 103, 'Read'],
        [WS + 103, WS + 104, 'Edit'],
        [WS + 400, WS + 410, 'Grep'],
      ],
    })
    const bars = toolBars(r, NOW, WS)
    expect(bars).toHaveLength(2)
    expect(bars[0]).toMatchObject({ from: WS + 100, to: WS + 104, count: 3, busy: 3 })
    expect(toolLabel(bars[0])).toBe('3 calls: Read×2, Edit · busy 3s')
    expect(toolLabel(bars[1])).toBe('Grep · 10s')
  })

  it('runs an open call to now, clips to the window, and stops a finished row at its last event', () => {
    const open = row({ key: 'a', tools: [[NOW - 30, -1, 'Bash']] })
    expect(toolBars(open, NOW, WS)[0]).toMatchObject({ to: NOW, busy: 30 })
    const early = row({ key: 'a', tools: [[WS - 50, WS + 10, 'Read']] })
    expect(toolBars(early, NOW, WS)[0].from).toBe(WS)
    const done = row({ key: 'a', finished: true, lastEventAt: WS + 200, tools: [[WS + 150, -1, 'Read']] })
    expect(toolBars(done, NOW, WS)[0].to).toBe(WS + 200)
  })

  it('tolerates a row with no tools field', () => {
    const r = row({ key: 'a' })
    delete (r as Partial<AgentWatchRow>).tools
    expect(toolBars(r, NOW, WS)).toEqual([])
  })
})

describe('formatDuration', () => {
  it('formats sub-second, seconds and minutes', () => {
    expect(formatDuration(0.4)).toBe('<1s')
    expect(formatDuration(4)).toBe('4s')
    expect(formatDuration(125)).toBe('2m05s')
  })
})
