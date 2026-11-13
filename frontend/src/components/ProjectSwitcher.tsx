import { useEffect, useRef, useState } from 'react'
import { projectHref } from '../lastView'
import { NO_STATUS, type ProjectStatus } from '../projectStatus'
import { effectivelyArchivedIds } from '../projectTree'
import { loadRecent, recentProjects } from '../recentProjects'
import type { Project } from '../types/Project'
import { ProjectChips } from './ProjectChips'

/**
 * The header's project switcher (naru task 2805): the current project's name
 * and status chips with a caret. Opens a short RECENT list and a "Search all…"
 * row that hands over to the command palette — with the left nav hidden this
 * is how you change project without leaving the keyboard or the board.
 */
export function ProjectSwitcher({
  projects,
  statuses,
  activeProjectId,
  searchChord,
  onSearchAll,
}: {
  projects: Project[]
  statuses: Map<number, ProjectStatus>
  activeProjectId: number | null
  /** The palette's chord, drawn on the last row. */
  searchChord: string
  onSearchAll: () => void
}) {
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<number[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const current = projects.find((p) => p.id === activeProjectId) ?? null
  // Archived projects stay out of the list, as in the nav's main list; the
  // palette is where they are reached.
  const hidden = effectivelyArchivedIds(projects)
  const rows = recentProjects(
    projects.filter((p) => !hidden.has(p.id)),
    recent,
  )

  function toggle() {
    if (!open) setRecent(loadRecent())
    setOpen(!open)
  }
  function close(refocus: boolean) {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }

  // Outside click closes; focus goes to the active row (else the first) once
  // the menu is up so the arrow keys work straight away.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
    const active = menuRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
    ;(active ?? items?.[0])?.focus()
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function onMenuKeyDown(e: React.KeyboardEvent) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    )
    const at = items.indexOf(document.activeElement as HTMLElement)
    // Handled keys stop here: the window's spatial nav answers to the arrows
    // and j/k too, and the live discard key to Escape.
    const claim = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.key === 'Escape') {
      claim()
      close(true)
    } else if (e.key === 'ArrowDown') {
      claim()
      items[(at + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      claim()
      items[(at - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      claim()
      items[0]?.focus()
    } else if (e.key === 'End') {
      claim()
      items[items.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="project-switcher" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`project-switcher-chip${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch project"
        onClick={toggle}
      >
        <span className="project-switcher-name">{current?.name ?? 'Projects'}</span>
        {current && (
          <span className="project-switcher-chips">
            <ProjectChips status={statuses.get(current.id) ?? NO_STATUS} />
          </span>
        )}
        <span className="project-switcher-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="project-switcher-menu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
          <div className="project-switcher-heading">RECENT</div>
          {rows.length === 0 && <p className="muted project-switcher-empty">No projects yet.</p>}
          {rows.map((p) => (
            <a
              key={p.id}
              role="menuitem"
              className={`project-switcher-row${p.id === activeProjectId ? ' active' : ''}`}
              href={projectHref(p.id)}
              aria-current={p.id === activeProjectId ? 'true' : undefined}
              onClick={() => setOpen(false)}
            >
              <span className="project-switcher-row-name">{p.name}</span>
              <ProjectChips status={statuses.get(p.id) ?? NO_STATUS} />
            </a>
          ))}
          <button
            type="button"
            role="menuitem"
            className="project-switcher-row project-switcher-search"
            onClick={() => {
              // Focus the chip first: the palette returns focus to whatever
              // had it, and this row is about to unmount.
              close(true)
              onSearchAll()
            }}
          >
            <span className="project-switcher-row-name">Search all…</span>
            <span className="project-switcher-kbd">{searchChord}</span>
          </button>
        </div>
      )}
    </div>
  )
}
