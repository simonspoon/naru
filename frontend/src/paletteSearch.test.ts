import { describe, expect, it } from 'vitest'
import { fuzzyMatch, rankItems, segments } from './paletteSearch'

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
