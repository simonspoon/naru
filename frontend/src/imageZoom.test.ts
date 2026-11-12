import { describe, expect, it } from 'vitest'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampView,
  fitScale,
  fitView,
  isFit,
  panBy,
  pinchView,
  resolveView,
  scaleBounds,
  stepScale,
  wheelZoomFactor,
  zoomAt,
  zoomKeyAction,
  zoomPercent,
} from './imageZoom'

const stage = { w: 800, h: 600 }
const big = { w: 4000, h: 2000 }
const tiny = { w: 16, h: 16 }

/** Where the image pixel `p` (image coordinates) sits on the stage. */
function onStage(v: { scale: number; x: number; y: number }, p: { x: number; y: number }) {
  return { x: v.x + p.x * v.scale, y: v.y + p.y * v.scale }
}

describe('fitScale', () => {
  it('shrinks a large image to the stage on its tighter axis', () => {
    expect(fitScale(big, stage)).toBe(0.2)
    expect(fitScale({ w: 1000, h: 3000 }, stage)).toBe(0.2)
  })

  it('never upscales a small image past 100%', () => {
    expect(fitScale(tiny, stage)).toBe(1)
    expect(fitScale({ w: 800, h: 600 }, stage)).toBe(1)
  })

  it('answers 1 for an unknown or empty size rather than NaN or Infinity', () => {
    expect(fitScale({ w: 0, h: 0 }, stage)).toBe(1)
    expect(fitScale(big, { w: 0, h: 0 })).toBe(1)
  })
})

describe('fitView', () => {
  it('centres the fitted image', () => {
    expect(fitView(big, stage)).toEqual({ scale: 0.2, x: 0, y: 100 })
    expect(fitView(tiny, stage)).toEqual({ scale: 1, x: 392, y: 292 })
  })

  it('is what a null view resolves to, recomputed for the current stage', () => {
    expect(resolveView(null, big, stage)).toEqual(fitView(big, stage))
    expect(resolveView(null, big, { w: 400, h: 600 }).scale).toBe(0.1)
  })
})

describe('zoomAt', () => {
  it('keeps the image point under the pointer fixed', () => {
    const start = { scale: 1, x: -1000, y: -500 }
    const at = { x: 300, y: 250 }
    const imgPoint = { x: (at.x - start.x) / start.scale, y: (at.y - start.y) / start.scale }
    for (const scale of [1.5, 2, 4, 0.5]) {
      const v = zoomAt(start, scale, at, big, stage)
      expect(v.scale).toBe(scale)
      const p = onStage(v, imgPoint)
      expect(p.x).toBeCloseTo(at.x, 9)
      expect(p.y).toBeCloseTo(at.y, 9)
    }
  })

  it('clamps at the maximum zoom', () => {
    const v = zoomAt(fitView(tiny, stage), 1000, { x: 400, y: 300 }, tiny, stage)
    expect(v.scale).toBe(MAX_ZOOM)
    expect(zoomAt(v, v.scale * 2, { x: 400, y: 300 }, tiny, stage).scale).toBe(MAX_ZOOM)
  })

  it('clamps at the minimum zoom', () => {
    const v = zoomAt(fitView(tiny, stage), 0.0001, { x: 400, y: 300 }, tiny, stage)
    expect(v.scale).toBe(MIN_ZOOM)
  })

  it('lets a huge image go down to its fit even when that is below MIN_ZOOM', () => {
    const huge = { w: 40000, h: 100 }
    expect(scaleBounds(huge, stage).min).toBe(0.02)
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0, { x: 0, y: 0 }, huge, stage).scale).toBe(0.02)
  })
})

