// The pure half of the Git tab's side panel (naru task 2737, docs/git-tab.md
// "Side panel"): worktree ordering and labels, branch grouping / filtering /
// capping, ahead-behind text and tooltips. No DOM, no React: covered by
// `gitPanel.test.ts`. Every string here comes from the repo and is only ever
// rendered as a text node.
import { relativeTime } from './gitGraph'
import type { GitBranch } from './types/GitBranch'
import type { GitStash } from './types/GitStash'
import type { GitWorktree } from './types/GitWorktree'
import type { GitWorktreeDetail } from './types/GitWorktreeDetail'

/** Rows shown per group before "Show more", and how many each click adds. */
export const GROUP_CAP = 50
export const GROUP_STEP = 100

/** A branch picked in the panel: the History log is scoped to it. The kind
 * keeps `origin/main` (remote) apart from a local branch named the same. */
export type BranchScope = { name: string; kind: 'local' | 'remote' }

export const SIDE_OPEN_KEY = 'naru-git-side'
export const SIDE_SECTIONS_KEY = 'naru-git-side-sections'

export type SectionId = 'worktrees' | 'branches' | 'stashes'
export const SECTION_IDS: SectionId[] = ['worktrees', 'branches', 'stashes']

/** The inline panel's remembered open flag; open unless it says "false". */
export function parseSideOpen(raw: string | null): boolean {
  return raw !== 'false'
}

/** Remembered per-section open flags; every section defaults to open. */
export function parseSections(raw: string | null): Record<SectionId, boolean> {
  const out: Record<SectionId, boolean> = { worktrees: true, branches: true, stashes: true }
  if (raw === null) return out
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v === 'object' && v !== null) {
      for (const id of SECTION_IDS) {
        const f = (v as Record<string, unknown>)[id]
        if (typeof f === 'boolean') out[id] = f
      }
    }
  } catch {
    // a corrupt value is the default
  }
  return out
}

export const exactTime = (iso: string): string =>
  Number.isNaN(Date.parse(iso)) ? iso : new Date(iso).toLocaleString()

// ---- worktrees ----

/** The main checkout first, the rest in git's order. */
export function orderWorktrees(ws: GitWorktree[]): GitWorktree[] {
  return [...ws.filter((w) => w.is_main), ...ws.filter((w) => !w.is_main)]
}

/** The last two path segments as `…/a/b` (shorter paths verbatim). */
export function shortFolder(path: string): string {
  const segs = path.split('/').filter((s) => s !== '')
  if (segs.length <= 2) return path
  return `…/${segs.slice(-2).join('/')}`
}

/** A bare or prunable worktree has nothing to look at. */
export function worktreeSelectable(w: GitWorktree): boolean {
  return !w.bare && !w.prunable
}

/** Branch name, or the first 8 chars of HEAD when detached. */
export function worktreeLabel(w: GitWorktree): string {
  return w.branch ?? w.head.slice(0, 8)
}

/** Path of the highlighted worktree: the picked one, else `is_current`. */
export function activeWorktreePath(ws: GitWorktree[], selected: string | null): string | null {
  if (selected !== null) return selected
  return ws.find((w) => w.is_current)?.path ?? null
}

/** Why a row is disabled, or null when it can be picked. */
export function disabledReason(w: GitWorktree): string | null {
  if (w.bare) return 'Bare repository: it has no working tree to show'
  if (w.prunable) {
    return `Prunable: its folder is gone${w.prunable_reason ? ` (${w.prunable_reason})` : ''}`
  }
  return null
}

export function detailsByPath(details: GitWorktreeDetail[] | null): Map<string, GitWorktreeDetail> {
  return new Map((details ?? []).map((d) => [d.path, d]))
}

/** "3 changed", "clean" at 0, null when unknown. */
export function changedText(n: number | null): string | null {
  if (n === null) return null
  return n === 0 ? 'clean' : `${n} changed`
}

/** The visible halves of an ahead/behind pair: a zero or unknown half is
 * hidden, so 0/0 and nulls show nothing. */
export function aheadBehind(
  ahead: number | null,
  behind: number | null,
): { ahead: string | null; behind: string | null } {
  return {
    ahead: ahead !== null && ahead > 0 ? `↑${ahead}` : null,
    behind: behind !== null && behind > 0 ? `↓${behind}` : null,
  }
}

function aheadBehindWords(ahead: number | null, behind: number | null, against: string): string | null {
  if (ahead === null || behind === null) return null
  if (ahead === 0 && behind === 0) return `Even with ${against}`
  return `${ahead} ahead, ${behind} behind ${against}`
}

export function worktreeTitle(
  w: GitWorktree,
  d: GitWorktreeDetail | undefined,
  base: string | null,
): string {
  const lines = [w.path]
  if (w.detached) lines.push(`Detached HEAD at ${w.head.slice(0, 8)}`)
  const reason = disabledReason(w)
  if (reason) lines.push(reason)
  if (w.locked) lines.push(`Locked${w.lock_reason ? `: ${w.lock_reason}` : ''}`)
  if (d) {
    const ab = aheadBehindWords(d.ahead, d.behind, base ?? 'the main checkout')
    if (ab) lines.push(ab)
    if (d.subject) lines.push(d.subject)
    if (d.date) lines.push(exactTime(d.date))
  }
  return lines.join('\n')
}

