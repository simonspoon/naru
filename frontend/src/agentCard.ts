// The Agents panel's swarm cards (mesa task 1554): the three pure decisions
// behind them, kept out of `AgentSidebar.tsx` so they can be unit-tested.
// The clock is an argument everywhere, exactly as in `agentChild.ts`.

import type { AgentSession } from './types/AgentSession'
import type { Project } from './types/Project'

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
export function nextExpiry(lingering: Lingering[], now: number): number | null {
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
  const fresh = sessions.filter((s) => !(s.sessionId in seen))
  if (fresh.length === 0) return seen
  const next = { ...seen }
  for (const s of fresh) next[s.sessionId] = now
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
