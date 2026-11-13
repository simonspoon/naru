// The Projects panel's row model (naru task 2808, docs/projects-panel.md):
// the project tree with four task counts per row, a running flag, a "needs
// you" flag, the pinned-and-recent section and the type-to-filter. Pure, so
// vitest covers the count and roll-up rules; `components/ProjectsPanel.tsx`
// only draws what this returns.

import {
  ancestorIds,
  buildTree,
  descendantIds,
  effectivelyArchivedIds,
  hasChildren,
  visibleRows,
} from './projectTree'
import type { ProjectCounts } from './types/ProjectCounts'

/** The fields of a project this module needs. */
export interface PanelProject {
  id: number
  name: string
  parent_id: number | null
  archived: boolean
}

/** What a row shows: the four columns plus what drives the glow and badge. */
export interface PanelCounts {
  backlog: number
  todo: number
  in_progress: number
  done: number
  /** Open questions plus bounced tasks. */
  needs: number
}

export const NO_COUNTS: PanelCounts = { backlog: 0, todo: 0, in_progress: 0, done: 0, needs: 0 }

export interface PanelRow<T extends PanelProject> {
  project: T
  depth: number
  /** Has a child among the projects shown, so it gets a caret. */
  parent: boolean
  collapsed: boolean
  /** True when `counts` include its children (a collapsed parent). */
  rolledUp: boolean
  counts: PanelCounts
  running: boolean
  needsYou: boolean
  archived: boolean
  pinned: boolean
}

/** The server's rows keyed by project. */
export function countsById(rows: ProjectCounts[]): Map<number, PanelCounts> {
  const out = new Map<number, PanelCounts>()
  for (const r of rows)
    out.set(r.project_id, {
      backlog: r.backlog,
      todo: r.todo,
      in_progress: r.in_progress,
      done: r.done,
      needs: r.questions + r.bounced,
    })
  return out
}

function add(a: PanelCounts, b: PanelCounts): PanelCounts {
  return {
    backlog: a.backlog + b.backlog,
    todo: a.todo + b.todo,
    in_progress: a.in_progress + b.in_progress,
    done: a.done + b.done,
    needs: a.needs + b.needs,
  }
}

/**
 * The counts a row shows. Open (or a leaf), only the project's own tasks: its
 * children are on screen with theirs. Collapsed, its own plus every
 * descendant in `shown`, so collapsing never hides work. `shown` is the set of
 * projects the panel lists, so a hidden archived child adds nothing.
 */
export function rowCounts<T extends PanelProject>(
  shown: T[],
  counts: Map<number, PanelCounts>,
  id: number,
  collapsed: boolean,
): PanelCounts {
  const own = counts.get(id) ?? NO_COUNTS
  if (!collapsed) return own
  return descendantIds(shown, id).reduce((sum, d) => add(sum, counts.get(d) ?? NO_COUNTS), own)
}

function toRow<T extends PanelProject>(
  shown: T[],
  counts: Map<number, PanelCounts>,
  archived: Set<number>,
  pinned: Set<number>,
  project: T,
  depth: number,
  parent: boolean,
  collapsed: boolean,
): PanelRow<T> {
  const rolledUp = parent && collapsed
  const c = rowCounts(shown, counts, project.id, rolledUp)
  return {
    project,
    depth,
    parent,
    collapsed: rolledUp,
    rolledUp,
    counts: c,
    running: c.in_progress > 0,
    needsYou: c.needs > 0,
    archived: archived.has(project.id),
    pinned: pinned.has(project.id),
  }
}

export interface PanelOptions {
  /** Parents the person collapsed. */
  collapsed: ReadonlySet<number>
  showArchived: boolean
  filter: string
  pinned: number[]
  /** Recently opened, newest first. */
  recent: number[]
  recentLimit?: number
}

export interface PanelModel<T extends PanelProject> {
  /** Pinned then recent; empty while filtering. */
  top: PanelRow<T>[]
  tree: PanelRow<T>[]
  /** Archived projects (or under an archived parent), shown or not. */
  archivedCount: number
}

