// Which tab of the Library page a hash route is on (mesa task 1676). The page
// is three tabs — the Claude Code items (the old page), the Scripts that used
// to be their own page, and a read-only list of every project's workflows —
// each on its own `#/library/…` segment so a tab is bookmarkable and
// Back-stable, as Settings' tabs are (`settingsTab.ts`). Pure: no DOM, no
// React — the page and the strip's hrefs both come from here.

export type LibraryTab = 'claude-code' | 'scripts' | 'workflows'

export const LIBRARY_TABS: readonly LibraryTab[] = ['claude-code', 'scripts', 'workflows']

const LABELS: Record<LibraryTab, string> = {
  'claude-code': 'Claude Code',
  scripts: 'Scripts',
  workflows: 'Workflows',
}

export function libraryTabLabel(tab: LibraryTab): string {
  return LABELS[tab]
}

/** The route a tab lives on. `claude-code` emits the bare `#/library`, the
 *  link every existing reference to the page already has. */
export function libraryTabHref(tab: LibraryTab): string {
  return tab === 'claude-code' ? '#/library' : `#/library/${tab}`
}

/** The hash of one detached script run (docs/scripts.md): a sub-view of the
 *  Scripts tab, addressed so a reload lands on the same run screen. */
export function libraryRunHref(runId: number): string {
  return `#/library/scripts/runs/${runId}`
}

export type LibraryRoute = { tab: LibraryTab; runId: number | null }

/** The route a `/library…` path is on, or `null` if it is not the Library's.
 *  An unknown segment is a stale link and lands on the first tab; the segment
 *  is matched case-insensitively, as a hand-typed hash produces it. */
export function libraryRouteFromPath(path: string): LibraryRoute | null {
  const run = /^\/library\/scripts\/runs\/(\d+)$/.exec(path)
  if (run) return { tab: 'scripts', runId: Number(run[1]) }
  const m = /^\/library(?:\/([^/]+))?$/.exec(path)
  if (!m) return null
  const seg = m[1]?.toLowerCase()
  const tab =
    seg !== undefined && (LIBRARY_TABS as readonly string[]).includes(seg)
      ? (seg as LibraryTab)
      : 'claude-code'
  return { tab, runId: null }
}

/** Where the retired Scripts page's addresses now live: `#/scripts` is the
 *  Scripts tab and `#/scripts/runs/<id>` the same run inside it. `null` for any
 *  other path. */
export function legacyScriptsRedirect(path: string): string | null {
  const m = /^\/scripts(?:\/runs\/(\d+))?$/.exec(path)
  if (!m) return null
  return m[1] ? libraryRunHref(Number(m[1])) : libraryTabHref('scripts')
}
