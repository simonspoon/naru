// Pure logic for the knowledge base page (naru task 1928, reworked in 1942):
// the `#/kb/<path>` address of one note and the route that names it. No
// React, so it is unit-tested (kbFilter.test.ts).

/** The note path a `#/kb/<path>` route names, or null for `#/kb` / non-kb. */
export function kbPathFromRoute(path: string): string | null {
  const m = /^\/kb\/(.+)$/.exec(path)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}

/** The hash address of a note (the inverse of `kbPathFromRoute`). */
export function kbNoteHref(path: string): string {
  return `#/kb/${path.split('/').map(encodeURIComponent).join('/')}`
}
