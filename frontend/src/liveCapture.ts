import type { ConfigLive } from './types/ConfigLive'

/**
 * The live conversation's typed capture box (mesa task 857).
 *
 * The box is an ordinary field (mesa task 1439): it has focus only when the
 * person clicks or Tabs into it, and nothing moves focus to it or keeps it
 * there — so text selected on the live whiteboard stays copyable. Dictation
 * through the page does not need the box focused: a transcribed or recognized
 * sentence reaches the conversation with the keyboard anywhere.
 *
 * The typed box itself is sent by Enter alone (mesa task 977): a timer that
 * posts what the person is still typing sends half-thoughts, and the box is
 * the fallback surface a person is deliberately typing into — not dictating
 * through — so the deliberate keystroke is the boundary, exactly as it is
 * anywhere else text is typed.
 *
 * The one number this module still owns — `autoSendIdleMs` — is read by
 * `liveRecognition.ts` alone now: the silence boundary that flushes a
 * *transcribed* recording once the person stops talking for a beat. It moved
 * here rather than staying inline there because it is one wait answering "has
 * the person stopped" and was, until task 977, also the typed draft's own
 * idle deadline — kept in one place so the two surfaces could not drift apart
 * and disagree about how long a pause means.
 */

/**
 * How long a transcribed recording must sit in silence before it is sent, with
 * nothing configured — `core::config::DEFAULT_LIVE_AUTO_SEND_MS`, and the wait
 * mesa had before the setting existed (back when it also governed the typed
 * box, before mesa task 977). It is also the answer while the config has not
 * been read yet (or could not be), because a conversation must not stall
 * waiting on a settings file.
 */
export const AUTO_SEND_IDLE_MS = 2000

/**
 * The bounds a configured wait is held to, mirroring
 * `core::config::MIN_LIVE_AUTO_SEND_MS`/`MAX_LIVE_AUTO_SEND_MS` — the same
 * duplication `watchersDraft.ts` makes, so both ends name one rule.
 */
export const MIN_AUTO_SEND_IDLE_MS = 250
export const MAX_AUTO_SEND_IDLE_MS = 60_000

/**
 * The wait this conversation runs on: the configured value, else the one mesa
 * ships — and clamped, because the editor is not the only way into the config
 * file and a hand-edited `0` would post a word at a time rather than configure
 * anything. `null` (the config not read yet, or unreachable) is the built-in
 * wait, never a stall.
 */
export function autoSendIdleMs(live: ConfigLive | null): number {
  if (!live) return AUTO_SEND_IDLE_MS
  const configured = live.auto_send_ms ?? live.auto_send_ms_default
  return Math.min(
    MAX_AUTO_SEND_IDLE_MS,
    Math.max(MIN_AUTO_SEND_IDLE_MS, configured),
  )
}