// ---- branches ----

export type BranchGroup = {
  /** Stable key: `local:<prefix>` or `remote:<remote>`. */
  key: string
  label: string
  remote: boolean
  branches: GitBranch[]
}

/** Name shown inside its group: the group prefix is stripped. */
export function groupedName(b: GitBranch): string {
  if (b.kind === 'remote') {
    const r = b.remote ?? b.name.split('/')[0]
    return b.name.startsWith(`${r}/`) ? b.name.slice(r.length + 1) : b.name
  }
  const i = b.name.indexOf('/')
  return i > 0 ? b.name.slice(i + 1) : b.name
}

/** Local branches without a `/` first, then one group per first `/` segment,
 * then one group per remote (collapsed by default in the UI). */
export function groupBranches(branches: GitBranch[]): {
  ungrouped: GitBranch[]
  groups: BranchGroup[]
} {
  const ungrouped: GitBranch[] = []
  const local = new Map<string, BranchGroup>()
  const remotes = new Map<string, BranchGroup>()
  for (const b of branches) {
    if (b.kind === 'remote') {
      const r = b.remote ?? b.name.split('/')[0]
      let g = remotes.get(r)
      if (!g) {
        g = { key: `remote:${r}`, label: r, remote: true, branches: [] }
        remotes.set(r, g)
      }
      g.branches.push(b)
      continue
    }
    const i = b.name.indexOf('/')
    if (i <= 0) {
      ungrouped.push(b)
      continue
    }
    const p = b.name.slice(0, i)
    let g = local.get(p)
    if (!g) {
      g = { key: `local:${p}`, label: p, remote: false, branches: [] }
      local.set(p, g)
    }
    g.branches.push(b)
  }
  return { ungrouped, groups: [...local.values(), ...remotes.values()] }
}

/** Case-insensitive substring over every branch name; blank keeps all. */
export function filterBranches(branches: GitBranch[], query: string): GitBranch[] {
  const q = query.trim().toLowerCase()
  if (q === '') return branches
  return branches.filter((b) => b.name.toLowerCase().includes(q))
}

/** "N of M" under an active filter, else null. */
export function filterCountLabel(query: string, matched: number, total: number): string | null {
  return query.trim() === '' ? null : `${matched} of ${total}`
}

/** A group is open while filtering (matches auto-expand), else by its own
 * remembered state, else open for local groups and closed for remotes. */
export function groupOpen(
  g: BranchGroup,
  filtering: boolean,
  state: Record<string, boolean>,
): boolean {
  if (filtering) return true
  return state[g.key] ?? !g.remote
}

/** Rows shown after `clicks` presses of "Show more". */
export function shownCount(total: number, clicks: number): number {
  return Math.min(total, GROUP_CAP + GROUP_STEP * clicks)
}

/** How many one more press reveals; 0 when everything is shown. */
export function moreCount(total: number, clicks: number): number {
  return Math.min(GROUP_STEP, total - shownCount(total, clicks))
}

export function branchTrackText(b: GitBranch): { gone: boolean; ahead: string | null; behind: string | null } {
  if (b.upstream_gone) return { gone: true, ahead: null, behind: null }
  return { gone: false, ...aheadBehind(b.ahead, b.behind) }
}

export type BranchBadges = { current: boolean; inWorktree: string | null; merged: boolean }

/** `inWorktree` is the path of another worktree that has it checked out. */
export function branchBadges(b: GitBranch, activePath: string | null): BranchBadges {
  return {
    current: b.is_head,
    inWorktree: b.worktree !== null && b.worktree !== activePath && !b.is_head ? b.worktree : null,
    merged: b.merged === true && !b.is_head,
  }
}

export function branchTitle(b: GitBranch): string {
  const lines = [b.name]
  if (b.upstream) lines.push(`Upstream: ${b.upstream}${b.upstream_gone ? ' (gone)' : ''}`)
  const ab = b.upstream && !b.upstream_gone ? aheadBehindWords(b.ahead, b.behind, b.upstream) : null
  if (ab) lines.push(ab)
  if (b.subject) lines.push(b.subject)
  lines.push(exactTime(b.date))
  lines.push(b.short_hash)
  if (b.worktree) lines.push(`Checked out in ${b.worktree}`)
  return lines.join('\n')
}

export function sameScope(a: BranchScope | null, b: BranchScope | null): boolean {
  return a === b || (a !== null && b !== null && a.name === b.name && a.kind === b.kind)
}

// ---- stashes ----

export function stashMessage(s: GitStash): { text: string; empty: boolean } {
  const t = s.message.trim()
  return t === '' ? { text: '(no message)', empty: true } : { text: s.message, empty: false }
}

export function stashSub(s: GitStash, now: Date): string {
  const when = relativeTime(s.date, now)
  return s.branch ? `on ${s.branch} · ${when}` : when
}

export function stashTitle(s: GitStash): string {
  return [s.name, s.message, s.branch ? `on ${s.branch}` : '', exactTime(s.date)]
    .filter((l) => l !== '')
    .join('\n')
}
