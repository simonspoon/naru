// History search, file filters and keyboard navigation for the Git tab
// (naru task 2736, docs/git-tab.md "Search and keys"). Pure logic only; the
// components in GitView.tsx wire it to the DOM.

/** The History log filters, as typed. Blank = not filtering on it. */
export type LogFilters = {
  q: string
  author: string
  path: string
  since: string
  until: string
}

export const NO_FILTERS: LogFilters = { q: '', author: '', path: '', since: '', until: '' }

export type FilterField = keyof LogFilters

/** Trimmed copy; the server treats blank as absent, so this is what is sent. */
export function normalizeFilters(f: LogFilters): LogFilters {
  return {
    q: f.q.trim(),
    author: f.author.trim(),
    path: f.path.trim(),
    since: f.since.trim(),
    until: f.until.trim(),
  }
}

export function hasFilters(f: LogFilters): boolean {
  const n = normalizeFilters(f)
  return Object.values(n).some((v) => v !== '')
}

/** A stable string for cache/race keys. */
export function filtersKey(f: LogFilters): string {
  const n = normalizeFilters(f)
  return JSON.stringify([n.q, n.author, n.path, n.since, n.until])
}

/** The path filter the server would accept (`git::valid_log_path`): blank,
 * or relative with no `..` or empty segment, backslash or control character.
 * Until it is, the filter is not sent. */
export function validPathFilter(raw: string): boolean {
  const p = raw.trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (p === '' || p === '.') return true
  // eslint-disable-next-line no-control-regex
  if (p.startsWith('/') || p.includes('\\') || /[\x00-\x1f\x7f]/.test(p)) return false
  return p.split('/').every((seg) => seg !== '..' && seg !== '')
}

/** One removable chip per active filter, in a fixed order. */
export function filterChips(f: LogFilters): { field: FilterField; label: string }[] {
  const n = normalizeFilters(f)
  const out: { field: FilterField; label: string }[] = []
  if (n.q) out.push({ field: 'q', label: `Message: ${n.q}` })
  if (n.author) out.push({ field: 'author', label: `Author: ${n.author}` })
  if (n.path) out.push({ field: 'path', label: `Path: ${n.path}` })
  if (n.since) out.push({ field: 'since', label: `Since ${n.since}` })
  if (n.until) out.push({ field: 'until', label: `Until ${n.until}` })
  return out
}

/** What the result line says under an active filter. */
export function resultLabel(count: number, hasMore: boolean, timedOut: boolean): string {
  if (timedOut) {
    return `Search stopped after 10 s: ${count} found so far. Narrow the filters to see the rest.`
  }
  const noun = count === 1 && !hasMore ? 'commit' : 'commits'
  return `${count}${hasMore ? '+' : ''} ${noun}`
}

/** A full or abbreviated commit id (7-64 hex), as the server accepts it. */
export function isShaLike(s: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(s.trim())
}

/** Loaded commit whose hash starts with `sha` (case-insensitive), if exactly one does. */
export function findByShaPrefix<T extends { hash: string }>(items: T[], sha: string): T | null {
  const p = sha.trim().toLowerCase()
  const hits = items.filter((c) => c.hash.toLowerCase().startsWith(p))
  return hits.length === 1 ? hits[0] : null
}

/** Client-side file filter: case-insensitive substring of the path (or the
 * rename source). Blank keeps everything. */
export function filterByPath<T extends { path: string; orig_path: string | null }>(
  files: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (q === '') return files
  return files.filter(
    (f) =>
      f.path.toLowerCase().includes(q) ||
      (f.orig_path !== null && f.orig_path.toLowerCase().includes(q)),
  )
}

/** What a bare key does inside the Git tab; null = not ours. */
export type GitKeyAction = 'down' | 'up' | 'back' | 'search' | 'prevFile' | 'nextFile' | 'help'

export function gitKeyAction(key: string): GitKeyAction | null {
  switch (key) {
    case 'ArrowDown':
    case 'j':
      return 'down'
    case 'ArrowUp':
    case 'k':
      return 'up'
    case 'Escape':
    case 'ArrowLeft':
      return 'back'
    case '/':
      return 'search'
    case '[':
      return 'prevFile'
    case ']':
      return 'nextFile'
    case '?':
      return 'help'
    default:
      return null
  }
}

/** Index after one step in a list of `n`, clamped at the ends. From -1
 * (nothing focused or selected) a step down lands on the first, up on the last;
 * -1 when the list is empty. Used for j/k and for `[` / `]`. */
export function stepIndex(current: number, n: number, dir: 1 | -1): number {
  if (n === 0) return -1
  if (current < 0) return dir === 1 ? 0 : n - 1
  return Math.min(n - 1, Math.max(0, current + dir))
}

/** The key list the "?" popover shows. */
export const GIT_KEYS: [string, string][] = [
  ['↑ ↓  or  k j', 'Move through the focused list (scrolls a focused diff)'],
  ['Enter', 'Open the focused commit or file'],
  ['Esc  or  ←', 'Back a level'],
  ['/', 'Search'],
  ['[  ]', 'Previous / next changed file'],
  ['?', 'Show or hide these keys'],
  ['Refs panel: / Esc', 'In the Refs panel: / filters branches, Esc returns to the content (closes the drawer)'],
  ['Refs panel: Enter', 'Pick the focused worktree, branch or stash (a branch scopes History, a stash opens)'],
]
