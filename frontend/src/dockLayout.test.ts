import { describe, expect, it, vi } from 'vitest'
import { collectLeafIds } from './lib/paneTree'
import {
  activateTab,
  closePanel,
  closedPanels,
  debouncedSaver,
  defaultStore,
  deleteLayout,
  dropPanel,
  groupOf,
  isVisible,
  PANEL_IDS,
  parseState,
  parseStore,
  PRESETS,
  resetLayout,
  revealPanel,
  saveAs,
  selectLayout,
  serializeStore,
  setRatios,
  updateActive,
  type DockState,
} from './dockLayout'

const talk = () => PRESETS.talk.make()

function docked(s: DockState): string[] {
  return PANEL_IDS.filter((p) => groupOf(s, p) !== null)
}

function consistent(s: DockState) {
  // Every leaf has a group and every group a leaf; each panel at most once.
  const leaves = collectLeafIds(s.tree).sort()
  expect(Object.keys(s.groups).sort()).toEqual(leaves)
  const tabs = Object.values(s.groups).flatMap((g) => g.tabs)
  expect(new Set(tabs).size).toBe(tabs.length)
  for (const g of Object.values(s.groups)) expect(g.tabs).toContain(g.active)
}

describe('presets', () => {
  it('are consistent and keep diagrams closed', () => {
    for (const p of Object.values(PRESETS)) {
      const s = p.make()
      consistent(s)
      expect(groupOf(s, 'diagrams')).toBeNull()
      expect(groupOf(s, 'main')).not.toBeNull()
    }
  })
  it('talk stacks agents and terminal, agents in front', () => {
    const s = talk()
    expect(groupOf(s, 'agents')).toBe(groupOf(s, 'terminal'))
    expect(isVisible(s, 'agents')).toBe(true)
    expect(isVisible(s, 'terminal')).toBe(false)
  })
})

describe('dropPanel', () => {
  it('stacks on a centre drop and prunes the emptied group', () => {
    const s = dropPanel(talk(), 'chat', groupOf(talk(), 'main')!, 'center')
    consistent(s)
    expect(groupOf(s, 'chat')).toBe(groupOf(s, 'main'))
    expect(isVisible(s, 'chat')).toBe(true)
    expect(isVisible(s, 'main')).toBe(false)
    expect(collectLeafIds(s.tree)).not.toContain('g-chat')
  })
  it('splits on an edge drop', () => {
    const s = dropPanel(talk(), 'chat', 'g-main', 'bottom')
    consistent(s)
    expect(groupOf(s, 'chat')).not.toBe('g-main')
    expect(isVisible(s, 'chat')).toBe(true)
    expect(docked(s)).toHaveLength(5)
  })
  it('splits a tab off its own stack', () => {
    const s = dropPanel(talk(), 'terminal', 'g-work', 'right')
    consistent(s)
    expect(groupOf(s, 'terminal')).not.toBe('g-work')
    expect(groupOf(s, 'agents')).toBe('g-work')
  })
  it('is a no-op onto its own lone group', () => {
    const s = talk()
    expect(dropPanel(s, 'chat', 'g-chat', 'left')).toBe(s)
  })
  it('opens a closed panel at the drop', () => {
    const s = dropPanel(talk(), 'diagrams', 'g-board', 'top')
    consistent(s)
    expect(isVisible(s, 'diagrams')).toBe(true)
  })
  it('keeps ratios summing to the child count', () => {
    const s = dropPanel(dropPanel(talk(), 'chat', 'g-board', 'left'), 'chat', 'g-board', 'right')
    const sum = (n: typeof s.tree): number => n.children.reduce((a, c) => a + c.ratio, 0)
    expect(sum(s.tree)).toBeCloseTo(s.tree.children.length)
  })
})

describe('closePanel / revealPanel', () => {
  it('closes and prunes', () => {
    const s = closePanel(talk(), 'board')
    consistent(s)
    expect(closedPanels(s)).toContain('board')
    expect(isVisible(s, 'board')).toBe(false)
  })
  it('reopens beside the neighbour it left', () => {
    const closed = closePanel(talk(), 'board')
    const s = revealPanel(closed, 'board')
    consistent(s)
    expect(isVisible(s, 'board')).toBe(true)
    // It sat between main-column and chat: reopened in the root row.
    expect(s.tree.children.length).toBe(3)
  })
  it('reopens stacked when it was a tab', () => {
    const s = revealPanel(closePanel(talk(), 'terminal'), 'terminal')
    expect(groupOf(s, 'terminal')).toBe(groupOf(s, 'agents'))
  })
  it('falls back to the root right when its anchor is closed', () => {
    let s = closePanel(talk(), 'chat')
    s = closePanel(s, 'board')
    s = revealPanel(s, 'chat')
    consistent(s)
    expect(isVisible(s, 'chat')).toBe(true)
  })
  it('opens into an empty layout', () => {
    let s = talk()
    for (const p of docked(s)) s = closePanel(s, p as never)
    expect(s.tree.children).toHaveLength(0)
    s = revealPanel(s, 'main')
    consistent(s)
    expect(docked(s)).toEqual(['main'])
  })
  it('activates a background tab and is idempotent', () => {
    const s = revealPanel(talk(), 'terminal')
    expect(isVisible(s, 'terminal')).toBe(true)
    expect(revealPanel(s, 'terminal')).toBe(s)
  })
  it('a never-docked panel with no lastSpot lands at the right', () => {
    const s = revealPanel(talk(), 'diagrams')
    consistent(s)
    expect(isVisible(s, 'diagrams')).toBe(true)
  })
})

