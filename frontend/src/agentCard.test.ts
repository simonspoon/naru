import { describe, expect, it } from 'vitest'
import {
  LINGER_MS,
  STALE_CHILD_MS,
  cardChildren,
  childKey,
  childKeys,
  childRowsOf,
  reconcileChildLingering,
  visibleChildren,
  agentChips,
  agentColor,
  elapsedSince,
  ENTER_MS,
  isEntering,
  modelTag,
  markSeen,
  nextExpiry,
  reconcileLingering,
  withLingering,
  type Lingering,
} from './agentCard'
import type { AgentChild } from './types/AgentChild'
import type { AgentSession } from './types/AgentSession'

const s = (sessionId: string, startedAt = 0) => ({ sessionId, startedAt }) as AgentSession

describe('agentChips', () => {
  it('names the project and the task', () => {
    expect(agentChips({ cwd: '/a/b', taskId: 1553 }, { name: 'naru' })).toEqual({
      project: 'naru',
      task: '#1553',
    })
  })
  it('falls back to the folder, and to nothing for a task', () => {
    expect(agentChips({ cwd: '/a/b/', taskId: null }, undefined)).toEqual({
      project: 'b',
      task: null,
    })
    expect(agentChips({ cwd: '/', taskId: null }, undefined).project).toBeNull()
  })
})

