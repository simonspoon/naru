import { describe, expect, it } from 'vitest'
import {
  clampPlacement,
  clampPoint,
  defaultPlacement,
  DOCK_Y,
  DOCK_ZONE,
  isDrag,
  muteIcon,
  ORB_MARGIN,
  ORB_PIE_BLEED,
  ORB_SIZE,
  orbBrightness,
  parsePlacement,
  serializePlacement,
  settle,
  usableHeight,
} from './liveOrb'
import type { LiveIndicator } from './liveIndicator'

const VW = 1200
const VH = 800

describe('settle', () => {
  it('leaves the orb exactly where it was dropped', () => {
    expect(settle({ x: 400, y: 300 }, VW, VH)).toEqual({ x: 400, y: 300, docked: false })
    expect(settle({ x: 13, y: 701 }, VW, VH)).toEqual({ x: 13, y: 684, docked: false })
    expect(settle({ x: 600, y: DOCK_ZONE }, VW, VH)).toEqual({ x: 600, y: DOCK_ZONE, docked: false })
  })
  it('docks to the top edge only, keeping x', () => {
    expect(settle({ x: 400, y: 10 }, VW, VH)).toEqual({ x: 400, y: DOCK_Y, docked: true })
    expect(settle({ x: 400, y: DOCK_ZONE - 1 }, VW, VH)).toEqual({ x: 400, y: DOCK_Y, docked: true })
    expect(settle({ x: 400, y: -30 }, VW, VH)).toEqual({ x: 400, y: DOCK_Y, docked: true })
  })
  it('clamps into the viewport', () => {
    expect(settle({ x: -50, y: 5000 }, VW, VH)).toEqual({ x: 0, y: VH - ORB_SIZE, docked: false })
    expect(settle({ x: 5000, y: 300 }, VW, VH).x).toBe(VW - ORB_SIZE)
  })
})

describe('clampPoint / clampPlacement', () => {
  it('keeps the orb on the page', () => {
    expect(clampPoint({ x: -50, y: 5000 }, VW, VH)).toEqual({ x: 0, y: VH - ORB_SIZE })
    expect(clampPoint({ x: 100, y: 100 }, VW, VH)).toEqual({ x: 100, y: 100 })
  })
  it('re-clamps a remembered position into a smaller window', () => {
    expect(clampPlacement({ x: 1100, y: 700, docked: false }, 500, 400)).toEqual({
      x: 500 - ORB_SIZE,
      y: 400 - ORB_SIZE,
      docked: false,
    })
  })
})

describe('defaultPlacement', () => {
  it('is the bottom-right corner, a margin in', () => {
    expect(defaultPlacement(VW, VH)).toEqual({
      x: VW - ORB_SIZE - ORB_MARGIN,
      y: VH - ORB_SIZE - ORB_MARGIN,
      docked: false,
    })
  })
})

describe('parsePlacement / serializePlacement', () => {
  it('round trips a dropped position and a docked one', () => {
    for (const p of [
      { x: 400, y: 300, docked: false },
      { x: 90, y: DOCK_Y, docked: true },
    ]) {
      expect(parsePlacement(serializePlacement(p), VW, VH)).toEqual(p)
    }
  })
  it('falls back to the default on anything unusable', () => {
    for (const raw of [null, '', 'nope', '5', 'null', '{"col":2,"row":2}', '{"x":"1","y":2}', '{"x":1}']) {
      expect(parsePlacement(raw, VW, VH)).toEqual(defaultPlacement(VW, VH))
    }
  })
})

describe('usableHeight (phone tab bar)', () => {
  const TAB = 48
  it('is the whole viewport off the phone tier', () => {
    expect(usableHeight(VH, 0)).toBe(VH)
  })
  it('stops a pie bloom above the tab bar', () => {
    expect(usableHeight(VH, TAB)).toBe(VH - TAB - ORB_PIE_BLEED)
    expect(usableHeight(20, TAB)).toBe(0)
  })
  it('clamps a drop and the default clear of the bar', () => {
    const h = usableHeight(VH, TAB)
    expect(settle({ x: 100, y: 5000 }, 400, h)).toEqual({ x: 100, y: h - ORB_SIZE, docked: false })
    expect(defaultPlacement(400, h).y).toBe(h - ORB_SIZE - ORB_MARGIN)
    expect(defaultPlacement(400, h).y + ORB_SIZE + ORB_PIE_BLEED).toBeLessThanOrEqual(VH - TAB)
  })
})

describe('docked in a short viewport', () => {
  it('never leaves the page', () => {
    const h = ORB_SIZE + DOCK_Y - 10
    expect(clampPlacement({ x: 10, y: 0, docked: true }, VW, h)).toEqual({ x: 10, y: h - ORB_SIZE, docked: true })
    expect(clampPlacement({ x: 10, y: 0, docked: true }, VW, 50)).toEqual({ x: 10, y: 0, docked: true })
  })
})

describe('parsePlacement garbage', () => {
  it('rejects non-finite numbers', () => {
    for (const raw of ['{"x":null,"y":5}', '{"x":1e999,"y":5}', '{"x":5,"y":-1e999}', '{"x":5,"y":"NaN"}']) {
      expect(parsePlacement(raw, VW, VH)).toEqual(defaultPlacement(VW, VH))
    }
  })
  it('sends a docked flag with a bad y to the default, and re-clamps a wild one', () => {
    expect(parsePlacement('{"docked":true,"y":"x","x":1}', VW, VH)).toEqual(defaultPlacement(VW, VH))
    expect(parsePlacement('{"docked":true,"x":1,"y":9999}', VW, VH)).toEqual({ x: 1, y: DOCK_Y, docked: true })
    expect(parsePlacement('{"docked":"yes","x":1,"y":9999}', VW, VH)).toEqual({ x: 1, y: VH - ORB_SIZE, docked: false })
  })
})

describe('orbBrightness', () => {
  it('is dim at rest, paused and listening, bright otherwise', () => {
    expect(orbBrightness(null)).toBe('dim')
    expect(orbBrightness('paused')).toBe('dim')
    expect(orbBrightness('listening')).toBe('dim')
    const bright: LiveIndicator[] = ['speaking', 'hearing', 'working', 'resting']
    for (const s of bright) expect(orbBrightness(s)).toBe('bright')
  })
})

describe('muteIcon', () => {
  it('names which side is muted', () => {
    expect(muteIcon(false, false)).toBeNull()
    expect(muteIcon(true, false)).toBe('mic')
    expect(muteIcon(false, true)).toBe('speaker')
    expect(muteIcon(true, true)).toBe('both')
  })
})

describe('isDrag', () => {
  it('separates a tap from a drag', () => {
    expect(isDrag({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false)
    expect(isDrag({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(true)
  })
})
