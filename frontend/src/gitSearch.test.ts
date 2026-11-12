import { describe, expect, it } from 'vitest'
import {
  NO_FILTERS,
  filterByPath,
  filterChips,
  filtersKey,
  findByShaPrefix,
  gitKeyAction,
  hasFilters,
  isShaLike,
  normalizeFilters,
  resultLabel,
  stepIndex,
  validPathFilter,
} from './gitSearch'

describe('log filters', () => {
  it('treats blank and whitespace as no filter', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false)
    expect(hasFilters({ ...NO_FILTERS, q: '   ' })).toBe(false)
    expect(hasFilters({ ...NO_FILTERS, author: 'al' })).toBe(true)
    expect(normalizeFilters({ ...NO_FILTERS, q: '  -x  ' }).q).toBe('-x')
  })

  it('keys equal filters equally and differing filters apart', () => {
    expect(filtersKey({ ...NO_FILTERS, q: 'a ' })).toBe(filtersKey({ ...NO_FILTERS, q: 'a' }))
    expect(filtersKey({ ...NO_FILTERS, q: 'a' })).not.toBe(
      filtersKey({ ...NO_FILTERS, author: 'a' }),
    )
  })

  it('makes one chip per active filter, in order', () => {
    const chips = filterChips({
      q: 'login',
      author: '',
      path: 'src/',
      since: '2024-01-01',
      until: '',
    })
    expect(chips).toEqual([
      { field: 'q', label: 'Message: login' },
      { field: 'path', label: 'Path: src/' },
      { field: 'since', label: 'Since 2024-01-01' },
    ])
  })

  it('labels the result count', () => {
    expect(resultLabel(1, false, false)).toBe('1 commit')
    expect(resultLabel(6, false, false)).toBe('6 commits')
    expect(resultLabel(100, true, false)).toBe('100+ commits')
    expect(resultLabel(3, false, true)).toMatch(/stopped after 10 s: 3 found/)
  })
})

describe('jump to sha', () => {
  it('accepts 7-64 hex only', () => {
    expect(isShaLike('abc1234')).toBe(true)
    expect(isShaLike(' ABC1234DEF ')).toBe(true)
    expect(isShaLike('abc123')).toBe(false)
    expect(isShaLike('abc123z')).toBe(false)
    expect(isShaLike('-abc1234')).toBe(false)
  })

  it('finds a loaded commit by unique prefix only', () => {
    const items = [{ hash: 'abc1234aaa' }, { hash: 'abc1234bbb' }, { hash: 'def5678ccc' }]
    expect(findByShaPrefix(items, 'DEF5678')).toEqual({ hash: 'def5678ccc' })
    expect(findByShaPrefix(items, 'abc1234')).toBeNull()
    expect(findByShaPrefix(items, 'abc1234b')).toEqual({ hash: 'abc1234bbb' })
    expect(findByShaPrefix(items, '0000000')).toBeNull()
  })
})

describe('file filter', () => {
  const files = [
    { path: 'src/App.tsx', orig_path: null },
    { path: 'docs/new.md', orig_path: 'docs/old.md' },
    { path: 'README.md', orig_path: null },
  ]
  it('matches path or rename source, case-insensitively', () => {
    expect(filterByPath(files, 'app').map((f) => f.path)).toEqual(['src/App.tsx'])
    expect(filterByPath(files, 'OLD').map((f) => f.path)).toEqual(['docs/new.md'])
    expect(filterByPath(files, '.md').length).toBe(2)
    expect(filterByPath(files, ' ')).toBe(files)
    expect(filterByPath(files, '*')).toEqual([])
  })
})

describe('keys', () => {
  it('maps the documented keys and nothing else', () => {
    expect(gitKeyAction('j')).toBe('down')
    expect(gitKeyAction('ArrowDown')).toBe('down')
    expect(gitKeyAction('k')).toBe('up')
    expect(gitKeyAction('ArrowUp')).toBe('up')
    expect(gitKeyAction('Escape')).toBe('back')
    expect(gitKeyAction('ArrowLeft')).toBe('back')
    expect(gitKeyAction('/')).toBe('search')
    expect(gitKeyAction('[')).toBe('prevFile')
    expect(gitKeyAction(']')).toBe('nextFile')
    expect(gitKeyAction('?')).toBe('help')
    expect(gitKeyAction('h')).toBeNull()
    expect(gitKeyAction('l')).toBeNull()
    expect(gitKeyAction('ArrowRight')).toBeNull()
    expect(gitKeyAction('Enter')).toBeNull()
  })

  it('steps within bounds', () => {
    expect(stepIndex(-1, 5, 1)).toBe(0)
    expect(stepIndex(-1, 5, -1)).toBe(4)
    expect(stepIndex(4, 5, 1)).toBe(4)
    expect(stepIndex(0, 5, -1)).toBe(0)
    expect(stepIndex(2, 5, 1)).toBe(3)
    expect(stepIndex(0, 0, 1)).toBe(-1)
  })
})

describe('path filter check', () => {
  it('matches the server rule', () => {
    for (const ok of ['', '.', 'src', './src/ui/', 'x*y.txt', '-x']) expect(validPathFilter(ok)).toBe(true)
    for (const bad of ['/etc', '../x', 'a/../b', 'a//b', 'a\\b', '..']) expect(validPathFilter(bad)).toBe(false)
  })
})
