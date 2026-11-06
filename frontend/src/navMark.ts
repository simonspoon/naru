// Whether the expanded nav shows its corner mark (naru task 2607). Saved in
// the config's `appearance` section (`nav-mark`, `docs/config.md`) like the
// theme and the mark skin, and mirrored to localStorage — as the theme is — so
// a reload with the mark off never mounts it (and its animation loop) before
// the config answers. On is the default: only the exact stored `'off'` hides it.

const KEY = 'naru-nav-mark'

let current = localStorage.getItem(KEY) !== 'off'
const listeners = new Set<() => void>()

/** Sets whether the nav mark shows; mirrors it and notifies only on a change. */
export function setNavMark(on: boolean): void {
  localStorage.setItem(KEY, on ? 'on' : 'off')
  if (on === current) return
  current = on
  listeners.forEach((l) => l())
}

export function currentNavMark(): boolean {
  return current
}

/** `useSyncExternalStore`'s subscribe: answers the unsubscribe. */
export function subscribeNavMark(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
