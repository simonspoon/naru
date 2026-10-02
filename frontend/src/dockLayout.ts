// The dockable panel layout (mesa task 1567, docs/dock.md): which of the six
// panels is where, as a split tree of tab *groups*, plus the machine-local
// store of named layouts the header's switcher flips between.
//
// Pure, like `projectPanes.ts`, so every gesture is testable without a DOM:
// - **A panel appears at most once.** Each leaf of the tree is a *group* (an
//   opaque id) and the group's tab stack lives in a side map, so the split
//   engine in `lib/paneTree.ts` is reused unchanged — it keys only off leaf ids.
// - **A drop is `splitLeafAt`.** An edge drop mints a new group, appends it to
//   the root and splits it in beside the target, the same move
//   `projectPanes.dropTab` makes; a centre drop stacks the panel as a tab.
// - **Closed is not absent.** Closing a panel remembers the spot it left
//   (`lastSpot`), so reopening puts it back beside whatever it sat next to.
// - **The nav is a dock zone too** (mesa task 1574): `nav` is an ordered stack
//   of panels docked into the left navigation, outside the split tree. A panel
//   is in a group *or* in `nav`, never both.

import {
  canonicalize,
  collectLeafIds,
  DEFAULT_RATIO,
  findPathToLeaf,
  newSplitId,
  removeLeaf,
  replaceAtPath,
  splitLeafAt,
  type DropEdge,
  type LeafNode,
  type PaneNode,
  type SplitNode,
} from './lib/paneTree'

export type PanelId = 'main' | 'chat' | 'board' | 'agents' | 'terminal' | 'workflows' | 'orb'

export const PANEL_IDS: readonly PanelId[] = ['main', 'chat', 'board', 'agents', 'terminal', 'workflows', 'orb']

const LABELS: Record<PanelId, string> = {
  main: 'Main',
  chat: 'Chat',
  board: 'Whiteboard',
  agents: 'Agents',
  terminal: 'Terminal',
  workflows: 'Workflows',
  orb: 'Naru',
}

export function panelLabel(id: PanelId): string {
  return LABELS[id]
}

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && (PANEL_IDS as readonly string[]).includes(value)
}

// The drag payload a panel tab travels as — its own type so a drag of
// anything else (a file path, a project-pane view tab) is never mistaken for it.
export const PANEL_DRAG_MIME = 'application/x-naru-panel'

export type DockLeaf = LeafNode<'group'>
export type DockRoot = SplitNode<'group'>
export type DockGroup = { tabs: PanelId[]; active: PanelId }
export type DropSpot = DropEdge | 'center'
/** Where a closed panel last sat: beside `anchor`, on `edge` of it (`center` =
 *  stacked in its group), or in the nav zone. */
export type LastSpot = { anchor: PanelId; edge: DropSpot } | { nav: true }

export type DockState = {
  tree: DockRoot
  groups: Record<string, DockGroup>
  /** Panels docked into the left navigation, top to bottom (mesa task 1574). */
  nav: PanelId[]
  lastSpot: Partial<Record<PanelId, LastSpot>>
}

// --- Building blocks ---------------------------------------------------

function leaf(group: string): DockLeaf {
  return { kind: 'leaf', contentKind: 'group', id: group }
}

function split(orientation: 'row' | 'column', ...kids: [number, PaneNode<'group'>][]): DockRoot {
  return {
    kind: 'split',
    id: newSplitId(),
    orientation,
    children: kids.map(([ratio, node]) => ({ ratio, node })),
  }
}

/** Rescales every split's ratios to sum to their count (proportions kept):
 *  a ratio is a CSS `flex-grow`, and flexbox under-fills when they sum to
 *  less than 1 — `projectPanes.normalizeRatios`'s reason, for this tree type. */
function normalize(root: DockRoot): DockRoot {
  function walk(node: PaneNode<'group'>): PaneNode<'group'> {
    if (node.kind === 'leaf') return node
    const sum = node.children.reduce((s, c) => s + c.ratio, 0)
    const scale = sum > 0 ? node.children.length / sum : 1
    return {
      ...node,
      children: node.children.map((c) => ({ ratio: c.ratio * scale, node: walk(c.node) })),
    }
  }
  return walk(root) as DockRoot
}

