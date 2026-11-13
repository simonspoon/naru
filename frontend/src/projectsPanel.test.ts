import { beforeEach, describe, expect, it } from 'vitest'
import {
  countsById,
  loadPanelCollapsed,
  loadPinned,
  loadShowArchived,
  NO_COUNTS,
  panelModel,
  parentRowId,
  rowCounts,
  savePanelCollapsed,
  saveShowArchived,
  togglePinned,
  type PanelCounts,
  type PanelOptions,
} from './projectsPanel'

const p = (id: number, name: string, parent_id: number | null = null, archived = false) => ({
  id,
  name,
  parent_id,
  archived,
})

// tools(1) > naru(2), khora(3) > khora-sub(4); games(5, archived) > dig(6); solo(7)
const projects = [
  p(1, 'Tools'),
  p(2, 'naru', 1),
  p(3, 'khora', 1),
  p(4, 'khora-sub', 3),
  p(5, 'Games', null, true),
  p(6, 'dig', 5),
  p(7, 'solo'),
]

const c = (backlog: number, todo: number, in_progress: number, done: number, needs = 0): PanelCounts => ({
  backlog,
  todo,
  in_progress,
  done,
  needs,
})

const counts = new Map<number, PanelCounts>([
  [1, c(1, 0, 0, 2)],
  [2, c(38, 3, 2, 412)],
  [3, c(3, 1, 0, 44)],
  [4, c(1, 0, 0, 1, 1)],
  [6, c(5, 5, 5, 5, 1)],
  [7, c(2, 0, 0, 9)],
])

const opts = (o: Partial<PanelOptions> = {}): PanelOptions => ({
  collapsed: new Set(),
  showArchived: false,
  filter: '',
  pinned: [],
  recent: [],
  ...o,
})

beforeEach(() => localStorage.clear())

describe('countsById', () => {
  it('maps server rows and adds questions to bounces for needs', () => {
    const m = countsById([
      { project_id: 9, backlog: 1, todo: 2, in_progress: 3, done: 4, questions: 2, bounced: 1 },
    ])
    expect(m.get(9)).toEqual(c(1, 2, 3, 4, 3))
  })
})

describe('rowCounts', () => {
  it('an open parent shows only its own counts', () => {
    expect(rowCounts(projects, counts, 1, false)).toEqual(c(1, 0, 0, 2))
  })
  it('a collapsed parent adds every descendant, at any depth', () => {
    expect(rowCounts(projects, counts, 1, true)).toEqual(c(1 + 38 + 3 + 1, 3 + 1, 2, 2 + 412 + 44 + 1, 1))
  })
  it('a project with no counts row is all zeros', () => {
    expect(rowCounts(projects, counts, 5, false)).toEqual(NO_COUNTS)
  })
  it('only descendants in the shown list roll up', () => {
    const shown = projects.filter((x) => x.id !== 4)
    expect(rowCounts(shown, counts, 3, true)).toEqual(c(3, 1, 0, 44))
  })
})

describe('panelModel tree', () => {
  it('indents children and hides archived subtrees by default', () => {
    const m = panelModel(projects, counts, opts())
    expect(m.tree.map((r) => [r.project.name, r.depth])).toEqual([
      ['Tools', 0],
      ['naru', 1],
      ['khora', 1],
      ['khora-sub', 2],
      ['solo', 0],
    ])
    expect(m.archivedCount).toBe(2)
  })

  it('open parents show own counts; a collapsed one rolls up and hides its subtree', () => {
    const open = panelModel(projects, counts, opts()).tree[0]
    expect(open).toMatchObject({ parent: true, collapsed: false, rolledUp: false, running: false })
    expect(open.counts).toEqual(c(1, 0, 0, 2))

    const m = panelModel(projects, counts, opts({ collapsed: new Set([1]) }))
    expect(m.tree.map((r) => r.project.name)).toEqual(['Tools', 'solo'])
    expect(m.tree[0]).toMatchObject({ collapsed: true, rolledUp: true, running: true, needsYou: true })
    expect(m.tree[0].counts.done).toBe(2 + 412 + 44 + 1)
  })

  it('a collapsed leaf is not rolled up', () => {
    const m = panelModel(projects, counts, opts({ collapsed: new Set([7]) }))
    expect(m.tree.find((r) => r.project.id === 7)).toMatchObject({ parent: false, rolledUp: false })
  })

  it('running and needs-you follow the shown counts', () => {
    const m = panelModel(projects, counts, opts())
    const by = (id: number) => m.tree.find((r) => r.project.id === id)!
    expect(by(2).running).toBe(true)
    expect(by(3).running).toBe(false)
    expect(by(3).needsYou).toBe(false)
    expect(by(4).needsYou).toBe(true)
  })

  it('show archived lists archived subtrees, flagged, and they roll up', () => {
    const m = panelModel(projects, counts, opts({ showArchived: true, collapsed: new Set([5]) }))
    const games = m.tree.find((r) => r.project.id === 5)!
    expect(games).toMatchObject({ archived: true, rolledUp: true })
    expect(games.counts).toEqual(c(5, 5, 5, 5, 1))
    expect(m.tree.some((r) => r.project.id === 6)).toBe(false)
    const open = panelModel(projects, counts, opts({ showArchived: true }))
    expect(open.tree.find((r) => r.project.id === 6)).toMatchObject({ archived: true, depth: 1 })
  })
})