/**
 * The whole panel. Archived projects (and anything under one) are left out
 * unless `showArchived`. A filter keeps every project whose name contains it
 * (case-insensitive) plus their ancestors for context, all expanded, and
 * hides the pinned-and-recent section so a match is listed once.
 */
export function panelModel<T extends PanelProject>(
  projects: T[],
  counts: Map<number, PanelCounts>,
  opts: PanelOptions,
): PanelModel<T> {
  const archived = effectivelyArchivedIds(projects)
  const shown = opts.showArchived ? projects : projects.filter((p) => !archived.has(p.id))
  const pinned = new Set(opts.pinned)
  const q = opts.filter.trim().toLowerCase()
  const row = (p: T, depth: number, parent: boolean, collapsed: boolean) =>
    toRow(shown, counts, archived, pinned, p, depth, parent, collapsed)

  if (q !== '') {
    const keep = new Set<number>()
    for (const p of shown) {
      if (!p.name.toLowerCase().includes(q)) continue
      keep.add(p.id)
      for (const a of ancestorIds(shown, p.id)) keep.add(a)
    }
    const kept = shown.filter((p) => keep.has(p.id))
    const tree = buildTree(kept).map(({ project, depth }) =>
      row(project, depth, hasChildren(kept, project.id), false),
    )
    return { top: [], tree, archivedCount: archived.size }
  }

  const isParent = (id: number) => hasChildren(shown, id)
  const tree = visibleRows(buildTree(shown), (id) => opts.collapsed.has(id)).map(
    ({ project, depth }) =>
      row(project, depth, isParent(project.id), opts.collapsed.has(project.id)),
  )

  const byId = new Map(shown.map((p) => [p.id, p]))
  const top: PanelRow<T>[] = []
  const seen = new Set<number>()
  for (const id of opts.pinned) {
    const p = byId.get(id)
    if (p && !seen.has(id)) {
      seen.add(id)
      top.push(row(p, 0, isParent(id), opts.collapsed.has(id)))
    }
  }
  let recents = 0
  for (const id of opts.recent) {
    if (recents >= (opts.recentLimit ?? 3)) break
    const p = byId.get(id)
    if (p && !seen.has(id)) {
      seen.add(id)
      recents++
      top.push(row(p, 0, isParent(id), opts.collapsed.has(id)))
    }
  }
  return { top, tree, archivedCount: archived.size }
}

/** The tree row the Left key goes to: the nearest shown ancestor, else null. */
export function parentRowId<T extends PanelProject>(tree: PanelRow<T>[], id: number): number | null {
  const at = tree.findIndex((r) => r.project.id === id)
  if (at < 0) return null
  const depth = tree[at].depth
  for (let i = at - 1; i >= 0; i--) if (tree[i].depth < depth) return tree[i].project.id
  return null
}

// ---- per-browser state: pins, collapsed parents, the archived switch ----

const PINNED_KEY = 'naru-projects-panel-pinned'
const COLLAPSED_KEY = 'naru-projects-panel-collapsed'
const ARCHIVED_KEY = 'naru-projects-panel-archived'

function loadIds(key: string): number[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is number => Number.isInteger(v) && v > 0)
  } catch {
    return []
  }
}

export function loadPinned(): number[] {
  return loadIds(PINNED_KEY)
}

/** Pins `id` (at the end) or unpins it; returns the new list. */
export function togglePinned(pinned: number[], id: number): number[] {
  const next = pinned.includes(id) ? pinned.filter((v) => v !== id) : [...pinned, id]
  localStorage.setItem(PINNED_KEY, JSON.stringify(next))
  return next
}

export function loadPanelCollapsed(): Set<number> {
  return new Set(loadIds(COLLAPSED_KEY))
}

export function savePanelCollapsed(ids: ReadonlySet<number>): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]))
}

export function loadShowArchived(): boolean {
  return localStorage.getItem(ARCHIVED_KEY) === '1'
}

export function saveShowArchived(show: boolean): void {
  if (show) localStorage.setItem(ARCHIVED_KEY, '1')
  else localStorage.removeItem(ARCHIVED_KEY)
}
