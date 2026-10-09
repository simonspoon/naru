import { describe, expect, it } from 'vitest'
import { offerGlows, offerPreview, offerTitle } from './liveOffer'

const offer = { text: 'how do I rebase onto main?', speaker: 'Simon', age_ms: 10 }

describe('offerGlows', () => {
  it('glows for an offer with no live session', () => {
    expect(offerGlows(offer, false)).toBe(true)
  })
  it('does not glow without an offer', () => {
    expect(offerGlows(null, false)).toBe(false)
    expect(offerGlows(undefined, false)).toBe(false)
  })
  it('does not glow while a conversation is live', () => {
    expect(offerGlows(offer, true)).toBe(false)
  })
  it('glows during a live session held in ambient mode', () => {
    expect(offerGlows(offer, true, true)).toBe(true)
    expect(offerGlows(null, true, true)).toBe(false)
  })
})

describe('offerPreview', () => {
  it('flattens whitespace and cuts long text', () => {
    expect(offerPreview('a\n  b')).toBe('a b')
    expect(offerPreview('x'.repeat(200))).toBe(`${'x'.repeat(80)}…`)
  })
})

describe('offerTitle', () => {
  it('names the action and quotes the overheard text', () => {
    expect(offerTitle(offer)).toContain('Naru can help')
    expect(offerTitle(offer)).toContain('how do I rebase')
    expect(offerTitle({ ...offer, text: '  ' })).toBe('Naru can help — start a conversation')
  })
})