export function groupOf(state: DockState, panel: PanelId): string | null {
  for (const [id, g] of Object.entries(state.groups)) if (g.tabs.includes(panel)) return id
  return null
}

/** Docked in the nav zone. */
export function inNav(state: DockState, panel: PanelId): boolean {
  return state.nav.includes(panel)
}

/** In the nav zone, or the front tab of its group — what the user can see.
 *  A collapsed nav mounts nothing but the orb's rail, so a panel docked in it
 *  is visible only while the nav is expanded (the orb always: the rail shows it). */
export function isVisible(state: DockState, panel: PanelId, navCollapsed = false): boolean {
  if (inNav(state, panel)) return panel === 'orb' || !navCollapsed
  const g = groupOf(state, panel)
  return g !== null && state.groups[g].active === panel
}

/** Panels docked nowhere: what the reopen menu lists. */
export function closedPanels(state: DockState): PanelId[] {
  return PANEL_IDS.filter((p) => groupOf(state, p) === null && !inNav(state, p))
}

export type PanelEntry = { id: PanelId; label: string; where: 'nav' | 'dock' | 'closed'; open: boolean }

/** The nav's Panels list: every panel, where it sits, and whether it is
 *  showing (a background tab is docked but not open). */
export function panelEntries(state: DockState, navCollapsed = false): PanelEntry[] {
  return PANEL_IDS.map((id) => ({
    id,
    label: LABELS[id],
    where: inNav(state, id) ? 'nav' : groupOf(state, id) !== null ? 'dock' : 'closed',
    open: isVisible(state, id, navCollapsed),
  }))
}

// --- Gestures ----------------------------------------------------------

function withoutPanel(state: DockState, panel: PanelId): DockState {
  if (inNav(state, panel)) return { ...state, nav: state.nav.filter((p) => p !== panel) }
  const gid = groupOf(state, panel)
  if (gid === null) return state
  const g = state.groups[gid]
  const tabs = g.tabs.filter((t) => t !== panel)
  const groups = { ...state.groups }
  if (tabs.length === 0) {
    delete groups[gid]
    return { ...state, groups, tree: removeLeaf(state.tree, gid) }
  }
  groups[gid] = { tabs, active: g.active === panel ? tabs[Math.min(g.tabs.indexOf(panel), tabs.length - 1)] : g.active }
  return { ...state, groups }
}

/** Where `panel` sits now, so a later reopen can put it back. */
function spotOf(state: DockState, panel: PanelId): LastSpot | undefined {
  if (inNav(state, panel)) return { nav: true }
  const gid = groupOf(state, panel)
  if (gid === null) return undefined
  const mates = state.groups[gid].tabs.filter((t) => t !== panel)
  if (mates.length > 0) return { anchor: state.groups[gid].active === panel ? mates[0] : state.groups[gid].active, edge: 'center' }
  const path = findPathToLeaf(state.tree, gid)
  if (path === null) return undefined
  let parent: SplitNode<'group'> = state.tree
  for (const i of path.slice(0, -1)) parent = parent.children[i].node as SplitNode<'group'>
  const i = path[path.length - 1]
  const neighborIdx = i + 1 < parent.children.length ? i + 1 : i - 1
  if (neighborIdx < 0) return undefined
  const first = (n: PaneNode<'group'>): string => (n.kind === 'leaf' ? n.id : first(n.children[0].node))
  const ng = state.groups[first(parent.children[neighborIdx].node)]
  if (!ng) return undefined
  const after = neighborIdx > i // the neighbour is after us, so we were before it
  const edge: DropEdge = parent.orientation === 'row' ? (after ? 'left' : 'right') : after ? 'top' : 'bottom'
  return { anchor: ng.active, edge }
}

