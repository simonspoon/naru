/**
 * The live conversation's message list, as pure logic (mesa task 1565): which
 * words in a turn are task references, the clock a group header shows, and the
 * one quiet line under the composer. Kept out of `LiveHub.tsx` so the rules
 * that could ship wrong are covered by `liveChat.test.ts`.
 */
import { parseTimestamp } from './time'
import { captureHint, type ListenPath } from './liveRecognition'
import { shortModel } from './sessionGraph'
import { contextLabel } from './liveHead'

export type TextSegment =
  { kind: 'text'; text: string } | { kind: 'task'; id: number; text: string }

export type TurnSegment = TextSegment | { kind: 'tone'; text: string }

/**
 * Splits a Naru turn's text into Breeze tone tags (naru task 2357) and the
 * rest, the rest further split by `taskSegments`. A tag is a short run of
 * letters, spaces, commas, hyphens and apostrophes in parentheses —
 * `(laughs)`, `(warmly, a little faster)` — which Breeze uses for delivery and
 * does not speak, so the transcript shows it quietly rather than as words. A
 * tag still open at the very end counts too, so a caption revealing it
 * character by character never flashes it as plain text. Joining the
 * segments' `text` reproduces the input.
 */
export function turnSegments(text: string): TurnSegment[] {
  const out: TurnSegment[] = []
  // A tag starts a word: the start or a space before it, matched as a
  // character rather than a lookbehind (older Safari), so `f(x)` stays text.
  const re = /(^|\s)(\([A-Za-z][A-Za-z ,'-]{0,39}(?:\)|$))/g
  let last = 0
  for (const m of text.matchAll(re)) {
    const at = (m.index ?? 0) + m[1].length
    if (at > last) out.push(...taskSegments(text.slice(last, at)))
    out.push({ kind: 'tone', text: m[2] })
    last = at + m[2].length
  }
  if (last < text.length) out.push(...taskSegments(text.slice(last)))
  return out
}

/**
 * Splits a turn's text into plain runs and `#1563`-style task references.
 * A reference is `#` plus digits standing alone: not glued to the end of a word
 * (`abc#12`), not a route (`#/tasks/5`, `/#12`), not followed by more word
 * characters (`#12abc`, `#12.5` is still a reference to 12 followed by `.5`
 * only if the dot is not followed by a digit). Every other character comes back
 * byte-identical, so joining the segments' `text` reproduces the input.
 */
export function taskSegments(text: string): TextSegment[] {
  const out: TextSegment[] = []
  // The leading boundary is matched as a character (or the start) rather than
  // a lookbehind, which older Safari cannot parse.
  const re = /(^|[^\w/#&])#(\d{1,9})(?![\w/]|\.\d)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    const at = (m.index ?? 0) + m[1].length
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    out.push({ kind: 'task', id: Number(m[2]), text: `#${m[2]}` })
    last = at + m[2].length + 1
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** The hash a task chip opens: the legacy `#/tasks/:id` form the router
 *  resolves to the task's project. */
export function taskHash(id: number): string {
  return `#/tasks/${id}`
}

/** `HH:MM` in the viewer's zone for a store timestamp; empty when unparseable. */
export function turnClock(createdAt: string): string {
  const d = parseTimestamp(createdAt)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The slim head's readout: the driver's model and its context size, each left
 * out when unknown rather than faked. Effort is not reachable from the page.
 */
export function headMeta(
  model: string | null,
  contextTokens: number | bigint | null | undefined,
): string {
  return [shortModel(model), contextLabel(contextTokens)]
    .filter((p) => p !== null && p !== '')
    .join(' · ')
}

export interface QuietHint {
  /** A chord to draw as a key cap before `text`, or null. */
  chord: string | null
  text: string
}

/**
 * The one line under the composer. The plain resting state is the short
 * "F5 to talk · Enter sends"; every other state keeps what `captureHint` says,
 * since refusals, an unavailable engine and a pause are information only that
 * line conveys. Listening is shortened to which path hears the person.
 */
export function quietHint(input: {
  live: boolean
  joined: boolean
  path: ListenPath
  blocked: boolean
  listening: boolean
  paused: boolean
  muted: boolean
  chord: string
  /** Another client holds the speaker claim (naru task 2095). */
  elsewhere?: boolean
}): QuietHint {
  const ready =
    input.live &&
    input.joined &&
    !input.elsewhere &&
    !input.paused &&
    !input.blocked &&
    input.path !== 'none' &&
    input.path !== 'unavailable'
  if (ready && input.muted) return { chord: input.chord, text: 'to talk · Enter sends' }
  if (ready && input.listening) {
    const via = input.path === 'auris' ? 'naru-audio' : 'this browser'
    return { chord: null, text: `Listening through ${via} · Enter sends` }
  }
  const text = captureHint(input)
  return { chord: null, text: input.paused ? text : `${text} Enter sends.` }
}
