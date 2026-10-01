// The Agents panel's swarm cards (mesa task 1554): the three pure decisions
// behind them, kept out of `AgentSidebar.tsx` so they can be unit-tested.
// The clock is an argument everywhere, exactly as in `agentChild.ts`.

import type { AgentChild } from './types/AgentChild'
import type { AgentSession } from './types/AgentSession'
import type { Project } from './types/Project'
import { orderedChildren } from './agentChild'
import { parseTimestamp } from './time'

/** How long a card that left the list stays, green, before it is gone — the
 * length of the CSS dissolve (`agent-card-leaving`), so nothing sits invisible. */
export const LINGER_MS = 2400

/** The chips beside a card's name, so five supervisors read as five jobs.
 * Both `null` when unknown — a chip is never invented. The project is the
 * one claiming the session's folder, else the folder's own last segment. */
export function agentChips(
  a: Pick<AgentSession, 'cwd' | 'taskId'>,
  project: Pick<Project, 'name'> | undefined,
): { project: string | null; task: string | null } {
  const folder = a.cwd.split('/').filter(Boolean).pop() ?? null
  return {
    project: project ? project.name : folder,
    task: a.taskId !== null ? `#${a.taskId}` : null,
  }
}

const PALETTE = ['#2bd4ff', '#5dffa8', '#ffb347', '#ff6b9a', '#7aa2ff', '#e6d95a']

/** A card's accent — its left edge and its sub-agents' rail. Hashed off the
 * session id, so it is stable across polls and never reshuffles. */
