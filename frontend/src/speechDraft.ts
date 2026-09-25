import type { ConfigSpeech } from './types/ConfigSpeech'

/**
 * Pure draft logic for the Settings page's speech editor (mesa task 822),
 * hoisted out of the component so it is unit-testable (see CLAUDE.md: the
 * frontend tests cover the pure modules, never a rendered tree).
 *
 * The same rule [`watchersDraft`](./watchersDraft.ts) models, for the one value
 * this section edits:
 *
 * - **Blank means "the synthesiser's own default"**, not "silence". A blank box
 *   is PUT as `null`, which removes the key so mesa passes no `-v` at all.
 * - **The voice is edited as text**, even when the box is a `<select>`: an
 *   installed binary mesa could not ask has no list to pick from, and the value
 *   already in the file has to survive that.
 * - **The model** (mesa task 1425) is naru-audio's text-to-speech model, the
 *   same blank-is-default rule; the voices on offer are that model's, so a
 *   model change refetches them and keeps the drafted voice only when the new
 *   model has it ([`voiceForModel`]).
 */

/** The section's boxes as typed: the voice and the text-to-speech model. */
export type SpeechDraft = { voice: string; model: string }

/** The editable text as loaded: an unconfigured voice or model is blank. */
export function draftFrom(speech: ConfigSpeech): SpeechDraft {
  return { voice: speech.voice ?? '', model: speech.model ?? '' }
}

/**
 * Whether the picker can be a list: only when the binary answered
 * `--list-voices` with something. Empty means mesa could not ask, and the box
 * has to accept a typed name instead — never that there are no voices.
 */
export function canPick(voices: string[]): boolean {
  return voices.length > 0
}

/**
 * The options to offer, in the binary's own order, with the drafted voice
 * included even when the list does not have it — otherwise selecting the list
 * would silently rewrite a value the user never touched. `voices` is the list
 * for the drafted model, which may be a refetch rather than the loaded one.
 */
export function options(voices: string[], current: string): string[] {
  const drafted = (current ?? '').trim()
  if (drafted === '' || voices.includes(drafted)) return voices
  return [...voices, drafted]
}

/**
 * Whether there is a model to pick: only naru-audio lists any, so the legacy
 * engine (and a daemon Naru could not ask) shows no model picker at all.
 */
export function canPickModel(speech: ConfigSpeech): boolean {
  return speech.models.length > 0
}

/**
 * The models to offer, in the daemon's order, with the drafted model included
 * when it is not listed — the same no-silent-rewrite rule as [`options`].
 */
export function modelOptions(speech: ConfigSpeech, current: string): string[] {
  const drafted = (current ?? '').trim()
  if (drafted === '' || speech.models.includes(drafted)) return speech.models
  return [...speech.models, drafted]
}

/**
 * The voice to keep once `voices` — the new model's list — has arrived: the
 * drafted one if that model has it, blank (its default voice) if not. An
 * empty list is "Naru could not ask", which proves nothing, so the draft
 * stands.
 */
export function voiceForModel(voice: string, voices: string[]): string {
  const drafted = (voice ?? '').trim()
  if (drafted === '' || voices.length === 0 || voices.includes(drafted)) {
    return voice
  }
  return ''
}

/**
 * The complaint about the model box, or `null` if it is fine. Blank is the
 * daemon's default. Mirrors `core::listen::is_model_name`.
 */
export function modelError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) {
    return 'letters, digits, underscores, dashes and dots only'
  }
  if (trimmed.length > 64) return 'longer than 64 characters'
  return null
}

/**
 * The complaint about the voice box, or `null` if it is fine. Blank is *not* an
 * error — it is the legitimate "use the binary's default", the reset.
 *
 * Mirrors the server's shape rule (`core::speech::is_voice_name`) so a name
 * that could be read as an option is refused before the round trip. Membership
 * in the offered list is deliberately **not** checked here: the server owns
 * that, and it skips it too when it has no list.
 */
export function valueError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)) {
    return 'letters, digits, underscores and dashes only'
  }
  if (trimmed.length > 64) return 'longer than 64 characters'
  return null
}

/**
 * What the **test** button reads while a sample is (or isn't) playing — the
 * three states the Inbox's play button also distinguishes (mesa task 824).
 * Synthesis takes seconds, so "asked for it" and "hearing it" must not look
 * alike; the label and its tooltip come from here together, so the two can
 * never disagree about which control the button currently is.
 *
 * `playing` is only meaningful while a sample exists — a stale `true` with no
 * sample is still "test", because there is nothing to stop.
 */
export function sampleButton(
  sampling: boolean,
  playing: boolean,
): { label: string; title: string } {
  if (!sampling) {
    return { label: 'test', title: 'hear a sentence in this voice' }
  }
  return playing
    ? { label: 'stop', title: 'stop the sample' }
    : { label: 'synthesising…', title: 'stop synthesising this sample' }
}

/** What a box means: a name, or `null` for "the default". */
function valueOf(text: string): string | null {
  const trimmed = (text ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** True when a box differs from what the server last reported. */
export function isDirty(speech: ConfigSpeech, draft: SpeechDraft): boolean {
  return (
    valueOf(draft.voice) !== (speech.voice ?? null) ||
    valueOf(draft.model) !== (speech.model ?? null)
  )
}

/** True when nothing drafted would be rejected by the server. */
export function isSavable(draft: SpeechDraft): boolean {
  return (
    valueError(draft.voice ?? '') === null &&
    modelError(draft.model ?? '') === null
  )
}

/**
 * The subset to PUT: each key only when it actually changed, so the API's
 * "only the keys present are touched" rule keeps two editors from clobbering
 * each other. A box cleared to blank sends `null` — the server's "remove this
 * key", which is the reset to the default.
 */
export function changedSpeech(
  speech: ConfigSpeech,
  draft: SpeechDraft,
): Record<string, string | null> {
  if (!isDirty(speech, draft) || !isSavable(draft)) return {}
  const changed: Record<string, string | null> = {}
  if (valueOf(draft.voice) !== (speech.voice ?? null)) {
    changed.voice = valueOf(draft.voice)
  }
  if (valueOf(draft.model) !== (speech.model ?? null)) {
    changed.model = valueOf(draft.model)
  }
  return changed
}
