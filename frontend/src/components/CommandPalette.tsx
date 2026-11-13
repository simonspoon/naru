import { useEffect, useMemo, useRef, useState } from 'react'
import { ccHref, projectHref } from '../lastView'
import { chordLabel, type KeymapAction } from '../keymap'
import { useKeymap } from '../keymapStore'
import {
  breadcrumb,
  childCounts,
  projectPanelTargets,
  rankItems,
  segments,
  subProjects,
  type Rankable,
} from '../paletteSearch'
import { paneLabel, PANE_TABS, type PaneTab } from '../projectPanes'
import { NO_STATUS, type ProjectStatus } from '../projectStatus'
import { effectivelyArchivedIds } from '../projectTree'
import { loadRecent, recentProjects } from '../recentProjects'
import type { Project } from '../types/Project'
import { ProjectChips } from './ProjectChips'

type Tag = 'PANEL' | 'PROJECT' | 'COMMAND' | 'ARCHIVED'

interface Entry extends Rankable {
  id: string
  tag: Tag
  run: () => void
  // The keymap action this row *is*, when it is one (mesa task 1079). The row
  // then shows the chord that action is bound to, read from the same keymap
  // the listener acts on, so the palette and the keyboard can never disagree.
  // Most rows are navigation with no shortcut of their own and leave it unset
  // — an invented chord would be worse than none.
  action?: KeymapAction
  // Project rows carry their status chips.
  status?: ProjectStatus
  // Project rows: what Tab drills into (naru task 2806).
  project?: { id: number; name: string }
  // Sub-project rows: how many sub-projects of its own it has (naru task
  // 2807), drawn as a hint that Tab goes deeper.
  children?: number
}

// A grouped list's section (the empty query, and a drilled-in project).
type Group = 'Sub-projects' | 'Panels' | 'Recent projects' | 'Commands'

interface Row {
  item: Entry
  indices: number[]
  group?: Group
}

const panelLabel = (tab: string) => paneLabel(tab as PaneTab)

// Rows ranked below the plain project row / panel they hang off.
const SUBVIEW_PENALTY = 400
// Archived projects stay reachable but sort after every live hit.
const ARCHIVED_PENALTY = 1_000_000
// Breadcrumb chips drawn before the deeper ones collapse to "…".
const MAX_CRUMBS = 4
// A query over hundreds of sub-view rows would paint them all; the best few
// dozen are what anyone reads.
const MAX_ROWS = 60

function navigate(hash: string) {
  window.location.hash = hash
}

/**
 * The palette's rows. Panels first (everything the left nav offers, plus
 * Ambient), then every project — "Go to" the project via its remembered tab
 * (`projectHref`, the sidebar link) — then commands. Per project there are
 * also flat "<name> — <panel>" rows for each of its tabs and "Create task in
 * <name>" (which lands on the create-task route — ProjectTasksPage opens the
 * form with its description field focused); those rank below the project row
 * and are hidden until something is typed, so "naru git" still finds naru's
 * Git without drilling in (naru task 2806).
 */