export function agentColor(sessionId: string): string {
  let h = 0
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

/** A session that dropped off the list, kept a moment so it can dissolve. */
export type Lingering = { session: AgentSession; leftAt: number }

/**
 * The next lingering set: sessions in `prev` and not in `next` join at `now`;
 * one that is back on the list, or has lingered `LINGER_MS`, is dropped.
 */
export function reconcileLingering(
  lingering: Lingering[],
  prev: AgentSession[],
  next: AgentSession[],
  now: number,
): Lingering[] {
  const live = new Set(next.map((s) => s.sessionId))
  const kept = lingering.filter((l) => !live.has(l.session.sessionId) && now - l.leftAt < LINGER_MS)
  const have = new Set(kept.map((l) => l.session.sessionId))
  const added = prev
    .filter((s) => !live.has(s.sessionId) && !have.has(s.sessionId))
    .map((session) => ({ session, leftAt: now }))
  // Same array when nothing changed, so a no-op poll re-renders nothing.
  if (added.length === 0 && kept.length === lingering.length) return lingering
  return [...kept, ...added]
}

/** Ms until the earliest lingering card is due to go, or `null` for none. */
export function nextExpiry(lingering: { leftAt: number }[], now: number): number | null {
  if (lingering.length === 0) return null
  return Math.max(0, Math.min(...lingering.map((l) => l.leftAt + LINGER_MS)) - now)
}

/** The list the panel draws: the live sessions plus the lingering ones,
 * newest start first, and the ids of the lingering ones. */
export function withLingering(
  agents: AgentSession[],
  lingering: Lingering[],
): { agents: AgentSession[]; leaving: string[] } {
  const live = new Set(agents.map((a) => a.sessionId))
  const gone = lingering.filter((l) => !live.has(l.session.sessionId)).map((l) => l.session)
  return {
    agents: [...agents, ...gone].sort((a, b) => b.startedAt - a.startedAt),
    leaving: gone.map((s) => s.sessionId),
  }
}

/** How long a card keeps its enter class: the 0.6s fly-in and its flash
 * (`agent-fly-in` in App.css) plus a margin, so nothing is cut off. */
export const ENTER_MS = 700

/** `seen` (session id to the ms it was first shown) plus every session in
 * `sessions` not yet in it, stamped `now`; the same object when none is new. */
export function markSeen(
  seen: Record<string, number>,
  sessions: AgentSession[],
  now: number,
): Record<string, number> {
  return markSeenKeys(
    seen,
    sessions.map((s) => s.sessionId),
    now,
  )
}

/** `markSeen` over bare keys — a session's id or a child's `childKey`. */
export function markSeenKeys(
  seen: Record<string, number>,
  keys: string[],
  now: number,
): Record<string, number> {
  const fresh = keys.filter((k) => !(k in seen))
  if (fresh.length === 0) return seen
  const next = { ...seen }
  for (const k of fresh) next[k] = now
  return next
}

/** Whether a card still wears the enter class: never seen yet (its first
 * render) or first seen under `ENTER_MS` ago. Past that the animation has
 * finished, so dropping the class — or remounting into another bucket —
 * replays nothing. */
export function isEntering(seen: Record<string, number>, id: string, now: number): boolean {
  const at = seen[id]
  return at === undefined || now - at < ENTER_MS
}

/** The quiet clock on a card's right: `7s`, `4m`, `2h`, `3d` since the
 * session started (`startedAt`, epoch ms). Floors; a future stamp is `0s`. */
export function elapsedSince(startedAt: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

// --- Sub-agents as their own cards (mesa task 1561) ---------------------
//
// A session's `children` are drawn as cards of their own right under it, so
// each needs a stable key (for the enter flash and the dissolve) and the
// same lingering bookkeeping a session has.

/** A running child older than this under a `done` session is a leaked
 * process, not work in flight (see `visibleChildren`). */
export const STALE_CHILD_MS = 60 * 60 * 1000

/**
 * The children of `a` worth a card. A `done` session may still hold work in
 * flight (mesa task 571/802), so its running children stay — but one running
 * for over `STALE_CHILD_MS` under a finished session is a shell nothing
 * ever reaped (a hung pipeline in a process that outlived its work), and
 * showing it as "running" for days is the ghost mesa task 1561 reported.
 * A child with no start time is kept: absence is not age.
 */
export function visibleChildren(
  a: Pick<AgentSession, 'state' | 'children'>,
  now: number,
): AgentChild[] {
  if (a.state !== 'done') return a.children
  return a.children.filter((c) => {
    if (c.state !== 'running' || c.startedAt === null) return true
    const started = parseTimestamp(c.startedAt).getTime()
    return !Number.isFinite(started) || now - started < STALE_CHILD_MS
  })
}

/** A child's identity across polls: its parent plus the transcript id, or the
 * command line for a shell (`agentChild.ts::childPaneId`'s rule) — never an
 * index, since cards reorder. */
export function childKey(parentSessionId: string, child: AgentChild): string {
  return `${parentSessionId}|${child.id ?? `cmd:${child.name}`}`
}

/** `childKey` for every child of one session, in the given (server) order,
 * the second and later of an identical key suffixed `#2`, `#3` — two parallel
 * shells running the same command line are two cards, not one. */
export function childKeys(parentSessionId: string, children: AgentChild[]): string[] {
  const count = new Map<string, number>()
  return children.map((child) => {
    const base = childKey(parentSessionId, child)
    const n = (count.get(base) ?? 0) + 1
    count.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  })
}

/** One child with the session it hangs off. */
export type ChildRow = { key: string; parent: string; child: AgentChild }

/** Every visible child of every session, flat. */
export function childRowsOf(sessions: AgentSession[], now: number): ChildRow[] {
  return sessions.flatMap((s) => {
    const children = visibleChildren(s, now)
    const keys = childKeys(s.sessionId, children)
    return children.map((child, i) => ({ key: keys[i], parent: s.sessionId, child }))
  })
}

/** A child that dropped off the list, kept a moment so it can dissolve. */
export type ChildLingering = { row: ChildRow; leftAt: number }

/** `reconcileLingering`, for children. */
export function reconcileChildLingering(
  lingering: ChildLingering[],
  prev: ChildRow[],
  next: ChildRow[],
  now: number,
): ChildLingering[] {
  const live = new Set(next.map((r) => r.key))
  const kept = lingering.filter((l) => !live.has(l.row.key) && now - l.leftAt < LINGER_MS)
  const have = new Set(kept.map((l) => l.row.key))
  const added = prev
    .filter((r) => !live.has(r.key) && !have.has(r.key))
    .map((row) => ({ row, leftAt: now }))
  if (added.length === 0 && kept.length === lingering.length) return lingering
  return [...kept, ...added]
}

/** The cards under one session, in order: its live children
 * (`orderedChildren`), then the lingering ones, flagged `leaving`. A child
 * that finished but is still listed is not `leaving` — it is green but
 * stays until it drops off. */
export function cardChildren(
  parentSessionId: string,
  live: AgentChild[],
  lingering: ChildLingering[],
): { key: string; child: AgentChild; leaving: boolean }[] {
  // Keys come from the server's order, before `orderedChildren` reshuffles.
  const keys = childKeys(parentSessionId, live)
  const keyOf = new Map(live.map((child, i) => [child, keys[i]]))
  const shown = orderedChildren(live).map((child) => ({
    key: keyOf.get(child) as string,
    child,
    leaving: false,
  }))
  const have = new Set(shown.map((c) => c.key))
  const gone = lingering
    .filter((l) => l.row.parent === parentSessionId && !have.has(l.row.key))
    .map((l) => ({ key: l.row.key, child: l.row.child, leaving: true }))
  return [...shown, ...gone]
}
