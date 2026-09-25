import { describe, expect, it } from 'vitest'
import {
  changedAudio,
  draftFrom,
  engineChange,
  engineChoices,
  engineStatus,
  isDirty,
  options,
  savedEngine,
} from './audioDraft'
import type { ConfigAudio } from './types/ConfigAudio'
import type { TranscribeStatus } from './types/TranscribeStatus'

const base = { url: null, url_default: 'http://127.0.0.1:7870', engine_default: 'legacy' }
const UNSET: ConfigAudio = { ...base, engine: null }
const DAEMON: ConfigAudio = { ...base, engine: 'naru-audio' }
const EXPLICIT_LEGACY: ConfigAudio = { ...base, engine: 'legacy' }
/** A hand edit the server would refuse to save. */
const HAND_EDITED: ConfigAudio = { ...base, engine: 'whisper' }

describe('draftFrom', () => {
  it('shows the engine in force: the configured one, else the built-in', () => {
    expect(draftFrom(UNSET)).toEqual({ engine: 'legacy' })
    expect(draftFrom(DAEMON)).toEqual({ engine: 'naru-audio' })
    expect(draftFrom({ ...base, engine: '  ' })).toEqual({ engine: 'legacy' })
  })

  it('reports a freshly loaded section as pristine', () => {
    for (const audio of [UNSET, DAEMON, EXPLICIT_LEGACY, HAND_EDITED]) {
      expect(isDirty(audio, draftFrom(audio))).toBe(false)
      expect(changedAudio(audio, draftFrom(audio))).toEqual({})
    }
  })
})

describe('options', () => {
  it('offers both engines, built-in first', () => {
    expect(options(UNSET)).toEqual(['legacy', 'naru-audio'])
    expect(options(DAEMON)).toEqual(['legacy', 'naru-audio'])
  })

  it('keeps a hand-edited value so the select does not rewrite it', () => {
    expect(options(HAND_EDITED)).toEqual(['legacy', 'naru-audio', 'whisper'])
    expect(engineChoices(null, ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('changedAudio', () => {
  it('sends the daemon engine when picked', () => {
    expect(isDirty(UNSET, { engine: 'naru-audio' })).toBe(true)
    expect(changedAudio(UNSET, { engine: 'naru-audio' })).toEqual({ engine: 'naru-audio' })
  })

  it('sends null to go back to the built-in — the route removes the key', () => {
    expect(changedAudio(DAEMON, { engine: 'legacy' })).toEqual({ engine: null })
    expect(changedAudio(HAND_EDITED, { engine: 'legacy' })).toEqual({ engine: null })
  })

  it('sends nothing when an explicit built-in is picked again', () => {
    expect(changedAudio(EXPLICIT_LEGACY, { engine: 'legacy' })).toEqual({})
  })

  it('never sends a url', () => {
    const withUrl: ConfigAudio = { ...DAEMON, url: 'http://127.0.0.1:9999' }
    expect(changedAudio(withUrl, { engine: 'legacy' })).toEqual({ engine: null })
  })
})

describe('engineChange', () => {
  it('is undefined for the engine in force, null for the built-in, else the engine', () => {
    expect(engineChange(null, 'server', 'server')).toBeUndefined()
    expect(engineChange('browser', 'server', 'browser')).toBeUndefined()
    expect(engineChange('browser', 'server', 'server')).toBeNull()
    expect(engineChange(null, 'server', 'browser')).toBe('browser')
  })
})

describe('engineStatus', () => {
  const at = '2026-09-24T12:00:03Z'
  const url = 'http://127.0.0.1:7870'
  const probe = (engine: string, state: TranscribeStatus['state']): TranscribeStatus => ({
    available: state === 'ready',
    state,
    engine,
    url: engine === 'naru-audio' ? url : null,
    message: state === 'ready' ? null : "Speech isn't available",
    checked_at: at,
  })

  it('names what legacy runs and whether auris is ready', () => {
    expect(engineStatus('legacy', probe('legacy', 'ready'))).toEqual({
      headline: 'In effect: legacy — speech through kokoro-rs, transcription through auris',
      details: [`Transcription (auris): ready (checked ${at})`],
    })
    expect(engineStatus('legacy', probe('legacy', 'error')).details).toEqual([
      `Transcription (auris): not available (checked ${at})`,
    ])
  })

  it('names the daemon URL, its reachability and STT readiness on naru-audio', () => {
    expect(engineStatus('naru-audio', probe('naru-audio', 'ready'))).toEqual({
      headline: `In effect: naru-audio — speech and transcription through the daemon at ${url}`,
      details: [`Daemon: reachable (checked ${at})`, 'Transcription (STT): ready'],
    })
    expect(engineStatus('naru-audio', probe('naru-audio', 'model_missing')).details).toEqual([
      `Daemon: reachable (checked ${at})`,
      'Transcription (STT): model missing',
    ])
    expect(engineStatus('naru-audio', probe('naru-audio', 'incompatible')).details[1]).toBe(
      'Transcription (STT): unknown (incompatible API)',
    )
    expect(engineStatus('naru-audio', probe('naru-audio', 'daemon_down')).details).toEqual([
      `Daemon: not reachable (checked ${at})`,
    ])
    // `error` may be a transport failure or a bad /health: no reachability claim.
    expect(engineStatus('naru-audio', probe('naru-audio', 'error')).details).toEqual([
      `Daemon: error (checked ${at})`,
    ])
  })

  it('reads a hand-edited engine the server does not parse as the built-in', () => {
    for (const engine of ['Legacy', 'kokoro', 'naru_audio']) {
      const saved = savedEngine({ ...base, engine })
      expect(saved).toBe('legacy')
      // The probe answers for legacy, so the status resolves rather than probing forever.
      expect(engineStatus(saved, probe('legacy', 'ready')).details).toEqual([
        `Transcription (auris): ready (checked ${at})`,
      ])
    }
    expect(savedEngine({ ...base, engine: ' naru-audio ' })).toBe('naru-audio')
    expect(savedEngine(UNSET)).toBe('legacy')
  })

  it('is still probing with no answer, or an answer about the other engine', () => {
    expect(engineStatus('naru-audio', null).details).toEqual(['Probing…'])
    // The save landed but the refetched probe has not: never report the old engine's state.
    expect(engineStatus('naru-audio', probe('legacy', 'ready'))).toEqual({
      headline: 'In effect: naru-audio — speech and transcription through the daemon',
      details: ['Probing…'],
    })
  })
})
