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

/**
 * How much longer than `autoSendIdleMs` a recording that ends mid-sentence is
 * held (naru task 2648), with nothing configured —
 * `core::config::DEFAULT_LIVE_FRAGMENT_GRACE_MS`, and the answer while the
 * config has not been read. Bounds mirror `MIN/MAX_LIVE_FRAGMENT_GRACE_MS`;
 * `0` turns the hold off.
 */
export const FRAGMENT_GRACE_MS = 2500
export const MAX_FRAGMENT_GRACE_MS = 30_000

/** The extra wait this conversation runs on: configured, else shipped, clamped. */
export function fragmentGraceMs(live: ConfigLive | null): number {
  if (!live) return FRAGMENT_GRACE_MS
  const configured = live.fragment_grace_ms ?? live.fragment_grace_ms_default
  return Math.min(MAX_FRAGMENT_GRACE_MS, Math.max(0, configured))
}

/**
 * Words a spoken sentence rarely ends on: articles, conjunctions,
 * prepositions, question words, modals and fillers. A recording whose last
 * word is one of these was cut by a thinking pause ("Alright, so how can",
 * "Should we have a"), not finished. Words that often close a whole reply
 * ("I think so", "I did that", "go on") are left out.
 */
const TRAILING_WORDS = new Set([
  'a', 'an', 'the',
  'and', 'but', 'or', 'nor', 'because', 'if', 'than',
  'while', 'although', 'though', 'unless', 'whether',
  'to', 'of', 'in', 'at', 'for', 'with', 'from', 'by', 'about',
  'into', 'onto', 'as', 'between', 'through', 'without',
  'how', 'what', 'which', 'where', 'when', 'why', 'who',
  'can', 'could', 'should', 'would', 'will',
  'my', 'your', 'our', 'their',
  'um', 'uh', 'er',
])

/**
 * The words that still hold a reply of three words or fewer: a short reply
 * can end on a modal, a question word or a letter ("yes I will", "not sure
 * why", "A"), so only an unambiguous fragment holds one ("The", "and um").
 */
const SHORT_TRAILING_WORDS = new Set([
  'the', 'an', 'and', 'but', 'or', 'of', 'with', 'from', 'because',
  'my', 'your', 'our', 'their', 'um', 'uh', 'er',
])

/**
 * The words that still hold a recording naru-audio closed with a `.` or `?`:
 * the transcriber punctuates a cut-off fragment as if it were finished
 * ("Alright, so how can?"), but a sentence almost never ends on an article,
 * a conjunction or a modal. Prepositions are left out, since "What's it
 * for?" is a whole question.
 */
const PUNCTUATED_TRAILING_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'because', 'if',
  'can', 'could', 'should', 'would', 'will',
])

/**
 * Whether held text reads as cut off mid-sentence (naru task 2648). Only a
 * positive signal holds it — a trailing comma, colon, semicolon or dash, or
 * a last word from `TRAILING_WORDS` (`PUNCTUATED_TRAILING_WORDS` when a `.`
 * or `?` follows it; for three words or fewer, only those also in
 * `SHORT_TRAILING_WORDS`) — so a short complete reply ("yes", "no", "2",
 * "that's all I had", "Can you?") is never held. `!` and `…` always read as
 * finished. Closing quotes and brackets are ignored.
 */
export function endsMidSentence(text: string): boolean {
  let t = text.trim().replace(/["'”’»)\]}]+$/, '')
  if (t === '') return false
  const last = t[t.length - 1]
  if ('!…'.includes(last)) return false
  if (',;:-–—'.includes(last)) return true
  const punctuated = '.?'.includes(last)
  if (punctuated) t = t.replace(/[.?]+$/, '')
  const words = t.split(/\s+/)
  const raw = words[words.length - 1].replace(/[^A-Za-z']/g, '')
  // A capital "A" ending a sentence is the letter ("take option A"), not the article.
  if (raw === 'A') return false
  const word = raw.toLowerCase()
  if (words.length <= 3 && !SHORT_TRAILING_WORDS.has(word)) return false
  return (punctuated ? PUNCTUATED_TRAILING_WORDS : TRAILING_WORDS).has(word)
}

/**
 * How long this held text must sit in silence before it is sent: the
 * auto-send wait, plus the grace when it ends mid-sentence, so the rest of
 * the sentence lands in the same turn instead of a turn of its own.
 */
export function silenceWaitMs(
  held: string,
  autoSendMs: number,
  graceMs: number,
): number {
  return endsMidSentence(held) ? autoSendMs + graceMs : autoSendMs
}
