import { describe, expect, it } from 'vitest'
import { COMPOSER_REVEAL_ZONE, composerShown, inRevealZone } from './liveComposerReveal'

const idle = { hovered: false, focused: false, draft: '', staged: false }

describe('composerShown', () => {
  it('hides when idle, empty and unfocused', () => {
    expect(composerShown(idle)).toBe(false)
  })
  it('shows on hover, focus, unsent text or a staged picture', () => {
    expect(composerShown({ ...idle, hovered: true })).toBe(true)
    expect(composerShown({ ...idle, focused: true })).toBe(true)
    expect(composerShown({ ...idle, draft: 'hi' })).toBe(true)
    expect(composerShown({ ...idle, draft: ' ' })).toBe(true)
    expect(composerShown({ ...idle, staged: true })).toBe(true)
  })
})

describe('inRevealZone', () => {
  const bottom = 800
  it('is the bottom strip while hidden', () => {
    expect(inRevealZone({ y: bottom - 1, bottom, composerTop: null })).toBe(true)
    expect(inRevealZone({ y: bottom - COMPOSER_REVEAL_ZONE, bottom, composerTop: null })).toBe(true)
    expect(inRevealZone({ y: bottom - COMPOSER_REVEAL_ZONE - 1, bottom, composerTop: null })).toBe(false)
  })
  it('grows to the whole shown box', () => {
    expect(inRevealZone({ y: 690, bottom, composerTop: 680 })).toBe(true)
    expect(inRevealZone({ y: 679, bottom, composerTop: 680 })).toBe(false)
  })
  it('never shrinks below the strip for a short box', () => {
    expect(inRevealZone({ y: bottom - 60, bottom, composerTop: 780 })).toBe(true)
  })
  it('is outside below the chat', () => {
    expect(inRevealZone({ y: bottom + 1, bottom, composerTop: null })).toBe(false)
  })
})
