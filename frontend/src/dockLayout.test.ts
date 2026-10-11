import { describe, expect, it, vi } from 'vitest'
import { collectLeafIds } from './lib/paneTree'
import {
  activateTab,
  closePanel,
  closedPanels,
  dockToNav,
  debouncedSaver,
  defaultStore,
  deleteLayout,
  missingBuiltins,
  moveLayout,
  renameLayout,
  restoreDefaultLayouts,
  dropPanel,
  groupOf,
  inNav,
  isVisible,
  panelEntries,
  PANEL_IDS,
  parseState,
  parseStore,
  PRESETS,
  resetLayout,
  revealPanel,
  revealLandsInNav,
  revealNeedsNav,
  navDropIndex,
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
  // The nav zone holds each panel at most once and shares none with a group.
  expect(new Set(s.nav).size).toBe(s.nav.length)
  for (const p of s.nav) expect(tabs).not.toContain(p)
}

describe('presets', () => {
  it('are consistent and keep workflows closed', () => {
    for (const p of Object.values(PRESETS)) {
      const s = p.make()
      consistent(s)
      expect(groupOf(s, 'workflows')).toBeNull()
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

describe('nav zone', () => {
  it('presets leave the nav zone empty (the orb is no panel)', () => {
    for (const p of Object.values(PRESETS)) expect(p.make().nav).toEqual([])
    expect(PANEL_IDS).not.toContain('orb')
  })
  it('moves a panel out of its group into the nav and back', () => {
    const into = dockToNav(talk(), 'chat')
    consistent(into)
    expect(inNav(into, 'chat')).toBe(true)
    expect(groupOf(into, 'chat')).toBeNull()
    expect(collectLeafIds(into.tree)).not.toContain('g-chat')
    const out = dropPanel(into, 'chat', 'g-main', 'right')
    consistent(out)
    expect(inNav(out, 'chat')).toBe(false)
    expect(groupOf(out, 'chat')).not.toBeNull()
  })
  it('reorders within the zone', () => {
    let s = dockToNav(dockToNav(talk(), 'agents'), 'chat')
    expect(s.nav).toEqual(['agents', 'chat'])
    s = dockToNav(s, 'chat', 0)
    expect(s.nav).toEqual(['chat', 'agents'])
    s = dockToNav(s, 'chat')
    expect(s.nav).toEqual(['agents', 'chat'])
    // Dropped below itself: the index is the list the person saw.
    expect(dockToNav(s, 'agents', 2).nav).toEqual(['chat', 'agents'])
    expect(dockToNav(s, 'agents', 1).nav).toEqual(['agents', 'chat'])
  })
  it('a reveal lands in the nav only for a closed panel whose last spot is the nav', () => {
    const s = dockToNav(talk(), 'chat')
    expect(revealLandsInNav(s, 'chat')).toBe(false) // already docked there
    expect(revealLandsInNav(closePanel(s, 'chat'), 'chat')).toBe(true)
    expect(revealLandsInNav(talk(), 'chat')).toBe(false)
    expect(revealLandsInNav(closePanel(talk(), 'chat'), 'chat')).toBe(false)
  })
  it('expands a collapsed nav only when the reveal would otherwise stay hidden', () => {
    const s = dockToNav(talk(), 'chat')
    expect(revealNeedsNav(s, 'chat', true)).toBe(true)
    expect(revealNeedsNav(s, 'chat', false)).toBe(false) // already expanded: nothing to do
    expect(revealNeedsNav(closePanel(s, 'chat'), 'chat', true)).toBe(true)
    // A board push or a route change on panels docked elsewhere leaves it be.
    expect(revealNeedsNav(s, 'board', true)).toBe(false)
    expect(revealNeedsNav(s, 'main', true)).toBe(false)
    expect(revealNeedsNav(closePanel(talk(), 'board'), 'board', true)).toBe(false)
  })
  it('a panel in a collapsed nav is not visible', () => {
    const s = dockToNav(talk(), 'chat')
    expect(isVisible(s, 'chat')).toBe(true)
    expect(isVisible(s, 'chat', false)).toBe(true)
    expect(isVisible(s, 'chat', true)).toBe(false)
    expect(isVisible(s, 'main', true)).toBe(true)
    expect(panelEntries(s, true).find((e) => e.id === 'chat')?.open).toBe(false)
  })
  it('docking the last group panel into the nav leaves a layout that survives a reload', () => {
    let s = talk()
    for (const p of ['main', 'chat', 'board', 'agents', 'terminal'] as const) s = dockToNav(s, p)
    expect(s.tree.children).toHaveLength(0)
    expect(Object.keys(s.groups)).toHaveLength(0)
    const back = parseState(JSON.parse(JSON.stringify(s)))
    expect(back).not.toBeNull()
    expect(back!.nav).toEqual(['main', 'chat', 'board', 'agents', 'terminal'])
    // The same emptiness with nothing in the nav is still no layout.
    const raw = JSON.parse(JSON.stringify(s))
    raw.nav = []
    expect(parseState(raw)).toBeNull()
  })
  it('navDropIndex picks the first item whose midpoint is below the pointer', () => {
    const items = [
      { top: 0, height: 100 },
      { top: 110, height: 100 },
    ]
    expect(navDropIndex(items, 10)).toBe(0)
    expect(navDropIndex(items, 60)).toBe(1)
    expect(navDropIndex(items, 150)).toBe(1)
    expect(navDropIndex(items, 170)).toBe(2)
    expect(navDropIndex([], 5)).toBe(0)
  })
  it('lists every panel with where it sits and whether it is open', () => {
    const e = panelEntries(talk())
    expect(e.map((x) => x.id)).toEqual([...PANEL_IDS])
    const by = Object.fromEntries(e.map((x) => [x.id, x]))
    expect(by.chat).toMatchObject({ where: 'dock', open: true })
    expect(by.terminal).toMatchObject({ where: 'dock', open: false })
    expect(by.workflows).toMatchObject({ where: 'closed', open: false })
  })
  it('a layout saved before the nav zone has an empty nav', () => {
    const raw = JSON.parse(JSON.stringify(talk()))
    delete raw.nav
    const s = parseState(raw)!
    consistent(s)
    expect(s.nav).toEqual([])
  })
  it('a saved layout holding the retired orb panel loads without it (naru task 1798)', () => {
    // As the previous build saved it: orb in the nav, in a group, and a lastSpot.
    const inNavRaw = JSON.parse(JSON.stringify(dockToNav(talk(), 'chat')))
    inNavRaw.nav = ['orb', 'chat']
    const a = parseState(inNavRaw)!
    consistent(a)
    expect(a.nav).toEqual(['chat'])

    const grouped = JSON.parse(JSON.stringify(talk()))
    grouped.groups['g-orb'] = { tabs: ['orb'], active: 'orb' }
    grouped.groups['g-main'].tabs.push('orb')
    grouped.lastSpot = { orb: { nav: true }, chat: { anchor: 'orb', edge: 'left' } }
    const b = parseState(grouped)!
    consistent(b)
    expect(JSON.stringify(b)).not.toContain('orb')

    // Through the whole store: every layout of the old shape loses it.
    const old = JSON.parse(JSON.stringify(defaultStore()))
    for (const l of old.layouts) l.state.nav = ['orb']
    for (const l of parseStore(old).layouts) {
      expect(l.state.nav).toEqual([])
      expect(JSON.stringify(l.state)).not.toContain('orb')
    }
  })
  it('a layout saved with the Diagrams panel keeps it as Workflows, wherever it sat', () => {
    const grouped = dropPanel(talk(), 'workflows', 'g-board', 'top')
    const legacy = (state: DockState) =>
      JSON.stringify(state).replaceAll('workflows', 'diagrams')
    const g = parseState(JSON.parse(legacy(grouped)))!
    consistent(g)
    expect(groupOf(g, 'workflows')).not.toBeNull()
    const inTheNav = dockToNav(talk(), 'workflows')
    const n = parseState(JSON.parse(legacy(inTheNav)))!
    expect(n.nav).toContain('workflows')
    const closed = closePanel(grouped, 'workflows')
    const c = parseState(JSON.parse(legacy(closed)))!
    expect(c.lastSpot.workflows).toEqual(closed.lastSpot.workflows)
    expect(JSON.stringify(c)).not.toContain('diagrams')
  })
  it('round-trips the nav and its last spot; rejects a panel in a group and the nav', () => {
    const s = closePanel(dockToNav(talk(), 'chat'), 'chat')
    const back = parseState(JSON.parse(JSON.stringify(s)))!
    expect(back.lastSpot.chat).toEqual({ nav: true })
    const raw = JSON.parse(JSON.stringify(talk()))
    raw.nav = ['main']
    expect(parseState(raw)).toBeNull()
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
    const s = dropPanel(talk(), 'workflows', 'g-board', 'top')
    consistent(s)
    expect(isVisible(s, 'workflows')).toBe(true)
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
    const s = revealPanel(talk(), 'workflows')
    consistent(s)
    expect(isVisible(s, 'workflows')).toBe(true)
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
    raw.nav = []
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
  it('a v1 store restores a missing built-in; a bad active id falls to the first', () => {
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
  it('selects, resets built-ins and deletes layouts', () => {
    let s = saveAs(defaultStore(), 'Mine')
    const mine = s.active
    s = updateActive(selectLayout(s, 'talk'), closePanel(PRESETS.talk.make(), 'chat'))
    s = resetLayout(s, 'talk')
    expect(groupOf(s.layouts[0].state, 'chat')).not.toBeNull()
    s = deleteLayout(selectLayout(s, mine), mine)
    expect(s.layouts).toHaveLength(3)
    expect(s.active).toBe('talk')
  })
})

describe('layout management', () => {
  it('renames any layout, refusing empty and duplicate names', () => {
    const s = defaultStore()
    const r = renameLayout(s, 'talk', '  Chat  ')
    expect(r.layouts[0]).toMatchObject({ id: 'talk', name: 'Chat', builtin: true })
    expect(renameLayout(s, 'talk', '  ')).toBe(s)
    expect(renameLayout(s, 'talk', 'Review')).toBe(s)
    expect(renameLayout(s, 'talk', 'Talk').layouts[0].name).toBe('Talk')
    expect(renameLayout(s, 'nope', 'X')).toBe(s)
  })
  it('deletes a built-in but never the last layout', () => {
    let s = deleteLayout(defaultStore(), 'talk')
    expect(s.layouts.map((l) => l.id)).toEqual(['review', 'build'])
    expect(s.active).toBe('review')
    s = deleteLayout(deleteLayout(s, 'review'), 'build')
    expect(s.layouts.map((l) => l.id)).toEqual(['build'])
    expect(deleteLayout(s, 'build')).toBe(s)
  })
  it('moves one step and stops at the ends', () => {
    const s = defaultStore()
    expect(moveLayout(s, 'talk', -1)).toBe(s)
    expect(moveLayout(s, 'build', 1)).toBe(s)
    expect(moveLayout(s, 'talk', 1).layouts.map((l) => l.id)).toEqual(['review', 'talk', 'build'])
    expect(moveLayout(s, 'build', -1).layouts.map((l) => l.id)).toEqual(['talk', 'build', 'review'])
  })
  it('restores only the missing built-ins, appended, leaving the rest alone', () => {
    let s = saveAs(defaultStore(), 'Mine')
    s = renameLayout(s, 'review', 'Look')
    s = updateActive(selectLayout(s, 'build'), closePanel(s.layouts[2].state, 'chat'))
    const edited = s.layouts[2]
    s = deleteLayout(deleteLayout(s, 'talk'), 'build')
    expect(missingBuiltins(s)).toEqual(['talk', 'build'])
    const r = restoreDefaultLayouts(s)
    expect(r.layouts.map((l) => l.id).slice(0, 2)).toEqual(['review', s.layouts[1].id])
    expect(r.layouts.map((l) => l.id).slice(2)).toEqual(['talk', 'build'])
    expect(r.layouts[0].name).toBe('Look')
    expect(r.layouts.map((l) => l.name)).not.toContain('Review')
    expect(closedPanels(r.layouts[3].state)).toEqual(closedPanels(PRESETS.build.make()))
    expect(closedPanels(r.layouts[3].state)).not.toEqual(closedPanels(edited.state))
    expect(restoreDefaultLayouts(r)).toBe(r)
  })
  it('a restored name that is taken gets a number', () => {
    let s = deleteLayout(defaultStore(), 'talk')
    s = renameLayout(s, 'review', 'Talk')
    expect(restoreDefaultLayouts(s).layouts.map((l) => l.name)).toEqual(['Talk', 'Build', 'Talk 2'])
  })
  it('a deleted built-in stays deleted across a reload; a rename survives', () => {
    let s = renameLayout(defaultStore(), 'review', 'Look')
    s = deleteLayout(s, 'talk')
    const back = parseStore(JSON.parse(serializeStore(s)))
    expect(back.active).toBe(s.active)
    expect(back.layouts.map((l) => l.id)).toEqual(['review', 'build'])
    expect(back.layouts[0]).toMatchObject({ name: 'Look', builtin: true })
  })
  it('a legacy v1 store loads with every built-in present', () => {
    const v1 = { ...JSON.parse(serializeStore(defaultStore())), v: 1 }
    v1.layouts = v1.layouts.slice(1)
    const back = parseStore(v1)
    expect(back.v).toBe(2)
    expect(back.layouts.map((l) => l.id)).toEqual(['talk', 'review', 'build'])
  })
  it('a v2 store with nothing left is the default store', () => {
    expect(parseStore({ v: 2, active: 'x', layouts: [] }).layouts).toHaveLength(3)
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
