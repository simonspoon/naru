import { describe, expect, it } from 'vitest'
import { headMeta, quietHint, taskHash, taskSegments, turnClock } from './liveChat'

const joined = {
  live: true,
  joined: true,
  path: 'auris' as const,
  blocked: false,
  listening: false,
  paused: false,
  muted: true,
  chord: 'F5',
  audioEngine: null,
}

describe('taskSegments', () => {
  it('splits a reference out of prose and round-trips the text', () => {
    const text = "That's #1563, in to-do."
    const segs = taskSegments(text)
    expect(segs).toEqual([
      { kind: 'text', text: "That's " },
      { kind: 'task', id: 1563, text: '#1563' },
      { kind: 'text', text: ', in to-do.' },
    ])
    expect(segs.map((s) => s.text).join('')).toBe(text)
  })
  it('finds several, including at the edges', () => {
    const ids = taskSegments('#1 and #22').flatMap((s) => (s.kind === 'task' ? [s.id] : []))
    expect(ids).toEqual([1, 22])
  })
  it('ignores routes, word-glued hashes and non-numbers', () => {
    for (const t of [
      '#/tasks/5',
      'go to #/live',
      'abc#12',
      '#12abc',
      '#abc',
      'a/#12',
      '##12',
      'no # 5',
    ]) {
      expect(taskSegments(t).every((s) => s.kind === 'text')).toBe(true)
    }
  })
  it('leaves a decimal alone but takes a sentence-final dot', () => {
    expect(taskSegments('#12.5').every((s) => s.kind === 'text')).toBe(true)
    expect(taskSegments('see #12.').some((s) => s.kind === 'task')).toBe(true)
  })
  it('returns nothing for empty text', () => {
    expect(taskSegments('')).toEqual([])
  })
})

describe('taskHash', () => {
  it('uses the legacy task route', () => expect(taskHash(7)).toBe('#/tasks/7'))
})

describe('turnClock', () => {
  it('is empty for garbage', () => expect(turnClock('nope')).toBe(''))
  it('is HH:MM for a store stamp', () =>
    expect(turnClock('2026-07-26 05:30:32')).toMatch(/^\d\d:\d\d$/))
})

describe('headMeta', () => {
  it('joins what is known', () =>
    expect(headMeta('claude-opus-5', 54800)).toBe('opus-5 · 54.8k ctx'))
  it('omits what is missing', () => {
    expect(headMeta(null, 950)).toBe('950 ctx')
    expect(headMeta('claude-opus-5', null)).toBe('opus-5')
    expect(headMeta(null, null)).toBe('')
  })
})

describe('quietHint', () => {
  it('is the short key line when muted and ready', () => {
    expect(quietHint(joined)).toEqual({
      chord: 'F5',
      text: 'to talk · Enter sends',
    })
  })
  it('names the path while listening', () => {
    expect(quietHint({ ...joined, muted: false, listening: true }).text).toBe(
      'Listening through auris · Enter sends',
    )
  })
  it('keeps refusals and pause text', () => {
    expect(quietHint({ ...joined, blocked: true }).text).toContain('refused')
    expect(quietHint({ ...joined, paused: true }).text).toContain('Paused')
    expect(quietHint({ ...joined, live: false }).chord).toBeNull()
  })
})
