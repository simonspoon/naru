import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import {
  activateTab,
  activeLayout,
  closedPanels,
  closePanel,
  deleteLayout,
  missingBuiltins,
  moveLayout,
  dropPanel,
  isPanelId,
  PANEL_DRAG_MIME,
  PANEL_IDS,
  panelLabel,
  renameLayout,
  resetLayout,
  restoreDefaultLayouts,
  revealPanel,
  saveAs,
  selectLayout,
  setRatios,
  type DockRoot,
  type DockState,
  type DropSpot,
  type PanelId,
} from '../dockLayout'
import { axisPos, computeDropEdge, getNodeAtPath, MIN_PANE_PX } from '../lib/paneTree'
import { beginPanelDrag, endPanelDrag, usePanelDrag } from '../lib/panelDrag'
import { DockSlot } from './DockSlot'
import type { Update, useDockStore } from '../useDockStore'

// What the pointer is over while a panel is dragged: the group and the spot.
type Over = { group: string; spot: DropSpot } | null

type Ctx = {
  state: DockState
  update: Update
  locked: ReadonlySet<PanelId>
  dragging: PanelId | null
  over: Over
  setOver: (o: Over) => void
  onDragEnd: () => void
  onDividerDown: (path: number[], i: number, o: 'row' | 'column', pos: number, el: HTMLElement) => void
}

const SPOT_LABEL: Record<DropSpot, string> = {
  left: 'Split left',
  right: 'Split right',
  top: 'Split top',
  bottom: 'Split bottom',
  center: 'Stack as tab',
}

