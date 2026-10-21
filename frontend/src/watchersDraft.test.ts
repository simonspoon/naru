import { describe, expect, it } from 'vitest'
import {
  changedWatchers,
  draftFrom,
  isDirty,
  isSavable,
  valueError,
} from './watchersDraft'
import type { ConfigWatchers } from './types/ConfigWatchers'

const DEFAULTED: ConfigWatchers = {
  queue_concurrency: null,
  queue_concurrency_default: 1,
}
const SET: ConfigWatchers = {
  queue_concurrency: 3,
  queue_concurrency_default: 1,
}

describe('draftFrom', () => {
  it('renders an unconfigured value blank and a configured one as text', () => {
    expect(draftFrom(DEFAULTED)).toEqual({ queue_concurrency: '' })
    expect(draftFrom(SET)).toEqual({ queue_concurrency: '3' })
  })

  it('reports a freshly loaded section as pristine', () => {
    expect(isDirty(DEFAULTED, draftFrom(DEFAULTED))).toBe(false)
    expect(isDirty(SET, draftFrom(SET))).toBe(false)
  })
})

describe('valueError', () => {
  it('accepts blank — that is the default, not a mistake', () => {
    expect(valueError('')).toBeNull()
    expect(valueError('   ')).toBeNull()
    expect(isSavable({ queue_concurrency: '' })).toBe(true)
  })

  it('accepts a whole number inside the range, trimmed', () => {
    expect(valueError('1')).toBeNull()
    expect(valueError('20')).toBeNull()
    expect(valueError(' 3 ')).toBeNull()
  })

  it('rejects anything that is not a whole number', () => {
    expect(valueError('2.5')).toBe('not a whole number')
    expect(valueError('abc')).toBe('not a whole number')
    expect(valueError('1e3')).toBe('not a whole number')
  })

  it('rejects a whole number outside 1..=20', () => {
    expect(valueError('0')).toBe('must be between 1 and 20')
    expect(valueError('21')).toBe('must be between 1 and 20')
    expect(valueError('-1')).toBe('must be between 1 and 20')
    expect(isSavable({ queue_concurrency: '21' })).toBe(false)
  })
})

describe('isDirty', () => {
  it('is true once the box is edited, and for a half-typed value', () => {
    expect(isDirty(DEFAULTED, { queue_concurrency: '4' })).toBe(true)
    expect(isDirty(SET, { queue_concurrency: '3' })).toBe(false)
    expect(isDirty(SET, { queue_concurrency: '' })).toBe(true)
    expect(isDirty(DEFAULTED, { queue_concurrency: '2.5' })).toBe(true)
  })
})

describe('changedWatchers', () => {
  it('sends nothing when the box has not moved', () => {
    expect(changedWatchers(SET, draftFrom(SET))).toEqual({})
    expect(changedWatchers(DEFAULTED, draftFrom(DEFAULTED))).toEqual({})
  })

  it('sends the number as typed, trimmed', () => {
    expect(changedWatchers(DEFAULTED, { queue_concurrency: ' 4 ' })).toEqual({
      queue_concurrency: 4,
    })
  })

  it('sends null for a value cleared back to blank', () => {
    expect(changedWatchers(SET, { queue_concurrency: '' })).toEqual({
      queue_concurrency: null,
    })
  })

  it('never sends a value the server would reject', () => {
    expect(changedWatchers(DEFAULTED, { queue_concurrency: '21' })).toEqual({})
  })
})
