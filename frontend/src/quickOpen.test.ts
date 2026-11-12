import { beforeEach, describe, expect, it } from 'vitest'
import {
  emptyQueryPaths,
  loadRecentFiles,
  matchTier,
  rankPaths,
  recordRecent,
  saveRecentFiles,
} from './quickOpen'

describe('matchTier', () => {
  it('orders exact name, name prefix, name subsequence, path subsequence', () => {
    expect(matchTier('api.ts', 'frontend/src/api.ts')).toBe(0)
    expect(matchTier('api', 'frontend/src/api.ts')).toBe(1)
    expect(matchTier('ats', 'frontend/src/api.ts')).toBe(2)
    expect(matchTier('srcapi', 'frontend/src/api.ts')).toBe(3)
    expect(matchTier('zzz', 'frontend/src/api.ts')).toBeNull()
  })

  it('is case-insensitive unless the query has an uppercase letter', () => {
    expect(matchTier('filesview', 'src/FilesView.tsx')).toBe(1)
    expect(matchTier('FilesView', 'src/FilesView.tsx')).toBe(1)
    expect(matchTier('FilesVIEW', 'src/FilesView.tsx')).toBeNull()
    expect(matchTier('Readme', 'README.md')).toBeNull()
  })

  it('ignores whitespace and matches nothing for an empty query', () => {
    expect(matchTier('src api', 'src/api.rs')).toBe(3)
    expect(matchTier('', 'a.ts')).toBeNull()
    expect(matchTier('   ', 'a.ts')).toBeNull()
  })
})

describe('rankPaths', () => {
  it('ranks by tier first, then the shorter path, then string order', () => {
    const paths = [
      'docs/api-notes.md', // name prefix
      'src/core/api.rs', // name prefix, longer
      'frontend/src/api.ts',
      'src/api.rs',
      'lib/xapix.ts', // name subsequence
      'a/p/i/z.md', // path subsequence
      'nothing.txt',
    ]
    expect(rankPaths('api', paths)).toEqual([
      'src/api.rs',
      'src/core/api.rs',
      'docs/api-notes.md',
      'frontend/src/api.ts',
      'lib/xapix.ts',
      'a/p/i/z.md',
    ])
  })

  it('puts an exact file name above every prefix match', () => {
    expect(rankPaths('mod.rs', ['src/modules.rs', 'src/core/deep/mod.rs'])).toEqual([
      'src/core/deep/mod.rs',
      'src/modules.rs',
    ])
    expect(rankPaths('mod', ['src/core/deep/mod', 'mod.rs'])).toEqual([
      'src/core/deep/mod',
      'mod.rs',
    ])
  })

  it('breaks equal-length ties alphabetically and honours the limit', () => {
    expect(rankPaths('a', ['b/a.ts', 'a/a.ts', 'c/a.ts'], 2)).toEqual(['a/a.ts', 'b/a.ts'])
    expect(rankPaths('', ['a.ts'])).toEqual([])
  })
})

describe('recordRecent', () => {
  it('moves a path to the front without duplicating it, capped', () => {
    expect(recordRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(recordRecent(['a', 'b'], 'z', 2)).toEqual(['z', 'a'])
  })
})

describe('emptyQueryPaths', () => {
  const paths = ['README.md', 'src/a.ts', 'src/b.ts', 'src/c.ts']

  it('lists recent, then other open tabs, then the rest in walk order', () => {
    expect(emptyQueryPaths(paths, false, ['src/c.ts', 'src/b.ts'], ['src/b.ts', 'src/a.ts'])).toEqual(
      ['src/b.ts', 'src/a.ts', 'src/c.ts', 'README.md'],
    )
  })

  it('drops a remembered path the complete listing no longer holds, unless open', () => {
    expect(emptyQueryPaths(paths, false, ['gone/open.ts'], ['gone/x.ts', 'gone/open.ts'])).toEqual([
      'gone/open.ts',
      ...paths,
    ])
  })

  it('keeps every remembered path when the listing is truncated', () => {
    expect(emptyQueryPaths(paths, true, [], ['beyond/cap.ts'], 2)).toEqual([
      'beyond/cap.ts',
      'README.md',
    ])
  })
})

describe('recent files storage', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips per project and survives garbage', () => {
    saveRecentFiles(1, ['a.ts'])
    saveRecentFiles(2, ['b.ts'])
    expect(loadRecentFiles(1)).toEqual(['a.ts'])
    expect(loadRecentFiles(2)).toEqual(['b.ts'])
    localStorage.setItem('naru-recent-files', '{not json')
    expect(loadRecentFiles(1)).toEqual([])
    saveRecentFiles(3, ['c.ts'])
    expect(loadRecentFiles(3)).toEqual(['c.ts'])
    localStorage.setItem('naru-recent-files', JSON.stringify({ 1: [1, 'x.ts'] }))
    expect(loadRecentFiles(1)).toEqual(['x.ts'])
  })
})
