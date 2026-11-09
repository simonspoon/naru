import type { LiveIndicator } from './liveIndicator'

// The live conversation's mark inputs, published by `LiveHub` (the only place
// they exist) for the agent watcher's centre orb (naru task 2632), the way
// `navMark.ts` shares the nav mark switch. null = this browser is not in a
// live conversation, so the watcher falls back to the server's poll.

export interface LiveMarkFeed {
  state: LiveIndicator | null
  level: number
  speechRms: () => number | null
  offer: boolean
}

let current: LiveMarkFeed | null = null
const listeners = new Set<() => void>()

/** Publishes the feed; notifies only when a field changed. */
export function setLiveMarkFeed(next: LiveMarkFeed | null): void {
  const same =
    next === current ||
    (next !== null &&
      current !== null &&
      next.state === current.state &&
      next.level === current.level &&
      next.speechRms === current.speechRms &&
      next.offer === current.offer)
  if (same) return
  current = next
  listeners.forEach((l) => l())
}

export function currentLiveMarkFeed(): LiveMarkFeed | null {
  return current
}

/** `useSyncExternalStore`'s subscribe: answers the unsubscribe. */
export function subscribeLiveMarkFeed(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
