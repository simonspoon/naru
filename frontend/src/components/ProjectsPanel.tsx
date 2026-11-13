import { useEffect, useMemo, useRef, useState } from 'react'
import { getProjectCounts } from '../api'
import { projectHref } from '../lastView'
import {
  countsById,
  loadPanelCollapsed,
  loadPinned,
  loadShowArchived,
  panelModel,
  parentRowId,
  savePanelCollapsed,
  saveShowArchived,
  togglePinned,
  type PanelRow,
} from '../projectsPanel'
import { loadRecent } from '../recentProjects'
import type { Project } from '../types/Project'
import { useFetch } from '../useFetch'

/**
 * The Projects panel (naru task 2808, docs/projects-panel.md): the project
 * tree with backlog / queued / running / done counts, a glow on a project with
 * a task running, a "Needs you" badge, pinned-and-recent rows on top, a
 * filter and a "Show archived" switch. A dock panel on the desktop tiers,
 * the `#/projects` page on the phone. Polls only while shown.
 */
export function ProjectsPanel({
  active,
  projects,
  activeProjectId,
}: {
  active: boolean
  /** Every project, archived included (App's one poll). */
  projects: Project[]
  activeProjectId: number | null
}) {
  // Kept here, outside the polling body, so hiding the panel keeps the text.
  const [filter, setFilter] = useState('')
  if (!active) return null
  return (
    <ProjectsPanelBody
      projects={projects}
      activeProjectId={activeProjectId}
      filter={filter}
      setFilter={setFilter}
    />
  )
}

/** Opens a project the way the command palette does. */
function openProject(id: number) {
  window.location.hash = projectHref(id)
}

type Keyed = { key: string; row: PanelRow<Project>; inTree: boolean }

