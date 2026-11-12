import { describe, expect, it } from 'vitest'
import {
  ROW_CAP,
  badgeOf,
  bulkAction,
  buildTree,
  clickSelect,
  dirKey,
  entriesOf,
  filterEntries,
  parseOpenSections,
  parseViewMode,
  pruneToVisible,
  reconcileSelection,
  sectionRows,
  selectOne,
  splitPath,
  splitSections,
  statusWord,
} from './gitWorktree'
import type { Entry } from './gitWorktree'
import type { GitFile } from './types/GitFile'

const f = (status: string, path: string, orig_path: string | null = null): GitFile => ({
  status,
  path,
  orig_path,
  submodule: false,
})

const only = (file: GitFile): Entry => entriesOf(file)[0]
const untracked = (n: number): Entry[] =>
  Array.from({ length: n }, (_, i) => only(f('??', `d${i % 7}/f${i}.txt`)))

describe('classification', () => {
  it('puts a file changed in index and tree in both sections', () => {
    const s = splitSections([f('MM', 'a.ts'), f('M.', 'b.ts'), f('.M', 'c.ts'), f('??', 'n.ts')])
    expect(s.staged.map((e) => [e.file.path, e.code])).toEqual([
      ['a.ts', 'M'],
      ['b.ts', 'M'],
    ])
    expect(s.changes.map((e) => [e.file.path, e.code])).toEqual([
      ['a.ts', 'M'],
      ['c.ts', 'M'],
    ])
    expect(s.untracked.map((e) => e.file.path)).toEqual(['n.ts'])
    expect(s.conflicts).toEqual([])
  })

  it('keeps every conflict pair only in Conflicts', () => {
    for (const x of ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']) {
      const e = entriesOf(f(x, 'c.ts'))
      expect(e).toHaveLength(1)
      expect(e[0].section).toBe('conflicts')
      expect(badgeOf(e[0])).toEqual({ letter: '!', tone: 'conflict' })
    }
  })

  it('words and badges', () => {
    expect(statusWord(only(f('UD', 'x')))).toBe('deleted by them')
    expect(statusWord(only(f('DU', 'x')))).toBe('deleted by us')
    expect(statusWord(only(f('UU', 'x')))).toBe('both modified')
    expect(statusWord(only(f('??', 'x')))).toBe('untracked')
    const [staged] = entriesOf(f('R.', 'new', 'old'))
    expect(statusWord(staged)).toBe('renamed')
    expect(badgeOf(staged)).toEqual({ letter: 'R', tone: 'renamed' })
    expect(badgeOf(only(f('??', 'x')))).toEqual({ letter: 'U', tone: 'untracked' })
    expect(statusWord(entriesOf(f('.Z', 'x'))[0])).toBe('Z')
  })

  it('a pair with no change column still shows the file', () => {
    expect(entriesOf(f('..', 'x'))).toHaveLength(1)
  })

  it('splits a path into folder and name', () => {
    expect(splitPath('a/b/c.ts')).toEqual({ dir: 'a/b/', name: 'c.ts' })
    expect(splitPath('c.ts')).toEqual({ dir: '', name: 'c.ts' })
    expect(splitPath('a/b/')).toEqual({ dir: 'a/', name: 'b/' })
  })

  it('filters across orig_path too', () => {
    const es = [only(f('R.', 'new.ts', 'old.ts')), only(f('M.', 'z.ts'))]
    expect(filterEntries(es, 'OLD').map((e) => e.file.path)).toEqual(['new.ts'])
    expect(filterEntries(es, '  ')).toBe(es)
  })

  it('parses remembered state defensively', () => {
    expect(parseViewMode('tree')).toBe('tree')
    expect(parseViewMode('x')).toBe('flat')
    expect(parseViewMode(null)).toBe('flat')
    expect(parseOpenSections('{"staged":false,"x":1}').staged).toBe(false)
    expect(parseOpenSections('{bad').changes).toBe(true)
  })
})

describe('tree', () => {
  it('compacts single-child folder chains and counts files', () => {
    const es = ['a/b/c/x.ts', 'a/b/c/y.ts', 'src/m.ts', 'src/n/o.ts', 'top.ts'].map((p) =>
      only(f('.M', p)),
    )
    const nodes = buildTree(es)
    expect(nodes.map((n) => (n.kind === 'dir' ? n.label : n.entry.file.path))).toEqual([
      'a/b/c',
      'src',
      'top.ts',
    ])
    const a = nodes[0]
    expect(a.kind === 'dir' && a.entries).toHaveLength(2)
    const src = nodes[1]
    expect(src.kind === 'dir' && src.entries).toHaveLength(2)
    // `src` holds a file, so `n` is not folded into it.
    expect(src.kind === 'dir' && src.children.map((c) => c.kind)).toEqual(['dir', 'file'])
  })

  it('an untracked folder entry is a leaf under its parent', () => {
    const nodes = buildTree([only(f('??', 'pkg/vendor/'))])
    expect(nodes).toHaveLength(1)
    const d = nodes[0]
    expect(d.kind === 'dir' && d.label).toBe('pkg')
    expect(d.kind === 'dir' && d.children[0].kind).toBe('file')
  })

  it('a collapsed folder hides its rows without counting them as capped', () => {
    const es = ['a/x.ts', 'a/y.ts', 'b/z.ts'].map((p) => only(f('.M', p)))
    const r = sectionRows('changes', es, 'tree', new Set([dirKey('changes', 'a/')]), false)
    expect(r.rows.map((x) => x.type)).toEqual(['dir', 'dir', 'file'])
    expect(r.visible).toEqual(['b/z.ts'])
    expect(r.hidden).toBe(0)
  })
})

