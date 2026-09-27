import type { LiveTurn } from './types/LiveTurn'
import { spokenText } from './liveTurns'

/**
 * The replay control's decision (mesa task 1449) — a play/stop button on every
 * Naru bubble, independent of the run's own `handled`/`performed` bookkeeping.
 * A replay never stamps `played_at` and never touches either of those sets:
 * it is this browser re-hearing something already said, not the conversation
 * advancing, so it must be indistinguishable from the run at every seam that
 * matters (`liveTurns.ts`'s module note) while changing none of it.
 */
export type ReplayControl = 'hidden' | 'disabled' | 'play' | 'stop'

export interface ReplayContext {
  /** A press has unlocked the player/clock (`Go live` or `Listen`) — with
   *  neither, there is nothing to play through. */
  unlocked: boolean
  /** The person's own switch on Naru's voice (mesa task 1327): silenced, so a
   *  replay would be a press with nothing to show for it. */
  speechMuted: boolean
  /** Stepped out of the conversation (task 882): the run itself is halted, and
   *  a replay starting anyway would be the one thing still making noise. */
  paused: boolean
  /** A *live* turn — not a replay — is currently sounding. Replay queues
   *  behind live speech rather than ever interrupting it, so every button but
   *  the one already sounding is disabled while this is true. */
  liveSounding: boolean
  /** The turn id this browser is currently replaying, or null. */
  replaying: number | null
}

/**
 * `hidden` for a turn with nothing to say aloud (a pure `navigate`/sidebar
 * turn, or any non-Naru turn) — the speak route itself refuses that text, so
 * a button offering it would only ever fail. Otherwise: `stop` for the turn
 * already replaying (checked first, so it stays pressable regardless of mute
 * or pause — those end the replay themselves rather than leaving a stuck
 * button); `disabled` while there is nothing to play through, the voice is
 * muted, the conversation is paused, or a live turn is the one sounding;
 * `play` otherwise.
 */
export function replayControl(turn: LiveTurn, ctx: ReplayContext): ReplayControl {
  if (spokenText(turn) === null) return 'hidden'
  if (ctx.replaying === turn.id) return 'stop'
  if (!ctx.unlocked || ctx.speechMuted || ctx.paused) return 'disabled'
  if (ctx.liveSounding) return 'disabled'
  return 'play'
}
