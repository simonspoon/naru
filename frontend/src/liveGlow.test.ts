import { describe, expect, it } from 'vitest'
import { glowColor } from './liveGlow'
import { PALETTES } from './liveMark'

describe('glowColor', () => {
  it('tints the three active states with the mark palette', () => {
    expect(glowColor('speaking')).toBe(PALETTES.speak.glow)
    expect(glowColor('hearing')).toBe(PALETTES.hear.glow)
    expect(glowColor('working')).toBe(PALETTES.think.glow)
    expect(glowColor('resting')).toBe(PALETTES.think.glow)
  })

  it('is off when idle, paused or there is no conversation', () => {
    expect(glowColor('listening')).toBeNull()
    expect(glowColor('paused')).toBeNull()
    expect(glowColor(null)).toBeNull()
  })
})
