/**
 * Live captions (mesa task 1555): a new Naru turn's words appear in time with
 * the voice rather than all at once. Pure arithmetic — the component owns the
 * clocks and the timer, and hands the numbers in.
 *
 * The speak route exposes no word timings, so words are placed by **character
 * length**: the share of the text revealed is the share of the audio heard.
 * The share comes from a clock the playback path actually has — the `<audio>`
 * element's `currentTime`/`duration`, or the decode path's playhead
 * (`SpeechStream.elapsed`). A chunked stream has no duration yet, so one is
 * estimated from the text at a speaking rate and the share is capped below 1:
 * the caption never overtakes the audio, and the component snaps to the full
 * text when playback ends.
 */

/** Characters spoken per second, for a body whose duration is not yet known. */
export const CAPTION_CHARS_PER_SECOND = 14

/** The most of the text an *estimated* duration may reveal; only the end of
 *  playback shows the rest, so a fast estimate never runs ahead of the voice. */
export const CAPTION_ESTIMATE_CAP = 0.95

/**
 * Whether this turn's words are paced by playback at all. Everything else —
 * a replay or an already-played turn, a muted voice, a pause, a failed
 * playback, or a turn that is not the one sounding — shows the whole text.
 */
export function captionActive(opts: {
  /** The turn the player took in hand to speak, if any. */
  captionId: number | null
  turnId: number
  /** The turn has a `played_at`, or is being replayed: heard before. */
  heard: boolean
  replaying: boolean
  speechMuted: boolean
  paused: boolean
}): boolean {
  return (
    opts.captionId === opts.turnId &&
    !opts.heard &&
    !opts.replaying &&
    !opts.speechMuted &&
    !opts.paused
  )
}

/**
 * Whether a turn this page is *about to* speak is held back (0 characters)
 * rather than painted whole until `speak()` takes it — a new turn would
 * otherwise flash full, and a turn queued behind a sounding one would sit full
 * for seconds. Only a turn this page will certainly say: not heard, not one it
 * already captioned (`captioned` outlives the turn ending, which clears
 * `captionId` a poll before `played_at` arrives), joined and unpaused, and
 * `willSpeak` (the run's own verdict: this page holds the voice and it is not
 * muted). Everything else renders full.
 */
export function captionHeld(opts: {
  captionId: number | null
  turnId: number
  heard: boolean
  /** The player has already taken this turn in hand, now or earlier. */
  captioned: boolean
  /** `spokenTurnVerdict(...) === 'speak'`. */
  willSpeak: boolean
  unlocked: boolean
  paused: boolean
}): boolean {
  return (
    opts.willSpeak &&
    opts.unlocked &&
    !opts.paused &&
    !opts.heard &&
    !opts.captioned &&
    opts.captionId !== opts.turnId
  )
}

/**
 * The share of the text heard, 0..1. `duration` is trusted only when finite
 * and positive (an element on a chunked body reports `Infinity` or `NaN`);
 * otherwise the duration is estimated from the text. Either way the share is
 * capped below 1 — a chunked body's finite duration can still grow as bytes
 * arrive — and only the end of playback shows the rest.
 */
export function captionFraction(
  elapsed: number | null,
  duration: number | null,
  text: string,
  speed = 1,
): number {
  if (elapsed === null || !Number.isFinite(elapsed) || elapsed <= 0) return 0
  if (duration !== null && Number.isFinite(duration) && duration > 0) {
    return Math.min(CAPTION_ESTIMATE_CAP, elapsed / duration)
  }
  // The estimate is at 1x; stretched output runs 1/speed as long (mesa task
  // 1560). The element path's `currentTime` is media time and passes 1.
  const estimate = Math.max(1, text.length / (CAPTION_CHARS_PER_SECOND * speed))
  return Math.min(CAPTION_ESTIMATE_CAP, elapsed / estimate)
}

/**
 * How many characters of `text` are showing at `fraction`: the end of the last
 * word that has begun, so a word appears whole as the voice reaches it. 0 until
 * the first word begins; the full length at 1 (or more).
 */
export function captionLength(text: string, fraction: number): number {
  if (fraction >= 1) return text.length
  if (fraction <= 0) return 0
  const reached = fraction * text.length
  let shown = 0
  const words = /\S+/g
  for (let m = words.exec(text); m !== null; m = words.exec(text)) {
    if (m.index > reached) break
    shown = m.index + m[0].length
  }
  return shown
}
