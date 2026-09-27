import { valueError } from './speechDraft'
import type { AddedVoice } from './types/AddedVoice'

/**
 * Pure logic for the Settings page's **add a cloned voice** form (mesa task
 * 1418), shown only on the naru-audio engine: a name, a clip (WAV or MP3,
 * ~5–15 s of one speaker) and exactly what the clip says, sent to
 * `POST /api/config/speech/voices`. The daemon has the last word on the clip
 * and the name; these rules only keep a request it would refuse from being
 * sent.
 */

/** The form as typed; the clip itself stays in the component. */
export type CloneDraft = { name: string; text: string; hasClip: boolean }

/** What the file picker offers. */
export const CLIP_ACCEPT = '.wav,.mp3,audio/wav,audio/x-wav,audio/mpeg'

/**
 * The complaint about the name box, or `null` if it is fine. Unlike the voice
 * box a blank name is not "default" — a voice needs one — but it is not shown
 * as an error either until something is typed. Otherwise the voice rule
 * (`speechDraft.ts::valueError`, `core::speech::is_voice_name`): a looser
 * name would be added and then never offered in the voice list.
 */
export function nameError(name: string): string | null {
  return valueError(name)
}

/**
 * Whether the form can be sent: a good name, a clip and — only when the
 * drafted model's manifest actually needs one (mesa task 1455,
 * `speechDraft.ts::capsFor`'s `clone_requires_transcript`) — a transcript. A
 * model with no use for a transcript can be cloned from the clip alone.
 */
export function cloneReady(draft: CloneDraft, requiresTranscript: boolean): boolean {
  return (
    draft.name.trim() !== '' &&
    nameError(draft.name) === null &&
    (!requiresTranscript || draft.text.trim() !== '') &&
    draft.hasClip
  )
}

/**
 * The line shown once a voice is added. Cloned voices are listed only by a
 * cloning model, so `voices` — the refetched list for the model drafted
 * above — decides whether it can be picked now or which model to pick first.
 */
export function addedNote(added: AddedVoice, voices: string[]): string {
  const name = `“${added.voice}”`
  if (voices.includes(added.voice)) {
    return `Added ${name} — pick it in the voice list above and save.`
  }
  if (added.models.length > 0) {
    return (
      `Added ${name}. Only a cloning model lists it: ` +
      `${added.models.join(', ')} — pick one as the model above to use it.`
    )
  }
  return `Added ${name}, but naru-audio lists it under none of its models.`
}