/** Appends a fresh one-panel group at the root's right edge. */
function appendAtRight(state: DockState, panel: PanelId): DockState {
  const gid = newSplitId()
  const groups = { ...state.groups, [gid]: { tabs: [panel], active: panel } }
  if (state.tree.children.length === 0) {
    return { ...state, groups, tree: split('row', [DEFAULT_RATIO, leaf(gid)]) }
  }
  const tree = canonicalize(split('row', [3, state.tree], [1, leaf(gid)])) as DockRoot
  return { ...state, groups, tree: normalize(tree) }
}

/**
 * `panel` dropped on the group `target`: centre stacks it as that group's
 * front tab, an edge splits `target` with a new group holding it. The panel
 * leaves wherever it was (open or not); a group it empties is pruned.
 */
export function dropPanel(state: DockState, panel: PanelId, target: string, spot: DropSpot): DockState {
  if (state.groups[target] === undefined) return state
  const from = groupOf(state, panel)
  // Onto its own group: stacking is a no-op, and splitting a lone tab off
  // itself has nothing to split.
  if (from === target && (spot === 'center' || state.groups[target].tabs.length === 1)) {
    return activateTab(state, target, panel)
  }
  const spotLeft = spotOf(state, panel)
  const base = withoutPanel(state, panel)
  const lastSpot = spotLeft ? { ...base.lastSpot, [panel]: spotLeft } : base.lastSpot
  if (spot === 'center') {
    const g = base.groups[target]
    return { ...base, lastSpot, groups: { ...base.groups, [target]: { tabs: [...g.tabs, panel], active: panel } } }
  }
  const gid = newSplitId()
  const withLeaf: DockState = {
    ...base,
    lastSpot,
    groups: { ...base.groups, [gid]: { tabs: [panel], active: panel } },
    tree: replaceAtPath(base.tree, [], (n) => ({
      ...n,
      children: [...n.children, { ratio: DEFAULT_RATIO, node: leaf(gid) }],
    })),
  }
  const from2 = findPathToLeaf(withLeaf.tree, gid)
  const to = findPathToLeaf(withLeaf.tree, target)
  if (from2 === null || to === null) return withLeaf
  return { ...withLeaf, tree: normalize(splitLeafAt(withLeaf.tree, from2, to, spot)) }
}

/** `panel` dropped into the nav zone at `index` (before the item now there;
 *  default: the bottom). The panel leaves wherever it was; moving within the
 *  zone reorders. May leave the tree with no group at all: a layout whose only
 *  docked panels are in the nav is valid (`parseState` keeps it). */
export function dockToNav(state: DockState, panel: PanelId, index?: number): DockState {
  const spotLeft = spotOf(state, panel)
  const base = withoutPanel(state, panel)
  const nav = [...base.nav]
  // `index` counts the list as the person saw it, panel included.
  const was = state.nav.indexOf(panel)
  const want = index === undefined ? nav.length : was !== -1 && was < index ? index - 1 : index
  const at = Math.max(0, Math.min(want, nav.length))
  nav.splice(at, 0, panel)
  const lastSpot = spotLeft && !('nav' in spotLeft) ? { ...base.lastSpot, [panel]: spotLeft } : base.lastSpot
  return { ...base, nav, lastSpot, tree: normalize(base.tree) }
}

export function closePanel(state: DockState, panel: PanelId): DockState {
  const spot = spotOf(state, panel)
  if (spot === undefined && groupOf(state, panel) === null) return state
  const next = withoutPanel(state, panel)
  return {
    ...next,
    tree: normalize(next.tree),
    lastSpot: spot ? { ...next.lastSpot, [panel]: spot } : next.lastSpot,
  }
}

export function activateTab(state: DockState, group: string, panel: PanelId): DockState {
  const g = state.groups[group]
  if (!g || !g.tabs.includes(panel) || g.active === panel) return state
  return { ...state, groups: { ...state.groups, [group]: { ...g, active: panel } } }
}

/**
 * Brings `panel` on screen: front tab if it is already docked, else reopened
 * where it last sat (beside the panel it was next to, if that one is open),
 * else on the root's right. Returns the same object when nothing changes, so
 * a caller can reveal on every event without re-rendering.
 */
