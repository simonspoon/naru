// Whether the host's ambient listening is on (naru task 2828). `LiveHub` already
// polls GET /api/live and reads `session.ambient`; it publishes that here so the
// nav's "Listening" badge follows the same poll instead of running its own.

let current = false
const listeners = new Set<() => void>()

/** Sets whether host ambient is on; notifies only on a change. */
export function setLiveAmbient(on: boolean): void {
  if (on === current) return
  current = on
  listeners.forEach((l) => l())
}

export function currentLiveAmbient(): boolean {
  return current
}

/** `useSyncExternalStore`'s subscribe: answers the unsubscribe. */
export function subscribeLiveAmbient(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
