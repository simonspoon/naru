import { describe, expect, it } from 'vitest'
import type { MarkMode } from './liveMark'
import {
  BLINK_SECONDS,
  blinkLid,
  BLOB_POINTS,
  blobFrame,
  blobPath,
  faceFrame,
  previewMicRms,
  previewState,
} from './markSkinFrames'

const MODES: MarkMode[] = ['idle', 'hear', 'speak', 'think', 'paused', 'offer']

describe('blinkLid', () => {
  it('is open most of the time and blinks every 2.5..6 s for about 120 ms', () => {
    const step = 0.005
    const starts: number[] = []
    let shut = 0
    let wasOpen = true
    for (let t = 0; t < 60; t += step) {
      const lid = blinkLid(t)
      expect(lid).toBeGreaterThanOrEqual(0)
      expect(lid).toBeLessThanOrEqual(1)
      if (lid > 0) shut += step
      if (lid > 0 && wasOpen) starts.push(t)
      wasOpen = lid === 0
    }
    expect(starts.length).toBeGreaterThan(9)
    const gaps = starts.slice(1).map((s, i) => s - starts[i])
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(2.5 - 0.01)
      expect(g).toBeLessThanOrEqual(6 + 0.01)
    }
    expect(shut / starts.length).toBeCloseTo(BLINK_SECONDS, 1)
    // Fully shut at a blink's middle.
    expect(Math.max(...starts.map((s) => blinkLid(s + BLINK_SECONDS / 2)))).toBeGreaterThan(0.95)
  })
})

describe('faceFrame', () => {
  it('runs at half speed under reduced motion, never frozen', () => {
    for (const mode of MODES) {
      for (const t of [0.3, 1.7, 4.2, 9.9]) expect(faceFrame(mode, 2 * t, 0.5, true)).toEqual(faceFrame(mode, t, 0.5, false))
    }
    expect(faceFrame('idle', 1, 0, true)).not.toEqual(faceFrame('idle', 2, 0, true))
  })
  it('holds a paused face perfectly still, dimmed with eyes half shut', () => {
    const a = faceFrame('paused', 1, 0, false)
    expect(faceFrame('paused', 7.3, 0.8, false)).toEqual(a)
    expect(a.opacity).toBeLessThan(1)
    expect(a.eyeOpen).toBeLessThan(0.6)
  })
  it('moves the mouth with the speech level', () => {
    expect(faceFrame('speak', 1, 0.9, false).mouthOpen).toBeGreaterThan(faceFrame('speak', 1, 0.1, false).mouthOpen + 0.4)
    expect(faceFrame('idle', 1, 0.9, false).mouthOpen).toBe(0)
  })
  it('looks attentive when hearing and up and aside when thinking', () => {
    const idle = faceFrame('idle', 1, 0, false)
    const hear = faceFrame('hear', 1, 0.5, false)
    expect(hear.eyeSize).toBeGreaterThan(idle.eyeSize)
    expect(hear.browLift).toBeLessThan(idle.browLift)
    for (const t of [0.5, 3, 8]) {
      const think = faceFrame('think', t, 0, false)
      expect(think.gazeY).toBeLessThan(-1)
      expect(think.gazeX).toBeGreaterThan(1)
    }
  })
})

describe('blobFrame', () => {
  it('runs at half speed under reduced motion, never frozen', () => {
    for (const mode of MODES) {
      for (const t of [0.3, 1.7, 4.2]) {
        const slow = blobFrame(mode, 2 * t, 0.5, true)
        const fast = blobFrame(mode, t, 0.5, false)
        expect({ ...slow, spin: 0 }).toEqual({ ...fast, spin: 0 })
        expect(slow.spin).toBe(fast.spin / 2)
      }
    }
    expect(blobFrame('idle', 1, 0, true)).not.toEqual(blobFrame('idle', 2, 0, true))
  })
  it('breathes at idle, holds still when paused', () => {
    expect(blobFrame('idle', 0.5, 0, false).scale).not.toBeCloseTo(blobFrame('idle', 2.5, 0, false).scale, 2)
    expect(blobFrame('paused', 9, 1, false)).toEqual(blobFrame('paused', 1, 0, false))
  })
  it('wobbles harder with a higher level', () => {
    const spread = (r: number[]): number => Math.max(...r) - Math.min(...r)
    for (const mode of ['hear', 'speak'] as const) {
      expect(spread(blobFrame(mode, 1.3, 1, false).radii)).toBeGreaterThan(spread(blobFrame(mode, 1.3, 0, false).radii))
      expect(blobFrame(mode, 1.3, 1, false).scale).toBeGreaterThan(blobFrame(mode, 1.3, 0, false).scale)
    }
    expect(blobFrame('idle', 1, 0, false).radii).toHaveLength(BLOB_POINTS)
  })
})

describe('blobPath', () => {
  it('is a closed cubic path through every point, a circle for equal radii', () => {
    const d = blobPath(new Array(8).fill(1), 32, 32, 20)
    expect(d.startsWith('M52.00 32.00')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    expect(d.match(/C/g)).toHaveLength(8)
    expect(d).toContain('32.00 52.00')
  })
})

describe('preview cycle', () => {
  it('walks idle, hearing, speaking, working, paused, two seconds each, then repeats', () => {
    expect([0, 2, 4, 6, 8, 10].map(previewState)).toEqual([null, 'hearing', 'speaking', 'working', 'paused', null])
    expect(previewState(1.99)).toBe(null)
  })
  it('makes a mic level in the speech range', () => {
    for (let t = 0; t < 10; t += 0.13) {
      expect(previewMicRms(t)).toBeGreaterThanOrEqual(0.01)
      expect(previewMicRms(t)).toBeLessThanOrEqual(0.12)
    }
  })
})