describe('pan bound', () => {
  it('keeps a zoomed image covering the stage — it cannot be panned out of view', () => {
    const v = { scale: 1, x: -1000, y: -500 }
    expect(panBy(v, 1e6, 1e6, big, stage)).toEqual({ scale: 1, x: 0, y: 0 })
    expect(panBy(v, -1e6, -1e6, big, stage)).toEqual({ scale: 1, x: -3200, y: -1400 })
    expect(panBy(v, 10, -20, big, stage)).toEqual({ scale: 1, x: -990, y: -520 })
  })

  it('centres an axis on which the image is smaller than the stage', () => {
    // 4000x2000 at 0.25 is 1000x500: wider than the stage, shorter than it.
    const v = panBy({ scale: 0.25, x: -100, y: 0 }, 0, 400, big, stage)
    expect(v.y).toBe(50)
    expect(v.x).toBe(-100)
  })

  it('re-bounds a stored view when the stage changes under it', () => {
    const v = { scale: 1, x: -3200, y: -1400 }
    const wider = { w: 2000, h: 600 }
    expect(clampView(v, big, wider).x).toBe(-2000)
  })
})

describe('pinchView', () => {
  it('scales by the finger spread about the pinch centre', () => {
    const start = { scale: 1, x: -1000, y: -500 }
    const c = { x: 400, y: 300 }
    const v = pinchView(start, 100, 200, c, c, big, stage)
    expect(v.scale).toBe(2)
    const imgPoint = { x: 1400, y: 800 }
    expect(onStage(v, imgPoint)).toEqual(c)
  })

  it('pans with the centre when the spread does not change', () => {
    const start = { scale: 1, x: -1000, y: -500 }
    const v = pinchView(start, 100, 100, { x: 400, y: 300 }, { x: 350, y: 280 }, big, stage)
    expect(v).toEqual({ scale: 1, x: -1050, y: -520 })
  })

  it('clamps like every other zoom', () => {
    const v = pinchView(fitView(tiny, stage), 1, 1e6, { x: 0, y: 0 }, { x: 0, y: 0 }, tiny, stage)
    expect(v.scale).toBe(MAX_ZOOM)
  })
})

describe('wheelZoomFactor', () => {
  it('zooms in on a negative delta and out on a positive one', () => {
    expect(wheelZoomFactor(-10, 0)).toBeGreaterThan(1)
    expect(wheelZoomFactor(10, 0)).toBeLessThan(1)
    expect(wheelZoomFactor(0, 0)).toBe(1)
  })

  it('is symmetric, so in-then-out returns to the start', () => {
    expect(wheelZoomFactor(-30, 0) * wheelZoomFactor(30, 0)).toBeCloseTo(1, 12)
  })

  it('caps one coarse notch and normalises line deltas', () => {
    expect(wheelZoomFactor(1e6, 0)).toBe(wheelZoomFactor(25, 0))
    expect(wheelZoomFactor(-100, 0)).toBeCloseTo(Math.exp(0.25), 12)
    expect(wheelZoomFactor(1, 1)).toBe(wheelZoomFactor(16, 0))
  })
})

describe('keys and readout', () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    zoomKeyAction({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods })

  it('maps + - 0 1', () => {
    expect(k('+')).toBe('in')
    expect(k('=')).toBe('in')
    expect(k('-')).toBe('out')
    expect(k('0')).toBe('fit')
    expect(k('1')).toBe('actual')
    expect(k('2')).toBeNull()
    expect(k('h')).toBeNull()
  })

  it('leaves modified keys to the browser', () => {
    expect(k('+', { metaKey: true })).toBeNull()
    expect(k('0', { ctrlKey: true })).toBeNull()
    expect(k('-', { altKey: true })).toBeNull()
  })

  it('steps and formats', () => {
    expect(stepScale(stepScale(1, 1), -1)).toBeCloseTo(1, 12)
    expect(zoomPercent(0.2)).toBe('20%')
    expect(zoomPercent(1.234)).toBe('123%')
  })

  it('recognises the fitted view', () => {
    expect(isFit(fitView(big, stage), big, stage)).toBe(true)
    expect(isFit({ scale: 1, x: 0, y: 0 }, big, stage)).toBe(false)
  })
})
