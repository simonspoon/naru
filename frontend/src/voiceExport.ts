import type { VoiceExport } from './types/VoiceExport'
import { nameError } from './voiceClone'

/**
 * Pure logic for the Settings page's **export / import a cloned voice**
 * controls (mesa task 1430), shown only on the naru-audio engine. Export
 * downloads one `naru-voice` file — `GET /api/config/speech/voices/{name}`,
 * the clip byte for byte as base64 plus its transcript; import reads such a
 * file, lets the person pick the name, and sends the clip and transcript
 * through the ordinary add-voice route. The format is documented in
 * `docs/config.md` ("Exporting and importing a cloned voice"): machines may
 * run different Naru versions, so a reader refuses a version it does not know
 * rather than guess at it.
 */

/** The `format` tag every voice file carries (`speech::VOICE_EXPORT_FORMAT`). */
export const VOICE_FORMAT = 'naru-voice'

/** The one file version this build reads and writes (`speech::VOICE_EXPORT_VERSION`). */
export const VOICE_VERSION = 1

/** What the import file picker offers. */
export const VOICE_FILE_ACCEPT = '.json,application/json'

/** The downloaded file's name: `<voice>.naru-voice.json`. */
export function exportFilename(name: string): string {
  return `${name}.${VOICE_FORMAT}.json`
}

/** The file's text as downloaded: the export, pretty-printed, one final newline. */
export function exportText(file: VoiceExport): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

export type ParsedVoice = { voice: VoiceExport } | { error: string }

/** Standard base64, padded — what the daemon writes for `ref.wav`. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Parses and checks a voice file's text. Total — never throws — so the page
 * shows whatever comes back. Only catches what a client usefully can before
 * the round trip; the server and the daemon still judge the name, the clip
 * and the transcript on import. The name comes back trimmed, since import
 * sends it trimmed. Unknown extra keys are ignored, so a later
 * version-1 writer may add one without breaking this reader.
 */
export function parseVoiceFile(text: string): ParsedVoice {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: 'That file is not valid JSON.' }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { error: 'That file is not a Naru voice file.' }
  }
  const d = data as Record<string, unknown>
  if (d.format !== VOICE_FORMAT) {
    return { error: 'That file is not a Naru voice file (no "format": "naru-voice").' }
  }
  if (typeof d.version !== 'number' || !Number.isInteger(d.version)) {
    return { error: 'That voice file has no version.' }
  }
  if (d.version !== VOICE_VERSION) {
    return {
      error:
        d.version > VOICE_VERSION
          ? `That voice file is version ${d.version}, from a newer Naru; this one reads version ${VOICE_VERSION}.`
          : `That voice file is version ${d.version}; this Naru reads version ${VOICE_VERSION}.`,
    }
  }
  if (typeof d.name !== 'string') {
    return { error: 'That voice file has no "name".' }
  }
  // A blank transcript is not a structural error here: whether one is
  // required depends on the model it would be imported to (mesa task 1455,
  // `importReady`), not on the file. Only "not a string at all" is a
  // malformed file.
  if (typeof d.text !== 'string') {
    return { error: 'That voice file has no transcript ("text").' }
  }
  if (
    typeof d.wav_base64 !== 'string' ||
    d.wav_base64 === '' ||
    !BASE64.test(d.wav_base64)
  ) {
    return { error: 'That voice file has no clip ("wav_base64" is not base64).' }
  }
  // `model` is optional (mesa task 1455): absent on a file exported before
  // it existed, which is always importable, landing on whichever model the
  // import names.
  const model =
    typeof d.model === 'string' && d.model.trim() !== '' ? d.model.trim() : null
  return {
    voice: {
      format: VOICE_FORMAT,
      version: VOICE_VERSION,
      name: d.name.trim(),
      text: d.text,
      wav_base64: d.wav_base64,
      model,
    },
  }
}

/**
 * The complaint about importing `voice` onto `currentModel`, or `null` if
 * there is none (mesa task 1455). A file with no recorded model (older
 * export) is always compatible — it lands on `currentModel`. A file
 * recorded for a *different* model is refused with a message naming both,
 * rather than silently cloning a clip for one model onto another; an
 * unresolved `currentModel` (Naru could not ask which model is current)
 * cannot be checked against, so nothing is refused.
 */
export function importModelError(voice: VoiceExport, currentModel: string): string | null {
  const fileModel = voice.model
  const current = currentModel.trim()
  if (fileModel === null || current === '' || fileModel === current) return null
  return (
    `This voice was cloned for "${fileModel}", not the drafted model "${current}". ` +
    `Pick "${fileModel}" as the model above, or export it again from there.`
  )
}

/**
 * Whether a read file can be imported as `name`: a parsed file on hand, a
 * name that passes the cloned-voice rule (`voiceClone.ts::nameError`), no
 * [`importModelError`], and — only when the current model actually needs
 * one (mesa task 1455) — a non-blank transcript. The name defaults to the
 * file's own and may be changed, so a voice can come back under a new name
 * beside the original.
 */
export function importReady(
  voice: VoiceExport | null,
  name: string,
  currentModel: string,
  requiresTranscript: boolean,
): boolean {
  return (
    voice !== null &&
    name.trim() !== '' &&
    nameError(name) === null &&
    importModelError(voice, currentModel) === null &&
    (!requiresTranscript || voice.text.trim() !== '')
  )
}
