/**
 * The custom ambient wake words (naru task 1769, `docs/config.md`): the pure
 * half of `WakeWordsSection`. The server trims, dedupes and validates again;
 * this turns the draft into the list to save and says what is wrong with it.
 */

/** The list to save: each entry trimmed, blanks dropped, case-insensitive duplicates dropped (first kept). */
export function wakeWordsToSave(draft: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of draft) {
    const word = raw.trim()
    if (word === '') continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

/**
 * Why `draft` cannot be saved, or null: an entry under 3 letters and digits in total is too short
 * to be heard, and one with anything but letters, digits, spaces, - ' and . (or over 40
 * characters) is refused, as the server's `is_plain_wake_word` does.
 */
export function wakeWordsError(draft: readonly string[]): string | null {
  const words = wakeWordsToSave(draft)
  const short = words.find((w) => (w.match(/[\p{L}\p{N}]/gu) ?? []).length < 3)
  if (short !== undefined) return `"${short}" needs at least 3 letters or digits.`
  const odd = words.find((w) => [...w].length > 40 || !/^[\p{L}\p{M}\p{N} '.-]*$/u.test(w))
  return odd === undefined
    ? null
    : `"${odd}" may hold only letters, digits, spaces, - ' and ., at most 40 characters.`
}

/** Moves `word` to the front: the first entry is the primary wake word, the assistant's name (naru task 2622). */
export function makePrimary(draft: readonly string[], word: string): string[] {
  if (!draft.includes(word)) return [...draft]
  return [word, ...draft.filter((w) => w !== word)]
}

/**
 * The "Wake on voice" switch (naru task 2622). Off empties the draft and remembers the list it had;
 * on restores the remembered list, or `["Naru"]` when there is none. `remembered` is untouched by
 * turning off an already-empty draft.
 */
export function toggleWake(
  draft: readonly string[],
  remembered: readonly string[],
  on: boolean,
): { words: string[]; remembered: string[] } {
  if (!on) return { words: [], remembered: draft.length > 0 ? [...draft] : [...remembered] }
  if (draft.length > 0) return { words: [...draft], remembered: [...remembered] }
  return { words: remembered.length > 0 ? [...remembered] : ['Naru'], remembered: [] }
}

/** The switch is on iff there is at least one wake word. */
export function wakeOn(draft: readonly string[]): boolean {
  return draft.length > 0
}

/** The verdict line of "Test my wake word", e.g. `yes (exact "Jarvis")` or `no (<reason>)`. */
export function wakeVerdictText(v: {
  wake: boolean
  match: 'exact' | 'sound_alike' | null
  word: string | null
  reason: string
}): string {
  if (!v.wake) return `no (${v.reason})`
  const how = v.match === 'sound_alike' ? 'sound-alike' : 'exact'
  return v.word === null ? `yes (${how})` : `yes (${how} "${v.word}")`
}

/**
 * Below this peak (of `-1..1` samples) a test clip is silence: a dead or muted
 * input, such as a MacBook's built-in mic with the lid closed, which still
 * opens but delivers digital zeros (naru task 2631). Room noise on a live mic
 * sits well above it.
 */
export const SILENT_PEAK = 0.005

/** The loudest absolute sample. */
export function peakLevel(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  return peak
}

/** The verdict when the clip was silence, naming the device it came from when the browser told us. */
export function silenceVerdictText(device: string): string {
  const from = device.trim() === '' ? '' : ` from "${device.trim()}"`
  return `no (mic captured silence${from}; check the browser's input device and permission)`
}
