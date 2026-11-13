import { useEffect, useMemo, useRef, useState } from 'react'
import { ccHref, projectHref } from '../lastView'
import { chordLabel, type KeymapAction } from '../keymap'
import { useKeymap } from '../keymapStore'
import { rankItems, segments, type Rankable } from '../paletteSearch'
import { NO_STATUS, type ProjectStatus } from '../projectStatus'
import { effectivelyArchivedIds } from '../projectTree'
import { loadRecent, recentProjects } from '../recentProjects'
import type { Project } from '../types/Project'
import { ProjectChips } from './ProjectChips'

type Tag = 'PAGE' | 'PROJECT' | 'COMMAND' | 'ARCHIVED'

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
}

// Rows ranked below the plain project row / page they hang off.
const SUBVIEW_PENALTY = 400
// Archived projects stay reachable but sort after every live hit.
const ARCHIVED_PENALTY = 1_000_000
// A query over hundreds of sub-view rows would paint them all; the best few
// dozen are what anyone reads.
const MAX_ROWS = 60

function navigate(hash: string) {
  window.location.hash = hash
}

/**
 * The palette's rows. Pages first (everything the left nav offers, plus
 * Ambient), then every project — "Go to" the project via its remembered tab
 * (`projectHref`, the sidebar link) — then commands. Per project there are
 * also the git/files/terminal/dashboard/workflows/settings sub-views and
 * "Create task in <name>" (which lands on the create-task route —
 * ProjectTasksPage opens the form with its description field focused); those
 * rank below the project row and are hidden until something is typed.
 */
function buildEntries(
  projects: Project[],
  statuses: Map<number, ProjectStatus>,
  nav: { hidden: boolean; toggle: (() => void) | null },
  onNewProject: () => void,
): { pages: Entry[]; projects: Entry[]; commands: Entry[]; subviews: Entry[] } {
  const page = (id: string, label: string, hash: () => string, keywords?: string): Entry => ({
    id,
    label,
    keywords,
    tag: 'PAGE',
    run: () => navigate(hash()),
  })
  const pages: Entry[] = [
    page('cc', 'CC Dashboard', ccHref, 'cc claude code telemetry'),
    page('inbox', 'Inbox', () => '#/inbox'),
    page('terminal', 'Terminal', () => '#/terminal', 'shell'),
    page('watcher', 'Agent watcher', () => '#/agent-watcher', 'agents running'),
    page('workflows', 'Workflows', () => '#/workflows', 'runs schedule overview'),
    page('library', 'Library', () => '#/library', 'agents skills hooks prompts claude'),
    page('kb', 'Knowledge base', () => '#/kb', 'kb notes'),
    page('ambient', 'Ambient', () => '#/ambient', 'listening hears'),
    page('settings', 'Settings', () => '#/settings', 'config keyboard shortcuts'),
    page('scripts', 'Scripts', () => '#/library/scripts', 'shell run library'),
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
      run: () => navigate(projectHref(p.id)),
    })
    if (archived) continue
    const sub = (id: string, label: string, hash: string, action?: KeymapAction): Entry => ({
      id: `${id}-${p.id}`,
      label,
      tag: 'COMMAND',
      penalty: SUBVIEW_PENALTY,
      action,
      run: () => navigate(hash),
    })
    for (const [seg, name] of [
      ['git', 'Git'],
      ['files', 'Files'],
      ['terminal', 'Terminal'],
      ['dashboard', 'Dashboard'],
      ['workflows', 'Workflows'],
      ['settings', 'Settings'],
    ])
      subviews.push(sub(seg, `${p.name} — ${name}`, `#/projects/${p.id}/${seg}`))
    subviews.push(
      sub('create', `Create task in ${p.name}`, `#/projects/${p.id}/create-task`, 'create-task'),
    )
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
  return { pages, projects: projectEntries, commands, subviews }
}

/**
 * Obsidian/VS-Code-style command palette: a centered modal opened by the
 * `command-palette` chords (App.tsx) that fuzzy-matches pages, projects and
 * commands, highlighting what matched. Escape and a backdrop click close it;
 * Up/Down move the selection, Enter runs it, and focus goes back to where it
 * was. An empty query lists the pages, then recent projects, then commands.
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
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // Captured once, at open, so close can hand focus back to it.
  const [opener] = useState(() => document.activeElement)

  const entries = useMemo(
    () => buildEntries(projects, statuses, { hidden: navHidden, toggle: onToggleNav }, onNewProject),
    [projects, statuses, navHidden, onToggleNav, onNewProject],
  )
  const rows = useMemo(() => {
    if (query.trim() === '') {
      const hiddenIds = effectivelyArchivedIds(projects)
      const live = entries.projects.filter((e) => e.tag === 'PROJECT')
      const byId = new Map(live.map((e) => [e.id, e]))
      const recent = recentProjects(
        projects.filter((p) => !hiddenIds.has(p.id)),
        loadRecent(),
      ).flatMap((p) => byId.get(`go-${p.id}`) ?? [])
      return [...entries.pages, ...recent, ...entries.commands].map((item) => ({
        item,
        indices: [] as number[],
      }))
    }
    return rankItems(
      [...entries.pages, ...entries.projects, ...entries.commands, ...entries.subviews],
      query,
    ).slice(0, MAX_ROWS)
  }, [entries, projects, query])

  // Re-filtering drops stale selections (e.g. index 8 selected, next
  // keystroke leaves only 3 results) — always reset to the top match.
  // Adjust state during render off the changed query rather than in an
  // effect (avoids a cascading render), matching ProjectTasksPage's
  // `prevTaskId` pattern.
  const [prevQuery, setPrevQuery] = useState(query)
  if (query !== prevQuery) {
    setPrevQuery(query)
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
  useEffect(() => {
    const el = listRef.current?.children[selected]
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
  }, [selected])

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
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={rows[selected] ? `command-palette-${rows[selected].item.id}` : undefined}
          value={query}
          placeholder="Jump to a project, page, or command…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="command-palette-list" id="command-palette-list" role="listbox" ref={listRef}>
          {rows.length === 0 ? (
            <li className="command-palette-empty muted">No matches.</li>
          ) : (
            rows.map(({ item: c, indices }, i) => (
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
                {c.action && (
                  <span className="command-palette-chord">
                    {(keymap[c.action] ?? []).map(chordLabel).join(' or ')}
                  </span>
                )}
                <span className="command-palette-tag">{c.tag}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