function ProjectsPanelBody({
  projects,
  activeProjectId,
  filter,
  setFilter,
}: {
  projects: Project[]
  activeProjectId: number | null
  filter: string
  setFilter: (v: string) => void
}) {
  const { data, error } = useFetch(getProjectCounts, 'projects-panel-counts', { pollMs: 5000 })
  const counts = useMemo(() => countsById(data ?? []), [data])
  const [collapsed, setCollapsed] = useState(loadPanelCollapsed)
  const [showArchived, setShowArchived] = useState(loadShowArchived)
  const [pinned, setPinned] = useState(loadPinned)
  // The open project is the newest recent one; App records it in an effect
  // that runs after this render, so it is put first here rather than read.
  const recent = useMemo(
    () => (activeProjectId === null ? loadRecent() : [activeProjectId, ...loadRecent()]),
    [activeProjectId],
  )
  const model = useMemo(
    () => panelModel(projects, counts, { collapsed, showArchived, filter, pinned, recent }),
    [projects, counts, collapsed, showArchived, filter, pinned, recent],
  )
  const rows: Keyed[] = [
    ...model.top.map((row) => ({ key: `top-${row.project.id}`, row, inTree: false })),
    ...model.tree.map((row) => ({ key: `tree-${row.project.id}`, row, inTree: true })),
  ]
  // Roving focus: one row is the tree's tab stop.
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const tabKey = rows.some((r) => r.key === focusKey) ? focusKey : (rows[0]?.key ?? null)
  const treeRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  // After a key moves focus, put the browser's focus on that row.
  const pendingFocus = useRef<string | null>(null)
  useEffect(() => {
    if (pendingFocus.current === null) return
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-key="${pendingFocus.current}"]`)
    pendingFocus.current = null
    el?.focus()
  })

  function focusRow(key: string | undefined) {
    if (!key) return
    setFocusKey(key)
    pendingFocus.current = key
    treeRef.current?.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus()
  }

  function setOpen(id: number, open: boolean) {
    const next = new Set(collapsed)
    if (open) next.delete(id)
    else next.add(id)
    savePanelCollapsed(next)
    setCollapsed(next)
  }

  function onTreeKeyDown(e: React.KeyboardEvent) {
    const at = rows.findIndex((r) => r.key === tabKey)
    const cur = rows[at]
    // Handled keys stop here: the window's spatial nav answers to the arrows
    // and j/k too.
    const claim = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // A focused caret or pin button keeps its own Enter / Space.
    if ((e.target as HTMLElement).closest('button')) return
    if (e.key === 'ArrowDown' || e.key === 'j') {
      claim()
      focusRow(rows[Math.min(at + 1, rows.length - 1)]?.key)
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      claim()
      if (at <= 0) filterRef.current?.focus()
      else focusRow(rows[at - 1]?.key)
    } else if (e.key === 'Home') {
      claim()
      focusRow(rows[0]?.key)
    } else if (e.key === 'End') {
      claim()
      focusRow(rows[rows.length - 1]?.key)
    } else if (!cur) {
      return
    } else if (e.key === 'ArrowRight' || e.key === 'l') {
      claim()
      if (!cur.inTree || !cur.row.parent) return
      if (cur.row.collapsed) setOpen(cur.row.project.id, true)
      else focusRow(rows[at + 1]?.key)
    } else if (e.key === 'ArrowLeft' || e.key === 'h') {
      claim()
      if (!cur.inTree) return
      if (cur.row.parent && !cur.row.collapsed && filter.trim() === '')
        setOpen(cur.row.project.id, false)
      else {
        const parent = parentRowId(model.tree, cur.row.project.id)
        if (parent !== null) focusRow(`tree-${parent}`)
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      claim()
      openProject(cur.row.project.id)
    } else if (e.key === 'p') {
      claim()
      setPinned(togglePinned(pinned, cur.row.project.id))
    } else if (e.key === '/') {
      claim()
      filterRef.current?.focus()
    }
  }

  function onFilterKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      focusRow(rows[0]?.key)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const first = model.tree[0] ?? model.top[0]
      if (first) openProject(first.project.id)
    } else if (e.key === 'Escape' && filter !== '') {
      e.preventDefault()
      e.stopPropagation()
      setFilter('')
    }
  }

  const filtering = filter.trim() !== ''
  const renderRow = ({ key, row, inTree }: Keyed) => (
    <Row
      key={key}
      dataKey={key}
      row={row}
      inTree={inTree && !filtering}
      current={row.project.id === activeProjectId}
      tabbable={key === tabKey}
      loaded={data !== null}
      onFocus={() => setFocusKey(key)}
      onToggle={() => setOpen(row.project.id, row.collapsed)}
      onPin={() => setPinned(togglePinned(pinned, row.project.id))}
    />
  )

  return (
    <div className="projects-panel">
      <div className="projects-panel-head">
        <input
          ref={filterRef}
          className="projects-panel-filter"
          type="search"
          placeholder="Filter"
          aria-label="Filter projects"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKeyDown}
        />
      </div>
      {error !== null && <p className="projects-panel-error">Counts unavailable: {error}</p>}
      <div className="projects-panel-legend" aria-hidden="true">
        <span className="projects-panel-legend-name" />
        <span className="pp-b">Back</span>
        <span className="pp-q">Queue</span>
        <span className="pp-r">Run</span>
        <span className="pp-d">Done</span>
      </div>
      <div
        className="projects-panel-scroll"
        role="tree"
        aria-label="Projects"
        ref={treeRef}
        onKeyDown={onTreeKeyDown}
      >
        {model.top.length > 0 && (
          <div role="group" aria-label="Pinned and recent">
            <div className="projects-panel-section">Pinned and recent</div>
            {rows.filter((r) => !r.inTree).map(renderRow)}
          </div>
        )}
        <div role="group" aria-label="All projects">
          {model.top.length > 0 && <div className="projects-panel-section">All projects</div>}
          {model.tree.length === 0 && (
            <p className="projects-panel-empty">{filtering ? 'No match' : 'No projects'}</p>
          )}
          {rows.filter((r) => r.inTree).map(renderRow)}
        </div>
      </div>
      <label className="projects-panel-foot">
        <input
          type="checkbox"
          role="switch"
          className="projects-panel-switch"
          checked={showArchived}
          onChange={(e) => {
            saveShowArchived(e.target.checked)
            setShowArchived(e.target.checked)
          }}
        />
        <span>Show archived</span>
        {!showArchived && model.archivedCount > 0 && (
          <small className="projects-panel-hidden">{model.archivedCount} hidden</small>
        )}
      </label>
    </div>
  )
}

function Row({
  dataKey,
  row,
  inTree,
  current,
  tabbable,
  loaded,
  onFocus,
  onToggle,
  onPin,
}: {
  dataKey: string
  row: PanelRow<Project>
  /** In the tree, not the top section or a filtered list: a caret works. */
  inTree: boolean
  current: boolean
  tabbable: boolean
  /** False until the first counts fetch lands: the cells stay blank. */
  loaded: boolean
  onFocus: () => void
  onToggle: () => void
  onPin: () => void
}) {
  const { project, counts } = row
  const caret = inTree && row.parent
  const cls = [
    'projects-panel-row',
    row.running ? 'running' : '',
    row.rolledUp ? 'rolled-up' : '',
    row.archived ? 'archived' : '',
    current ? 'current' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const label = !loaded
    ? project.name
    : `${project.name}: ${counts.backlog} backlog, ${counts.todo} queued, ${counts.in_progress} running, ${counts.done} done${row.rolledUp ? ', including sub-projects' : ''}${row.needsYou ? ', needs you' : ''}`
  const n = (v: number, c: string, what: string) =>
    loaded ? (
      <span className={`${c}${v === 0 ? ' zero' : ''}`} title={`${v} ${what}`}>
        {v}
      </span>
    ) : (
      <span className={c} />
    )
  return (
    <div
      role="treeitem"
      data-key={dataKey}
      className={cls}
      tabIndex={tabbable ? 0 : -1}
      aria-level={row.depth + 1}
      aria-expanded={caret ? !row.collapsed : undefined}
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      style={{ paddingLeft: `${0.25 + row.depth * 1.25}rem` }}
      onFocus={onFocus}
      onClick={() => openProject(project.id)}
    >
      {caret ? (
        <button
          type="button"
          className="projects-panel-caret"
          tabIndex={-1}
          aria-hidden="true"
          title={row.collapsed ? 'Expand' : 'Collapse'}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
        >
          {row.collapsed ? '▸' : '▾'}
        </button>
      ) : (
        <span className="projects-panel-caret" aria-hidden="true" />
      )}
      {row.running && <span className="projects-panel-dot" aria-hidden="true" title="Running" />}
      <span className="projects-panel-name">{project.name}</span>
      {row.needsYou && (
        <span className="projects-panel-needs" title="Needs you: a question is waiting or a task bounced">
          <span className="projects-panel-needs-long">Needs you</span>
          <span className="projects-panel-needs-short" aria-hidden="true">
            !
          </span>
        </span>
      )}
      <button
        type="button"
        className={`projects-panel-pin${row.pinned ? ' pinned' : ''}`}
        tabIndex={-1}
        aria-hidden="true"
        title={row.pinned ? 'Unpin (p)' : 'Pin (p)'}
        onClick={(e) => {
          e.stopPropagation()
          onPin()
        }}
      >
        {row.pinned ? '★' : '☆'}
      </button>
      <span className="projects-panel-counts" aria-hidden="true">
        {n(counts.backlog, 'pp-b', 'backlog')}
        {n(counts.todo, 'pp-q', 'queued')}
        {n(counts.in_progress, 'pp-r', 'running')}
        {n(counts.done, 'pp-d', 'done')}
      </span>
    </div>
  )
}
