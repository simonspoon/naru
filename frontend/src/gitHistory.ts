// The pure half of the Git tab's History view (naru task 2735): page merging,
// ref ordering and labels, per-file stat totals, and the SVG geometry of one
// graph row. No DOM, no React — covered by `gitHistory.test.ts`. The lane
// layout itself lives in `gitGraph.ts`.
import type { GraphEdge } from './gitGraph'
import type { GitCommitFile } from './types/GitCommitFile'
import type { GitRef } from './types/GitRef'

/** Commits per server page (mirrors the server; only used to tell "one page loaded"). */
export const PAGE_SIZE = 100

/** Pages loaded at most while hunting for a not-yet-loaded parent. */
export const PARENT_HUNT_PAGES = 3

/**
 * Append a page to the loaded commits, dropping hashes already present (a
 * commit landing between two page fetches shifts the offset and repeats one).
 * Returns the same array when nothing was new.
 */
export function mergePage<T extends { hash: string }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((c) => c.hash))
  const fresh: T[] = []
  for (const c of incoming) {
    if (seen.has(c.hash)) continue
    seen.add(c.hash)
    fresh.push(c)
  }
  return fresh.length === 0 ? existing : existing.concat(fresh)
}

/**
 * A window-focus refresh replaces the first page in place. That is only safe
 * (cheap, and it cannot throw pages 2+ away) while exactly one page is loaded.
 */
export function focusRefreshable(pagesLoaded: number): boolean {
  return pagesLoaded === 1
}

const KIND_ORDER: Record<GitRef['kind'], number> = {
  head: 0,
  branch: 1,
  remote: 2,
  tag: 3,
  other: 4,
}

/** HEAD / current branch first, then local branches, remotes, tags, others
 * (stable within a kind). */
export function orderRefs(refs: GitRef[]): GitRef[] {
  return refs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (a.r.is_head !== b.r.is_head) return a.r.is_head ? -1 : 1
      const k = KIND_ORDER[a.r.kind] - KIND_ORDER[b.r.kind]
      return k !== 0 ? k : a.i - b.i
    })
    .map((x) => x.r)
}

/** Visible text of one ref badge. */
export function refText(ref: GitRef): string {
  if (ref.kind === 'head') return 'HEAD (detached)'
  if (ref.is_head) return `HEAD → ${ref.name}`
  if (ref.kind === 'tag') return `◇ ${ref.name}`
  return ref.name
}

/** CSS modifier for one ref badge (`git-ref-<this>`). */
export function refClass(ref: GitRef): string {
  if (ref.kind === 'head') return 'detached'
  if (ref.is_head) return 'head'
  return ref.kind
}

/** Sum of per-file counts; `binary` counts files whose numbers are unknown. */
export function statTotals(files: GitCommitFile[]): {
  files: number
  added: number
  deleted: number
  binary: number
} {
  let added = 0
  let deleted = 0
  let binary = 0
  for (const f of files) {
    if (f.added === null || f.deleted === null) binary++
    else {
      added += f.added
      deleted += f.deleted
    }
  }
  return { files: files.length, added, deleted, binary }
}

/** "3 files, +10 −2" (", 1 binary" appended when any). */
export function totalsLabel(t: ReturnType<typeof statTotals>): string {
  const base = `${t.files} ${t.files === 1 ? 'file' : 'files'}, +${t.added} −${t.deleted}`
  return t.binary > 0 ? `${base}, ${t.binary} binary` : base
}

/** Subject for display: a blank subject is shown as a muted placeholder. */
export function subjectOrPlaceholder(subject: string): { text: string; empty: boolean } {
  return subject.trim() === ''
    ? { text: '(no message)', empty: true }
    : { text: subject, empty: false }
}

/** Screen-reader label of one commit row. */
export function rowLabel(c: {
  subject: string
  author: string
  short_hash: string
  parents: string[]
  refs: GitRef[]
}, when: string): string {
  const parts = [subjectOrPlaceholder(c.subject).text, c.author, when, c.short_hash]
  if (c.parents.length > 1) parts.push('merge commit')
  if (c.refs.length > 0) parts.push(`refs: ${c.refs.map((r) => r.name).join(', ')}`)
  return parts.join(', ')
}

export const COL_W = 14
export const NODE_R = 4

/** x of lane `col`'s centre line. */
export const laneX = (col: number): number => COL_W / 2 + COL_W * col

/** Width of a graph cell `lanes` columns wide. */
export const graphWidth = (lanes: number): number => lanes * COL_W + 6

/** SVG path data for one edge in a row of height `h` (see gitGraph.ts header). */
export function edgePath(e: GraphEdge, h: number): string {
  const xf = laneX(e.from)
  const xt = laneX(e.to)
  const mid = h / 2
  if (e.kind === 'through') return `M${xf} 0V${h}`
  if (e.kind === 'in') {
    if (xf === xt) return `M${xf} 0V${mid}`
    return `M${xf} 0C${xf} ${mid * 0.6} ${xt} ${mid * 0.4} ${xt} ${mid}`
  }
  if (xf === xt) return `M${xf} ${mid}V${h}`
  return `M${xf} ${mid}C${xf} ${mid + mid * 0.6} ${xt} ${mid + mid * 0.4} ${xt} ${h}`
}
