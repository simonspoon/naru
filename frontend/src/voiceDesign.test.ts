import { describe, expect, it } from 'vitest'
import {
  DESCRIPTION_MAX,
  auditionLabel,
  canAudition,
  canKeep,
  canReroll,
  canSave,
  descriptionError,
  type DesignState,
} from './voiceDesign'

const FRESH: DesignState = {
  description: 'A warm, low voice.',
  auditioned: null,
  kept: null,
  busy: null,
}

describe('descriptionError', () => {
  it('is quiet for blank and for anything up to the bound', () => {
    expect(descriptionError('')).toBeNull()
    expect(descriptionError('  ')).toBeNull()
    expect(descriptionError('x'.repeat(DESCRIPTION_MAX))).toBeNull()
    expect(descriptionError(` ${'x'.repeat(DESCRIPTION_MAX)} `)).toBeNull()
  })
  it('refuses past the bound, counting code points as the server does', () => {
    expect(descriptionError('x'.repeat(DESCRIPTION_MAX + 1))).not.toBeNull()
    expect(descriptionError('é'.repeat(DESCRIPTION_MAX))).toBeNull()
    expect(descriptionError('🎙'.repeat(DESCRIPTION_MAX))).toBeNull()
  })
})

describe('audition', () => {
  it('needs a usable description and nothing in flight', () => {
    expect(canAudition(FRESH)).toBe(true)
    expect(canAudition({ ...FRESH, description: ' ' })).toBe(false)
    expect(
      canAudition({ ...FRESH, description: 'x'.repeat(DESCRIPTION_MAX + 1) }),
    ).toBe(false)
    expect(canAudition({ ...FRESH, busy: 'sample' })).toBe(false)
  })
  it('regenerates the same description and auditions a changed one', () => {
    expect(auditionLabel(FRESH)).toBe('audition')
    const heard = { ...FRESH, auditioned: 'A warm, low voice.' }
    expect(auditionLabel(heard)).toBe('regenerate')
    expect(auditionLabel({ ...heard, description: ' A warm, low voice. ' })).toBe(
      'regenerate',
    )
    expect(auditionLabel({ ...heard, description: 'A bright voice.' })).toBe(
      'audition',
    )
  })
})

describe('keep', () => {
  it('keeps only the voice that was heard', () => {
    expect(canKeep(FRESH)).toBe(false)
    const heard = { ...FRESH, auditioned: 'A warm, low voice.' }
    expect(canKeep(heard)).toBe(true)
    expect(canKeep({ ...heard, description: 'A bright voice.' })).toBe(false)
    expect(canKeep({ ...heard, busy: 'reference' })).toBe(false)
  })
  it('re-rolls only a reference that exists', () => {
    expect(canReroll(FRESH)).toBe(false)
    expect(canReroll({ ...FRESH, kept: 'A warm, low voice.' })).toBe(true)
    expect(
      canReroll({ ...FRESH, kept: 'A warm, low voice.', busy: 'reference' }),
    ).toBe(false)
  })
})

describe('canSave', () => {
  const kept = { ...FRESH, kept: 'A warm, low voice.' }
  it('needs a reference clip and a good name', () => {
    expect(canSave(kept, 'warm')).toBe(true)
    expect(canSave(FRESH, 'warm')).toBe(false)
    expect(canSave(kept, '  ')).toBe(false)
    expect(canSave(kept, 'Warm Voice')).toBe(false)
    expect(canSave({ ...kept, busy: 'save' }, 'warm')).toBe(false)
  })
  it('still saves the kept clip after the description is edited', () => {
    expect(canSave({ ...kept, description: 'Something else.' }, 'warm')).toBe(
      true,
    )
  })
})