export function revealPanel(state: DockState, panel: PanelId): DockState {
  if (inNav(state, panel)) return state
  const gid = groupOf(state, panel)
  if (gid !== null) return activateTab(state, gid, panel)
  const spot = state.lastSpot[panel]
  if (spot && 'nav' in spot) return dockToNav(state, panel)
  const anchorGroup = spot && 'anchor' in spot ? groupOf(state, spot.anchor) : null
  if (spot && 'anchor' in spot && anchorGroup !== null) return dropPanel(state, panel, anchorGroup, spot.edge)
  return appendAtRight(state, panel)
}

/** Whether `revealPanel` would *change* anything by putting a closed `panel`
 *  back into the nav zone (its last spot). A programmatic reveal of a panel
 *  that is already docked changes nothing, so it must not re-expand a nav the
 *  person collapsed; only this case does. */
export function revealLandsInNav(state: DockState, panel: PanelId): boolean {
  if (inNav(state, panel) || groupOf(state, panel) !== null) return false
  const spot = state.lastSpot[panel]
  return spot !== undefined && 'nav' in spot
}

/** Whether revealing `panel` must expand a collapsed nav: only when it would
 *  otherwise stay hidden there — a non-orb panel docked in the nav, or closed
 *  with the nav as its last spot. Any other reveal (a board push, a route
 *  change) leaves the person's collapse alone; once expanded, later reveals
 *  find the panel visible and change nothing. */
export function revealNeedsNav(state: DockState, panel: PanelId, navCollapsed: boolean): boolean {
  return navCollapsed && panel !== 'orb' && (inNav(state, panel) || revealLandsInNav(state, panel))
}

/** Where a dragged panel lands in the nav zone: the index of the first item
 *  whose vertical midpoint is below `y`, else the end. */
export function navDropIndex(items: { top: number; height: number }[], y: number): number {
  for (let i = 0; i < items.length; i++) if (y < items[i].top + items[i].height / 2) return i
  return items.length
}

/** Writes every child ratio of the split at `path` (a divider drag). */
export function setRatios(state: DockState, path: number[], ratios: number[]): DockState {
  return {
    ...state,
    tree: replaceAtPath(state.tree, path, (n) => ({
      ...n,
      children: n.children.map((c, i) => ({ ...c, ratio: ratios[i] ?? c.ratio })),
    })),
  }
}

// --- Presets -----------------------------------------------------------

function group(...tabs: PanelId[]): DockGroup {
  return { tabs, active: tabs[0] }
}

function make(tree: DockRoot, groups: Record<string, DockGroup>, nav: PanelId[] = ['orb']): DockState {
  return { tree, groups, nav, lastSpot: {} }
}

export const PRESETS: Record<string, { name: string; make: () => DockState }> = {
  // The mockup: main over a stack of agents/terminal, the board, the chat.
  talk: {
    name: 'Talk',
    make: () =>
      make(
        split(
          'row',
          [3, split('column', [2, leaf('g-main')], [1, leaf('g-work')])],
          [1.6, leaf('g-board')],
          [1.4, leaf('g-chat')],
        ),
        { 'g-main': group('main'), 'g-work': group('agents', 'terminal'), 'g-board': group('board'), 'g-chat': group('chat') },
      ),
  },
  review: {
    name: 'Review',
    make: () =>
      make(
        split('row', [1.5, leaf('g-main')], [1, split('column', [1, leaf('g-board')], [1, leaf('g-chat')])]),
        { 'g-main': group('main'), 'g-board': group('board'), 'g-chat': group('chat') },
      ),
  },
  build: {
    name: 'Build',
    make: () =>
      make(
        split(
          'row',
          [2, leaf('g-main')],
          [1.2, split('column', [1, leaf('g-agents')], [1, leaf('g-terminal')])],
          [1, leaf('g-chat')],
        ),
        { 'g-main': group('main'), 'g-agents': group('agents'), 'g-terminal': group('terminal'), 'g-chat': group('chat') },
      ),
  },
}

