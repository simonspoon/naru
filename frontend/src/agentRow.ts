// The Agent sidebar's list row (mesa task 869) — the two derivations its
// four lines need, kept out of `AgentSidebar.tsx` so they can be unit-tested
// (the repo's rule: logic worth testing never lives inline in a `.tsx`).
//
// Both answer `null` rather than a placeholder when there is nothing to say.
// A row renders nothing at all in that case: "no transcript yet" and "no
// usage line yet" must not read as an empty response or as zero tokens.

import type { AgentSession } from './types/AgentSession'
import { isRunningAgent } from './agentProject'

/**
 * The context-window figure for a row's right-hand meta slot: a compact,
 * fixed-width-ish token count.
 *
 * `null` for absent (no usage line on the transcript yet) **and for 0** —
 * a session occupying no context has nothing worth a column of its own, and
 * "0" beside a running agent reads as a measurement, not as an absence.
 * Negative is treated the same way: it can only be a bad reading.
 *
 * Under 1k the raw count is exact; above it one decimal is kept unless it
 * would be `.0`, so the string never exceeds six characters and a column of
 * them stays scannable.
 */
export function formatContextTokens(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return null
  if (tokens < 1000) return String(Math.round(tokens))
  const [value, suffix] = tokens < 1_000_000 ? [tokens / 1000, 'k'] : [tokens / 1_000_000, 'M']
  // `toFixed(1)` then strip a trailing `.0`: 48.2k, but 1k rather than 1.0k.
  return value.toFixed(1).replace(/\.0$/, '') + suffix
}

/**
 * The one-line preview of an agent's latest prose.
 *
 * The server already bounds the text; this only makes it fit on one line —
 * every run of whitespace (newlines included) collapses to a single space,
 * so a multi-paragraph reply can't turn the row into a block. Whitespace-only
 * text is nothing to show, so it comes back `null` like an absent one.
 *
 * The result is still **untrusted model-authored text** and is rendered as a
 * plain text node: never HTML, markdown or a URL.
 */
export function responsePreview(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed === '' ? null : collapsed
}

/**
 * The one big sentence a card leads with (mesa task 1484): what the agent is
 * doing, best effort, in this order — the in-progress todo / newest tool
 * description the server lifted (`activity`, only while the session is
 * running), else the latest assistant prose.
 * `null` when neither is known, and the card then shows its name alone.
 */
export function agentHeadline(
  a: Pick<AgentSession, 'pid' | 'state' | 'activity' | 'lastResponse'>,
): string | null {
  // `activity` is a doing-now sentence: once the session is done or gone the
  // last todo / tool description would sit there for ever, so the closing
  // reply takes over.
  return (isRunningAgent(a) ? responsePreview(a.activity) : null) ?? responsePreview(a.lastResponse)
}

/** A Naru timestamp (`YYYY-MM-DD HH:MM:SS`, UTC) as epoch ms; `null` when
 *  absent or unparseable. */
export function naruTimeMs(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null
  const ms = Date.parse(text.trim().replace(' ', 'T') + 'Z')
  return Number.isFinite(ms) ? ms : null
}

/**
 * When the step behind the headline began (epoch ms) — only while the
 * headline *is* the server's `activity` (a running agent with one); `null`
 * when it fell back to the latest reply, where a step age would mislead.
 */
export function headlineSince(
  a: Pick<AgentSession, 'pid' | 'state' | 'activity' | 'activitySince'>,
): number | null {
  if (!isRunningAgent(a) || responsePreview(a.activity) === null) return null
  return naruTimeMs(a.activitySince)
}

export interface TrailStep {
  text: string
  /** Epoch ms the step was written, `null` if the line had no timestamp. */
  atMs: number | null
}

/**
 * The recent-steps trail, newest first, each text collapsed to one line;
 * steps with no text are dropped. Model-authored: render as plain text.
 */
export function stepTrail(a: Pick<AgentSession, 'recentSteps'>): TrailStep[] {
  const out: TrailStep[] = []
  for (const step of [...(a.recentSteps ?? [])].reverse()) {
    const text = responsePreview(step.text)
    if (text !== null) out.push({ text, atMs: naruTimeMs(step.at) })
  }
  return out
}

/**
 * The tint a top-level card wears (mesa task 1502), and the colour of its
 * dot: `active` while the session is `working` (or, with no `state` at all,
 * `busy`) and its process is busy, `stale` for the sticky `idle` + `working`
 * pair (`AgentSidebar.tsx::bucketOf` — a background session can sit there
 * for 90+ minutes after its turn, mesa task 571), `null` for every other
 * state, which keeps its old look.
 */