function buildEntries(
  projects: Project[],
  statuses: Map<number, ProjectStatus>,
  nav: { hidden: boolean; toggle: (() => void) | null },
  onNewProject: () => void,
): { panels: Entry[]; projects: Entry[]; commands: Entry[]; subviews: Entry[] } {
  const panel = (id: string, label: string, hash: () => string, keywords?: string): Entry => ({
    id,
    label,
    keywords,
    tag: 'PANEL',
    run: () => navigate(hash()),
  })
  const panels: Entry[] = [
    panel('cc', 'CC Dashboard', ccHref, 'cc claude code telemetry'),
    panel('inbox', 'Inbox', () => '#/inbox'),
    panel('terminal', 'Terminal', () => '#/terminal', 'shell'),
    panel('watcher', 'Agent watcher', () => '#/agent-watcher', 'agents running'),
    panel('workflows', 'Workflows', () => '#/workflows', 'runs schedule overview'),
    panel('library', 'Library', () => '#/library', 'agents skills hooks prompts claude'),
    panel('kb', 'Knowledge base', () => '#/kb', 'kb notes'),
    panel('ambient', 'Ambient', () => '#/ambient', 'listening hears'),
    panel('settings', 'Settings', () => '#/settings', 'config keyboard shortcuts'),
    panel('scripts', 'Scripts', () => '#/library/scripts', 'shell run library'),
  ]
  const hiddenIds = effectivelyArchivedIds(projects)
  const projectEntries: Entry[] = []
  const subviews: Entry[] = []
  for (const p of projects) {
    const archived = hiddenIds.has(p.id)
    projectEntries.push({
      id: `go-${p.id}`,
      label: p.name,
      tag: archived ? 'ARCHIVED' : 'PROJECT',
      penalty: archived ? ARCHIVED_PENALTY : 0,
      status: statuses.get(p.id) ?? NO_STATUS,
      project: { id: p.id, name: p.name },
      run: () => navigate(projectHref(p.id)),
    })
    if (archived) continue
    for (const t of projectPanelTargets(p.id, PANE_TABS, panelLabel))
      subviews.push({
        id: `${t.key}-${p.id}`,
        label: t.command ? `Create task in ${p.name}` : `${p.name} — ${t.label}`,
        tag: t.command ? 'COMMAND' : 'PANEL',
        penalty: SUBVIEW_PENALTY,
        action: t.command ? 'create-task' : undefined,
        run: () => navigate(t.hash),
      })
  }
  const commands: Entry[] = []
  if (nav.toggle) {
    commands.push({
      id: 'toggle-nav',
      label: nav.hidden ? 'Show sidebar' : 'Hide sidebar',
      keywords: 'nav navigation menu left toggle',
      tag: 'COMMAND',
      run: nav.toggle,
    })
  }
  commands.push(
    {
      id: 'new-project',
      label: 'New project',
      keywords: 'create add',
      tag: 'COMMAND',
      run: onNewProject,
    },
    {
      id: 'live',
      // `#/live` is a verb now (mesa task 857): the header's LiveHub
      // intercepts it, opens the conversation panel and puts the hash back.
      label: 'Live conversation',
      keywords: 'live talk speak voice dictate',
      tag: 'COMMAND',
      run: () => navigate('#/live'),
    },
  )
  return { panels, projects: projectEntries, commands, subviews }
}

/**
 * A drilled-in project's rows (naru task 2806): its panels, Board first, then
 * Create task — grouped, so the list reads as that project's panels.
 */
function drillEntries(
  project: { id: number; name: string },
  statuses: Map<number, ProjectStatus>,
): Entry[] {
  return projectPanelTargets(project.id, PANE_TABS, panelLabel).map((t) => ({
    id: `drill-${t.key}`,
    label: t.label,
    tag: t.command ? 'COMMAND' : 'PANEL',
    action: t.command ? 'create-task' : undefined,
    // The Board row carries the project's queued/running chips, as the
    // project row did.
    status: t.key === 'board' ? (statuses.get(project.id) ?? NO_STATUS) : undefined,
    run: () => navigate(t.hash),
  }))
}

/**
 * A drilled-in project's direct sub-projects as rows (naru task 2807), drawn
 * like project rows elsewhere: status chips, and a hint when they have
 * sub-projects of their own. Enter opens one; Tab drills into it.
 */
function subProjectEntries(
  projects: Project[],
  parentId: number,
  statuses: Map<number, ProjectStatus>,
): Entry[] {
  const hiddenIds = effectivelyArchivedIds(projects)
  const counts = childCounts(projects)
  return subProjects(projects, parentId, hiddenIds).map((p) => ({
    id: `sub-${p.id}`,
    label: p.name,
    tag: hiddenIds.has(p.id) ? 'ARCHIVED' : 'PROJECT',
    penalty: hiddenIds.has(p.id) ? ARCHIVED_PENALTY : 0,
    status: statuses.get(p.id) ?? NO_STATUS,
    project: { id: p.id, name: p.name },
    children: counts.get(p.id) ?? 0,
    run: () => navigate(projectHref(p.id)),
  }))
}

