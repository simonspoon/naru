import { describe, expect, it } from 'vitest'
import {
  CAPTION_CHARS_PER_SECOND,
  CAPTION_ESTIMATE_CAP,
  captionActive,
  captionHeld,
  captionFraction,
  captionLength,
} from './liveCaption'

const base = {
  captionId: 7,
  turnId: 7,
  heard: false,
  replaying: false,
  speechMuted: false,
  paused: false,
}

describe('captionActive', () => {
  it('paces only the turn the player took in hand', () => {
    expect(captionActive(base)).toBe(true)
    expect(captionActive({ ...base, turnId: 8 })).toBe(false)
    expect(captionActive({ ...base, captionId: null })).toBe(false)
  })
  it('shows full text for heard, replayed, muted and paused turns', () => {
    expect(captionActive({ ...base, heard: true })).toBe(false)
    expect(captionActive({ ...base, replaying: true })).toBe(false)
    expect(captionActive({ ...base, speechMuted: true })).toBe(false)
    expect(captionActive({ ...base, paused: true })).toBe(false)
  })
})

describe('captionHeld', () => {
  const held = {
    captionId: null,
    turnId: 7,
    heard: false,
    captioned: false,
    willSpeak: true,
    unlocked: true,
    paused: false,
  }
  it('holds back a turn this page is about to speak', () => {
    expect(captionHeld(held)).toBe(true)
  })
  it('renders full what the page will not speak or has already handled', () => {
    expect(captionHeld({ ...held, captionId: 7 })).toBe(false)
    expect(captionHeld({ ...held, captioned: true })).toBe(false)
    expect(captionHeld({ ...held, heard: true })).toBe(false)
    expect(captionHeld({ ...held, willSpeak: false })).toBe(false)
    expect(captionHeld({ ...held, unlocked: false })).toBe(false)
    expect(captionHeld({ ...held, paused: true })).toBe(false)
  })
  it('holds a turn queued behind another that is sounding', () => {
    expect(captionHeld({ ...held, captionId: 3 })).toBe(true)
  })
})

describe('captionFraction', () => {
  it('is zero before the audio has a position', () => {
    expect(captionFraction(null, 10, 'hello')).toBe(0)
    expect(captionFraction(0, 10, 'hello')).toBe(0)
    expect(captionFraction(NaN, 10, 'hello')).toBe(0)
  })
  it('is elapsed over a known duration, capped below 1 until playback ends', () => {
    expect(captionFraction(2, 8, 'hello')).toBe(0.25)
    expect(captionFraction(20, 8, 'hello')).toBe(CAPTION_ESTIMATE_CAP)
  })
  it('estimates from the text when the duration is unknown, never reaching 1', () => {
    const text = 'x'.repeat(CAPTION_CHARS_PER_SECOND * 10)
    expect(captionFraction(5, Infinity, text)).toBeCloseTo(0.5)
    expect(captionFraction(5, NaN, text)).toBeCloseTo(0.5)
    expect(captionFraction(5, null, text)).toBeCloseTo(0.5)
    expect(captionFraction(100, Infinity, text)).toBe(CAPTION_ESTIMATE_CAP)
  })
  it('stretches the estimate by the speed of the stretched output clock', () => {
    const text = 'x'.repeat(CAPTION_CHARS_PER_SECOND * 10)
    // 0.75x: ten 1x seconds take 13.33s, so 5s is 0.375 (not ahead at 0.5).
    expect(captionFraction(5, null, text, 0.75)).toBeCloseTo(0.375)
    // 1.5x: 6.67s total, so 5s is 0.75 (not lagging at 0.5).
    expect(captionFraction(5, null, text, 1.5)).toBeCloseTo(0.75)
  })
  it('leaves a known duration (the element path) unscaled by speed', () => {
    expect(captionFraction(2, 8, 'hello', 1.5)).toBe(0.25)
  })
})

describe('captionLength', () => {
  const text = 'one two three four'
  it('shows nothing at 0 and everything at 1', () => {
    expect(captionLength(text, 0)).toBe(0)
    expect(captionLength(text, 1)).toBe(text.length)
    expect(captionLength(text, 1.5)).toBe(text.length)
  })
  it('reveals whole words as the voice reaches them', () => {
    expect(captionLength(text, 0.01)).toBe(3)
    expect(text.slice(0, captionLength(text, 0.3))).toBe('one two')
    expect(text.slice(0, captionLength(text, 0.7))).toBe('one two three four'.slice(0, 13))
    expect(text.slice(0, captionLength(text, 0.95))).toBe(text)
  })
  it('weights words by length and never splits one', () => {
    const t = 'a extraordinarily'
    expect(t.slice(0, captionLength(t, 0.05))).toBe('a')
    expect(t.slice(0, captionLength(t, 0.2))).toBe('a extraordinarily')
  })
  it('handles empty and whitespace-only text', () => {
    expect(captionLength('', 0.5)).toBe(0)
    expect(captionLength('   ', 0.5)).toBe(0)
  })
})