describe('panelModel filter', () => {
  it('keeps matches and their ancestors, expanded, and drops the top section', () => {
    const m = panelModel(
      projects,
      counts,
      opts({ filter: '  SUB ', collapsed: new Set([1, 3]), pinned: [7] }),
    )
    expect(m.tree.map((r) => [r.project.name, r.depth, r.rolledUp])).toEqual([
      ['Tools', 0, false],
      ['khora', 1, false],
      ['khora-sub', 2, false],
    ])
    expect(m.tree[0].counts).toEqual(c(1, 0, 0, 2))
    expect(m.top).toEqual([])
  })
  it('does not match archived projects while they are hidden', () => {
    expect(panelModel(projects, counts, opts({ filter: 'dig' })).tree).toEqual([])
    expect(panelModel(projects, counts, opts({ filter: 'dig', showArchived: true })).tree.map((r) => r.project.id)).toEqual([5, 6])
  })
})

describe('panelModel pinned and recent', () => {
  it('lists pins first, then up to three recents not pinned, own counts, no archived', () => {
    const m = panelModel(
      projects,
      counts,
      opts({ pinned: [7, 99, 1], recent: [2, 7, 6, 3, 4, 1] }),
    )
    expect(m.top.map((r) => [r.project.id, r.pinned])).toEqual([
      [7, true],
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ])
    expect(m.top[1].counts).toEqual(c(1, 0, 0, 2))
    expect(m.tree.find((r) => r.project.id === 7)!.pinned).toBe(true)
  })
  it('a pinned parent collapsed in the tree rolls up there too', () => {
    const m = panelModel(projects, counts, opts({ pinned: [1], collapsed: new Set([1]) }))
    expect(m.top[0]).toMatchObject({ rolledUp: true, running: true })
    expect(m.top[0].counts.done).toBe(2 + 412 + 44 + 1)
  })
})

describe('parentRowId', () => {
  it('finds the nearest shallower row above', () => {
    const { tree } = panelModel(projects, counts, opts())
    expect(parentRowId(tree, 4)).toBe(3)
    expect(parentRowId(tree, 3)).toBe(1)
    expect(parentRowId(tree, 1)).toBeNull()
  })
})

describe('per-browser state', () => {
  it('pins toggle and persist', () => {
    expect(loadPinned()).toEqual([])
    const a = togglePinned([], 3)
    const b = togglePinned(a, 5)
    expect(loadPinned()).toEqual([3, 5])
    togglePinned(b, 3)
    expect(loadPinned()).toEqual([5])
  })
  it('collapsed parents and the archived switch persist; junk reads as empty', () => {
    savePanelCollapsed(new Set([1, 3]))
    expect([...loadPanelCollapsed()]).toEqual([1, 3])
    localStorage.setItem('naru-projects-panel-collapsed', '{bad')
    expect(loadPanelCollapsed().size).toBe(0)
    expect(loadShowArchived()).toBe(false)
    saveShowArchived(true)
    expect(loadShowArchived()).toBe(true)
    saveShowArchived(false)
    expect(loadShowArchived()).toBe(false)
  })
})