describe('agentColor', () => {
  it('is stable per id', () => {
    expect(agentColor('abc')).toBe(agentColor('abc'))
    expect(agentColor('abc')).toMatch(/^#/)
  })
})

describe('lingering', () => {
  it('keeps a departed session, then drops it after LINGER_MS', () => {
    const a = s('a')
    let l = reconcileLingering([], [a, s('b')], [s('b')], 1000)
    expect(l).toEqual([{ session: a, leftAt: 1000 }])
    l = reconcileLingering(l, [s('b')], [s('b')], 1000 + LINGER_MS - 1)
    expect(l).toHaveLength(1)
    l = reconcileLingering(l, [s('b')], [s('b')], 1000 + LINGER_MS)
    expect(l).toEqual([])
  })
  it('does not re-stamp an already lingering session', () => {
    const a = s('a')
    const l = reconcileLingering([{ session: a, leftAt: 5 }], [a], [], 900)
    expect(l[0].leftAt).toBe(5)
  })
  it('returns the same array when nothing changed', () => {
    const l: Lingering[] = [{ session: s('a'), leftAt: 5 }]
    expect(reconcileLingering(l, [s('b')], [s('b')], 6)).toBe(l)
    expect(reconcileLingering([], [s('b')], [s('b')], 6)).toEqual([])
  })
  it('names the time to the earliest expiry', () => {
    expect(nextExpiry([], 0)).toBeNull()
    const l: Lingering[] = [
      { session: s('a'), leftAt: 100 },
      { session: s('b'), leftAt: 500 },
    ]
    expect(nextExpiry(l, 300)).toBe(100 + LINGER_MS - 300)
    expect(nextExpiry(l, 100 + LINGER_MS + 9)).toBe(0)
  })
  it('drops one that came back', () => {
    const a = s('a')
    expect(reconcileLingering([{ session: a, leftAt: 5 }], [], [a], 6)).toEqual([])
  })
  it('merges newest first and names the leaving ids', () => {
    const l: Lingering[] = [{ session: s('old', 1), leftAt: 0 }]
    const r = withLingering([s('new', 9), s('mid', 5)], l)
    expect(r.agents.map((x) => x.sessionId)).toEqual(['new', 'mid', 'old'])
    expect(r.leaving).toEqual(['old'])
  })
})

describe('elapsedSince', () => {
  it('floors into the compact unit', () => {
    expect(elapsedSince(0, 59_999)).toBe('59s')
    expect(elapsedSince(0, 240_000)).toBe('4m')
    expect(elapsedSince(0, 7_300_000)).toBe('2h')
    expect(elapsedSince(0, 3 * 86_400_000)).toBe('3d')
    expect(elapsedSince(10, 0)).toBe('0s')
  })
})

describe('markSeen / isEntering', () => {
  it('stamps only new ids and keeps the object when none is', () => {
    const seen = { a: 100 }
    expect(markSeen(seen, [s('a')], 999)).toBe(seen)
    expect(markSeen(seen, [s('a'), s('b')], 999)).toEqual({ a: 100, b: 999 })
  })
  it('enters on first render and inside the window, not after it', () => {
    expect(isEntering({}, 'a', 5)).toBe(true)
    expect(isEntering({ a: 100 }, 'a', 100 + ENTER_MS - 1)).toBe(true)
    expect(isEntering({ a: 100 }, 'a', 100 + ENTER_MS)).toBe(false)
  })
  it('does not re-enter on a remount after the window', () => {
    const seen = markSeen({}, [s('a')], 0)
    expect(isEntering(seen, 'a', ENTER_MS + 5000)).toBe(false)
    expect(markSeen(seen, [s('a')], ENTER_MS + 5000)).toBe(seen)
  })
})

const NOW = Date.parse('2026-10-01T12:00:00Z')
const ts = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const kid = (over: Partial<AgentChild>) =>
  ({ id: null, kind: 'shell', name: 'sleep 9', state: 'running', startedAt: null, ...over }) as AgentChild

describe('visibleChildren', () => {
  const week = ts(NOW - 7 * 86_400_000)
  it('drops a running child a week old under a done session — the ghost', () => {
    const done = { state: 'done', children: [kid({ startedAt: week })] }
    expect(visibleChildren(done, NOW)).toEqual([])
  })
  it('keeps recent work in flight under a done session, and unknown ages', () => {
    const recent = kid({ startedAt: ts(NOW - STALE_CHILD_MS + 60_000) })
    const unknown = kid({ name: 'x' })
    expect(visibleChildren({ state: 'done', children: [recent, unknown] }, NOW)).toHaveLength(2)
  })
  it('keeps a finished child under a done session', () => {
    const fin = kid({ state: 'finished', startedAt: week })
    expect(visibleChildren({ state: 'done', children: [fin] }, NOW)).toEqual([fin])
  })
  it('never filters a session that is not done', () => {
    const c = kid({ startedAt: week })
    expect(visibleChildren({ state: 'working', children: [c] }, NOW)).toEqual([c])
  })
})

describe('childKey', () => {
  it('uses the transcript id, else the command, never an index', () => {
    expect(childKey('p', kid({ id: 'agent-1' }))).toBe('p|agent-1')
    expect(childKey('p', kid({}))).toBe('p|cmd:sleep 9')
  })
})

describe('childKeys', () => {
  it('numbers identical shells so two parallel ones stay two cards', () => {
    const a = kid({})
    const b = kid({})
    const other = kid({ name: 'ls' })
    expect(childKeys('p', [a, other, b])).toEqual(['p|cmd:sleep 9', 'p|cmd:ls', 'p|cmd:sleep 9#2'])
  })
  it('keeps both through lingering and card order', () => {
    const p = { sessionId: 'p', state: 'working', children: [kid({}), kid({})] } as AgentSession
    const rows = childRowsOf([p], NOW)
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
    const l = reconcileChildLingering([], rows, [], NOW)
    expect(cardChildren('p', [], l).map((c) => c.key)).toEqual(rows.map((r) => r.key))
    expect(cardChildren('p', p.children, []).map((c) => c.key)).toEqual(rows.map((r) => r.key))
  })
})

describe('child lingering', () => {
  const parent = (children: AgentChild[]) =>
    ({ sessionId: 'p', state: 'working', children }) as AgentSession
  const a = kid({ id: 'agent-a', kind: 'subagent' })
  const b = kid({})
  it('keeps a vanished child for LINGER_MS, then drops it', () => {
    const prev = childRowsOf([parent([a, b])], NOW)
    const next = childRowsOf([parent([a])], NOW)
    const l = reconcileChildLingering([], prev, next, NOW)
    expect(l.map((x) => x.row.key)).toEqual(['p|cmd:sleep 9'])
    expect(reconcileChildLingering(l, next, next, NOW + 100)).toBe(l)
    expect(reconcileChildLingering(l, next, next, NOW + LINGER_MS)).toEqual([])
  })
  it('does not dissolve a shell that became hidden behind a subagent timer', () => {
    const t0 = '2026-10-01 11:59:00'
    const shell = kid({ command: 'sleep 1200 & wait', startedAt: t0 })
    const sub = kid({ id: 'agent-x', kind: 'subagent', name: 'Explore', startedAt: t0 })
    const prev = childRowsOf([parent([shell])], NOW)
    expect(prev).toHaveLength(1)
    const nextSessions = [parent([shell, sub])]
    expect(childRowsOf(nextSessions, NOW).map((r) => r.child)).toEqual([sub])
    expect(reconcileChildLingering([], prev, childRowsOf(nextSessions, NOW), NOW)).toHaveLength(1)
    expect(reconcileChildLingering([], prev, childRowsOf(nextSessions, NOW, true), NOW)).toEqual([])
  })
  it('lists live children first, then dissolving ones flagged leaving', () => {
    const prev = childRowsOf([parent([a, b])], NOW)
    const l = reconcileChildLingering([], prev, childRowsOf([parent([a])], NOW), NOW)
    expect(cardChildren('p', [a], l).map((c) => [c.key, c.leaving])).toEqual([
      ['p|agent-a', false],
      ['p|cmd:sleep 9', true],
    ])
    expect(cardChildren('other', [], l)).toEqual([])
  })
})

describe('modelTag', () => {
  it('names the family', () => {
    expect(modelTag('claude-opus-4-5')).toBe('opus')
    expect(modelTag('claude-sonnet-4-5-20250929')).toBe('sonnet')
    expect(modelTag('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(modelTag('claude-opus-5[1m]')).toBe('opus')
  })
  it('shortens an unrecognised id', () => {
    expect(modelTag('claude-foo-9-20260101')).toBe('foo-9')
    expect(modelTag('gpt-x[1m]')).toBe('gpt-x')
  })
  it('is null when unknown', () => {
    expect(modelTag(null)).toBeNull()
    expect(modelTag('')).toBeNull()
    expect(modelTag('claude-')).toBeNull()
  })
})
