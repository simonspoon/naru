import { describe, expect, it } from 'vitest'
import { wakeWordsError, wakeWordsToSave } from './wakeWords'

describe('wakeWordsToSave', () => {
  it('trims, drops blanks and dedupes ignoring case, keeping the first', () => {
    expect(wakeWordsToSave(['  Computer ', '', '   ', 'computer', 'Jarvis', 'JARVIS'])).toEqual([
      'Computer',
      'Jarvis',
    ])
  })

  it('keeps hyphenated and multi-word phrases as typed', () => {
    expect(wakeWordsToSave(['ok-computer', ' hey  jarvis '])).toEqual(['ok-computer', 'hey  jarvis'])
  })

  it('is empty for an empty draft', () => {
    expect(wakeWordsToSave([])).toEqual([])
  })
})

describe('wakeWordsError', () => {
  it('accepts words and digits, including non-Latin letters', () => {
    expect(wakeWordsError(['Computer', 'R2D2', '電脳機', ''])).toBeNull()
  })

  it('names an entry with no letter or digit', () => {
    expect(wakeWordsError(['okay', '-- !'])).toBe('"-- !" needs at least 3 letters or digits.')
  })

  it('rejects an entry under 3 letters and digits in total', () => {
    for (const bad of ['a', 'it', 'OK', 'o-k']) {
      expect(wakeWordsError(['okay', bad])).toBe(`"${bad}" needs at least 3 letters or digits.`)
    }
    expect(wakeWordsError(['R2D'])).toBeNull()
  })
})
