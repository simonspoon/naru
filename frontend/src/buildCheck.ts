/**
 * Is this page older than the server it talks to? (naru task 2656)
 *
 * The page records the commit `GET /api/version` reported when it loaded
 * (naru task 2655) and re-reads it on window focus and visibility (`App`),
 * and whenever `LiveHub` sees its stream come back — the control socket
 * reopening, or the live poll recovering from an error — which is what a
 * rebuilt and restarted server looks like from here. No polling loop of its
 * own. A different commit shows the "Naru updated" banner; the page never
 * reloads by itself.
 *
 * Two small channels, the `liveContext.ts` pattern, because the triggers live
 * in `LiveHub` (header) while the version fetch and the banner live in `App`,
 * and the verdict has to reach `LiveHub`'s view line so `naru live status`
 * can tell the agent whether "tap reload" applies.
 */

/** Stale iff both commits are known and differ. `unknown` (a build without
 *  git) never counts, nor does a version not fetched yet. */
export function staleBuild(loaded: string | null, now: string | null): boolean {
  if (loaded === null || now === null) return false
  if (loaded === 'unknown' || now === 'unknown') return false
  return loaded !== now
}

// ---- "check now" (LiveHub → App) ----

const checkListeners = new Set<() => void>()

/** Ask for `/api/version` to be re-read: the stream just reconnected. */
export function requestBuildCheck(): void {
  for (const fn of checkListeners) fn()
}

export function subscribeBuildCheck(fn: () => void): () => void {
  checkListeners.add(fn)
  return () => {
    checkListeners.delete(fn)
  }
}

// ---- the verdict (App → LiveHub) ----

let stale = false
const staleListeners = new Set<() => void>()

export function publishStale(next: boolean): void {
  if (next === stale) return
  stale = next
  for (const fn of staleListeners) fn()
}

export function pageStale(): boolean {
  return stale
}

export function subscribeStale(fn: () => void): () => void {
  staleListeners.add(fn)
  return () => {
    staleListeners.delete(fn)
  }
}