describe('activateTab / setRatios', () => {
  it('ignores a tab the group does not hold', () => {
    const s = talk()
    expect(activateTab(s, 'g-main', 'chat')).toBe(s)
  })
  it('writes the ratios of the split at the path', () => {
    const s = setRatios(talk(), [], [1, 2, 3])
    expect(s.tree.children.map((c) => c.ratio)).toEqual([1, 2, 3])
  })
})

describe('parse', () => {
  it('round-trips a state', () => {
    const s = dropPanel(talk(), 'chat', 'g-main', 'center')
    const back = parseState(JSON.parse(JSON.stringify(s)))
    expect(back).not.toBeNull()
    consistent(back!)
    expect(groupOf(back!, 'chat')).toBe('g-main')
  })
  it('drops unknown ids', () => {
    const raw = JSON.parse(JSON.stringify(talk()))
    raw.groups['g-chat'].tabs = ['nope']
    const s = parseState(raw)!
    consistent(s)
    expect(groupOf(s, 'chat')).toBeNull()
    expect(collectLeafIds(s.tree)).not.toContain('g-chat')
  })
  it('rejects a duplicated panel', () => {
    const raw = JSON.parse(JSON.stringify(talk()))
    raw.groups['g-chat'].tabs = ['main']
    expect(parseState(raw)).toBeNull()
  })
  it('rejects garbage and empty layouts', () => {
    expect(parseState(null)).toBeNull()
    expect(parseState({ tree: 3, groups: {} })).toBeNull()
    const raw = JSON.parse(JSON.stringify(talk()))
    for (const g of Object.values(raw.groups) as { tabs: string[] }[]) g.tabs = []
    expect(parseState(raw)).toBeNull()
  })
})

describe('store', () => {
  it('garbage reads as the default store', () => {
    for (const raw of ['x', { v: 2, layouts: [] }]) {
      const s = parseStore(raw)
      expect(s.active).toBe('talk')
      expect(s.layouts.map((l) => l.id)).toEqual(['talk', 'review', 'build'])
    }
  })
  it('a broken built-in falls back to its preset, a broken user layout is dropped', () => {
    const s = defaultStore()
    const raw = JSON.parse(serializeStore(s))
    raw.layouts[0].state = { tree: 1 }
    raw.layouts.push({ id: 'u-1', name: 'Mine', state: { nope: true } })
    const back = parseStore(raw)
    expect(back.layouts.map((l) => l.id)).toEqual(['talk', 'review', 'build'])
    consistent(back.layouts[0].state)
  })
  it('restores a missing built-in and a bad active id', () => {
    const back = parseStore({ v: 1, active: 'zzz', layouts: [] })
    expect(back.layouts.map((l) => l.id)).toEqual(['talk', 'review', 'build'])
    expect(back.active).toBe('talk')
  })
  it('edits land in the active layout; + saves a copy under a unique name', () => {
    let s = defaultStore()
    s = updateActive(s, closePanel(s.layouts[0].state, 'chat'))
    expect(closedPanels(s.layouts[0].state)).toContain('chat')
    s = saveAs(s, 'Mine')
    s = saveAs(s, 'Mine')
    expect(s.layouts.map((l) => l.name).slice(3)).toEqual(['Mine', 'Mine 2'])
    expect(s.layouts[3].builtin).toBe(false)
    expect(closedPanels(s.layouts[3].state)).toContain('chat')
    expect(saveAs(s, '  ')).toBe(s)
  })
  it('selects, resets built-ins and deletes only user layouts', () => {
    let s = saveAs(defaultStore(), 'Mine')
    const mine = s.active
    expect(deleteLayout(s, 'talk')).toBe(s)
    s = updateActive(selectLayout(s, 'talk'), closePanel(PRESETS.talk.make(), 'chat'))
    s = resetLayout(s, 'talk')
    expect(groupOf(s.layouts[0].state, 'chat')).not.toBeNull()
    s = deleteLayout(selectLayout(s, mine), mine)
    expect(s.layouts).toHaveLength(3)
    expect(s.active).toBe('talk')
  })
})

describe('debouncedSaver', () => {
  it('writes only the last state after the wait, and flush writes at once', () => {
    vi.useFakeTimers()
    const saved: string[] = []
    const saver = debouncedSaver((s) => saved.push(s.active), 250)
    const a = { ...defaultStore(), active: 'a' }
    saver.schedule(a)
    saver.schedule({ ...a, active: 'b' })
    vi.advanceTimersByTime(249)
    expect(saved).toEqual([])
    vi.advanceTimersByTime(1)
    expect(saved).toEqual(['b'])
    saver.schedule({ ...a, active: 'c' })
    saver.flush()
    saver.flush()
    vi.advanceTimersByTime(1000)
    expect(saved).toEqual(['b', 'c'])
    vi.useRealTimers()
  })
})
