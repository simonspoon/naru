import { describe, expect, it } from 'vitest'
import {
  LINGER_MS,
  agentChips,
  agentColor,
  elapsedSince,
  ENTER_MS,
  isEntering,
  markSeen,
  nextExpiry,
  reconcileLingering,
  withLingering,
  type Lingering,
} from './agentCard'
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
