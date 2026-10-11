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
  /** What the stop button calls; `null` hides it. */
  stop: { route: 'agent' | 'run'; id: string } | null
  /** The muted line under the row, `null` for none. */
  note: string | null
}

const RUN_TERMINAL = ['done', 'failed', 'stopped']

/**
 * What a row may do. A runner row is never attachable (it is not a claude
 * job) and stops through `/api/runs/{id}/stop`, but only while its run is
 * not already over; the "external terminal" note belongs to interactive
 * rows alone.
 */
export function agentRowActions(
  a: Pick<AgentSession, 'id' | 'kind' | 'runId' | 'state'>,
): AgentRowActions {
  switch (agentKindOf(a)) {
    case 'background':
      return { attachable: true, stop: { route: 'agent', id: a.id as string }, note: null }
    case 'runner':
      return {
        attachable: false,
        stop: RUN_TERMINAL.includes(a.state ?? '') ? null : { route: 'run', id: a.runId as string },
        note: null,
      }
    case 'interactive':
      return { attachable: false, stop: null, note: 'external terminal — not attachable' }
  }
}

/** The in-flight key for a stop: a run id never collides with a job id. */
export function stopKeyOf(stop: { route: 'agent' | 'run'; id: string }): string {
  return stop.route === 'run' ? `run:${stop.id}` : stop.id
}
