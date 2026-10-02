import type { PanelId } from '../dockLayout'

// --- Stable per-panel host containers (mesa task 1567) -----------------
//
// `ptyPool.ts`'s mechanism, for the dock's panels. A panel's content renders
// ONCE, by a `createPortal` into the container made here, and a `DockSlot`
// (components/DockSlot.tsx) just moves that container into whichever group
// currently shows the panel. Re-docking a panel therefore relocates a DOM node
// and never remounts React state — which is load-bearing: the conversation's
// microphone, audio element and session state live in LiveHub, and Agents and
// Terminal hold live PTY sockets, none of which may restart because the person
// dragged a tab.
//
// A panel with no slot (closed, or a background tab) is parked in a hidden div
// rather than detached, so its content keeps a parent either way.

// `rail-orb` is not a panel: it is the second view of the orb the collapsed
// nav's rail shows (mesa task 1574), hosted the same way.
export type HostId = PanelId | 'rail-orb'

const hosts = new Map<HostId, HTMLDivElement>()
let parkEl: HTMLDivElement | null = null

function park(): HTMLDivElement {
  if (parkEl === null) {
    parkEl = document.createElement('div')
    parkEl.className = 'dock-park'
    parkEl.hidden = true
    document.body.appendChild(parkEl)
  }
  return parkEl
}

/** The panel's container: created on first ask, never replaced. */
export function hostFor(id: HostId): HTMLDivElement {
  let el = hosts.get(id)
  if (el === undefined) {
    el = document.createElement('div')
    el.className = `dock-host dock-host-${id}`
    el.dataset.panel = id
    hosts.set(id, el)
    park().appendChild(el)
  }
  return el
}

// Reparenting resets a scroll offset and drops focus, so both are carried
// across the move: the chat transcript must not jump to the top when the chat
// changes group, and a caret in the capture box must survive it.
function move(el: HTMLDivElement, to: HTMLElement): void {
  if (el.parentNode === to) return
  const active = document.activeElement
  const hadFocus = active !== null && el.contains(active)
  const scrolled: [Element, number, number][] = []
  for (const d of el.querySelectorAll('*')) {
    if (d.scrollTop !== 0 || d.scrollLeft !== 0) scrolled.push([d, d.scrollTop, d.scrollLeft])
  }
  to.appendChild(el)
  for (const [d, top, left] of scrolled) {
    d.scrollTop = top
    d.scrollLeft = left
  }
  if (hadFocus && active instanceof HTMLElement && document.activeElement !== active) active.focus()
}

export function attach(id: HostId, slot: HTMLElement): void {
  move(hostFor(id), slot)
}

/** Parks the container, but only if `slot` still holds it: a panel that moved
 *  to another slot in the same commit has already been attached there. */
export function release(id: HostId, slot: HTMLElement): void {
  const el = hostFor(id)
  if (el.parentNode === slot) move(el, park())
}
