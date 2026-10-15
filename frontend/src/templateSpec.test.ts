import { describe, expect, it } from 'vitest'
import {
  cellSortKey,
  groupItems,
  isNumericColumn,
  moveSelection,
  normalizeSpec,
  safeHref,
} from './templateSpec'

describe('normalizeSpec', () => {
  it('rejects non-objects and unknown types without throwing', () => {
    expect(normalizeSpec(null).ok).toBe(false)
    expect(normalizeSpec('x').ok).toBe(false)
    const r = normalizeSpec({ type: 'nope' })
    expect(r.ok).toBe(false)
  })
  it('requires the fields each type needs', () => {
    expect(normalizeSpec({ type: 'card' }).ok).toBe(false)
    expect(normalizeSpec({ type: 'stat', label: 'a' }).ok).toBe(false)
    expect(normalizeSpec({ type: 'callout' }).ok).toBe(false)
    expect(normalizeSpec({ type: 'table', columns: [] }).ok).toBe(false)
    expect(normalizeSpec({ type: 'list-detail', items: [] }).ok).toBe(false)
  })
  it('coerces a bad tone and drops unsafe hrefs', () => {
    const r = normalizeSpec({ type: 'card', title: 't', tone: 'purple', href: 'javascript:alert(1)' })
    expect(r.ok && r.spec.type === 'card' && r.spec.tone).toBe('neutral')
    expect(r.ok && r.spec.type === 'card' && r.spec.href).toBeUndefined()
  })
  it('defaults a callout tone to info', () => {
    const r = normalizeSpec({ type: 'callout', text: 'hi' })
    expect(r.ok && r.spec.type === 'callout' && r.spec.tone).toBe('info')
  })
  it('turns an invalid panel child into a callout and caps depth', () => {
    const r = normalizeSpec({ type: 'panel', children: [{ type: 'zzz' }] })
    expect(r.ok && r.spec.type === 'panel' && r.spec.children?.[0].type).toBe('callout')
    let deep: unknown = { type: 'panel' }
    for (let i = 0; i < 8; i++) deep = { type: 'panel', children: [deep] }
    // Too-deep panels degrade to a callout inside, never throw.
    expect(JSON.stringify(normalizeSpec(deep))).toContain('nested too deeply')
  })
  it('normalizes table cells to plain values', () => {
    const r = normalizeSpec({ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ a: { x: 1 } }, 'bad'] })
    expect(r.ok && r.spec.type === 'table' && r.spec.rows).toEqual([{ a: null }])
  })
})

describe('safeHref', () => {
  it('allows hash routes and http(s) only', () => {
    expect(safeHref('#/kb')).toBe('#/kb')
    expect(safeHref('https://a.b')).toBe('https://a.b')
    expect(safeHref('//evil.com')).toBeUndefined()
    expect(safeHref('data:text/html,x')).toBeUndefined()
    expect(safeHref(3)).toBeUndefined()
  })
})

describe('columns and sorting', () => {
  const rows = [{ n: 1, s: 'a' }, { n: null, s: 'B' }, { n: 3, s: 'c' }]
  it('detects numeric columns', () => {
    expect(isNumericColumn({ key: 'n', label: 'N' }, rows)).toBe(true)
    expect(isNumericColumn({ key: 's', label: 'S' }, rows)).toBe(false)
    expect(isNumericColumn({ key: 'n', label: 'N', numeric: false }, rows)).toBe(false)
    expect(isNumericColumn({ key: 'zz', label: 'Z' }, rows)).toBe(false)
  })
  it('builds comparable sort keys', () => {
    expect(cellSortKey(5, true)).toBe(5)
    expect(cellSortKey(null, true)).toBe(-Infinity)
    expect(cellSortKey('B', false)).toBe('b')
    expect(cellSortKey(null, false)).toBe('')
  })
})

describe('list helpers', () => {
  it('moves selection and clamps', () => {
    const ids = ['a', 'b', 'c']
    expect(moveSelection(ids, 'a', 1)).toBe('b')
    expect(moveSelection(ids, 'c', 1)).toBe('c')
    expect(moveSelection(ids, 'a', -1)).toBe('a')
    expect(moveSelection(ids, null, 1)).toBe('a')
    expect(moveSelection(ids, null, -1)).toBe('c')
    expect(moveSelection([], 'a', 1)).toBeNull()
  })
  it('groups in first-seen order with ungrouped first', () => {
    const g = groupItems([
      { id: '1', title: 'x', group: 'B' },
      { id: '2', title: 'y' },
      { id: '3', title: 'z', group: 'A' },
      { id: '4', title: 'w', group: 'B' },
    ])
    expect(g.map((s) => s.group)).toEqual([null, 'B', 'A'])
    expect(g[1].items.map((i) => i.id)).toEqual(['1', '4'])
  })
})
