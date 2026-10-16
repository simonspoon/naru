import type { ConfigAudio } from './types/ConfigAudio'
import type { AudioTestResult } from './types/AudioTestResult'
import type { TranscribeStatus } from './types/TranscribeStatus'

/**
 * Pure logic for the Settings page's Audio section and, via the two engine
 * helpers below, the `listen.engine` selector in
 * [`listenDraft`](./listenDraft.ts). Hoisted out of the component so it is
 * unit-testable (CLAUDE.md: the frontend tests cover the pure modules).
 *
 * The naru-audio daemon is the only speech engine (naru task 1386 retired
 * `auris` and `kokoro-rs`), so the only audio setting is the daemon URL
 * (naru task 1793): free text, blank is the built-in (`null`), a bare
 * `host[:port]` gets `http://` put in front, and the server's validation
 * stays the authority on anything else.
 */

/** The one speech engine: the naru-audio daemon. */
export const AUDIO_ENGINE = 'naru-audio'

export type AudioDraft = { url: string }

/** The engine in force: the configured one, else the built-in. */
function effective(configured: string | null, fallback: string): string {
  const trimmed = (configured ?? '').trim()
  return trimmed === '' ? fallback : trimmed
}

/**
 * The options to offer: the known engines, plus a configured value that is
 * not one of them (a hand edit) so the select shows the file rather than
 * silently rewriting a value nobody touched.
 */
export function engineChoices(configured: string | null, known: string[]): string[] {
  const trimmed = (configured ?? '').trim()
  if (trimmed === '' || known.includes(trimmed)) return known
  return [...known, trimmed]
}

/**
 * What to PUT for a drafted engine: `undefined` when it is already the one
 * in force (send no key), `null` when it is the built-in (remove the key),
 * else the engine itself.
 */
export function engineChange(
  configured: string | null,
  fallback: string,
  drafted: string,
): string | null | undefined {
  if (drafted === effective(configured, fallback)) return undefined
  return drafted === fallback ? null : drafted
}

/**
 * The URL to send for typed text: `null` for blank (the built-in), else the
 * trimmed text with `http://` prefixed when it names no scheme.
 */
export function normalizeUrl(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return trimmed.includes('://') ? trimmed : `http://${trimmed}`
}

/** `undefined` when the typed URL is already the saved one, else what to PUT. */
export function urlChange(configured: string | null, drafted: string): string | null | undefined {
  const saved = (configured ?? '').trim() || null
  const next = normalizeUrl(drafted)
  return next === saved ? undefined : next
}

/** The form as loaded: the saved URL (blank = built-in). */
export function draftFrom(audio: ConfigAudio): AudioDraft {
  return { url: (audio.url ?? '').trim() }
}

/** True when the typed URL differs from what the server last reported. */
export function isDirty(audio: ConfigAudio, draft: AudioDraft): boolean {
  return urlChange(audio.url, draft.url) !== undefined
}

/** The subset to PUT: `url`, only when it changed. */
export function changedAudio(
  audio: ConfigAudio,
  draft: AudioDraft,
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  const url = urlChange(audio.url, draft.url)
  if (url !== undefined) out.url = url
  return out
}

/** The note shown when an environment variable overrides the saved URL, else `null`. */
export function envNote(audio: ConfigAudio): string | null {
  return audio.url_env
    ? `NARU_AUDIO_URL=${audio.url_env} overrides this setting on this server. The saved value applies when the variable is removed.`
    : null
}

/** The sentence for a "test connection" answer. */
export function testResultLine(result: AudioTestResult): string {
  const where = result.url
  switch (result.state) {
    case 'ready':
      return `Reachable and ready at ${where}`
    case 'daemon_down':
      return `Not reachable at ${where}`
    case 'model_missing':
      return `Reachable at ${where}, but its speech-to-text model is missing`
    case 'incompatible':
      return `Reachable at ${where}, but it speaks an incompatible API version`
    default:
      return `Error from ${where}`
  }
}

/**
 * The read-only status above the daemon address: what speech and
 * transcription run through, and what `GET /api/live/transcribe`'s probe
 * found (mesa task 1411). `null` status is still probing. The probe reports
 * only speech-to-text readiness, so nothing is claimed about speech output
 * beyond where it goes. The server's `message` is shown on its own line,
 * verbatim.
 */
export function engineStatus(status: TranscribeStatus | null): {
  headline: string
  details: string[]
} {
  const headline = `Speech and transcription run through the naru-audio daemon${
    status?.url ? ` at ${status.url}` : ''
  }`
  if (!status) return { headline, details: ['Probing…'] }
  const checked = `checked ${status.checked_at}`
  if (status.state === 'daemon_down') {
    return { headline, details: [`Daemon: not reachable (${checked})`] }
  }
  // `error` is also a transport failure or a /health that answered badly, so
  // it claims nothing about reachability; the verbatim message says which.
  if (status.state === 'error') {
    return { headline, details: [`Daemon: error (${checked})`] }
  }
  const stt =
    status.state === 'incompatible' ? 'unknown (incompatible API)' : status.state.replace(/_/g, ' ')
  return {
    headline,
    details: [`Daemon: reachable (${checked})`, `Transcription (STT): ${stt}`],
  }
}