describe('row cap', () => {
  it('renders at most ROW_CAP rows in flat mode, then reports the rest', () => {
    const es = untracked(5000)
    const r = sectionRows('untracked', es, 'flat', new Set(), false)
    expect(ROW_CAP).toBe(500)
    expect(r.rows).toHaveLength(500)
    expect(r.hidden).toBe(4500)
    const all = sectionRows('untracked', es, 'flat', new Set(), true)
    expect(all.rows).toHaveLength(5000)
    expect(all.hidden).toBe(0)
  })

  it('caps rendered file rows in tree mode too', () => {
    const es = untracked(5000)
    const r = sectionRows('untracked', es, 'tree', new Set(), false)
    expect(r.visible).toHaveLength(500)
    expect(r.hidden).toBe(4500)
  })
})

describe('selection', () => {
  const vis = ['a', 'b', 'c', 'd', 'e']
  const none = { toggle: false, range: false }

  it('a plain click selects one and opens it', () => {
    const s = clickSelect(null, 'changes', 'b', vis, none)
    expect(s).toEqual({ section: 'changes', paths: ['b'], anchor: 'b', primary: 'b' })
  })

  it('cmd-click toggles within the section', () => {
    let s = clickSelect(null, 'changes', 'a', vis, none)
    s = clickSelect(s, 'changes', 'c', vis, { toggle: true, range: false })
    expect(s?.paths).toEqual(['a', 'c'])
    expect(s?.primary).toBe('c')
    s = clickSelect(s, 'changes', 'c', vis, { toggle: true, range: false })
    expect(s?.paths).toEqual(['a'])
    expect(s?.primary).toBe('a')
    expect(clickSelect(s, 'changes', 'a', vis, { toggle: true, range: false })).toBeNull()
  })

  it('shift-click extends from the anchor over the visible order, both ways', () => {
    const s = clickSelect(null, 'changes', 'b', vis, none)
    const down = clickSelect(s, 'changes', 'd', vis, { toggle: false, range: true })
    expect(down?.paths).toEqual(['b', 'c', 'd'])
    expect(down?.anchor).toBe('b')
    const up = clickSelect(down, 'changes', 'a', vis, { toggle: false, range: true })
    expect(up?.paths).toEqual(['a', 'b'])
  })

  it('never spans sections', () => {
    const s = selectOne('staged', 'a')
    expect(clickSelect(s, 'changes', 'c', vis, { toggle: true, range: false })).toEqual(
      selectOne('changes', 'c'),
    )
    expect(clickSelect(s, 'changes', 'c', vis, { toggle: false, range: true })).toEqual(
      selectOne('changes', 'c'),
    )
  })

  it('prune keeps only visible rows of a multi-selection', () => {
    const vis = { conflicts: [], staged: [], changes: ['a', 'c'], untracked: [] }
    const sel = { section: 'changes' as const, paths: ['a', 'b', 'c'], anchor: 'a', primary: 'b' }
    expect(pruneToVisible(sel, vis)).toEqual({
      section: 'changes',
      paths: ['a', 'c'],
      anchor: 'a',
      primary: 'c',
    })
    const all = { ...vis, changes: ['a', 'b', 'c'] }
    expect(pruneToVisible(sel, all)).toBe(sel)
    expect(pruneToVisible(sel, { ...vis, changes: [] })).toBeNull()
    const lone = selectOne('changes', 'zzz')
    expect(pruneToVisible(lone, vis)).toBe(lone)
    expect(pruneToVisible(null, vis)).toBeNull()
  })

  it('reconcile: unchanged keeps the object, drops gone paths, follows a lone file', () => {
    const sel = { section: 'staged' as const, paths: ['a', 'b'], anchor: 'a', primary: 'b' }
    const same = splitSections([f('M.', 'a'), f('M.', 'b')])
    expect(reconcileSelection(sel, same)).toBe(sel)
    const less = splitSections([f('M.', 'a')])
    expect(reconcileSelection(sel, less)).toEqual({
      section: 'staged',
      paths: ['a'],
      anchor: 'a',
      primary: 'a',
    })
    const lone = selectOne('staged', 'a')
    expect(reconcileSelection(lone, splitSections([f('.M', 'a')]))).toEqual(
      selectOne('changes', 'a'),
    )
    expect(reconcileSelection(lone, splitSections([f('.M', 'other')]))).toBeNull()
    expect(reconcileSelection(null, same)).toBeNull()
  })
})

describe('bulk header action', () => {
  it('is one `all: true` with no filter and no conflict', () => {
    expect(bulkAction('unstage', 'staged', ['a', 'b'], false, false)).toEqual({
      label: 'Unstage all',
      target: { all: true },
    })
    expect(bulkAction('stage', 'changes', ['a'], false, false).target).toEqual({ all: true })
  })

  it('is the shown paths with a filter, with a conflict, or on Untracked', () => {
    expect(bulkAction('stage', 'changes', ['a'], true, false)).toEqual({
      label: 'Stage shown',
      target: { paths: ['a'] },
    })
    expect(bulkAction('stage', 'changes', ['a'], false, true).target).toEqual({ paths: ['a'] })
    expect(bulkAction('stage', 'untracked', ['a', 'b'], false, false)).toEqual({
      label: 'Stage all',
      target: { paths: ['a', 'b'] },
    })
  })
})
