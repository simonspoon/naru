// Pure logic for the Files tab's directory watch (naru task 1873): the NDJSON
// line contract of `GET /api/projects/{id}/files/watch`, which listings a
// change must refetch, and the reconnect back-off. No DOM, no fetch.

export type FilesWatchEvent =
  | { type: 'ready' }
  | { type: 'ping' }
  /** `dirs` are project-relative directory paths ("" = the root); `null` means
   * "something changed, unknown where" — refetch everything held. */
  | { type: 'change'; dirs: string[] | null }

/** One stream line as an event, or `null` for anything malformed or of an
 * unknown type. Never throws. */
export function parseWatchLine(line: string): FilesWatchEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as { type?: unknown; dirs?: unknown }
  if (v.type === 'ready') return { type: 'ready' }
  if (v.type === 'ping') return { type: 'ping' }
  if (v.type === 'change') {
    if (v.dirs === null || v.dirs === undefined) return { type: 'change', dirs: null }
    if (Array.isArray(v.dirs) && v.dirs.every((d) => typeof d === 'string')) {
      return { type: 'change', dirs: v.dirs as string[] }
    }
  }
  return null
}

/**
 * Which listings a change event should refetch. `loaded` is every directory
 * path the tree holds a cache entry for — whatever the caller passes is taken
 * as loaded (an entry still loading or in error is the caller's call to
 * include). A changed directory that is not loaded is collapsed and will load
 * lazily on expand, so it is not fetched.
 */
export function levelsToRefetch(
  dirs: string[] | null,
  loaded: Iterable<string>,
): { root: boolean; dirs: string[] } {
  const held = [...loaded].filter((d) => d !== '')
  if (dirs === null) return { root: true, dirs: held }
  const changed = new Set(dirs)
  return { root: changed.has(''), dirs: held.filter((d) => changed.has(d)) }
}

/** Delay before re-opening the stream after attempt `attempt` (0-based):
 * 1s doubling, capped at 30s. */
export function reconnectDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  return Math.min(30000, 1000 * 2 ** Math.min(n, 10))
}
