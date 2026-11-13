import { describe, expect, it } from 'vitest'
import {
  breadcrumb,
  childCounts,
  fuzzyMatch,
  projectPanelTargets,
  rankItems,
  segments,
  subProjects,
} from './paletteSearch'

describe('fuzzyMatch', () => {
  it('matches a subsequence case-insensitively and returns its indices', () => {
    expect(fuzzyMatch('kb', 'Knowledge base')?.indices).toEqual([0, 10])
    expect(fuzzyMatch('NA', 'naru')?.indices).toEqual([0, 1])
  })
  it('returns null when the characters are not in order', () => {
    expect(fuzzyMatch('xz', 'naru')).toBeNull()
    expect(fuzzyMatch('un', 'nu')).toBeNull()
  })
  it('ignores whitespace in the query', () => {
    expect(fuzzyMatch('na git', 'naru — Git')).not.toBeNull()
  })
  it('ranks prefix > word start > contiguous > scattered', () => {
    const score = (t: string) => fuzzyMatch('na', t)!.score
    expect(score('naru')).toBeGreaterThan(score('my naru'))
    expect(score('my naru')).toBeGreaterThan(score('terminal'))
    expect(score('terminal')).toBeGreaterThan(score('knowledge base'))
  })
})

describe('rankItems', () => {
  const items = [
    { label: 'Knowledge base' },
    { label: 'Terminal' },
    { label: 'naru-mac' },
    { label: 'naru-audio', penalty: 500 },
  ]
  it('keeps input order for an empty query', () => {
    expect(rankItems(items, '  ').map((r) => r.item.label)).toEqual(items.map((i) => i.label))
  })
  it('filters and sorts best first, honouring penalty', () => {
    expect(rankItems(items, 'na').map((r) => r.item.label)).toEqual([
      'naru-mac',
      'naru-audio',
      'Terminal',
      'Knowledge base',
    ])
  })
  it('breaks ties by input order', () => {
    const r = rankItems([{ label: 'ab', keywords: 'first' }, { label: 'ab', keywords: 'second' }], 'ab')
    expect(r.map((x) => x.item.keywords)).toEqual(['first', 'second'])
  })
  it('falls back to keywords, below label hits, with no highlight', () => {
    const r = rankItems([{ label: 'Live conversation', keywords: 'talk speak' }, { label: 'Talk' }], 'talk')
    expect(r.map((x) => x.item.label)).toEqual(['Talk', 'Live conversation'])
    expect(r[1].indices).toEqual([])
  })
})

describe('segments', () => {
  it('groups matched and unmatched runs', () => {
    expect(segments('naru', [0, 1])).toEqual([
      { text: 'na', hit: true },
      { text: 'ru', hit: false },
    ])
    expect(segments('abc', [])).toEqual([{ text: 'abc', hit: false }])
    expect(segments('', [])).toEqual([])
  })
})

describe('projectPanelTargets', () => {
  const tabs = ['dashboard', 'board', 'git', 'settings']
  const label = (t: string) => t[0].toUpperCase() + t.slice(1)
  const targets = projectPanelTargets(7, tabs, label)
  it('lists Board first, then the tabs in order, then Create task', () => {
    expect(targets.map((t) => t.label)).toEqual([
      'Board',
      'Dashboard',
      'Git',
      'Settings',
      'Create task',
    ])
    expect(targets.map((t) => t.command)).toEqual([false, false, false, false, true])
  })
  it('routes Board to the bare project and the rest to their segment', () => {
    expect(targets.map((t) => t.hash)).toEqual([
      '#/projects/7',
      '#/projects/7/dashboard',
      '#/projects/7/git',
      '#/projects/7/settings',
      '#/projects/7/create-task',
    ])
  })
})

describe('subProjects', () => {
  const projects = [
    { id: 1, parent_id: null },
    { id: 2, parent_id: 1 },
    { id: 3, parent_id: 2 },
    { id: 4, parent_id: 1 },
    { id: 5, parent_id: 1 },
  ]
  it('lists only direct children, in server order', () => {
    expect(subProjects(projects, 1, new Set()).map((p) => p.id)).toEqual([2, 4, 5])
    expect(subProjects(projects, 2, new Set()).map((p) => p.id)).toEqual([3])
    expect(subProjects(projects, 3, new Set())).toEqual([])
  })
  it('puts archived children after the live ones', () => {
    expect(subProjects(projects, 1, new Set([2])).map((p) => p.id)).toEqual([4, 5, 2])
  })
  it('counts direct children per project', () => {
    const c = childCounts(projects)
    expect([c.get(1), c.get(2), c.get(3)]).toEqual([3, 1, undefined])
  })
})

describe('breadcrumb', () => {
  it('keeps a short path whole', () => {
    expect(breadcrumb(['a', 'b', 'c'], 4)).toEqual(['a', 'b', 'c'])
  })
  it('collapses the middle of a long one, keeping the first and the innermost', () => {
    expect(breadcrumb(['a', 'b', 'c', 'd', 'e', 'f'], 4)).toEqual(['a', null, 'e', 'f'])
  })
})
