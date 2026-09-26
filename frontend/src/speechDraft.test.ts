import { describe, expect, it } from 'vitest'
import {
  canPick,
  canPickModel,
  changedSpeech,
  draftFrom,
  isDirty,
  isSavable,
  modelError,
  modelOptions,
  options,
  sampleButton,
  valueError,
  voiceForModel,
} from './speechDraft'
import type { ConfigSpeech } from './types/ConfigSpeech'

const VOICES = ['af_heart', 'bm_george', 'zf_xiaoni']
const MODELS = ['kokoro-v1.0', 'pocket-tts-int8']
const DEFAULTED: ConfigSpeech = {
  voice: null,
  voices: VOICES,
  model: null,
  cloned: [],
  models: [],
}
const SET: ConfigSpeech = {
  voice: 'bm_george',
  voices: VOICES,
  model: null,
  cloned: [],
  models: [],
}
/** What a machine with no synthesiser installed reports. */
const NO_BINARY: ConfigSpeech = {
  voice: 'bm_george',
  voices: [],
  model: null,
  cloned: [],
  models: [],
}
/** naru-audio, with a model chosen (mesa task 1425). */
const DAEMON: ConfigSpeech = {
  voice: 'bm_george',
  voices: VOICES,
  model: 'kokoro-v1.0',
  cloned: [],
  models: MODELS,
}

describe('draftFrom', () => {
  it('renders an unconfigured voice blank and a configured one as text', () => {
    expect(draftFrom(DEFAULTED)).toEqual({ voice: '', model: '' })
    expect(draftFrom(SET)).toEqual({ voice: 'bm_george', model: '' })
    expect(draftFrom(DAEMON)).toEqual({
      voice: 'bm_george',
      model: 'kokoro-v1.0',
    })
  })

  it('reports a freshly loaded section as pristine', () => {
    expect(isDirty(DEFAULTED, draftFrom(DEFAULTED))).toBe(false)
    expect(isDirty(SET, draftFrom(SET))).toBe(false)
    expect(isDirty(DAEMON, draftFrom(DAEMON))).toBe(false)
  })
})

describe('options', () => {
  it('offers a list only when the binary answered', () => {
    expect(canPick(DEFAULTED.voices)).toBe(true)
    expect(canPick(NO_BINARY.voices)).toBe(false)
  })

  it('keeps the binary order and adds nothing when the voice is listed', () => {
    expect(options(VOICES, 'bm_george')).toEqual(VOICES)
    expect(options(VOICES, '')).toEqual(VOICES)
  })

  it('keeps a configured voice the binary no longer lists', () => {
    // Otherwise opening the list would silently rewrite a value nobody touched.
    expect(options(VOICES, 'am_gone')).toEqual([...VOICES, 'am_gone'])
  })
})

describe('models (mesa task 1425)', () => {
  it('offers a model picker only when naru-audio listed models', () => {
    expect(canPickModel(DAEMON)).toBe(true)
    expect(canPickModel(SET)).toBe(false)
  })

  it('keeps the daemon order and a drafted model it does not list', () => {
    expect(modelOptions(DAEMON, 'kokoro-v1.0')).toEqual(MODELS)
    expect(modelOptions(DAEMON, '')).toEqual(MODELS)
    expect(modelOptions(DAEMON, 'gone-1.0')).toEqual([...MODELS, 'gone-1.0'])
  })

  it('keeps the voice when the new model has it, else its default', () => {
    expect(voiceForModel('bm_george', ['af_heart', 'bm_george'])).toBe(
      'bm_george',
    )
    expect(voiceForModel('bm_george', ['alba'])).toBe('')
    expect(voiceForModel('', ['alba'])).toBe('')
  })

  it('keeps the voice when the new list is empty — Naru could not ask', () => {
    expect(voiceForModel('bm_george', [])).toBe('bm_george')
  })

  it('checks the model name shape, dots allowed, blank is the default', () => {
    expect(modelError('')).toBeNull()
    expect(modelError('kokoro-v1.0')).toBeNull()
    expect(modelError('-o')).not.toBeNull()
    expect(modelError('a b')).not.toBeNull()
    expect(modelError('a'.repeat(65))).not.toBeNull()
    expect(isSavable({ voice: '', model: '-o' })).toBe(false)
  })

  it('sends only the keys that changed, null for a cleared model', () => {
    expect(
      changedSpeech(DAEMON, { voice: 'bm_george', model: 'pocket-tts-int8' }),
    ).toEqual({ model: 'pocket-tts-int8' })
    expect(
      changedSpeech(DAEMON, { voice: '', model: 'pocket-tts-int8' }),
    ).toEqual({ voice: null, model: 'pocket-tts-int8' })
    expect(changedSpeech(DAEMON, { voice: 'bm_george', model: '' })).toEqual({
      model: null,
    })
  })
})

describe('valueError', () => {
  it('accepts blank — that is the default, not a mistake', () => {
    expect(valueError('')).toBeNull()
    expect(valueError('   ')).toBeNull()
    expect(isSavable({ voice: '', model: '' })).toBe(true)
  })

  it('accepts a voice name, trimmed', () => {
    expect(valueError('af_heart')).toBeNull()
    expect(valueError('  bm_george  ')).toBeNull()
    expect(valueError('v2')).toBeNull()
  })

  it('refuses anything that could reach the argv as an option', () => {
    expect(valueError('-o')).not.toBeNull()
    expect(valueError('--voice x')).not.toBeNull()
    expect(valueError('af heart')).not.toBeNull()
    expect(valueError('af_heart; rm -rf /')).not.toBeNull()
    expect(valueError('a'.repeat(65))).not.toBeNull()
    expect(isSavable({ voice: '-o', model: '' })).toBe(false)
  })
})

describe('changedSpeech', () => {
  it('sends nothing when nothing changed', () => {
    expect(changedSpeech(SET, draftFrom(SET))).toEqual({})
  })

  it('sends the new voice, trimmed', () => {
    expect(changedSpeech(SET, { voice: ' af_heart ', model: '' })).toEqual({
      voice: 'af_heart',
    })
  })

  it('sends null when the box is cleared — the reset', () => {
    expect(changedSpeech(SET, { voice: '', model: '' })).toEqual({ voice: null })
  })

  it('sends nothing the server would reject', () => {
    expect(changedSpeech(SET, { voice: '-o', model: '' })).toEqual({})
  })
})

describe('sampleButton', () => {
  it('offers to play when nothing is sampling', () => {
    expect(sampleButton(false, false).label).toBe('test')
  })

  it('separates "asked for it" from "hearing it"', () => {
    expect(sampleButton(true, false).label).toBe('synthesising…')
    expect(sampleButton(true, true).label).toBe('stop')
  })

  it('never lets the tooltip and the label be two different controls', () => {
    // While a sample exists the button stops it, whichever state it is in.
    for (const playing of [false, true]) {
      expect(sampleButton(true, playing).title).toContain('stop')
    }
    expect(sampleButton(false, true)).toEqual(sampleButton(false, false))
  })
})
