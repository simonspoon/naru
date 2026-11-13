// The projects the person last opened, newest first, for the header's project
// switcher. A per-browser preference like `mainCollapse.ts`: localStorage, no
// column, no route. Reads are total — a hand-edited or stale value is simply
// an empty / shorter list.

const KEY = 'naru-recent-projects'
const MAX_STORED = 12

export function loadRecent(): number[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is number => Number.isInteger(v) && v > 0)
  } catch {
    return []
  }
}

/** Records `id` as the most recent project. */
export function recordRecent(id: number): void {
  const next = [id, ...loadRecent().filter((v) => v !== id)].slice(0, MAX_STORED)
  localStorage.setItem(KEY, JSON.stringify(next))
}

/**
 * The switcher's rows: up to `limit` remembered projects that still exist, in
 * recency order; with none remembered (or none left), the first `limit`
 * projects in server order instead.
 */
export function recentProjects<T extends { id: number }>(
  projects: T[],
  recent: number[],
  limit = 5,
): T[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const rows: T[] = []
  for (const id of recent) {
    const p = byId.get(id)
    if (p && !rows.includes(p)) rows.push(p)
    if (rows.length === limit) break
  }
  return rows.length > 0 ? rows : projects.slice(0, limit)
}
