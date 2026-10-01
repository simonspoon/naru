/**
 * The conversation panel's head — the compact strip above the transcript
 * (mesa task 1069).
 *
 * Until now the panel led with one sentence (`liveSession.ts::liveStatusLine`)
 * and the only *picture* of the conversation was an 18px canvas centered in
 * the page header, where it had to answer for a conversation whose panel was
 * usually shut. The head is where both belong once the panel is the surface
 * the person is actually looking at: the Naru mark (no word — mesa task
 * 1544 removed the title), how loud the room is, and how long this has been going on.
 *
 * Everything here is presentation, and deliberately pure — the clocks and
 * the meter history are arithmetic the component would otherwise do inline
 * in JSX.
 */

import type { LiveButton } from './liveSession'

/**
 * How long the conversation has been going, as `MM:SS`.
 *
 * Minutes are not rolled into hours: this is a stopwatch on one conversation
 * read at a glance beside a title, and `1:01:01` is a wider, more punctuated
 * thing to parse than `61:01` for a case that barely happens. A clock-skewed
 * future start clamps at `00:00` rather than printing a negative, the same
 * choice `timeAgo` makes.
 */
export function elapsedLabel(startedAtMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
  const mins = Math.floor(secs / 60)
  return `${String(mins).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
}

/**
 * The driving agent's context size for the head's toolbar, compact:
 * `950 ctx`, `38.5k ctx`, `1.2M ctx`. Null (no agent yet, transcript unreadable) is null
 * rather than `0` — the head then leaves it out instead of claiming an empty
 * context. One decimal, dropped when it is `.0`; a value that rounds up to the
 * next unit (`999_950` → `1M`) is promoted rather than printed as `1000k`.
 */
export function contextLabel(raw: number | bigint | null | undefined): string | null {
  // ts-rs types an i64 as `bigint`; JSON delivers a plain number.
  const tokens = raw === null || raw === undefined ? NaN : Number(raw)
  if (!Number.isFinite(tokens) || tokens < 0) return null
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '')
  if (tokens < 1000) return `${Math.round(tokens)} ctx`
  const k = Math.round(tokens / 100) / 10
  if (k < 1000) return `${trim(k)}k ctx`
  return `${trim(Math.round(tokens / 100_000) / 10)}M ctx`
}

/** How many bars the head's level meter holds. */
export const METER_BARS = 12

/**
 * How many animation frames one bar stands for. The meter is a *history*, not
 * a level: at 60fps a bar per frame would scroll the whole 12 off screen in a
 * fifth of a second, which reads as noise. Five frames is ~12 bars a second —
 * slow enough that a syllable is a bar rather than a blur, fast enough that
 * the row still moves while someone is talking.
 */
export const METER_FRAMES_PER_BAR = 5

/**
 * The scrolling bar history: newest on the right, oldest falling off the left.
 *
 * Called every frame, and **returns the array it was given** on the frames
 * that change nothing — the caller compares by reference to decide whether to
 * render at all, so the rAF loop driving this costs one modulo on four frames
 * out of five. `level` is clamped rather than trusted: it comes from a
 * microphone, and a bar taller than its track is a layout bug rather than a
 * loud room.
 */
export function pushMeterHistory(
  history: number[],
  level: number,
  tick: number,
): number[] {
  if (tick % METER_FRAMES_PER_BAR !== 0) return history
  const kept = history.slice(-(METER_BARS - 1))
  const next = [...kept, Math.min(1, Math.max(0, level))]
  while (next.length < METER_BARS) next.unshift(0)
  return next
}

/** A meter with nothing in it yet — all twelve slots silent. */
export function emptyMeterHistory(): number[] {
  return new Array<number>(METER_BARS).fill(0)
}

/**
 * Whether the press that ends the conversation belongs in the panel head
 * rather than the page header (mesa task 1069).
 *
 * Ending lives beside Pause now, where the conversation itself is, and the
 * header keeps only the presses that *start* one. The exception is a press
 * already in flight: `Going live…` is labelled `stop` while the spawn is
 * running (`liveSession.ts`), and moving that into a panel the person has
 * probably not opened would take the only feedback the header has for it.
 * So: a real, pressable End moves; a disabled placeholder stays put.
 */
export function endsInHead(button: LiveButton | null): boolean {
  return button !== null && button.action === 'stop' && !button.disabled
}
