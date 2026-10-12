/**
 * Cutting the agent's turn by voice (naru task 1890, part of 1780).
 *
 * A spoken pause phrase ("hold on") already pauses this page; when the agent
 * is also mid-turn it should stop working too, so the page fires
 * `POST /api/live/interrupt` beside the pause. Only the three places that
 * hear a pause phrase ask this: the Pause button, Escape and the ambient
 * path never do. Pure so the rule is tested without a rendered hub.
 */
export interface InterruptInput {
  /** A conversation is live. */
  live: boolean
  /** This browser has joined it. */
  joined: boolean
  /** The agent is mid-turn (`session.working_since` is set). */
  working: boolean
}

/** True only when the conversation is live, joined and the agent is working. */
export function shouldInterruptAgent({ live, joined, working }: InterruptInput): boolean {
  return live && joined && working
}
