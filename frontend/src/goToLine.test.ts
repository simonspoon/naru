import { describe, expect, it } from 'vitest'
import { goToOffset, parseGoToLine } from './goToLine'

describe('parseGoToLine', () => {
  it('reads a line, and a line with a column', () => {
    expect(parseGoToLine('12')).toEqual({ line: 12, col: 1 })
    expect(parseGoToLine('12:5')).toEqual({ line: 12, col: 5 })
    expect(parseGoToLine(' 3 , 4 ')).toEqual({ line: 3, col: 4 })
  })

  it('refuses anything that is not a position', () => {
    for (const bad of ['', ' ', 'abc', '1:', ':3', '1:2:3', '-4', '1.5', '2:x']) {
      expect(parseGoToLine(bad)).toBeNull()
    }
  })
})

describe('goToOffset', () => {
  const text = 'one\ntwo two\n\nfour'

  it('lands on the start of a line', () => {
    expect(goToOffset(text, '1')).toBe(0)
    expect(goToOffset(text, '2')).toBe(4)
    expect(goToOffset(text, '4')).toBe(text.indexOf('four'))
  })

  it('lands on a column within the line', () => {
    expect(goToOffset(text, '2:5')).toBe(8)
  })

  it('clamps the line into the document', () => {
    expect(goToOffset(text, '0')).toBe(0)
    expect(goToOffset(text, '99')).toBe(text.indexOf('four'))
    expect(goToOffset(text, '99:99')).toBe(text.length)
  })

  it('clamps the column to the end of its own line, never the next', () => {
    expect(goToOffset(text, '1:50')).toBe(3)
    expect(goToOffset(text, '3:9')).toBe(text.indexOf('\n\n') + 1)
    expect(goToOffset(text, '2:0')).toBe(4)
  })

  it('counts a trailing newline as a last empty line', () => {
    expect(goToOffset('a\n', '2')).toBe(2)
    expect(goToOffset('', '5:5')).toBe(0)
  })

  it('answers null for input that is not a position', () => {
    expect(goToOffset(text, 'two')).toBeNull()
  })
})