function DockGroupView({ id, ratio, ctx }: { id: string; ratio: number; ctx: Ctx }) {
  const group = ctx.state.groups[id]
  const ref = useRef<HTMLDivElement>(null)
  if (!group) return null
  // A group showing a locked panel (a board holding unsent ink) takes no
  // drops either: stacking over it would take it off screen mid-stroke.
  const frozen = ctx.locked.has(group.active)
  const shielded = ctx.dragging !== null && !frozen
  const spot = ctx.over?.group === id ? ctx.over.spot : null

  function pointerSpot(e: DragEvent): DropSpot {
    const rect = ref.current!.getBoundingClientRect()
    return computeDropEdge({ x: e.clientX, y: e.clientY }, rect) ?? 'center'
  }

  return (
    <div
      ref={ref}
      className="dock-group"
      style={{ flexGrow: ratio, flexBasis: 0, minWidth: 0, minHeight: 0 }}
      data-group={id}
    >
      <div className="dock-tabs" role="tablist">
        {group.tabs.map((t) => {
          const lock = ctx.locked.has(t)
          return (
            <div
              key={t}
              role="tab"
              aria-selected={t === group.active}
              className={`dock-tab${t === group.active ? ' active' : ''}`}
              draggable={!lock}
              onClick={() => ctx.update((s) => activateTab(s, id, t))}
              onDragStart={(e) => beginPanelDrag(e, t)}
              onDragEnd={ctx.onDragEnd}
              title={lock ? 'Unsent ink on the board holds it in place' : `Drag ${panelLabel(t)} to rearrange`}
            >
              <span className="dock-grip" aria-hidden="true">
                ⠿
              </span>
              <span className="dock-tab-label">{panelLabel(t)}</span>
              {!lock && (
                <button
                  type="button"
                  className="dock-tab-close"
                  aria-label={`Close ${panelLabel(t)}`}
                  title={`Close ${panelLabel(t)}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    ctx.update((s) => closePanel(s, t))
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="dock-body">
        {group.tabs.map((t) => (
          <DockSlot key={t} panel={t} active={t === group.active} />
        ))}
      </div>
      {/* While a panel is dragged, a transparent shield over the whole group:
          an iframe (a board) or xterm underneath would otherwise swallow the
          dragover and the drop never reach us. It also draws the drop zones. */}
      {shielded && (
        <div
          className="dock-shield"
          onDragEnter={(e) => {
            if (e.dataTransfer.types.includes(PANEL_DRAG_MIME)) e.preventDefault()
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(PANEL_DRAG_MIME)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            const s = pointerSpot(e)
            if (ctx.over?.group !== id || ctx.over.spot !== s) ctx.setOver({ group: id, spot: s })
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) ctx.setOver(null)
          }}
          onDrop={(e) => {
            const p = e.dataTransfer.getData(PANEL_DRAG_MIME)
            if (!isPanelId(p)) return
            e.preventDefault()
            const s = pointerSpot(e)
            ctx.onDragEnd()
            ctx.update((st) => dropPanel(st, p, id, s))
          }}
        >
          {spot !== null && (
            <div className={`dock-zone dock-zone-${spot}`}>
              <span>{SPOT_LABEL[spot]}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Module scope, like `ProjectSplitView`: a divider drag re-renders this tree
// many times a second, and a component defined in the re-rendering parent
// would get a new identity each time and remount every group.
function DockSplitView({ node, path, ctx }: { node: DockRoot; path: number[]; ctx: Ctx }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} className={`dock-split dock-split-${node.orientation}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.node.id}>
          {child.node.kind === 'leaf' ? (
            <DockGroupView id={child.node.id} ratio={child.ratio} ctx={ctx} />
          ) : (
            <div className="dock-split-wrap" style={{ flexGrow: child.ratio, flexBasis: 0 }}>
              <DockSplitView node={child.node} path={[...path, i]} ctx={ctx} />
            </div>
          )}
          {i < node.children.length - 1 && (
            <div
              className={`dock-divider dock-divider-${node.orientation}`}
              role="separator"
              aria-orientation={node.orientation === 'row' ? 'vertical' : 'horizontal'}
              onMouseDown={(e) => {
                e.preventDefault()
                if (ref.current) ctx.onDividerDown(path, i, node.orientation, axisPos(e, node.orientation), ref.current)
              }}
            >
              <span className="dock-divider-knob" />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  )
}

/**
 * The dock: the split tree of tab groups (mesa task 1567, docs/dock.md). Each
 * group is a tab strip over the slot showing its front panel; a tab drag lights
 * drop zones over the group under the pointer.
 */
export function DockLayout({
  state,
  update,
  locked,
}: {
  state: DockState
  update: Update
  locked: ReadonlySet<PanelId>
}) {
  const dragging = usePanelDrag()
  const [over, setOver] = useState<Over>(null)
  const [divider, setDivider] = useState<null | {
    path: number[]
    i: number
    orientation: 'row' | 'column'
    startPos: number
    startA: number
    startB: number
    size: number
  }>(null)

  // The shield goes up a tick after the drag starts (`lib/panelDrag.ts`, shared
  // with the nav zone and the Panels list, which drag panels too).
  const onDragEnd = useCallback(() => {
    endPanelDrag()
    setOver(null)
  }, [])

  // Same math as the other pane surfaces' dividers: a pixel delta becomes a
  // ratio delta against the two neighbours' combined ratio.
  useEffect(() => {
    if (!divider) return
    const onMove = (e: MouseEvent) => {
      if (divider.size <= 0) return
      const sum = divider.startA + divider.startB
      const delta = ((axisPos(e, divider.orientation) - divider.startPos) / divider.size) * sum
      const min = (MIN_PANE_PX / divider.size) * sum
      const a = Math.min(sum - min, Math.max(min, divider.startA + delta))
      update((s) => {
        const node = getNodeAtPath(s.tree, divider.path)
        if (node.kind !== 'split') return s
        const ratios = node.children.map((c) => c.ratio)
        ratios[divider.i] = a
        ratios[divider.i + 1] = sum - a
        return setRatios(s, divider.path, ratios)
      })
    }
    const onUp = () => setDivider(null)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('dock-resizing')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('dock-resizing')
    }
  }, [divider, update])

  const ctx: Ctx = {
    state,
    update,
    locked,
    dragging,
    over,
    setOver,
    onDragEnd,
    onDividerDown: (path, i, orientation, startPos, el) => {
      const node = getNodeAtPath(state.tree, path)
      if (node.kind !== 'split') return
      const rect = el.getBoundingClientRect()
      setDivider({
        path,
        i,
        orientation,
        startPos,
        startA: node.children[i].ratio,
        startB: node.children[i + 1].ratio,
        size: orientation === 'row' ? rect.width : rect.height,
      })
    },
  }

  if (state.tree.children.length === 0) {
    return (
      <div className="dock dock-empty">
        <p className="muted">Every panel is closed.</p>
        <div className="dock-empty-list">
          {PANEL_IDS.map((p) => (
            <button key={p} type="button" onClick={() => update((s) => revealPanel(s, p))}>
              Open {panelLabel(p)}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="dock">
      <DockSplitView node={state.tree} path={[]} ctx={ctx} />
    </div>
  )
}

/**
 * The header's layout strip: the saved layouts as a switcher, a "+" that saves
 * the current arrangement under a name, and the panels menu — every panel with
 * whether it is showing, which is how a closed one comes back.
 */
export function DockBar({
  dock,
  locked,
}: {
  dock: ReturnType<typeof useDockStore>
  locked: ReadonlySet<PanelId>
}) {
  const { store, setStore, state, update } = dock
  const [naming, setNaming] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // The per-layout menu (right-click a layout, or its ⋮ button) and the layout
  // being renamed in place.
  const [layoutMenu, setLayoutMenu] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string; invalid?: boolean } | null>(null)
  const layoutMenuRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = activeLayout(store)
  const closed = useMemo(() => closedPanels(state), [state])
  // Unsent ink pins the board in place, so the arrangement may not change
  // under it: no switching, saving or resetting while it is held.
  const frozen = locked.size > 0

  // Ink arriving while a layout menu or rename is open closes it, so nothing in
  // either can still change the arrangement under the held board (adjusted
  // during render, not in an effect).
  if (frozen && (layoutMenu !== null || renaming !== null)) {
    setLayoutMenu(null)
    setRenaming(null)
  }

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  useEffect(() => {
    if (layoutMenu === null) return
    const onDown = (e: MouseEvent) => {
      if (layoutMenuRef.current && !layoutMenuRef.current.contains(e.target as Node)) setLayoutMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLayoutMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [layoutMenu])

  const menuTarget = store.layouts.find((l) => l.id === layoutMenu) ?? null
  const menuIndex = menuTarget === null ? -1 : store.layouts.indexOf(menuTarget)
  const canRestore = missingBuiltins(store).length > 0

  return (
    <div className="dock-bar" role="group" aria-label="Saved layouts">
      <div className="dock-presets">
        {store.layouts.map((l) =>
          renaming?.id === l.id ? (
            <input
              key={l.id}
              className="dock-name-input"
              autoFocus
              value={renaming.value}
              aria-label={`Rename layout ${l.name}`}
              aria-invalid={renaming.invalid ? 'true' : undefined}
              disabled={frozen}
              onChange={(e) => setRenaming({ id: l.id, value: e.target.value })}
              onBlur={() => setRenaming(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setRenaming(null)
                if (e.key === 'Enter') {
                  // An empty or duplicate name leaves the store as it was: keep
                  // the input open, marked, rather than losing what was typed.
                  if (renameLayout(store, l.id, renaming.value) === store) {
                    setRenaming({ ...renaming, invalid: true })
                    return
                  }
                  setStore((st) => renameLayout(st, l.id, renaming.value))
                  setRenaming(null)
                }
              }}
            />
          ) : (
            <button
              key={l.id}
              type="button"
              className={`dock-preset${l.id === store.active ? ' on' : ''}`}
              aria-pressed={l.id === store.active}
              disabled={frozen}
              onClick={() => setStore((st) => selectLayout(st, l.id))}
              onContextMenu={(e) => {
                e.preventDefault()
                setLayoutMenu(l.id)
              }}
            >
              {l.name}
            </button>
          ),
        )}
        {naming === null ? (
          <button
            type="button"
            className="dock-preset dock-preset-add"
            disabled={frozen}
            aria-label="Save this arrangement as a new layout"
            title="Save this arrangement as a new layout"
            onClick={() => setNaming('')}
          >
            +
          </button>
        ) : (
          <input
            className="dock-name-input"
            autoFocus
            value={naming}
            placeholder="Layout name"
            aria-label="New layout name"
            onChange={(e) => setNaming(e.target.value)}
            onBlur={() => setNaming(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setNaming(null)
              if (e.key === 'Enter') {
                setStore((s) => saveAs(s, naming))
                setNaming(null)
              }
            }}
          />
        )}
        {current.builtin && (
          <button
            type="button"
            className="dock-preset dock-preset-aux"
            aria-label={`Reset ${current.name} to its preset`}
            disabled={frozen}
            title={`Reset ${current.name} to its preset`}
            onClick={() => setStore((st) => resetLayout(st, current.id))}
          >
            ↺
          </button>
        )}
        <div className="dock-menu" ref={layoutMenuRef}>
          <button
            type="button"
            className="dock-preset dock-preset-aux"
            aria-haspopup="menu"
            aria-expanded={layoutMenu !== null}
            aria-label={`Layout options for ${current.name}`}
            title={`Layout options for ${current.name}`}
            disabled={frozen}
            onClick={() => setLayoutMenu((m) => (m === null ? current.id : null))}
          >
            ⋮
          </button>
          {menuTarget !== null && (
            <div className="dock-menu-list dock-layout-menu" role="menu" aria-label={`Layout ${menuTarget.name}`}>
              <div className="dock-menu-heading">{menuTarget.name}</div>
              <button
                type="button"
                role="menuitem"
                disabled={frozen}
                onClick={() => {
                  setRenaming({ id: menuTarget.id, value: menuTarget.name })
                  setLayoutMenu(null)
                }}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={frozen || store.layouts.length <= 1}
                onClick={() => {
                  setStore((st) => deleteLayout(st, menuTarget.id))
                  setLayoutMenu(null)
                }}
              >
                Delete
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={frozen || menuIndex <= 0}
                onClick={() => setStore((st) => moveLayout(st, menuTarget.id, -1))}
              >
                Move left
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={frozen || menuIndex >= store.layouts.length - 1}
                onClick={() => setStore((st) => moveLayout(st, menuTarget.id, 1))}
              >
                Move right
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={frozen || !canRestore}
                onClick={() => {
                  setStore((st) => restoreDefaultLayouts(st))
                  setLayoutMenu(null)
                }}
              >
                Restore default layouts
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="dock-menu" ref={menuRef}>
        <button
          type="button"
          className="dock-preset"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={closed.length > 0 ? `${closed.length} closed` : 'Panels'}
          onClick={() => setMenuOpen((o) => !o)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="dock-menu-list" role="menu">
            {PANEL_IDS.map((p) => {
              const docked = !closed.includes(p)
              return (
                <button
                  key={p}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={docked}
                  disabled={locked.has(p) && docked}
                  onClick={() => {
                    update((s) => (docked ? closePanel(s, p) : revealPanel(s, p)))
                    setMenuOpen(false)
                  }}
                >
                  <span className="dock-menu-check">{docked ? '✓' : ''}</span>
                  {panelLabel(p)}
                  {!docked && <span className="muted"> · closed</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
