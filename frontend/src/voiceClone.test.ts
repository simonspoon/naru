import { describe, expect, it } from 'vitest'
import { addedNote, cloneReady, nameError } from './voiceClone'

const ADDED = { voice: 'amy', duration: 6.2, models: ['qwen3-tts-0.6b-base-mlx'] }

describe('nameError', () => {
  it('holds a name to the voice rule the voice list filters on', () => {
    expect(nameError('amy')).toBeNull()
    expect(nameError('amy_2-b')).toBeNull()
    expect(nameError('Amy Smith')).not.toBeNull()
    expect(nameError('.hidden')).not.toBeNull()
    expect(nameError('a/b')).not.toBeNull()
    expect(nameError('a'.repeat(65))).not.toBeNull()
  })
})

describe('cloneReady', () => {
  const ok = { name: 'amy', text: 'Hello there.', hasClip: true }
  it('needs a good name, a transcript and a clip', () => {
    expect(cloneReady(ok)).toBe(true)
    expect(cloneReady({ ...ok, name: '  ' })).toBe(false)
    expect(cloneReady({ ...ok, name: 'Amy Smith' })).toBe(false)
    expect(cloneReady({ ...ok, text: ' \n ' })).toBe(false)
    expect(cloneReady({ ...ok, hasClip: false })).toBe(false)
  })
})

describe('addedNote', () => {
  it('says to pick it when the drafted model lists it', () => {
    expect(addedNote(ADDED, ['elise', 'amy'])).toBe(
      'Added “amy” — pick it in the voice list above and save.',
    )
  })
  it('names the cloning models when the drafted model does not', () => {
    expect(addedNote(ADDED, ['af_heart'])).toBe(
      'Added “amy”. Only a cloning model lists it: qwen3-tts-0.6b-base-mlx — pick one as the model above to use it.',
    )
  })
  it('says so when no model lists it', () => {
    expect(addedNote({ ...ADDED, models: [] }, [])).toBe(
      'Added “amy”, but naru-audio lists it under none of its models.',
    )
  })
})
