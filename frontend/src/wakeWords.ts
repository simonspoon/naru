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

/** Why `draft` cannot be saved, or null: an entry under 3 letters and digits in total is too short to be heard. */
export function wakeWordsError(draft: readonly string[]): string | null {
  const bad = wakeWordsToSave(draft).find((w) => (w.match(/[\p{L}\p{N}]/gu) ?? []).length < 3)
  return bad === undefined ? null : `"${bad}" needs at least 3 letters or digits.`
}