export function agentTint(a: Pick<AgentSession, 'state' | 'status'>): 'active' | 'stale' | null {
  const working = a.state === 'working' || (a.state === null && a.status === 'busy')
  if (!working) return null
  return a.status === 'idle' ? 'stale' : 'active'
}

export type AgentKind = 'background' | 'interactive' | 'runner'

/**
 * Which of the three row kinds the Agents panel lists (naru task 1830): a
 * `naru run` job (`kind: 'runner'` with its run job id), a `--bg` session
 * (has the short job id `claude attach`/`claude stop` take), or an
 * interactive terminal session (neither).
 */
export function agentKindOf(a: Pick<AgentSession, 'id' | 'kind' | 'runId'>): AgentKind {
  if (a.kind === 'runner' && a.runId !== null) return 'runner'
  return a.id !== null ? 'background' : 'interactive'
}

export interface AgentRowActions {
  /** Only a background session has a pty to attach to. */
  attachable: boolean
  /** Whether clicking the row opens a pane (a claude pty or a run view). */
  openable: boolean
  /** What the stop button calls; `null` hides it. */
  stop: { route: 'agent' | 'run'; id: string } | null
  /** The muted line under the row, `null` for none. */
  note: string | null
}

/**
 * What a row may do. A runner row is never attachable (it is not a claude
 * job) and stops through `/api/runs/{id}/stop`, but only while its run is
 * not already over (`status` is null once it is); the "external terminal" note belongs to interactive
 * rows alone.
 */
export function agentRowActions(
  a: Pick<AgentSession, 'id' | 'kind' | 'runId' | 'status'>,
): AgentRowActions {
  switch (agentKindOf(a)) {
    case 'background':
      return { attachable: true, openable: true, stop: { route: 'agent', id: a.id as string }, note: null }
    case 'runner':
      return {
        attachable: false,
        openable: true,
        stop: a.status !== null ? { route: 'run', id: a.runId as string } : null,
        note: null,
      }
    case 'interactive':
      return { attachable: false, openable: false, stop: null, note: 'external terminal — not attachable' }
  }
}

/** The in-flight key for a stop: a run id never collides with a job id. */
export function stopKeyOf(stop: { route: 'agent' | 'run'; id: string }): string {
  return stop.route === 'run' ? `run:${stop.id}` : stop.id
}

const RUN_PANE_PREFIX = 'run:'

/**
 * The pane-tree id of a run's pane (naru task 1832). Prefixed so it can never
 * collide with a `--bg` job id (the other leaf ids are bare job ids or
 * `child:`-prefixed).
 */
export function runPaneId(runId: string): string {
  return `${RUN_PANE_PREFIX}${runId}`
}

export function isRunPaneId(paneId: string): boolean {
  return paneId.startsWith(RUN_PANE_PREFIX)
}

/** The run job id a run pane id names, `null` for any other id. */
export function parseRunPaneId(paneId: string): string | null {
  if (!isRunPaneId(paneId)) return null
  const id = paneId.slice(RUN_PANE_PREFIX.length)
  return id === '' ? null : id
}

/** The pane id a row opens on click: a runner row its run pane, a background
 *  row its attach pane, an interactive row none. */
export function rowPaneId(a: Pick<AgentSession, 'id' | 'kind' | 'runId'>): string | null {
  switch (agentKindOf(a)) {
    case 'runner':
      return runPaneId(a.runId as string)
    case 'background':
      return a.id
    case 'interactive':
      return null
  }
}

export type Bucket = 'BLOCKED' | 'ACTIVE' | 'DONE'

/**
 * Which sidebar bucket a listed session sits in. The same rule as
 * `isRunningAgent` (`agentProject.ts`): active unless upstream reports it
 * `done` (mesa task 861); `blocked` keeps its own bucket, the one that needs
 * a person. A `done` session that still has live shells or subagents is
 * still working, so it stays ACTIVE (naru task 1902) — DONE is only for one
 * with nothing in flight.
 */
export function bucketOf(
  a: Pick<AgentSession, 'state' | 'liveShells' | 'liveSubagents'>,
): Bucket {
  if (a.state === 'blocked') return 'BLOCKED'
  if (a.state !== 'done') return 'ACTIVE'
  return (a.liveShells ?? 0) + (a.liveSubagents ?? 0) > 0 ? 'ACTIVE' : 'DONE'
}

/**
 * Whether a row carries the "stalled" badge (naru task 1953): the server's
 * stall watchdog has seen this dispatched session silent past
 * `watchers.stall-minutes` on a still-`in_progress` task. Only a row that is
 * still a live process can be stalled — an exited one is just over.
 */
export function isStalledRow(a: Pick<AgentSession, 'stalled' | 'pid'>): boolean {
  return a.stalled === true && a.pid !== null && a.pid !== undefined
}
