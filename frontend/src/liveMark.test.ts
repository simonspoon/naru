import { describe, expect, it } from 'vitest'
import {
  BAR_SLOT,
  easeRgb,
  easeToward,
  hexToRgb,
  isSettled,
  levelFromRms,
  markFrame,
  markMode,
  paletteFor,
  PALETTES,
  shimmer,
} from './liveMark'
import type { LiveIndicator } from './liveIndicator'

describe('markMode', () => {
  it('maps every ranked state to one of the mockup looks', () => {
    const want: Record<LiveIndicator, string> = {
      speaking: 'speak',
      hearing: 'hear',
      working: 'think',
      resting: 'think',
      listening: 'idle',
      paused: 'paused',
    }
    for (const [state, mode] of Object.entries(want)) {
      expect(markMode(state as LiveIndicator)).toBe(mode)
    }
    expect(markMode(null)).toBe('idle')
  })
})

describe('palettes', () => {
  it('match the approved mockup', () => {
    expect(PALETTES.idle.bars).toEqual(['#3b3550', '#4a4366', '#5b537c', '#6d6592'])
    expect(PALETTES.hear.bars).toEqual(['#1f7fff', '#1fb6ff', '#29e6ff', '#b8f6ff'])
    expect(PALETTES.speak.bars).toEqual(['#ff5a3c', '#ff8a2b', '#ffb02b', '#ffe2a8'])
    expect(PALETTES.think.bars).toEqual(['#6a2bff', '#8a4bff', '#b06bff', '#e6d1ff'])
  })
  it('gives paused idle colours, and the favicon bars map symmetrically', () => {
    expect(paletteFor('paused')).toBe(PALETTES.idle)
    expect(BAR_SLOT).toEqual([0, 1, 2, 3, 2, 1, 0])
    expect(hexToRgb('#29e6ff')).toEqual([0x29, 0xe6, 0xff])
  })
})

describe('levelFromRms', () => {
  it('is silent under the floor, monotonic and capped at 1', () => {
    expect(levelFromRms(0)).toBe(0)
    expect(levelFromRms(0.002)).toBe(0)
    expect(levelFromRms(NaN)).toBe(0)
    expect(levelFromRms(0.05)).toBeLessThan(levelFromRms(0.1))
    expect(levelFromRms(0.1)).toBeLessThan(levelFromRms(0.2))
    expect(levelFromRms(5)).toBe(1)
  })
})

describe('easing', () => {
  it('moves toward the target without overshooting or snapping', () => {
    const a = easeToward(0, 1, 1 / 60, 8)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(0.2)
    expect(easeToward(0, 1, 100, 8)).toBeCloseTo(1, 6)
    expect(easeToward(0.3, 1, 0, 8)).toBe(0.3)
  })
  it('eases colour channels together', () => {
    const c = easeRgb([0, 0, 0], [100, 200, 50], 0.1, 6)
    expect(c[0]).toBeGreaterThan(0)
    expect(c[0]).toBeLessThan(100)
    expect(c[1] / c[0]).toBeCloseTo(2, 6)
  })
})

describe('markFrame', () => {
  it('grows with the level while hearing and speaking', () => {
    for (const mode of ['hear', 'speak'] as const) {
      const quiet = markFrame(mode, 1, 0, false)
      const loud = markFrame(mode, 1, 1, false)
      expect(loud.scale).toBeGreaterThan(quiet.scale)
      expect(loud.glow).toBeGreaterThan(quiet.glow)
      expect(Math.max(...loud.bars)).toBeGreaterThan(Math.max(...quiet.bars))
    }
  })
  it('clamps a wild level', () => {
    expect(markFrame('hear', 1, 9, false).scale).toBeCloseTo(1.16, 6)
    expect(markFrame('hear', 1, -3, false).scale).toBeCloseTo(0.86, 6)
  })
  it('thinking ignores the level and sweeps a shimmer across the bars', () => {
    expect(markFrame('think', 2, 0, false)).toEqual(markFrame('think', 2, 1, false))
    const a = markFrame('think', 0.2, 0, false).bars
    const b = markFrame('think', 0.9, 0, false).bars
    expect(a.indexOf(Math.max(...a))).not.toBe(b.indexOf(Math.max(...b)))
    expect(shimmer(0, 0)).toBeGreaterThanOrEqual(0.55)
    expect(shimmer(0, 0)).toBeLessThanOrEqual(1)
  })
  it('idle breathes gently and paused holds still and dim', () => {
    const s = [0, 1, 2, 3].map((t) => markFrame('idle', t, 0, false).scale)
    expect(new Set(s).size).toBeGreaterThan(1)
    for (const v of s) expect(Math.abs(v - 0.9)).toBeLessThanOrEqual(0.05 + 1e-9)
    const p1 = markFrame('paused', 0, 0, false)
    expect(markFrame('paused', 7.3, 1, false)).toEqual(p1)
    expect(p1.opacity).toBeLessThan(1)
  })
  it('reduced motion runs the clock at half speed', () => {
    expect(markFrame('idle', 4, 0, true)).toEqual(markFrame('idle', 2, 0, false))
    expect(markFrame('think', 4, 0, true)).toEqual(markFrame('think', 2, 0, false))
  })
})

describe('isSettled', () => {
  it('is false with no previous frame or a different length', () => {
    expect(isSettled(null, [1], 0.1)).toBe(false)
    expect(isSettled([1], [1, 2], 0.1)).toBe(false)
  })
  it('is true only when every value moved less than eps', () => {
    expect(isSettled([1, 2], [1.0005, 2], 0.001)).toBe(true)
    expect(isSettled([1, 2], [1, 2.01], 0.001)).toBe(false)
  })
})