export const DEFAULT_LAYOUT_ID = 'talk'

// --- Persistence -------------------------------------------------------

export type SavedLayout = { id: string; name: string; builtin: boolean; state: DockState }
export type DockStore = { v: 2; active: string; layouts: SavedLayout[] }

export const DOCK_STORAGE_KEY = 'naru-dock-layouts'

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function parseNode(raw: unknown): PaneNode<'group'> | null {
  if (!isObj(raw)) return null
  if (raw.kind === 'leaf') return typeof raw.id === 'string' ? leaf(raw.id) : null
  if (raw.kind !== 'split') return null
  if (raw.orientation !== 'row' && raw.orientation !== 'column') return null
  if (!Array.isArray(raw.children)) return null
  const children: { ratio: number; node: PaneNode<'group'> }[] = []
  for (const c of raw.children) {
    if (!isObj(c)) return null
    const node = parseNode(c.node)
    if (node === null) return null
    children.push({ ratio: typeof c.ratio === 'number' && c.ratio > 0 ? c.ratio : DEFAULT_RATIO, node })
  }
  return {
    kind: 'split',
    id: typeof raw.id === 'string' ? raw.id : newSplitId(),
    orientation: raw.orientation,
    children,
  }
}

/**
 * The Diagrams panel became Workflows (mesa task 1607). A layout saved before
 * that names `diagrams` in a group's tabs, its `active`, the nav list and a
 * `lastSpot`; each is renamed so the panel keeps its place, rather than being
 * dropped as an unknown id. A layout that already holds `workflows` keeps it
 * (the unknown duplicate is dropped by the id filter, never double-docked).
 */
function renameLegacyPanels(raw: unknown): unknown {
  if (!isObj(raw)) return raw
  const id = (p: unknown) => (p === 'diagrams' ? 'workflows' : p)
  const list = (v: unknown) => (Array.isArray(v) ? v.map(id) : v)
  const out: Record<string, unknown> = { ...raw }
  if (isObj(raw.groups)) {
    out.groups = Object.fromEntries(
      Object.entries(raw.groups).map(([gid, g]) => [
        gid,
        isObj(g) ? { ...g, tabs: list(g.tabs), active: id(g.active) } : g,
      ]),
    )
  }
  if (Array.isArray(raw.nav)) out.nav = list(raw.nav)
  if (isObj(raw.lastSpot)) {
    out.lastSpot = Object.fromEntries(
      Object.entries(raw.lastSpot).map(([p, s]) => [
        id(p),
        isObj(s) && 'anchor' in s ? { ...s, anchor: id(s.anchor) } : s,
      ]),
    )
  }
  return out
}

/**
 * Total: unknown panel ids are dropped, a panel in two groups (or a group
 * named twice in the tree) rejects the whole state, and anything that leaves
 * no panel docked is `null` — the caller falls back to a preset, never to an
 * empty layout.
 */
