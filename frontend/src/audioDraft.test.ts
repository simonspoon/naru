import { describe, expect, it } from 'vitest'
import {
  changedAudio,
  draftFrom,
  engineChange,
  engineChoices,
  engineStatus,
  envNote,
  isDirty,
  normalizeUrl,
  testResultLine,
  urlChange,
} from './audioDraft'
import type { ConfigAudio } from './types/ConfigAudio'
import type { TranscribeStatus } from './types/TranscribeStatus'

const UNSET: ConfigAudio = {
  url: null,
  url_default: 'http://127.0.0.1:7870',
  url_env: null,
}

describe('draftFrom', () => {
  it('shows the saved url, blank when unset', () => {
    expect(draftFrom(UNSET)).toEqual({ url: '' })
    expect(draftFrom({ ...UNSET, url: ' http://h:1 ' })).toEqual({ url: 'http://h:1' })
  })

  it('reports a freshly loaded section as pristine', () => {
    for (const audio of [UNSET, { ...UNSET, url: 'http://h:1' }]) {
      expect(isDirty(audio, draftFrom(audio))).toBe(false)
      expect(changedAudio(audio, draftFrom(audio))).toEqual({})
    }
  })
})

describe('engineChoices / engineChange (shared with the listen engine select)', () => {
  it('keeps a hand-edited value so the select does not rewrite it', () => {
    expect(engineChoices(null, ['a', 'b'])).toEqual(['a', 'b'])
    expect(engineChoices('c', ['a', 'b'])).toEqual(['a', 'b', 'c'])
  })

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
  const probe = (state: TranscribeStatus['state']): TranscribeStatus => ({
    available: state === 'ready',
    state,
    engine: 'naru-audio',
    url,
    message: state === 'ready' ? null : "Speech isn't available",
    checked_at: at,
    version_warning: null,
  })

  it('names the daemon URL, its reachability and STT readiness', () => {
    expect(engineStatus(probe('ready'))).toEqual({
      headline: `Speech and transcription run through the naru-audio daemon at ${url}`,
      details: [`Daemon: reachable (checked ${at})`, 'Transcription (STT): ready'],
    })
    expect(engineStatus(probe('model_missing')).details).toEqual([
      `Daemon: reachable (checked ${at})`,
      'Transcription (STT): model missing',
    ])
    expect(engineStatus(probe('incompatible')).details[1]).toBe(
      'Transcription (STT): unknown (incompatible API)',
    )
    expect(engineStatus(probe('daemon_down')).details).toEqual([
      `Daemon: not reachable (checked ${at})`,
    ])
    // `error` may be a transport failure or a bad /health: no reachability claim.
    expect(engineStatus(probe('error')).details).toEqual([`Daemon: error (checked ${at})`])
  })

  it('is still probing with no answer', () => {
    expect(engineStatus(null)).toEqual({
      headline: 'Speech and transcription run through the naru-audio daemon',
      details: ['Probing…'],
    })
  })
})

describe('audio url (naru task 1793)', () => {
  it('normalizes: blank is null, a bare host gets http://, a scheme is kept', () => {
    expect(normalizeUrl('  ')).toBeNull()
    expect(normalizeUrl(' 10.0.0.5:7870 ')).toBe('http://10.0.0.5:7870')
    expect(normalizeUrl('studio.local')).toBe('http://studio.local')
    expect(normalizeUrl('http://a:1')).toBe('http://a:1')
    expect(normalizeUrl('https://a:1')).toBe('https://a:1')
  })

  it('seeds the draft from the saved url and is pristine', () => {
    const saved: ConfigAudio = { ...UNSET, url: 'http://10.0.0.5:7870' }
    expect(draftFrom(saved)).toEqual({ url: 'http://10.0.0.5:7870' })
    expect(isDirty(saved, draftFrom(saved))).toBe(false)
    expect(changedAudio(saved, draftFrom(saved))).toEqual({})
  })

  it('sends the normalized url when changed and null when cleared', () => {
    expect(changedAudio(UNSET, { url: '10.0.0.5' })).toEqual({ url: 'http://10.0.0.5' })
    const saved: ConfigAudio = { ...UNSET, url: 'http://10.0.0.5:7870' }
    expect(changedAudio(saved, { url: ' ' })).toEqual({ url: null })
    expect(isDirty(saved, { url: '10.0.0.5:7870' })).toBe(false)
    expect(urlChange(null, '')).toBeUndefined()
  })

  it('notes an environment override only when one is in force', () => {
    expect(envNote(UNSET)).toBeNull()
    expect(envNote({ ...UNSET, url_env: 'http://x:1' })).toContain(
      'NARU_AUDIO_URL=http://x:1 overrides',
    )
  })

  it('words each test answer', () => {
    const r = (state: 'ready' | 'daemon_down' | 'model_missing' | 'incompatible' | 'error') =>
      testResultLine({ url: 'http://h:1', state, message: null, version_warning: null })
    expect(r('ready')).toBe('Reachable and ready at http://h:1')
    expect(r('daemon_down')).toBe('Not reachable at http://h:1')
    expect(r('model_missing')).toContain('model is missing')
    expect(r('incompatible')).toContain('incompatible')
    expect(r('error')).toBe('Error from http://h:1')
  })
})
