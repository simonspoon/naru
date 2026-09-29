// Whether the main panel (the routed page + terminal) is folded to a slim
// rail (mesa task 1485), so the live conversation and the agents panel can
// have the row. A per-browser preference like `navCollapse.ts`: localStorage,
// no column, no route. Anything stored other than the literal "1" reads as
// "not collapsed", so a hand-edited or stale key can never hide the page.

const KEY = 'mesa-main-collapsed'

export function loadMainCollapsed(): boolean {
  return localStorage.getItem(KEY) === '1'
}

export function saveMainCollapsed(collapsed: boolean): void {
  if (collapsed) localStorage.setItem(KEY, '1')
  else localStorage.removeItem(KEY)
}

/** `main`'s floor for the neighbours' width clamps: with the main panel
 *  folded there is no page to protect, so the other panels may take the row. */
export function mainFloor(collapsed: boolean, floor: number): number {
  return collapsed ? 0 : floor
}

/** True when a click landed on a left-nav link — the gesture that brings a
 *  folded main panel back (the nav is how you choose what main shows). */
export function isNavLinkClick(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('nav.sidebar a') !== null
}

/** Whether the shell is folded right now, read off the layout — the two
 *  width clamps run inside drag/observer callbacks that have no App state. */
export function mainIsCollapsed(): boolean {
  return document.querySelector('.shell-body.main-collapsed') !== null
}
