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
  toolRows,
  TOOL_ROW_CAP,
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
    const o = orderRows(rows, NOW, WS)
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

describe('toolRows', () => {
  it('makes one row per call with its duration', () => {
    const r = row({ key: 'a', tools: [[WS + 100, WS + 103, 'Read', '/a/b.rs']] })
    const t = toolRows(r, NOW, WS)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ name: 'Read', from: WS + 100, to: WS + 103, duration: 3, open: false })
    expect(t[0].summary).toBe('/a/b.rs')
    expect(toolLabel(t[0])).toBe('Read · 3s\n/a/b.rs')
  })

  it('runs an open call to now, clips to the window, and stops a finished row at its last event', () => {
    const open = row({ key: 'a', tools: [[NOW - 30, -1, 'Bash', '']] })
    expect(toolRows(open, NOW, WS)[0]).toMatchObject({ to: NOW, duration: 30, open: true })
    expect(toolLabel(toolRows(open, NOW, WS)[0])).toBe('Bash · running 30s')
    const early = row({ key: 'a', tools: [[WS - 50, WS + 10, 'Read', '']] })
    expect(toolRows(early, NOW, WS)[0].from).toBe(WS)
    const done = row({ key: 'a', finished: true, lastEventAt: WS + 200, tools: [[WS + 150, -1, 'Read', '']] })
    expect(toolRows(done, NOW, WS)[0].to).toBe(WS + 200)
  })

  it('keeps only the newest calls, oldest first', () => {
    const tools = Array.from({ length: TOOL_ROW_CAP + 5 }, (_, i): [number, number, string, string] => [
      WS + i * 10,
      WS + i * 10 + 1,
      'Read',
      '',
    ])
    const t = toolRows(row({ key: 'a', tools }), NOW, WS)
    expect(t).toHaveLength(TOOL_ROW_CAP)
    expect(t[0].from).toBe(WS + 50)
    expect(t[t.length - 1].from).toBe(WS + (TOOL_ROW_CAP + 4) * 10)
  })

  it('tolerates a row with no tools field', () => {
    const r = row({ key: 'a' })
    delete (r as Partial<AgentWatchRow>).tools
    expect(toolRows(r, NOW, WS)).toEqual([])
  })
})

describe('orderRows tool rows', () => {
  it('hangs tool rows under their session and subagent', () => {
    const rows = [
      row({ key: 'a', startedAt: 10, tools: [[WS + 5, WS + 6, 'Read', '']] }),
      row({ key: 'a/s1', kind: 'subagent', parent: 'a', startedAt: 11, tools: [[WS + 7, WS + 8, 'Grep', '']] }),
      row({ key: 'a/sh', kind: 'shell', parent: 'a', startedAt: 12 }),
    ]
    const o = orderRows(rows, NOW, WS)
    expect(o.map((x) => (x.tool ? `${x.row.key}:${x.tool.name}` : x.row.key))).toEqual([
      'a',
      'a:Read',
      'a/s1',
      'a/s1:Grep',
      'a/sh',
    ])
    expect(o.map((x) => x.depth)).toEqual([0, 1, 1, 1, 1])
  })
})

describe('formatDuration', () => {
  it('formats sub-second, seconds and minutes', () => {
    expect(formatDuration(0.4)).toBe('<1s')
    expect(formatDuration(4)).toBe('4s')
    expect(formatDuration(125)).toBe('2m05s')
  })
})