export function parseState(raw0: unknown): DockState | null {
  const raw = renameLegacyPanels(raw0)
  if (!isObj(raw) || !isObj(raw.groups)) return null
  const tree0 = parseNode(raw.tree)
  if (tree0 === null || tree0.kind !== 'split') return null
  const groups: Record<string, DockGroup> = {}
  const seen = new Set<PanelId>()
  for (const [gid, g] of Object.entries(raw.groups)) {
    if (!isObj(g) || !Array.isArray(g.tabs)) return null
    const tabs = g.tabs.filter(isPanelId)
    for (const t of tabs) {
      if (seen.has(t)) return null
      seen.add(t)
    }
    if (tabs.length === 0) continue
    groups[gid] = { tabs, active: isPanelId(g.active) && tabs.includes(g.active) ? g.active : tabs[0] }
  }
  const leaves = collectLeafIds(tree0)
  if (new Set(leaves).size !== leaves.length) return null
  // Prune leaves with no group, then groups with no leaf.
  let tree = tree0 as DockRoot
  for (const id of leaves) if (groups[id] === undefined) tree = removeLeaf(tree, id)
  const inTree = new Set(collectLeafIds(tree))
  for (const gid of Object.keys(groups)) if (!inTree.has(gid)) delete groups[gid]
  // The nav zone (mesa task 1574). A layout saved before it has no `nav` key
  // and never heard of the orb: the orb lands at the top of the nav for it.
  // One that has the key keeps exactly what it says (an empty list = closed).
  const nav: PanelId[] = []
  if (Array.isArray(raw.nav)) {
    for (const p of raw.nav) {
      if (!isPanelId(p) || nav.includes(p)) continue
      if (seen.has(p)) return null
      nav.push(p)
    }
  } else if (!seen.has('orb')) {
    nav.push('orb')
  }
  // Nothing docked is no layout (a preset takes over) — unless the nav zone
  // holds panels the layout itself named: docking the last group panel into
  // the nav leaves exactly that, and must survive a reload.
  if (Object.keys(groups).length === 0 && !(Array.isArray(raw.nav) && nav.length > 0)) return null
  const lastSpot: DockState['lastSpot'] = {}
  if (isObj(raw.lastSpot)) {
    for (const [p, s] of Object.entries(raw.lastSpot)) {
      if (!isPanelId(p) || !isObj(s)) continue
      if (s.nav === true) {
        lastSpot[p] = { nav: true }
        continue
      }
      if (!isPanelId(s.anchor)) continue
      const edge = s.edge
      if (edge === 'center' || edge === 'left' || edge === 'right' || edge === 'top' || edge === 'bottom') {
        lastSpot[p] = { anchor: s.anchor, edge }
      }
    }
  }
  return { tree: normalize(tree), groups, nav, lastSpot }
}

export function defaultStore(): DockStore {
  return {
    v: 2,
    active: DEFAULT_LAYOUT_ID,
    layouts: Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, builtin: true, state: p.make() })),
  }
}

/**
 * Total: garbage is the default store; a layout that does not parse is
 * replaced by its preset (a built-in) or dropped (a user one). A built-in is
 * tracked by its id (`talk`/`review`/`build`), never its name, so it may be
 * renamed. A v1 store (before built-ins could be deleted) has the missing
 * built-ins put back; a v2 one keeps a deleted one deleted, and an empty one
 * is the default store (a store always holds a layout).
 */
export function parseStore(raw: unknown): DockStore {
  if (!isObj(raw) || (raw.v !== 1 && raw.v !== 2) || !Array.isArray(raw.layouts)) return defaultStore()
  const layouts: SavedLayout[] = []
  const ids = new Set<string>()
  for (const l of raw.layouts) {
    if (!isObj(l) || typeof l.id !== 'string' || typeof l.name !== 'string' || ids.has(l.id)) continue
    const builtin = l.id in PRESETS
    const state = parseState(l.state) ?? (builtin ? PRESETS[l.id].make() : null)
    if (state === null) continue
    const name = l.name.trim()
    ids.add(l.id)
    layouts.push({ id: l.id, name: raw.v === 1 && builtin ? PRESETS[l.id].name : name === '' ? l.id : name, builtin, state })
  }
  if (raw.v === 1) {
    for (const [id, p] of Object.entries(PRESETS)) {
      if (!ids.has(id)) layouts.splice(Object.keys(PRESETS).indexOf(id), 0, { id, name: p.name, builtin: true, state: p.make() })
    }
  }
  if (layouts.length === 0) return defaultStore()
  const active = typeof raw.active === 'string' && layouts.some((l) => l.id === raw.active) ? raw.active : layouts[0].id
  return { v: 2, active, layouts }
}

export function serializeStore(store: DockStore): string {
  return JSON.stringify(store)
}

export function loadStore(): DockStore {
  try {
    return parseStore(JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? ''))
  } catch {
    return defaultStore()
  }
}

export function saveStore(store: DockStore): void {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, serializeStore(store))
  } catch {
    // Machine-local convenience: a full or blocked store costs the memory only.
  }
}

