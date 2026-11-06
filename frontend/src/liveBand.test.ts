import { describe, expect, it } from 'vitest'
import { simEnvelope, smoothLevel } from './liveBand'

describe('smoothLevel', () => {
  it('attacks faster than it releases', () => {
    const attack = smoothLevel(0, 1) // jump up from silence
    const release = smoothLevel(1, 0) // drop to silence from full
    // Attack moves further toward its target in one step than release does.
    expect(attack).toBeGreaterThan(1 - release)
  })

  it('converges toward the target over repeated steps', () => {
    let level = 0
    for (let i = 0; i < 50; i++) level = smoothLevel(level, 0.8)
    expect(level).toBeCloseTo(0.8, 2)
  })

  it('is stable once it reaches its target', () => {
    expect(smoothLevel(0.5, 0.5)).toBe(0.5)
  })
})

describe('simEnvelope', () => {
  it('stays within 0..1', () => {
    for (let t = 0; t < 20; t += 0.37) {
      const v = simEnvelope(t)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('actually varies over time', () => {
    const values = new Set<number>()
    for (let t = 0; t < 20; t += 0.37) values.add(Number(simEnvelope(t).toFixed(4)))
    expect(values.size).toBeGreaterThan(1)
  })
})

describe('smoothLevel per frame step', () => {
  it('lands where two 60Hz steps would from one 30fps step (naru task 2606)', () => {
    expect(smoothLevel(0, 1, 2)).toBeCloseTo(smoothLevel(smoothLevel(0, 1), 1), 10)
    expect(smoothLevel(1, 0, 2)).toBeCloseTo(smoothLevel(smoothLevel(1, 0), 0), 10)
    expect(smoothLevel(0.3, 0.9, 1)).toBe(smoothLevel(0.3, 0.9))
  })
})
