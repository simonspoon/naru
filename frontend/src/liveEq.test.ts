import { describe, expect, it } from 'vitest'
import { EQ_COLOR_VAR, EQ_GAIN_FLOOR, eqBarCount, eqBarHeight, eqGain, eqMode } from './liveEq'

describe('eqMode', () => {
  it('lights for the person, Naru and thinking', () => {
    expect(eqMode('hearing')).toBe('user')
    expect(eqMode('speaking')).toBe('naru')
    expect(eqMode('working')).toBe('think')
    expect(eqMode('resting')).toBe('think')
  })
  it('is dark when nothing is happening', () => {
    expect(eqMode('listening')).toBeNull()
    expect(eqMode('paused')).toBeNull()
    expect(eqMode(null)).toBeNull()
  })
  it('colours by theme token', () => {
    expect(EQ_COLOR_VAR).toEqual({ user: '--cyan', naru: '--violet', think: '--amber' })
  })
})

describe('eqBarHeight', () => {
  it('follows the level while speaking and stays in 0..1', () => {
    for (let i = 0; i < 50; i++) {
      expect(eqBarHeight('user', i, i * 0.07, 0)).toBe(0)
      const h = eqBarHeight('naru', i, i * 0.07, 1)
      expect(h).toBeGreaterThanOrEqual(0.3)
      expect(h).toBeLessThanOrEqual(1)
    }
  })
  it('thinking pulses gently between 0.12 and 0.5', () => {
    let lo = 1
    let hi = 0
    for (let t = 0; t < 5.2; t += 0.05) {
      const h = eqBarHeight('think', 0, t, 0)
      lo = Math.min(lo, h)
      hi = Math.max(hi, h)
    }
    expect(lo).toBeCloseTo(0.12, 2)
    expect(hi).toBeCloseTo(0.5, 2)
  })
})

describe('eqGain', () => {
  it('fades in and out over a fraction of a second', () => {
    let g = 0
    for (let k = 0; k < 30; k++) g = eqGain(g, true, 1 / 30)
    expect(g).toBeGreaterThan(0.99)
    for (let k = 0; k < 30; k++) g = eqGain(g, false, 1 / 30)
    expect(g).toBeLessThan(EQ_GAIN_FLOOR)
  })
})

describe('eqBarCount', () => {
  it('fits 3px bars with 3px gaps', () => {
    expect(eqBarCount(0)).toBe(0)
    expect(eqBarCount(3)).toBe(1)
    expect(eqBarCount(1203)).toBe(201)
  })
})
