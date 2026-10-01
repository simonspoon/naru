import { describe, expect, it } from 'vitest'
import {
  canPick,
  canPickModel,
  capsFor,
  changedSpeech,
  draftFrom,
  effectiveModel,
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
import type { SpeechModelCaps } from './types/SpeechModelCaps'

const VOICES = ['af_heart', 'bm_george', 'zf_xiaoni']
const MODELS = ['kokoro-v1.0', 'pocket-tts-int8']
const CAPS: SpeechModelCaps[] = [
  {
    model: 'kokoro-v1.0',
    default: true,
    clone: false,
    clone_requires_transcript: false,
    design: false,
  },
  {
    model: 'pocket-tts-int8',
    default: false,
    clone: true,
    clone_requires_transcript: true,
    design: true,
  },
]
const DEFAULTED: ConfigSpeech = {
  voice: null,
  voices: VOICES,
  model: null,
  cloned: [],
  models: [],
  capabilities: [],
  speed: 1,
}
const SET: ConfigSpeech = {
  voice: 'bm_george',
  voices: VOICES,
  model: null,
  cloned: [],
  models: [],
  capabilities: [],
  speed: 1,
}
/** What a machine with no synthesiser installed reports. */
const NO_BINARY: ConfigSpeech = {
  voice: 'bm_george',
  voices: [],
  model: null,
  cloned: [],
  models: [],
  capabilities: [],
  speed: 1,
}
/** naru-audio, with a model chosen (mesa task 1425). */
const DAEMON: ConfigSpeech = {
  voice: 'bm_george',
  voices: VOICES,
  model: 'kokoro-v1.0',
  cloned: [],
  models: MODELS,
  capabilities: CAPS,
  speed: 1,
}

describe('draftFrom', () => {
  it('renders an unconfigured voice blank and a configured one as text', () => {
    expect(draftFrom(DEFAULTED)).toEqual({ voice: '', model: '', speed: 1 })
    expect(draftFrom(SET)).toEqual({ voice: 'bm_george', model: '', speed: 1 })
    expect(draftFrom(DAEMON)).toEqual({
      voice: 'bm_george',
      model: 'kokoro-v1.0',
      speed: 1,
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

  it('keeps a configured voice when Naru could not ask at all', () => {
    // An empty list proves nothing, so the box must still hold what is
    // configured rather than silently rewrite it.
    expect(options([], 'am_gone')).toEqual(['am_gone'])
  })

  it('drops a drafted voice a non-empty list does not have', () => {
    // mesa task 1455: the Breeze-shows-Qwen-voices bug. Once a model's own
    // list actually answers, a voice from a different model must not
    // silently ride along as if this model offered it.
    expect(options(VOICES, 'am_gone')).toEqual(VOICES)
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

  it('clears the voice on a model switch even when the new list is empty', () => {
    // mesa task 1455: a model switch is a genuinely different voice set, so
    // a voice left over from the previous model must not silently ride
    // along onto one that was never asked whether it has it.
    expect(voiceForModel('bm_george', [])).toBe('')
    expect(voiceForModel('', [])).toBe('')
  })

  it('checks the model name shape, dots allowed, blank is the default', () => {
    expect(modelError('')).toBeNull()
    expect(modelError('kokoro-v1.0')).toBeNull()
    expect(modelError('-o')).not.toBeNull()
    expect(modelError('a b')).not.toBeNull()
    expect(modelError('a'.repeat(65))).not.toBeNull()
    expect(isSavable({ voice: '', model: '-o', speed: 1 })).toBe(false)
  })

  it('sends only the keys that changed, null for a cleared model', () => {
    expect(
      changedSpeech(DAEMON, { voice: 'bm_george', model: 'pocket-tts-int8', speed: 1 }),
    ).toEqual({ model: 'pocket-tts-int8' })
    expect(
      changedSpeech(DAEMON, { voice: '', model: 'pocket-tts-int8', speed: 1 }),
    ).toEqual({ voice: null, model: 'pocket-tts-int8' })
    expect(changedSpeech(DAEMON, { voice: 'bm_george', model: '', speed: 1 })).toEqual({
      model: null,
    })
  })
})

describe('effectiveModel and capsFor (mesa task 1455)', () => {
  it('resolves a blank draft to naru-audios own default model', () => {
    expect(effectiveModel('', CAPS)).toBe('kokoro-v1.0')
  })

  it('resolves a typed draft to itself, trimmed, whether or not it is known', () => {
    expect(effectiveModel(' pocket-tts-int8 ', CAPS)).toBe('pocket-tts-int8')
    expect(effectiveModel('gone-1.0', CAPS)).toBe('gone-1.0')
  })

  it('resolves to nothing when neither the draft nor a default is known', () => {
    expect(effectiveModel('', [])).toBe('')
  })

  it('finds a models capabilities, or null when it is not on the list', () => {
    expect(capsFor('pocket-tts-int8', CAPS)).toEqual(CAPS[1])
    expect(capsFor('gone-1.0', CAPS)).toBeNull()
  })
})

describe('valueError', () => {
  it('accepts blank — that is the default, not a mistake', () => {
    expect(valueError('')).toBeNull()
    expect(valueError('   ')).toBeNull()
    expect(isSavable({ voice: '', model: '', speed: 1 })).toBe(true)
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
    expect(isSavable({ voice: '-o', model: '', speed: 1 })).toBe(false)
  })
})

describe('speed (mesa task 1560)', () => {
  it('loads the saved speed into the draft', () => {
    expect(draftFrom({ ...SET, speed: 1.25 }).speed).toBe(1.25)
  })

  it('is dirty and sent as a number when the slider moves', () => {
    const draft = { ...draftFrom(SET), speed: 1.25 }
    expect(isDirty(SET, draft)).toBe(true)
    expect(changedSpeech(SET, draft)).toEqual({ speed: 1.25 })
  })

  it('sends null when the slider returns to 1 — the reset', () => {
    const saved = { ...SET, speed: 1.25 }
    expect(changedSpeech(saved, { ...draftFrom(saved), speed: 1 })).toEqual({
      speed: null,
    })
  })

  it('is clean at the saved speed', () => {
    const saved = { ...SET, speed: 0.8 }
    expect(isDirty(saved, draftFrom(saved))).toBe(false)
    expect(changedSpeech(saved, draftFrom(saved))).toEqual({})
  })
})

describe('changedSpeech', () => {
  it('sends nothing when nothing changed', () => {
    expect(changedSpeech(SET, draftFrom(SET))).toEqual({})
  })

  it('sends the new voice, trimmed', () => {
    expect(changedSpeech(SET, { voice: ' af_heart ', model: '', speed: 1 })).toEqual({
      voice: 'af_heart',
    })
  })

  it('sends null when the box is cleared — the reset', () => {
    expect(changedSpeech(SET, { voice: '', model: '', speed: 1 })).toEqual({ voice: null })
  })

  it('sends nothing the server would reject', () => {
    expect(changedSpeech(SET, { voice: '-o', model: '', speed: 1 })).toEqual({})
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
