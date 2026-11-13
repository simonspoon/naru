import { beforeEach, describe, expect, it } from 'vitest'
import { loadRecent, recentProjects, recordRecent } from './recentProjects'

const KEY = 'naru-recent-projects'
const ps = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id }))

beforeEach(() => localStorage.clear())

describe('recording', () => {
  it('puts the newest first and dedupes', () => {
    recordRecent(1)
    recordRecent(2)
    recordRecent(1)
    expect(loadRecent()).toEqual([1, 2])
  })
  it('caps what it stores', () => {
    for (let i = 1; i <= 30; i++) recordRecent(i)
    expect(loadRecent()).toHaveLength(12)
    expect(loadRecent()[0]).toBe(30)
  })
})

describe('loading', () => {
  it('tolerates malformed values', () => {
    for (const raw of ['', 'nope', '{"a":1}', '"x"', 'null']) {
      localStorage.setItem(KEY, raw)
      expect(loadRecent()).toEqual([])
    }
  })
  it('drops non-integer entries', () => {
    localStorage.setItem(KEY, JSON.stringify([3, 'x', 1.5, -2, null, 4]))
    expect(loadRecent()).toEqual([3, 4])
  })
})

describe('recentProjects', () => {
  it('lists remembered projects in recency order, skipping ids that are gone', () => {
    expect(recentProjects(ps, [9, 3, 1, 3]).map((p) => p.id)).toEqual([3, 1])
  })
  it('caps at the limit', () => {
    expect(recentProjects(ps, [7, 6, 5, 4, 3, 2, 1]).map((p) => p.id)).toEqual([7, 6, 5, 4, 3])
  })
  it('falls back to the first projects in server order', () => {
    expect(recentProjects(ps, []).map((p) => p.id)).toEqual([1, 2, 3, 4, 5])
    expect(recentProjects(ps, [99]).map((p) => p.id)).toEqual([1, 2, 3, 4, 5])
  })
})
