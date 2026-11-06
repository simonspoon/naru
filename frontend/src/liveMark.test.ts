import { describe, expect, it } from 'vitest'
import {
  BAR_SLOT,
  easeRgb,
  easeToward,
  hexToRgb,
  isSettled,
  levelFromRms,
  MARK_FRAME_MS,
  MARK_GLIDE_MS,
  MARK_REST_FRAME_MS,
  markFrame,
  markFrameDelay,
  markFrameDue,
  markFrameWait,
  markMode,
  paletteFor,
  PALETTES,
  shimmer,
} from './liveMark'
import type { LiveIndicator } from './liveIndicator'

describe('offer mode', () => {
  it('turns the idle mark gold only while nothing else is reported', () => {
    expect(markMode(null, true)).toBe('offer')
    expect(markMode('hearing', true)).toBe('hear')
    expect(markMode(null)).toBe('idle')
    expect(PALETTES.offer.bars[3]).toBe('#fff0c2')
    expect(paletteFor('offer')).toBe(PALETTES.offer)
  })
})

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

describe('markFrameDelay', () => {
  it('caps every active mode at 30fps, whatever the time since the change', () => {
    for (const mode of ['hear', 'speak', 'think', 'offer'] as const) {
      expect(markFrameDelay(mode, 0)).toBe(MARK_FRAME_MS)
      expect(markFrameDelay(mode, 60_000)).toBe(MARK_FRAME_MS)
    }
    expect(MARK_FRAME_MS).toBeCloseTo(33.33, 1)
  })
  it('keeps 30fps through the glide into a resting look, then rests', () => {
    for (const mode of ['idle', 'paused'] as const) {
      expect(markFrameDelay(mode, 0)).toBe(MARK_FRAME_MS)
      expect(markFrameDelay(mode, MARK_GLIDE_MS - 1)).toBe(MARK_FRAME_MS)
      expect(markFrameDelay(mode, MARK_GLIDE_MS)).toBe(MARK_REST_FRAME_MS)
      expect(markFrameDelay(mode, 60_000)).toBe(MARK_REST_FRAME_MS)
    }
  })
})

/**
 * NaruMark's loop against a simulated display (naru task 2606): sleep
 * `markFrameWait`, then the first vsync after the timer (plus `lateMs` of timer
 * lateness), turned away by `markFrameDue` until it is due. Answers the gaps
 * between painted frames.
 */
function paintedGaps(mode: 'idle' | 'hear' | 'speak' | 'think' | 'paused' | 'offer', hz: number, lateMs: number, workMs: number): number[] {
  const vsync = 1000 / hz
  // Timestamps jitter by a little, as real ones do.
  const at = (n: number): number => n * vsync + (n % 3 === 0 ? 0.2 : -0.2)
  let n = 1
  let last = at(n)
  let delay = 0
  const gaps: number[] = []
  for (let i = 0; i < 400; i++) {
    const now = at(n)
    if (!markFrameDue(last, now, delay)) {
      n++
      continue
    }
    if (i > 0) gaps.push(now - last)
    last = now
    delay = markFrameDelay(mode, now)
    const wake = now + workMs + markFrameWait(now, now + workMs, delay) + lateMs
    while (at(n) < wake) n++
  }
  return gaps
}

describe('the frame cap against real display rates', () => {
  for (const hz of [60, 75, 90, 120, 144, 165, 240]) {
    for (const mode of ['idle', 'hear', 'speak', 'think', 'paused', 'offer'] as const) {
      it(`${mode} at ${hz}Hz never paints closer than ~33ms, nor much later`, () => {
        for (const late of [0, 3, 7]) {
          for (const work of [0.5, 4]) {
            const gaps = paintedGaps(mode, hz, late, work)
            expect(gaps.length).toBeGreaterThan(50)
            expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MARK_FRAME_MS - 1)
            // On time: never more than a vsync (plus the timer's lateness) past the cap.
            const floor = markFrameDelay(mode, 60_000) === MARK_REST_FRAME_MS ? MARK_REST_FRAME_MS : MARK_FRAME_MS
            const settled = gaps.slice(60)
            expect(Math.max(...settled)).toBeLessThanOrEqual(floor + 1000 / hz + Math.max(0, late - 8) + 1)
          }
        }
      })
    }
  }
})
