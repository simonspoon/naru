import { describe, expect, it } from 'vitest'
import {
  VOICE_FORMAT,
  VOICE_VERSION,
  exportFilename,
  exportText,
  importReady,
  parseVoiceFile,
} from './voiceExport'
import type { VoiceExport } from './types/VoiceExport'

const AMY: VoiceExport = {
  format: 'naru-voice',
  version: 1,
  name: 'amy',
  text: 'Hello there.',
  wav_base64: 'UklGRgABAgM=',
}

describe('exportFilename', () => {
  it('names the file after the voice and the format', () => {
    expect(exportFilename('amy')).toBe('amy.naru-voice.json')
  })
})

describe('parseVoiceFile', () => {
  it('round-trips what export writes', () => {
    expect(parseVoiceFile(exportText(AMY))).toEqual({ voice: AMY })
    expect(VOICE_FORMAT).toBe('naru-voice')
    expect(VOICE_VERSION).toBe(1)
  })

  it('ignores keys it does not know', () => {
    expect(
      parseVoiceFile(JSON.stringify({ ...AMY, exported_at: '2026-09-25' })),
    ).toEqual({ voice: AMY })
  })

  it('trims the name', () => {
    expect(
      parseVoiceFile(JSON.stringify({ ...AMY, name: '  amy \n' })),
    ).toEqual({ voice: AMY })
  })

  it('refuses what is not JSON or not a voice file', () => {
    for (const text of ['not json', '[]', 'null', '"x"', '{}']) {
      expect(parseVoiceFile(text)).toHaveProperty('error')
    }
    expect(
      parseVoiceFile(JSON.stringify({ ...AMY, format: 'mesa-library' })),
    ).toHaveProperty('error')
  })

  it('refuses a version it does not read, naming a newer one as such', () => {
    const newer = parseVoiceFile(JSON.stringify({ ...AMY, version: 2 }))
    expect(newer).toEqual({
      error:
        'That voice file is version 2, from a newer Naru; this one reads version 1.',
    })
    for (const version of [0, '1', 1.5, null]) {
      expect(
        parseVoiceFile(JSON.stringify({ ...AMY, version })),
      ).toHaveProperty('error')
    }
    expect(
      parseVoiceFile(JSON.stringify({ ...AMY, version: undefined })),
    ).toHaveProperty('error')
  })

  it('refuses a missing name, a blank transcript or a clip that is not base64', () => {
    for (const bad of [
      { name: 7 },
      { text: '  ' },
      { text: undefined },
      { wav_base64: '' },
      { wav_base64: 'not base64!' },
      { wav_base64: 'UklGR' },
    ]) {
      expect(parseVoiceFile(JSON.stringify({ ...AMY, ...bad }))).toHaveProperty(
        'error',
      )
    }
  })
})

describe('importReady', () => {
  it('needs a file and a good name, which may differ from the file’s', () => {
    expect(importReady(AMY, 'amy')).toBe(true)
    expect(importReady(AMY, 'amy-2')).toBe(true)
    expect(importReady(null, 'amy')).toBe(false)
    expect(importReady(AMY, ' ')).toBe(false)
    expect(importReady(AMY, 'Amy Smith')).toBe(false)
  })
})
