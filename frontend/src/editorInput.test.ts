import { describe, expect, it } from 'vitest'
import { detectIndentUnit, replacementRange, tabEscapeAfter } from './editorInput'

describe('replacementRange', () => {
  it('describes an insertion', () => {
    expect(replacementRange('ab', 'a  b')).toEqual({ start: 1, end: 1, text: '  ' })
  })

  it('describes a deletion as an empty replacement', () => {
    expect(replacementRange('  ab', 'ab')).toEqual({ start: 0, end: 2, text: '' })
  })

  it('describes a replacement', () => {
    expect(replacementRange('abcd', 'aXd')).toEqual({ start: 1, end: 3, text: 'X' })
  })

  it('describes no change as an empty range', () => {
    expect(replacementRange('ab', 'ab')).toEqual({ start: 2, end: 2, text: '' })
  })

  it('never overlaps prefix and suffix on repeated characters', () => {
    expect(replacementRange('aa', 'aaa')).toEqual({ start: 2, end: 2, text: 'a' })
    expect(replacementRange('aaa', 'aa')).toEqual({ start: 2, end: 3, text: '' })
  })

  it('reconstructs the target text from the range it answers', () => {
    const cases: Array<[string, string]> = [
      ['ab', 'a  b'],
      ['a\nb\nc', '  a\n  b\n  c'],
      ['  ab', '  a\n  b'],
      ['f()', 'f'],
      ['', 'new file\n'],
      ['all of it', ''],
    ]
    for (const [before, after] of cases) {
      const range = replacementRange(before, after)
      expect(before.slice(0, range.start) + range.text + before.slice(range.end)).toBe(after)
    }
  })
})

describe('detectIndentUnit', () => {
  it('answers the two-space fallback for a file with nothing to learn from', () => {
    expect(detectIndentUnit('')).toBe('  ')
    expect(detectIndentUnit('one\ntwo\nthree\n')).toBe('  ')
  })

  it('reads a four-space file as four spaces', () => {
    const rust = 'fn main() {\n    let a = 1;\n    if a > 0 {\n        run();\n    }\n}\n'
    expect(detectIndentUnit(rust)).toBe('    ')
  })

  it('reads a two-space file as two spaces', () => {
    const ts = 'function f() {\n  const a = 1\n  if (a) {\n    g()\n  }\n}\n'
    expect(detectIndentUnit(ts)).toBe('  ')
  })

  it('reads a tab-indented file as one tab', () => {
    const sh = 'if true; then\n\techo hi\n\tif x; then\n\t\techo deep\n\tfi\nfi\n'
    expect(detectIndentUnit(sh)).toBe('\t')
  })

  it('is not turned into a space file by one aligned continuation', () => {
    expect(detectIndentUnit('\ta\n\tb\n\tc\n  d\n')).toBe('\t')
  })

  it('ignores blank lines that carry only trailing whitespace', () => {
    expect(detectIndentUnit('a\n    \n    b\n    c\n')).toBe('    ')
  })

  it('never answers wider than an alignment-sized indent', () => {
    expect(detectIndentUnit('a\n            b\n            c\n')).toBe('        ')
  })
})

describe('tabEscapeAfter', () => {
  it('is disarmed until Escape is pressed', () => {
    expect(tabEscapeAfter(false, 'a')).toBe(false)
    expect(tabEscapeAfter(false, 'Tab')).toBe(false)
  })

  it('arms on Escape', () => {
    expect(tabEscapeAfter(false, 'Escape')).toBe(true)
    expect(tabEscapeAfter(true, 'Escape')).toBe(true)
  })

  it('disarms on the next typed key, so an unused hatch costs nothing', () => {
    expect(tabEscapeAfter(true, 'a')).toBe(false)
    expect(tabEscapeAfter(true, 'Enter')).toBe(false)
    expect(tabEscapeAfter(true, 'Tab')).toBe(false)
  })

  it('survives a held modifier, so Escape-then-Shift+Tab still escapes', () => {
    expect(tabEscapeAfter(true, 'Shift')).toBe(true)
    expect(tabEscapeAfter(true, 'Meta')).toBe(true)
    expect(tabEscapeAfter(false, 'Shift')).toBe(false)
  })
})
