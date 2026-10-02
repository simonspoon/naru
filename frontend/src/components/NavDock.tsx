import { useLayoutEffect, useRef, useState } from 'react'
import {
  closePanel,
  dockToNav,
  isPanelId,
  navDropIndex,
  PANEL_DRAG_MIME,
  panelEntries,
  panelLabel,
  type DockState,
  type PanelId,
} from '../dockLayout'
import { ccHref } from '../lastView'
import * as dockHosts from '../lib/dockHosts'
import { beginPanelDrag, endPanelDrag, usePanelDrag } from '../lib/panelDrag'
import type { Update } from '../useDockStore'
import { DockSlot } from './DockSlot'

// The nav as a dock zone (mesa task 1574, docs/dock.md): the panels docked into
// the left navigation, the Panels list that opens/places every panel, and the
// slim rail the collapsed nav becomes.

type Locked = ReadonlySet<PanelId>

/** The nav zone: a vertical stack above the nav items, and a drop target for a
 *  dragged panel (the line shows where it will land). Empty and idle, it takes
 *  no room; mid-drag an empty zone shows a landing strip. */
export function NavZone({ state, update, locked }: { state: DockState; update: Update; locked: Locked }) {
  const dragging = usePanelDrag()
  const [at, setAt] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  if (state.nav.length === 0 && dragging === null) return null

  function indexAt(y: number): number {
    const items = ref.current?.querySelectorAll<HTMLElement>('.nav-dock-item') ?? []
    return navDropIndex([...items].map((el) => el.getBoundingClientRect()), y)
  }

  return (
    <div
      ref={ref}
      className={`nav-dock${dragging !== null ? ' dragging' : ''}`}
      aria-label="Panels docked in the navigation"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PANEL_DRAG_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const i = indexAt(e.clientY)
        if (i !== at) setAt(i)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAt(null)
      }}
      onDrop={(e) => {
        const p = e.dataTransfer.getData(PANEL_DRAG_MIME)
        if (!isPanelId(p)) return
        e.preventDefault()
        const i = indexAt(e.clientY)
        setAt(null)
        endPanelDrag()
        update((s) => dockToNav(s, p, i))
      }}
    >
      {state.nav.map((p, i) => {
        const lock = locked.has(p)
        return (
          <div key={p} className="nav-dock-item" data-panel={p}>
            {at === i && <div className="nav-dock-line" />}
            <div
              className="nav-dock-head"
              draggable={!lock}
              onDragStart={(e) => beginPanelDrag(e, p)}
              onDragEnd={() => {
                endPanelDrag()
                setAt(null)
              }}
              title={lock ? 'Unsent ink on the board holds it in place' : `Drag ${panelLabel(p)} to rearrange`}
            >
              <span className="dock-grip" aria-hidden="true">
                ⠿
              </span>
              <span className="nav-dock-label">{panelLabel(p)}</span>
              {!lock && (
                <button
                  type="button"
                  className="nav-dock-close"
                  aria-label={`Close ${panelLabel(p)}`}
                  title={`Close ${panelLabel(p)}`}
                  onClick={() => update((s) => closePanel(s, p))}
                >
                  ×
                </button>
              )}
            </div>
            <div className="nav-dock-body">
              <DockSlot panel={p} />
            </div>
          </div>
        )
      })}
      {at === state.nav.length && <div className="nav-dock-line" />}
      {state.nav.length === 0 && <div className="nav-dock-empty">Dock a panel here</div>}
    </div>
  )
}

/** The nav's Panels section: every panel with an open/closed dot. A click opens
 *  it where it last sat; dragging a row out docks it where it is dropped. */
export function NavPanels({
  state,
  navCollapsed,
  locked,
  onReveal,
}: {
  state: DockState
  navCollapsed: boolean
  locked: Locked
  onReveal: (p: PanelId) => void
}) {
  return (
    <div className="nav-panels" role="group" aria-label="Panels">
      <div className="nav-panels-head">
        <span>Panels</span>
        <span>open ●</span>
      </div>
      {panelEntries(state, navCollapsed).map((e) => (
        // A div, not a <button>: Firefox does not start a drag from a button.
        <div
          key={e.id}
          role="button"
          tabIndex={0}
          className={`nav-panel-row${e.open ? ' open' : ''}`}
          draggable={!locked.has(e.id)}
          onDragStart={(ev) => beginPanelDrag(ev, e.id)}
          onDragEnd={endPanelDrag}
          onClick={() => onReveal(e.id)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault()
              onReveal(e.id)
            }
          }}
          title={`Open ${e.label}, or drag it where you want it`}
        >
          <span className="dock-grip" aria-hidden="true">
            ⠿
          </span>
          <span className="nav-panel-name">{e.label}</span>
          <em>{e.where === 'nav' ? 'in nav' : e.where === 'closed' ? 'closed' : ''}</em>
          <span className={`nav-panel-dot${e.open ? ' open' : ''}`} aria-label={e.open ? 'open' : 'closed'} />
        </div>
      ))}
    </div>
  )
}

const RAIL_GLYPH: Record<PanelId, string> = {
  main: '▦',
  chat: '✎',
  board: '◧',
  agents: '◎',
  terminal: '›_',
  diagrams: '◇',
  orb: '●',
}

/** The collapsed nav: the expand handle, a mini orb (the orb's second view,
 *  hosted by LiveHub, so it reacts exactly as the orb panel does), icons for the
 *  two nav links that matter most (the dashboard, the inbox with its unread
 *  count) and one small icon per other panel, dotted when open. */
export function NavRail({
  state,
  navCollapsed,
  unread,
  onReveal,
  onExpand,
}: {
  state: DockState
  navCollapsed: boolean
  unread: number
  onReveal: (p: PanelId) => void
  onExpand: () => void
}) {
  const miniRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = miniRef.current
    if (slot === null) return
    dockHosts.attach('rail-orb', slot)
    return () => dockHosts.release('rail-orb', slot)
  }, [])
  return (
    <>
      <button
        type="button"
        className="sidebar-toggle"
        aria-label="Expand sidebar"
        title="Expand sidebar"
        onClick={onExpand}
      >
        »
      </button>
      <div className="nav-rail">
        <div className="nav-rail-orb" ref={miniRef} />
        <div className="nav-rail-sep" />
        <a className="nav-rail-icon" href={ccHref()} aria-label="CC Dashboard" title="CC Dashboard">
          ⌂
        </a>
        <a className="nav-rail-icon" href="#/inbox" aria-label="Inbox" title="Inbox">
          ✉
          {unread > 0 && <span className="nav-rail-badge">{unread}</span>}
        </a>
        <div className="nav-rail-sep" />
        {panelEntries(state, navCollapsed)
          .filter((e) => e.id !== 'orb')
          .map((e) => (
            <button
              key={e.id}
              type="button"
              className={`nav-rail-icon${e.open ? ' open' : ''}`}
              aria-label={`${e.open ? 'Show' : 'Open'} ${e.label}`}
              title={`${e.label}${e.open ? '' : ' (closed)'}`}
              onClick={() => onReveal(e.id)}
            >
              {RAIL_GLYPH[e.id]}
            </button>
          ))}
      </div>
    </>
  )
}
