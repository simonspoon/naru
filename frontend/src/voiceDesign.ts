import { nameError } from './voiceClone'
import type { SpeechModelCaps } from './types/SpeechModelCaps'

/**
 * Pure logic for the Settings page's **design a voice** panel (mesa task
 * 1426), shown only on the naru-audio engine. Three steps: describe a voice;
 * **audition** it — the voice-design model reads a short Naru line with the
 * description as `instructions`, as many takes as wanted; **keep** it — the
 * same model reads the longer reference script, which can be re-rolled — and
 * then save that clip under a name through the ordinary add-voice route, with
 * the reference script as its transcript. These rules only keep a request
 * the server would refuse from being sent, and say which step is next.
 */

/** The longest description the server takes (`speech::DESIGN_INSTRUCTIONS_MAX`). */
export const DESCRIPTION_MAX = 500

/**
 * Whether the design panel is offered at all (mesa task 1455): only a model
 * that can both design a voice from a description *and* clone one — the
 * kept take is saved by cloning it onto this same model — qualifies. `null`
 * (the current model's capabilities are not known, e.g. Naru could not ask)
 * offers nothing rather than guess.
 */
export function canDesignVoice(caps: SpeechModelCaps | null): boolean {
  return caps !== null && caps.design && caps.clone
}

/**
 * Where the panel is. `auditioned` is the description the take on hand was
 * made from and `kept` the one the reference clip was read in — each `null`
 * until that step has succeeded; `busy` is the request in flight, if any.
 */
export type DesignState = {
  description: string
  auditioned: string | null
  kept: string | null
  busy: 'sample' | 'reference' | 'save' | null
}

/**
 * The complaint about the description, or `null` if it is fine. Blank is not
 * shown as an error — there is simply nothing to audition yet. Counted in
 * code points, as the server counts characters.
 */
export function descriptionError(description: string): string | null {
  const length = [...description.trim()].length
  if (length > DESCRIPTION_MAX) {
    return `longer than ${DESCRIPTION_MAX} characters (${length})`
  }
  return null
}

function describable(description: string): boolean {
  return description.trim() !== '' && descriptionError(description) === null
}

/** Whether the audition button can be pressed: a usable description, idle. */
export function canAudition(state: DesignState): boolean {
  return state.busy === null && describable(state.description)
}

/**
 * The audition button's word: "regenerate" when the take on hand is of the
 * description as it now reads — another take of the same voice — and
 * "audition" when there is none, or the description has changed since.
 */
export function auditionLabel(state: DesignState): string {
  return state.auditioned !== null &&
    state.auditioned === state.description.trim()
    ? 'regenerate'
    : 'audition'
}

/**
 * Whether keep can be pressed: the take on hand is of the description as it
 * now reads, so what is kept is the voice that was heard.
 */
export function canKeep(state: DesignState): boolean {
  return (
    state.busy === null &&
    state.auditioned !== null &&
    state.auditioned === state.description.trim()
  )
}

/** Whether the reference clip can be re-rolled: one exists, idle. */
export function canReroll(state: DesignState): boolean {
  return state.busy === null && state.kept !== null
}

/**
 * Whether the kept clip can be saved as `name`: a reference clip exists and
 * the name passes the cloned-voice rule (`voiceClone.ts::nameError`).
 */
export function canSave(state: DesignState, name: string): boolean {
  return (
    state.busy === null &&
    state.kept !== null &&
    name.trim() !== '' &&
    nameError(name) === null
  )
}
