import { describe, expect, it } from 'vitest'
import { isNearBottom, newSince, ownTurnSince } from './liveScroll'

describe('isNearBottom', () => {
  it('is true at the very bottom', () => {
    expect(isNearBottom(600, 1000, 400)).toBe(true)
  })
  it('is true within the threshold and false past it', () => {
    expect(isNearBottom(552, 1000, 400)).toBe(true)
    expect(isNearBottom(551, 1000, 400)).toBe(false)
  })
  it('is true when the content does not overflow', () => {
    expect(isNearBottom(0, 300, 400)).toBe(true)
  })
  it('honours a custom threshold', () => {
    expect(isNearBottom(500, 1000, 400, 100)).toBe(true)
    expect(isNearBottom(499, 1000, 400, 100)).toBe(false)
  })
})

describe('newSince', () => {
  it('is 0 while the reader is at the bottom', () => {
    expect(newSince(10, null)).toBe(0)
  })
  it('counts turns arrived since they scrolled away', () => {
    expect(newSince(14, 10)).toBe(4)
  })
  it('never goes negative', () => {
    expect(newSince(3, 10)).toBe(0)
  })
})

describe('ownTurnSince', () => {
  const turns = [
    { id: 4, role: 'naru' },
    { id: 5, role: 'user' },
    { id: 6, role: 'naru' },
  ]
  it('is true for a person turn newer than the last one seen', () => {
    expect(ownTurnSince(turns, 4)).toBe(true)
  })
  it('is false once that turn has been seen', () => {
    expect(ownTurnSince(turns, 5)).toBe(false)
  })
  it('ignores new Naru turns', () => {
    expect(ownTurnSince([...turns, { id: 7, role: 'naru' }], 6)).toBe(false)
  })
})