/**
 * Trailing-edge debounce for the store write: a divider drag changes the store
 * on every mousemove, and `localStorage` is synchronous. `flush` writes what is
 * pending at once (unmount, page hide), so the final state is never lost.
 */
export function debouncedSaver(save: (s: DockStore) => void, ms: number) {
  let pending: DockStore | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (pending !== null) {
      const s = pending
      pending = null
      save(s)
    }
  }
  return {
    schedule(s: DockStore) {
      pending = s
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, ms)
    },
    flush,
  }
}

export function activeLayout(store: DockStore): SavedLayout {
  return store.layouts.find((l) => l.id === store.active) ?? store.layouts[0]
}

/** An edit lands in the active layout, live. */
export function updateActive(store: DockStore, state: DockState): DockStore {
  return { ...store, layouts: store.layouts.map((l) => (l.id === store.active ? { ...l, state } : l)) }
}

export function selectLayout(store: DockStore, id: string): DockStore {
  return store.layouts.some((l) => l.id === id) ? { ...store, active: id } : store
}

/** "+": the current arrangement under a new name (made unique), now active. */
export function saveAs(store: DockStore, name: string): DockStore {
  const base = name.trim()
  if (base === '') return store
  let unique = base
  for (let n = 2; store.layouts.some((l) => l.name === unique); n++) unique = `${base} ${n}`
  let id = `u-${newSplitId()}`
  while (store.layouts.some((l) => l.id === id)) id = `u-${newSplitId()}`
  const state = activeLayout(store).state
  return { ...store, active: id, layouts: [...store.layouts, { id, name: unique, builtin: false, state }] }
}

/** A built-in goes back to its preset. */
export function resetLayout(store: DockStore, id: string): DockStore {
  const p = PRESETS[id]
  if (!p) return store
  return { ...store, layouts: store.layouts.map((l) => (l.id === id ? { ...l, state: p.make() } : l)) }
}

/** Any layout, built-in or not — but never the last one. Deleting the active
 *  one falls back to the first. */
export function deleteLayout(store: DockStore, id: string): DockStore {
  if (store.layouts.length <= 1 || !store.layouts.some((l) => l.id === id)) return store
  const layouts = store.layouts.filter((l) => l.id !== id)
  return { ...store, layouts, active: store.active === id ? layouts[0].id : store.active }
}

/** Trimmed; an empty name or one another layout already wears is refused. */
export function renameLayout(store: DockStore, id: string, name: string): DockStore {
  const next = name.trim()
  if (next === '' || !store.layouts.some((l) => l.id === id)) return store
  if (store.layouts.some((l) => l.id !== id && l.name === next)) return store
  return { ...store, layouts: store.layouts.map((l) => (l.id === id ? { ...l, name: next } : l)) }
}

/** One step left (-1) or right (+1); the ends do not wrap. */
export function moveLayout(store: DockStore, id: string, delta: -1 | 1): DockStore {
  const from = store.layouts.findIndex((l) => l.id === id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= store.layouts.length) return store
  const layouts = [...store.layouts]
  ;[layouts[from], layouts[to]] = [layouts[to], layouts[from]]
  return { ...store, layouts }
}

/** The built-ins (by id) the store no longer holds. */
export function missingBuiltins(store: DockStore): string[] {
  return Object.keys(PRESETS).filter((id) => !store.layouts.some((l) => l.id === id))
}

/** Appends each missing built-in in its default arrangement (a name another
 *  layout wears gets a number); every layout still there, renamed or edited,
 *  is untouched. */
export function restoreDefaultLayouts(store: DockStore): DockStore {
  const missing = missingBuiltins(store)
  if (missing.length === 0) return store
  const layouts = [...store.layouts]
  for (const id of missing) {
    let name = PRESETS[id].name
    for (let n = 2; layouts.some((l) => l.name === name); n++) name = `${PRESETS[id].name} ${n}`
    layouts.push({ id, name, builtin: true, state: PRESETS[id].make() })
  }
  return { ...store, layouts }
}
