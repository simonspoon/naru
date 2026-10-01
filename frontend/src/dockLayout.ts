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

export type PanelId = 'main' | 'chat' | 'board' | 'agents' | 'terminal' | 'diagrams'

export const PANEL_IDS: readonly PanelId[] = ['main', 'chat', 'board', 'agents', 'terminal', 'diagrams']

const LABELS: Record<PanelId, string> = {
  main: 'Main',
  chat: 'Chat',
  board: 'Whiteboard',
  agents: 'Agents',
  terminal: 'Terminal',
  diagrams: 'Diagrams',
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
 *  stacked in its group). */
export type LastSpot = { anchor: PanelId; edge: DropSpot }

export type DockState = {
  tree: DockRoot
  groups: Record<string, DockGroup>
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

/** In the tree *and* the front tab of its group — what the user can see. */
export function isVisible(state: DockState, panel: PanelId): boolean {
  const g = groupOf(state, panel)
  return g !== null && state.groups[g].active === panel
}

/** Panels in no group at all: what the reopen menu lists. */
export function closedPanels(state: DockState): PanelId[] {
  return PANEL_IDS.filter((p) => groupOf(state, p) === null)
}

// --- Gestures ----------------------------------------------------------

function withoutPanel(state: DockState, panel: PanelId): DockState {
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
  const gid = groupOf(state, panel)
  if (gid !== null) return activateTab(state, gid, panel)
  const spot = state.lastSpot[panel]
  const anchorGroup = spot ? groupOf(state, spot.anchor) : null
  if (spot && anchorGroup !== null) return dropPanel(state, panel, anchorGroup, spot.edge)
  return appendAtRight(state, panel)
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

function make(tree: DockRoot, groups: Record<string, DockGroup>): DockState {
  return { tree, groups, lastSpot: {} }
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
export type DockStore = { v: 1; active: string; layouts: SavedLayout[] }

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
 * Total: unknown panel ids are dropped, a panel in two groups (or a group
 * named twice in the tree) rejects the whole state, and anything that leaves
 * no panel docked is `null` — the caller falls back to a preset, never to an
 * empty layout.
 */
export function parseState(raw: unknown): DockState | null {
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
  if (Object.keys(groups).length === 0) return null
  const lastSpot: DockState['lastSpot'] = {}
  if (isObj(raw.lastSpot)) {
    for (const [p, s] of Object.entries(raw.lastSpot)) {
      if (!isPanelId(p) || !isObj(s) || !isPanelId(s.anchor)) continue
      const edge = s.edge
      if (edge === 'center' || edge === 'left' || edge === 'right' || edge === 'top' || edge === 'bottom') {
        lastSpot[p] = { anchor: s.anchor, edge }
      }
    }
  }
  return { tree: normalize(tree), groups, lastSpot }
}

export function defaultStore(): DockStore {
  return {
    v: 1,
    active: DEFAULT_LAYOUT_ID,
    layouts: Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, builtin: true, state: p.make() })),
  }
}

/** Total: garbage is the default store; a layout that does not parse is
 *  replaced by its preset (a built-in) or dropped (a user one); the three
 *  built-ins are always present. */
export function parseStore(raw: unknown): DockStore {
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.layouts)) return defaultStore()
  const layouts: SavedLayout[] = []
  const ids = new Set<string>()
  for (const l of raw.layouts) {
    if (!isObj(l) || typeof l.id !== 'string' || typeof l.name !== 'string' || ids.has(l.id)) continue
    const builtin = l.id in PRESETS
    const state = parseState(l.state) ?? (builtin ? PRESETS[l.id].make() : null)
    if (state === null) continue
    ids.add(l.id)
    layouts.push({ id: l.id, name: builtin ? PRESETS[l.id].name : l.name, builtin, state })
  }
  for (const [id, p] of Object.entries(PRESETS)) {
    if (!ids.has(id)) layouts.splice(Object.keys(PRESETS).indexOf(id), 0, { id, name: p.name, builtin: true, state: p.make() })
  }
  const active = typeof raw.active === 'string' && layouts.some((l) => l.id === raw.active) ? raw.active : DEFAULT_LAYOUT_ID
  return { v: 1, active, layouts }
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

/** User layouts only; deleting the active one falls back to the first. */
export function deleteLayout(store: DockStore, id: string): DockStore {
  const target = store.layouts.find((l) => l.id === id)
  if (!target || target.builtin) return store
  const layouts = store.layouts.filter((l) => l.id !== id)
  return { ...store, layouts, active: store.active === id ? layouts[0].id : store.active }
}
