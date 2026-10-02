import { useSyncExternalStore } from 'react'
import type { DragEvent } from 'react'
import { PANEL_DRAG_MIME, panelLabel, type PanelId } from '../dockLayout'

// Which panel is being dragged right now (mesa task 1574). A panel is dragged
// from a dock tab, the nav zone or the nav's Panels list, and dropped on a dock
// group or the nav zone — surfaces in different components — so the one fact
// they share, "a panel drag is in flight", lives here rather than in any of them.

let current: PanelId | null = null
let timer: number | null = null
const listeners = new Set<() => void>()

function set(p: PanelId | null): void {
  if (current === p) return
  current = p
  for (const l of listeners) l()
}

/** `dragstart` handler body: writes the payload and, a tick later, raises the
 *  shield (mounting it inside `dragstart` makes some browsers cancel the drag). */
export function beginPanelDrag(e: DragEvent, p: PanelId): void {
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData(PANEL_DRAG_MIME, p)
  // Some browsers cancel a drag that carries no `text/plain`.
  e.dataTransfer.setData('text/plain', panelLabel(p))
  timer = window.setTimeout(() => set(p), 0)
}

/** `dragend`/`drop`: a drag that ends inside that tick must not raise the shield after. */
export function endPanelDrag(): void {
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  set(null)
}

/** The panel being dragged, or null (the shield is up exactly while this is set). */
export function currentPanelDrag(): PanelId | null {
  return current
}

export function usePanelDrag(): PanelId | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}
