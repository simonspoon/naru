import { describe, expect, it } from 'vitest'
import {
  makePrimary,
  peakLevel,
  silenceVerdictText,
  SILENT_PEAK,
  toggleWake,
  wakeOn,
  wakeVerdictText,
  wakeWordsError,
  wakeWordsToSave,
} from './wakeWords'

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

  it('refuses quotes, newlines, other symbols and over 40 characters, like the server', () => {
    for (const bad of ['Jarvis"', 'Jar\nvis', 'Jarvis!', 'a'.repeat(41)]) {
      expect(wakeWordsError(['okay', bad])).toMatch(/may hold only letters/)
    }
    expect(wakeWordsError(["O'Neil", 'Mr. Robot', 'Hey-Computer', 'a'.repeat(40)])).toBeNull()
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

describe('makePrimary', () => {
  it('moves the word to the front, keeping the rest in order', () => {
    expect(makePrimary(['Naru', 'Computer', 'Jarvis'], 'Jarvis')).toEqual(['Jarvis', 'Naru', 'Computer'])
  })

  it('leaves the list alone for the first word or an unknown one', () => {
    expect(makePrimary(['Naru', 'Jarvis'], 'Naru')).toEqual(['Naru', 'Jarvis'])
    expect(makePrimary(['Naru'], 'nope')).toEqual(['Naru'])
  })
})

describe('toggleWake', () => {
  it('off empties the draft and remembers it; on restores it', () => {
    const off = toggleWake(['Jarvis', 'Naru'], [], false)
    expect(off).toEqual({ words: [], remembered: ['Jarvis', 'Naru'] })
    expect(toggleWake(off.words, off.remembered, true).words).toEqual(['Jarvis', 'Naru'])
  })

  it('on with nothing remembered falls back to Naru', () => {
    expect(toggleWake([], [], true)).toEqual({ words: ['Naru'], remembered: [] })
  })

  it('off on an empty draft keeps what was remembered; on with words is a no-op', () => {
    expect(toggleWake([], ['A b c'], false).remembered).toEqual(['A b c'])
    expect(toggleWake(['Naru'], [], true).words).toEqual(['Naru'])
  })

  it('wakeOn is true iff the list is non-empty', () => {
    expect(wakeOn([])).toBe(false)
    expect(wakeOn(['Naru'])).toBe(true)
  })
})

describe('wakeVerdictText', () => {
  it('names the match and the word on a wake', () => {
    expect(wakeVerdictText({ wake: true, match: 'exact', word: 'Jarvis', reason: 'ok' })).toBe('yes (exact "Jarvis")')
    expect(wakeVerdictText({ wake: true, match: 'sound_alike', word: 'Naru', reason: 'ok' })).toBe(
      'yes (sound-alike "Naru")',
    )
  })

  it('gives the reason when it would not wake', () => {
    expect(wakeVerdictText({ wake: false, match: null, word: null, reason: 'no wake word heard' })).toBe(
      'no (no wake word heard)',
    )
  })
})

describe('peakLevel', () => {
  it('is the loudest absolute sample, 0 for none', () => {
    expect(peakLevel(new Float32Array([0.1, -0.4, 0.3]))).toBeCloseTo(0.4)
    expect(peakLevel(new Float32Array([]))).toBe(0)
  })

  it('reads a lid-closed built-in mic (denormal zeros) as silence, room noise as not', () => {
    expect(peakLevel(new Float32Array(1000).fill(2e-34))).toBeLessThan(SILENT_PEAK)
    expect(peakLevel(new Float32Array([0.002, -0.01, 0.004]))).toBeGreaterThanOrEqual(SILENT_PEAK)
  })
})

describe('silenceVerdictText', () => {
  it('names the device when there is one', () => {
    expect(silenceVerdictText(' MacBook Pro Microphone (Built-in) ')).toBe(
      'no (mic captured silence from "MacBook Pro Microphone (Built-in)"; check the browser\'s input device and permission)',
    )
    expect(silenceVerdictText('')).toBe("no (mic captured silence; check the browser's input device and permission)")
  })
})
