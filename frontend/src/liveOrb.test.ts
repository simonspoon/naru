import { describe, expect, it } from 'vitest'
import {
  ANCHORS,
  anchorPosition,
  clampPoint,
  DEFAULT_ANCHOR,
  isDrag,
  muteIcon,
  ORB_MARGIN,
  ORB_SIZE,
  orbBrightness,
  parseAnchor,
  serializeAnchor,
  snapAnchor,
} from './liveOrb'
import type { LiveIndicator } from './liveIndicator'

const VW = 1200
const VH = 800

describe('anchorPosition', () => {
  it('puts corners a margin from the edges', () => {
    expect(anchorPosition({ col: 0, row: 0 }, VW, VH)).toEqual({ x: ORB_MARGIN, y: ORB_MARGIN })
    expect(anchorPosition({ col: 2, row: 2 }, VW, VH)).toEqual({
      x: VW - ORB_SIZE - ORB_MARGIN,
      y: VH - ORB_SIZE - ORB_MARGIN,
    })
  })
  it('centres an edge midpoint', () => {
    expect(anchorPosition({ col: 1, row: 0 }, VW, VH).x).toBe((VW - ORB_SIZE) / 2)
  })
  it('does not go negative in a tiny viewport', () => {
    expect(anchorPosition({ col: 2, row: 2 }, 50, 50)).toEqual({ x: ORB_MARGIN, y: ORB_MARGIN })
  })
})

describe('snapAnchor', () => {
  it('snaps to the nearest corner', () => {
    expect(snapAnchor({ x: 10, y: 20 }, VW, VH)).toEqual({ col: 0, row: 0 })
    expect(snapAnchor({ x: VW - 100, y: VH - 100 }, VW, VH)).toEqual({ col: 2, row: 2 })
    expect(snapAnchor({ x: VW - 90, y: 30 }, VW, VH)).toEqual({ col: 2, row: 0 })
  })
  it('snaps to an edge midpoint when that is nearest', () => {
    expect(snapAnchor({ x: (VW - ORB_SIZE) / 2, y: 40 }, VW, VH)).toEqual({ col: 1, row: 0 })
    expect(snapAnchor({ x: 20, y: (VH - ORB_SIZE) / 2 }, VW, VH)).toEqual({ col: 0, row: 1 })
  })
  it('never answers the page centre', () => {
    const s = snapAnchor({ x: (VW - ORB_SIZE) / 2, y: (VH - ORB_SIZE) / 2 }, VW, VH)
    expect(s.col === 1 && s.row === 1).toBe(false)
  })
})

describe('clampPoint', () => {
  it('keeps the orb on the page', () => {
    expect(clampPoint({ x: -50, y: 5000 }, VW, VH)).toEqual({ x: 0, y: VH - ORB_SIZE })
    expect(clampPoint({ x: 100, y: 100 }, VW, VH)).toEqual({ x: 100, y: 100 })
  })
})

describe('parseAnchor / serializeAnchor', () => {
  it('round trips every anchor', () => {
    for (const a of ANCHORS) expect(parseAnchor(serializeAnchor(a))).toEqual(a)
  })
  it('falls back to the default on anything unusable', () => {
    for (const raw of [null, '', 'nope', '5', 'null', '{"col":1,"row":1}', '{"col":3,"row":0}', '{"col":"0","row":0}', '{"col":0}']) {
      expect(parseAnchor(raw)).toEqual(DEFAULT_ANCHOR)
    }
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
