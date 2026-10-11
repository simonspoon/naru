import type { ConfigAudio } from './types/ConfigAudio'
import type { AudioTestResult } from './types/AudioTestResult'
import type { TranscribeStatus } from './types/TranscribeStatus'

/**
 * Pure logic for the Settings page's engine selectors (mesa task 1391):
 * `audio.engine` (which engine the **server** runs speech through) and, via
 * the two engine helpers below, `listen.engine` in
 * [`listenDraft`](./listenDraft.ts). Hoisted out of the component so it is
 * unit-testable (CLAUDE.md: the frontend tests cover the pure modules).
 *
 * An engine is picked from a fixed list, so the draft holds the **effective**
 * engine — the configured one, else the built-in — and a save follows the
 * route's rule that `null` removes the key: picking the built-in sends
 * `null` rather than writing the default into the file. The daemon URL
 * (naru task 1793) is free text: blank is the built-in (`null`), a bare
 * `host[:port]` gets `http://` put in front, and the server's validation
 * stays the authority on anything else.
 */

/** The engines `PUT /api/config/audio` accepts, built-in first. */
export const AUDIO_ENGINES = ['legacy', 'naru-audio']

export type AudioDraft = { engine: string; url: string }

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

/** The form as loaded: the engine in force and the saved URL (blank = built-in). */
export function draftFrom(audio: ConfigAudio): AudioDraft {
  return {
    engine: effective(audio.engine, audio.engine_default),
    url: (audio.url ?? '').trim(),
  }
}

/** The engines to offer for `audio.engine`. */
export function options(audio: ConfigAudio): string[] {
  return engineChoices(audio.engine, AUDIO_ENGINES)
}

/** True when the select differs from what the server last reported. */
export function isDirty(audio: ConfigAudio, draft: AudioDraft): boolean {
  return (
    engineChange(audio.engine, audio.engine_default, draft.engine) !== undefined ||
    urlChange(audio.url, draft.url) !== undefined
  )
}

/** The subset to PUT: `engine` and `url`, each only when it changed. */
export function changedAudio(
  audio: ConfigAudio,
  draft: AudioDraft,
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  const engine = engineChange(audio.engine, audio.engine_default, draft.engine)
  if (engine !== undefined) out.engine = engine
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
 * The engine the server is running now: the saved one, never the draft,
 * normalised the way the server reads it (`config::audio_engine`) — a known
 * engine is kept, and anything else a hand edit left behind (`Legacy`, an
 * unknown word) is the built-in, since that is what the server falls back to.
 */
export function savedEngine(audio: ConfigAudio): string {
  const engine = effective(audio.engine, audio.engine_default)
  return AUDIO_ENGINES.includes(engine) ? engine : audio.engine_default
}

/**
 * The read-only status beside the selector (mesa task 1411): which engine is
 * **in effect** — [`savedEngine`], never the draft — what it runs speech and
 * transcription through, and what `GET /api/live/transcribe`'s probe found.
 * `null` status, or one taken against another engine (the refetch after a
 * save has not landed yet), is still probing. The probe reports only
 * speech-to-text readiness, so nothing is claimed about speech output beyond
 * where it goes. The server's `message` is shown on its own line, verbatim.
 */
export function engineStatus(
  saved: string,
  status: TranscribeStatus | null,
): { headline: string; details: string[] } {
  const daemon = saved === 'naru-audio'
  const headline = daemon
    ? `In effect: naru-audio — speech and transcription through the daemon${
        status?.url ? ` at ${status.url}` : ''
      }`
    : 'In effect: legacy — speech through kokoro-rs, transcription through auris'
  if (!status || status.engine !== saved) return { headline, details: ['Probing…'] }
  const checked = `checked ${status.checked_at}`
  if (!daemon) {
    const stt = status.state === 'ready' ? 'ready' : 'not available'
    return { headline, details: [`Transcription (auris): ${stt} (${checked})`] }
  }
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
