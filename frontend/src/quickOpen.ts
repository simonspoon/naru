// The Files tab's Cmd/Ctrl+P "Go to file" box (naru task 2744): ranking a
// project's file paths against what was typed, and the recently-opened list an
// empty query shows. Pure apart from the two small localStorage helpers at the
// bottom, so the ordering rules are tested here rather than through khora.
//
// Filtering is client-side over one capped list (`GET /files/names`, see
// `core::files::list_file_names`): the server's cost is the walk, which is the
// same whatever is typed, so a request per keystroke would repeat it per
// keystroke, while ranking 50,000 short strings in memory takes milliseconds.

/** The most rows the box renders for one query. */
export const MAX_QUICK_OPEN_RESULTS = 100

/** The most recently-opened paths remembered per project. */
export const MAX_RECENT_FILES = 20

/** How well a path matched, best first: the query is the whole file name, the
 *  start of it, scattered through it in order, or scattered through the whole
 *  path in order. */
export type MatchTier = 0 | 1 | 2 | 3

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** True when every character of `needle` appears in `hay` in order. */
function isSubsequence(needle: string, hay: string): boolean {
  let j = 0
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) j++
  }
  return j === needle.length
}

/** What is actually matched: the query without whitespace (a space typed
 *  between a folder and a name means nothing to a path), and whether to fold
 *  case — not when the query holds an uppercase letter, the smart-case rule. */
function normalize(query: string): { needle: string; fold: boolean } {
  const stripped = query.replace(/\s+/g, '')
  const fold = stripped === stripped.toLowerCase()
  return { needle: stripped, fold }
}

/** The tier `path` matches `query` at, or `null` for no match. An empty query
 *  matches nothing here; the empty box is `emptyQueryPaths`'s job. */
export function matchTier(query: string, path: string): MatchTier | null {
  const { needle, fold } = normalize(query)
  if (needle === '') return null
  return tierOf(needle, fold ? path.toLowerCase() : path)
}

function tierOf(needle: string, hay: string): MatchTier | null {
  const base = basenameOf(hay)
  if (base === needle) return 0
  if (base.startsWith(needle)) return 1
  if (isSubsequence(needle, base)) return 2
  if (isSubsequence(needle, hay)) return 3
  return null
}

/**
 * The paths matching `query`, best first, at most `limit` of them.
 *
 * Exact file name > file-name prefix > file-name subsequence > path
 * subsequence; within a tier the shorter path wins (`src/a.ts` before
 * `src/deep/a.ts`), then plain string order so the result is stable.
 */
export function rankPaths(
  query: string,
  paths: readonly string[],
  limit = MAX_QUICK_OPEN_RESULTS,
): string[] {
  const { needle, fold } = normalize(query)
  if (needle === '') return []
  const hits: { path: string; tier: MatchTier }[] = []
  for (const path of paths) {
    const tier = tierOf(needle, fold ? path.toLowerCase() : path)
    if (tier !== null) hits.push({ path, tier })
  }
  hits.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )
  return hits.slice(0, limit).map((h) => h.path)
}

/** `path` moved to the front of the most-recently-opened list, capped. */
export function recordRecent(
  recent: readonly string[],
  path: string,
  max = MAX_RECENT_FILES,
): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, max)
}

/**
 * What the box lists before anything is typed: the recently opened files, most
 * recent first, then any other open tab, then the rest of the project in walk
 * order, at most `limit` in all.
 *
 * A remembered path that is neither open nor in a complete listing has been
 * deleted or moved, and drops out. A truncated listing proves nothing about a
 * path it does not hold, so then every remembered one stays.
 */
export function emptyQueryPaths(
  paths: readonly string[],
  truncated: boolean,
  open: readonly string[],
  recent: readonly string[],
  limit = MAX_QUICK_OPEN_RESULTS,
): string[] {
  const listed = new Set(paths)
  const openSet = new Set(open)
  const out: string[] = []
  const seen = new Set<string>()
  const add = (p: string) => {
    if (out.length >= limit || seen.has(p)) return
    seen.add(p)
    out.push(p)
  }
  for (const p of recent) if (truncated || openSet.has(p) || listed.has(p)) add(p)
  for (const p of open) add(p)
  for (const p of paths) {
    if (out.length >= limit) break
    add(p)
  }
  return out
}

const RECENT_KEY = 'naru-recent-files'

/** This project's recently opened paths; anything malformed reads as none. */
export function loadRecentFiles(projectId: number): string[] {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}')
    const list = (all as Record<string, unknown> | null)?.[String(projectId)]
    return Array.isArray(list)
      ? list.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT_FILES)
      : []
  } catch {
    return []
  }
}

export function saveRecentFiles(projectId: number, recent: readonly string[]): void {
  let all: unknown
  try {
    all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}')
  } catch {
    all = {}
  }
  if (all === null || typeof all !== 'object' || Array.isArray(all)) all = {}
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify({ ...(all as Record<string, unknown>), [projectId]: recent }),
    )
  } catch {
    // Storage full or blocked: the list is a convenience, not data.
  }
}
