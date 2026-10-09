import { describe, expect, it } from 'vitest'
import {
  canPick,
  changedListen,
  draftFrom,
  engineOptions,
  isDirty,
  isSavable,
  options,
  valueError,
  vocabularyError,
  vocabularyNote,
} from './listenDraft'
import type { ConfigListen } from './types/ConfigListen'

const NO_VOCAB = { vocabulary: null, hotword_models: [], default_model: null }
const MODELS = ['parakeet-tdt-0.6b-v2-int8', 'whisper-base', 'whisper-large-v3']
const DEFAULTED: ConfigListen = { model: null, models: MODELS, engine: null, engine_default: 'server', ...NO_VOCAB }
const SET: ConfigListen = { model: 'whisper-base', models: MODELS, engine: null, engine_default: 'server', ...NO_VOCAB }
/** What a machine with no `auris` installed reports. */
const NO_BINARY: ConfigListen = { model: 'whisper-base', models: [], engine: null, engine_default: 'server', ...NO_VOCAB }

describe('draftFrom', () => {
  it('renders an unconfigured model blank and a configured one as text', () => {
    expect(draftFrom(DEFAULTED)).toEqual({ model: '', engine: 'server', vocabulary: '' })
    expect(draftFrom(SET)).toEqual({ model: 'whisper-base', engine: 'server', vocabulary: '' })
  })

  it('reports a freshly loaded section as pristine', () => {
    expect(isDirty(DEFAULTED, draftFrom(DEFAULTED))).toBe(false)
    expect(isDirty(SET, draftFrom(SET))).toBe(false)
  })
})

describe('options', () => {
  it('offers a list only when the binary answered', () => {
    expect(canPick(DEFAULTED)).toBe(true)
    expect(canPick(NO_BINARY)).toBe(false)
  })

  it('keeps the binary order and adds nothing when the model is listed', () => {
    expect(options(SET)).toEqual(MODELS)
    expect(options(DEFAULTED)).toEqual(MODELS)
  })

  it('keeps a configured model the binary no longer lists', () => {
    // Otherwise opening the list would silently rewrite a value nobody touched.
    const retired: ConfigListen = { model: 'am-gone', models: MODELS, engine: null, engine_default: 'server', ...NO_VOCAB }
    expect(options(retired)).toEqual([...MODELS, 'am-gone'])
  })
})

describe('valueError', () => {
  it('accepts blank — that is the default, not a mistake', () => {
    expect(valueError('')).toBeNull()
    expect(valueError('   ')).toBeNull()
    expect(isSavable(SET, { model: '', engine: 'server', vocabulary: '' })).toBe(true)
  })

  it('accepts a model name, trimmed', () => {
    expect(valueError('whisper-base')).toBeNull()
    expect(valueError('  whisper-base  ')).toBeNull()
    expect(valueError('v2')).toBeNull()
  })

  it('accepts a dot — the real model names have version numbers in them', () => {
    expect(valueError('parakeet-tdt-0.6b-v2-int8')).toBeNull()
  })

  it('refuses a leading dot', () => {
    expect(valueError('.hidden')).not.toBeNull()
  })

  it('refuses anything that could reach the argv as an option', () => {
    expect(valueError('-o')).not.toBeNull()
    expect(valueError('--model x')).not.toBeNull()
    expect(valueError('whisper base')).not.toBeNull()
    expect(valueError('whisper/base')).not.toBeNull()
    expect(valueError('whisper-base; rm -rf /')).not.toBeNull()
    expect(valueError('a'.repeat(65))).not.toBeNull()
    expect(isSavable(SET, { model: '-o', engine: 'server', vocabulary: '' })).toBe(false)
  })
})

describe('changedListen', () => {
  it('sends nothing when nothing changed', () => {
    expect(changedListen(SET, draftFrom(SET))).toEqual({})
  })

  it('sends the new model, trimmed', () => {
    expect(changedListen(SET, { model: ' parakeet-tdt-0.6b-v2-int8 ', engine: 'server', vocabulary: '' })).toEqual(
      { model: 'parakeet-tdt-0.6b-v2-int8' },
    )
  })

  it('sends null when the box is cleared — the reset', () => {
    expect(changedListen(SET, { model: '', engine: 'server', vocabulary: '' })).toEqual({ model: null })
  })

  it('sends nothing the server would reject', () => {
    expect(changedListen(SET, { model: '-o', engine: 'server', vocabulary: '' })).toEqual({})
  })
})