/**
 * Obsidian/VS-Code-style command palette: a centered modal opened by the
 * `command-palette` chords (App.tsx) that fuzzy-matches panels, projects and
 * commands, highlighting what matched. Escape and a backdrop click close it;
 * Up/Down move the selection, Enter runs it, and focus goes back to where it
 * was. An empty query lists the panels, then recent projects, then commands.
 *
 * Tab on a project row drills into it (naru task 2806): the project becomes a
 * chip before the input, the query clears and the list is that project's
 * sub-projects, then its panels and Create task, filtered by what is typed
 * next. Tab on a sub-project row drills further (naru task 2807), the chips
 * becoming a breadcrumb; Backspace on an empty input pops one chip at a time
 * back to the full list.
 */
export function CommandPalette({
  onClose,
  projects,
  statuses,
  navHidden,
  onToggleNav,
  onNewProject,
}: {
  onClose: () => void
  projects: Project[]
  statuses: Map<number, ProjectStatus>
  navHidden: boolean
  // Null on the phone tier, which has no hide/show-sidebar command.
  onToggleNav: (() => void) | null
  onNewProject: () => void
}) {
  const keymap = useKeymap()
  const [query, setQuery] = useState('')
  // The drill path, outermost first; the list shows the last one's contents.
  const [path, setPath] = useState<{ id: number; name: string }[]>([])
  const drill = path.length > 0 ? path[path.length - 1] : null
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Captured once, at open, so close can hand focus back to it.
  const [opener] = useState(() => document.activeElement)

  const entries = useMemo(
    () => buildEntries(projects, statuses, { hidden: navHidden, toggle: onToggleNav }, onNewProject),
    [projects, statuses, navHidden, onToggleNav, onNewProject],
  )
  const rows = useMemo((): Row[] => {
    if (drill) {
      const all = drillEntries(drill, statuses)
      const ranked = rankItems(all, query)
      // Sub-projects, then panels, then Create task whatever the ranking, so
      // each heading appears once.
      const subs = rankItems(subProjectEntries(projects, drill.id, statuses), query)
      const panels = ranked.filter((r) => r.item.tag !== 'COMMAND')
      const commands = ranked.filter((r) => r.item.tag === 'COMMAND')
      return [
        ...subs.map((r): Row => ({ ...r, group: 'Sub-projects' })),
        ...panels.map((r): Row => ({ ...r, group: 'Panels' })),
        ...commands.map((r): Row => ({ ...r, group: 'Commands' })),
      ]
    }
    if (query.trim() === '') {
      const hiddenIds = effectivelyArchivedIds(projects)
      const live = entries.projects.filter((e) => e.tag === 'PROJECT')
      const byId = new Map(live.map((e) => [e.id, e]))
      const recent = recentProjects(
        projects.filter((p) => !hiddenIds.has(p.id)),
        loadRecent(),
      ).flatMap((p) => byId.get(`go-${p.id}`) ?? [])
      const grouped = (items: Entry[], group: Group): Row[] =>
        items.map((item) => ({ item, indices: [], group }))
      return [
        ...grouped(entries.panels, 'Panels'),
        ...grouped(recent, 'Recent projects'),
        ...grouped(entries.commands, 'Commands'),
      ]
    }
    return rankItems(
      [...entries.panels, ...entries.projects, ...entries.commands, ...entries.subviews],
      query,
    ).slice(0, MAX_ROWS)
  }, [entries, projects, query, drill, statuses])

  // Re-filtering drops stale selections (e.g. index 8 selected, next
  // keystroke leaves only 3 results) — always reset to the top match.
  // Adjust state during render off the changed query rather than in an
  // effect (avoids a cascading render), matching ProjectTasksPage's
  // `prevTaskId` pattern.
  const listKey = `${path.map((p) => p.id).join('/')}\u0000${query}`
  const [prevListKey, setPrevListKey] = useState(listKey)
  if (listKey !== prevListKey) {
    setPrevListKey(listKey)
    setSelected(0)
  }

  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      // Back to where it was — unless something else has taken focus since
      // (the New project modal's field, say).
      const now = document.activeElement
      if ((now === null || now === document.body) && opener instanceof HTMLElement) opener.focus()
    }
  }, [opener])

  // Keep the selected row in view as Up/Down moves past the visible window.
  // Keyed on the row's id, not `rows`: a status poll rebuilds `rows` and must
  // not snap a wheel-scrolled list back.
  const selectedId = rows[selected]?.item.id
  useEffect(() => {
    const el = selectedId ? document.getElementById(`command-palette-${selectedId}`) : null
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  function run(index: number) {
    const row = rows[index]
    if (!row) return
    row.item.run()
    onClose()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Tab') {
      // Tab never leaves the modal; on a project or sub-project row it drills
      // in, one level deeper.
      e.preventDefault()
      const project = rows[selected]?.item.project
      if (project && !e.shiftKey) {
        setPath((p) => [...p, project])
        setQuery('')
      }
    } else if (e.key === 'Backspace' && drill && query === '') {
      e.preventDefault()
      setPath((p) => p.slice(0, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(selected)
    } else if (e.key === 'Escape') {
      // Stop here so it doesn't also reach a background view's own Escape
      // listener (e.g. the expanded workflow canvas) — the palette is a
      // modal, so Escape closes only it.
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div className="command-palette-backdrop" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-input-row">
          {breadcrumb(path, MAX_CRUMBS).map((p) => (
            <span key={p ? p.id : 'more'} className={`command-palette-step${p ? '' : ' more'}`}>
              {p ? (
                <span className="command-palette-chip" title={p.name}>
                  {p.name}
                </span>
              ) : (
                <span className="command-palette-more" title={path.map((q) => q.name).join(' › ')}>
                  …
                </span>
              )}
              <span className="command-palette-crumb" aria-hidden="true">
                ›
              </span>
            </span>
          ))}
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={rows[selected] ? `command-palette-${rows[selected].item.id}` : undefined}
            value={query}
            aria-label={drill ? `Sub-projects and panels of ${drill.name}` : undefined}
            placeholder={
              drill
                ? rows.some((r) => r.group === 'Sub-projects')
                  ? 'sub-project or panel…'
                  : 'panel…'
                : 'Jump to a project, panel, or command…'
            }
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul className="command-palette-list" id="command-palette-list" role="listbox">
          {rows.length === 0 ? (
            <li className="command-palette-empty muted">No matches.</li>
          ) : (
            rows.flatMap(({ item: c, indices, group }, i) => [
              ...(group && group !== rows[i - 1]?.group
                ? [
                    <li key={`head-${group}`} role="presentation" className="command-palette-head">
                      {group}
                    </li>,
                  ]
                : []),
              <li
                key={c.id}
                id={`command-palette-${c.id}`}
                role="option"
                aria-selected={i === selected}
                className={`command-palette-item${i === selected ? ' active' : ''}${c.tag === 'ARCHIVED' ? ' archived' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => run(i)}
              >
                <span className="command-palette-label">
                  {segments(c.label, indices).map((s, k) =>
                    s.hit ? <mark key={k}>{s.text}</mark> : <span key={k}>{s.text}</span>,
                  )}
                </span>
                {c.status && <ProjectChips status={c.status} />}
                {c.children ? (
                  <span className="command-palette-kids" title="Tab to see its sub-projects">
                    {c.children} sub ›
                  </span>
                ) : null}
                {c.action && (
                  <span className="command-palette-chord">
                    {(keymap[c.action] ?? []).map(chordLabel).join(' or ')}
                  </span>
                )}
                <span className="command-palette-tag">{c.tag}</span>
              </li>,
            ])
          )}
        </ul>
        <div className="command-palette-foot muted">
          <span>
            <kbd>Tab</kbd>into project
          </span>
          <span>
            <kbd>↵</kbd>open
          </span>
          <span>
            <kbd>⌫</kbd>
            {path.length > 1 ? 'up a level' : 'back to all'}
          </span>
          <span>
            <kbd>esc</kbd>close
          </span>
        </div>
      </div>
    </div>
  )
}
