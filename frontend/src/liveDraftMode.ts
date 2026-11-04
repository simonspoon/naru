/**
 * Auto-send and draft mode for the live capture box (naru task 2572).
 *
 * Auto-send ON is the conversation as it always was: every heard turn is
 * posted at its silence boundary. Auto-send OFF is **draft mode**: a heard
 * turn is appended to the box instead, where the person can edit it, and
 * nothing reaches the agent until they press send — or end an utterance with
 * "send it", which is stripped and sends the whole draft hands-free.
 *
 * The switch is this browser's own, remembered in `localStorage`, like the
 * microphone choice (`liveDevices.ts`).
 */

const KEY = 'naru-live-auto-send'

/** Whether heard turns are sent on their own; on unless turned off here. */
export function readAutoSend(): boolean {
  return localStorage.getItem(KEY) !== 'off'
}

/** Remember the switch; the default (on) is remembered as nothing at all. */
export function writeAutoSend(on: boolean): void {
  if (on) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, 'off')
}

/**
 * "send it" as the last words of an utterance, ignoring case and any
 * punctuation around it — "…the fix. Send it!" — but not inside a word
 * ("resend it") and not mid-sentence ("send it to Bob").
 */
const SEND_IT = /(^|[^\p{L}\p{N}])send[^\p{L}\p{N}]+it[^\p{L}\p{N}]*$/iu

/**
 * The utterance without a closing "send it", or `null` when it does not end
 * with one. What remains is trimmed of the punctuation that led into the
 * phrase ("the fix, send it" → "the fix").
 */
export function stripSendIt(heard: string): string | null {
  const match = SEND_IT.exec(heard)
  if (match === null) return null
  return heard
    .slice(0, match.index + match[1].length)
    .replace(/[\s,;:–—-]+$/u, '')
}

/** A heard piece added to the end of the draft, one space between them. */
export function appendHeard(draft: string, heard: string): string {
  const piece = heard.trim()
  if (piece === '') return draft
  if (draft.trim() === '') return piece
  return /\s$/.test(draft) ? draft + piece : `${draft} ${piece}`
}

/**
 * One heard utterance landing in draft mode: the box's new text, and whether
 * the person asked for it to be sent. Every utterance lands, however short —
 * "yes" is a whole answer.
 */
export function draftTurn(draft: string, heard: string): { draft: string; send: boolean } {
  const rest = stripSendIt(heard)
  if (rest === null) return { draft: appendHeard(draft, heard), send: false }
  return { draft: appendHeard(draft, rest), send: true }
}
