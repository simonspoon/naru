import { describe, expect, it } from 'vitest'
import {
  VOICE_FORMAT,
  VOICE_VERSION,
  exportFilename,
  exportText,
  importModelError,
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
  model: 'clones',
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

  it('refuses a missing name, a transcript that is not a string, or a clip that is not base64', () => {
    for (const bad of [
      { name: 7 },
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

  it('accepts a blank transcript — whether one is required is the model’s business, not the file’s', () => {
    // mesa task 1455.
    expect(parseVoiceFile(JSON.stringify({ ...AMY, text: '  ' }))).toEqual({
      voice: { ...AMY, text: '  ' },
    })
  })

  it('keeps model as null when the file names none — an older export (mesa task 1455)', () => {
    const noModel = {
      format: AMY.format,
      version: AMY.version,
      name: AMY.name,
      text: AMY.text,
      wav_base64: AMY.wav_base64,
    }
    expect(parseVoiceFile(JSON.stringify(noModel))).toEqual({
      voice: { ...AMY, model: null },
    })
    expect(
      parseVoiceFile(JSON.stringify({ ...AMY, model: '  ' })),
    ).toEqual({ voice: { ...AMY, model: null } })
  })
})

describe('importModelError (mesa task 1455)', () => {
  it('allows a file with no recorded model onto any model', () => {
    expect(importModelError({ ...AMY, model: null }, 'clones')).toBeNull()
    expect(importModelError({ ...AMY, model: null }, '')).toBeNull()
  })

  it('allows a file recorded for the current model', () => {
    expect(importModelError(AMY, 'clones')).toBeNull()
    expect(importModelError(AMY, ' clones ')).toBeNull()
  })

  it('refuses a file recorded for a different model, naming both', () => {
    const err = importModelError(AMY, 'other-model')
    expect(err).toContain('clones')
    expect(err).toContain('other-model')
  })

  it('cannot judge an unresolved current model, so it refuses nothing', () => {
    expect(importModelError(AMY, '')).toBeNull()
  })
})

describe('importReady', () => {
  it('needs a file and a good name, which may differ from the file’s', () => {
    expect(importReady(AMY, 'amy', 'clones', true)).toBe(true)
    expect(importReady(AMY, 'amy-2', 'clones', true)).toBe(true)
    expect(importReady(null, 'amy', 'clones', true)).toBe(false)
    expect(importReady(AMY, ' ', 'clones', true)).toBe(false)
    expect(importReady(AMY, 'Amy Smith', 'clones', true)).toBe(false)
  })

  it('refuses a model mismatch', () => {
    expect(importReady(AMY, 'amy', 'other-model', true)).toBe(false)
  })

  it('needs a transcript only when the current model requires one', () => {
    const blank = { ...AMY, text: '' }
    expect(importReady(blank, 'amy', 'clones', true)).toBe(false)
    expect(importReady(blank, 'amy', 'clones', false)).toBe(true)
  })
})