describe('engine', () => {
  const BROWSER: ConfigListen = { ...SET, engine: 'browser' }

  it('drafts the engine in force and offers both, keeping a hand edit', () => {
    expect(draftFrom(BROWSER).engine).toBe('browser')
    expect(engineOptions(SET)).toEqual(['server', 'browser'])
    expect(engineOptions({ ...SET, engine: 'whisper' })).toEqual(['server', 'browser', 'whisper'])
    expect(isDirty(BROWSER, draftFrom(BROWSER))).toBe(false)
  })

  it('sends only the engine when only the engine changed', () => {
    const draft = { ...draftFrom(SET), engine: 'browser' }
    expect(isDirty(SET, draft)).toBe(true)
    expect(changedListen(SET, draft)).toEqual({ engine: 'browser' })
  })

  it('sends null to go back to the built-in engine', () => {
    expect(changedListen(BROWSER, { ...draftFrom(BROWSER), engine: 'server' })).toEqual({ engine: null })
  })

  it('sends both keys when both changed', () => {
    expect(changedListen(SET, { model: '', engine: 'browser', vocabulary: '' })).toEqual({ model: null, engine: 'browser' })
  })

  it('holds the engine back when the user typed a model the server would reject', () => {
    expect(changedListen(SET, { model: '-o', engine: 'browser', vocabulary: '' })).toEqual({})
  })

  it('saves the engine alone past a bad model already in the file', () => {
    const HAND_EDITED: ConfigListen = { ...SET, model: 'whisper/base' }
    const draft = { ...draftFrom(HAND_EDITED), engine: 'browser' }
    expect(isSavable(HAND_EDITED, draft)).toBe(true)
    expect(changedListen(HAND_EDITED, draft)).toEqual({ engine: 'browser' })
  })
})

describe('vocabulary', () => {
  const WITH: ConfigListen = { ...SET, vocabulary: 'Naru :4\nkhora' }

  it('drafts the stored text and is pristine until edited', () => {
    expect(draftFrom(WITH).vocabulary).toBe('Naru :4\nkhora')
    expect(isDirty(WITH, draftFrom(WITH))).toBe(false)
    expect(changedListen(WITH, draftFrom(WITH))).toEqual({})
  })

  it('sends the trimmed text when changed and null when cleared', () => {
    expect(changedListen(SET, { ...draftFrom(SET), vocabulary: ' Naru :4\n' })).toEqual({
      vocabulary: 'Naru :4',
    })
    expect(changedListen(WITH, { ...draftFrom(WITH), vocabulary: '  \n' })).toEqual({
      vocabulary: null,
    })
  })

  it('holds back a save the server would refuse, but not past a bad stored one', () => {
    const bad = { ...draftFrom(SET), vocabulary: 'a/b' }
    expect(isSavable(SET, bad)).toBe(false)
    expect(changedListen(SET, bad)).toEqual({})
    const HAND_EDITED: ConfigListen = { ...SET, vocabulary: 'a/b' }
    const draft = { ...draftFrom(HAND_EDITED), engine: 'browser' }
    expect(isSavable(HAND_EDITED, draft)).toBe(true)
  })

  it('accepts the grammar', () => {
    expect(vocabularyError('')).toBeNull()
    expect(vocabularyError('# note\n\nNaru\nhello world :0.5 # x\nkhora :8')).toBeNull()
  })

  it('names the line of each error', () => {
    expect(vocabularyError('ok\na/b')).toBe('line 2: a term cannot contain "/"')
    expect(vocabularyError('Naru :fast')).toContain('line 1: the boost "fast" is not a number')
    expect(vocabularyError('Naru:4')).toContain('line 1: "Naru:4" has a ":" inside a word')
    expect(vocabularyError('\n:4')).toBe('line 2: a stray ":" where the term should be')
    expect(vocabularyError('Naru :0')).toContain('must be above 0 and at most 8')
    expect(vocabularyError('Naru :8.5')).toContain('must be above 0 and at most 8')
    expect(vocabularyError('Naru :')).toContain('is not a number')
    expect(vocabularyError('a\u0007b')).toContain('control character')
  })

  it('limits a term to 64 bytes and the list to 128 terms', () => {
    expect(vocabularyError('a'.repeat(64))).toBeNull()
    expect(vocabularyError('a'.repeat(65))).toContain('line 1: the term is 65 bytes')
    expect(vocabularyError('é'.repeat(33))).toContain('66 bytes')
    const many = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join('\n')
    expect(vocabularyError(many(128))).toBeNull()
    expect(vocabularyError(many(129))).toBe('129 terms; at most 128')
  })

  it('says whether the engine and model use the vocabulary', () => {
    const daemon: ConfigListen = {
      ...SET,
      model: null,
      hotword_models: ['parakeet-tdt-0.6b-v2-int8'],
      default_model: 'whisper-base',
    }
    expect(vocabularyNote(daemon, null)).toBeNull()
    expect(vocabularyNote(daemon, 'legacy')).toBe('Vocabulary is used only with the Naru Audio engine.')
    // No configured model: the daemon's default is judged.
    expect(vocabularyNote(daemon, 'naru-audio')).toBe(
      'whisper-base ignores the vocabulary; a model such as parakeet-tdt-0.6b-v2-int8 uses it.',
    )
    expect(vocabularyNote({ ...daemon, model: 'parakeet-tdt-0.6b-v2-int8' }, 'naru-audio')).toBeNull()
    // An MLX-only daemon: no alternative to name, but the model still ignores it.
    expect(vocabularyNote({ ...daemon, hotword_models: [] }, 'naru-audio')).toBe(
      'whisper-base ignores the vocabulary.',
    )
    expect(
      vocabularyNote({ ...daemon, model: 'whisper-large-v3', hotword_models: [] }, 'naru-audio'),
    ).toBe('whisper-large-v3 ignores the vocabulary.')
    // Effective model unknown: claim nothing.
    expect(vocabularyNote({ ...daemon, default_model: null }, 'naru-audio')).toBeNull()
  })
})
