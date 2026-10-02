// The live conversation's own agent on the Agents panel (mesa task 1491):
// which listed session it is, how the card treats its state, and the panel's
// default view. Pure, so the rules are unit-tested rather than inline in
// `AgentSidebar.tsx`.

import type { AgentChild } from './types/AgentChild'
import type { AgentSession } from './types/AgentSession'
import type { LiveState } from './types/LiveState'

/** The job id the live conversation's agent runs under — `null` when nothing
 *  is live. `live_sessions.agent_id` is the short job id `claude agents`
 *  reports as `AgentSession.id`, rebound on a handoff, so it always names the
 *  *current* driver and no name or prompt sniffing is needed. */
export function liveAgentId(live: Pick<LiveState, 'session'> | null | undefined): string | null {
  const s = live?.session
  return s && s.status === 'live' ? s.agent_id : null
}

/** Splits the list into the pinned live card and everything else. `live` is
 *  `null` when no live session is running or its job is not listed (the card
 *  is then simply omitted); `rest` keeps its order. */
export function pinLiveAgent(
  agents: AgentSession[],
  agentId: string | null,
): { live: AgentSession | null; rest: AgentSession[] } {
  if (agentId === null) return { live: null, rest: agents }
  const live = agents.find((a) => a.id === agentId) ?? null
  return { live, rest: live === null ? agents : agents.filter((a) => a !== live) }
}

/** The one state the live card may show: what it waits on, but only when
 *  that is a permission prompt (the notion `agents::blocked` uses, mesa task
 *  1293). Normally it is just running, so blocked/inactive/done say nothing. */
export function liveCardWait(a: Pick<AgentSession, 'state' | 'waitingFor'>): string | null {
  if (a.state !== 'blocked' || !a.waitingFor) return null
  return a.waitingFor.toLowerCase().includes('permission') ? a.waitingFor : null
}

/** The panel opens on the full-width card list, not the split view; a phone
 *  already shows one thing at a time, so it keeps its own layout. */
export function defaultListMaximized(phone: boolean): boolean {
  return !phone
}

/** The live agent's parked `naru live listen` — a background shell the agent
 *  keeps waiting for the next spoken turn (`mesa live listen` is the old
 *  spelling). A shell's `command` is its paired Bash call's real command; a
 *  shell no call was paired with only has the `zsh -c …` wrapper in `name`,
 *  which carries the same text. */
export function isListenChild(c: Pick<AgentChild, 'kind' | 'name' | 'command'>): boolean {
  return c.kind === 'shell' && /\b(?:naru|mesa)\s+live\s+listen\b/.test(c.command ?? c.name)
}

/** The live card's children without the parked listen — it is not work, the
 *  glyph (`liveActivity`) says it instead. Shells and subagents stay. */
export function withoutListen<T extends Pick<AgentChild, 'kind' | 'name' | 'command'>>(
  children: T[],
): T[] {
  return children.filter((c) => !isListenChild(c))
}

/** Hearing or working: `listening` while a listen child is running (the agent
 *  is parked, waiting for the person), `working` otherwise. */
export function liveActivity(
  children: Pick<AgentChild, 'kind' | 'name' | 'command' | 'state'>[],
): 'listening' | 'working' {
  return children.some((c) => isListenChild(c) && c.state === 'running') ? 'listening' : 'working'
}
