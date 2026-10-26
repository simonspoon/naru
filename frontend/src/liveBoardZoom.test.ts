import { describe, expect, it } from 'vitest'
import {
  MAX_BOARD_ZOOM,
  MIN_BOARD_ZOOM,
  boardZoomLabel,
  clampBoardZoom,
  isPan,
  scrollForZoom,
  stepBoardZoom,
  isZoomWheel,
  wheelBoardZoom,
} from './liveBoardZoom'

describe('clampBoardZoom', () => {
  it('keeps the zoom inside its bounds', () => {
    expect(clampBoardZoom(10)).toBe(MAX_BOARD_ZOOM)
    expect(clampBoardZoom(0.01)).toBe(MIN_BOARD_ZOOM)
    expect(clampBoardZoom(1.5)).toBe(1.5)
    expect(clampBoardZoom(Number.NaN)).toBe(1)
  })
})

describe('stepBoardZoom', () => {
  it('steps by 25% and snaps through 100%', () => {
    expect(stepBoardZoom(1, 1)).toBe(1.25)
    expect(stepBoardZoom(1.25, -1)).toBe(1)
    expect(stepBoardZoom(0.9, 1)).toBe(1)
    expect(stepBoardZoom(1.1, -1)).toBe(1)
    expect(stepBoardZoom(1, -1)).toBe(0.8)
  })

  it('stops at the bounds', () => {
    expect(stepBoardZoom(MAX_BOARD_ZOOM, 1)).toBe(MAX_BOARD_ZOOM)
    expect(stepBoardZoom(MIN_BOARD_ZOOM, -1)).toBe(MIN_BOARD_ZOOM)
  })
})

describe('isZoomWheel', () => {
  it('a plain wheel scrolls; Cmd, Option, Ctrl and a pinch zoom', () => {
    const none = { ctrlKey: false, metaKey: false, altKey: false }
    expect(isZoomWheel(none)).toBe(false)
    expect(isZoomWheel({ ...none, metaKey: true })).toBe(true)
    expect(isZoomWheel({ ...none, altKey: true })).toBe(true)
    expect(isZoomWheel({ ...none, ctrlKey: true })).toBe(true)
  })
})

describe('wheelBoardZoom', () => {
  it('a plain wheel down zooms out and up zooms in', () => {
    expect(wheelBoardZoom(1, 100, 0, false)).toBeLessThan(1)
    expect(wheelBoardZoom(1, -100, 0, false)).toBeGreaterThan(1)
    expect(wheelBoardZoom(1, -100, 0, false)).toBeCloseTo(Math.exp(0.15))
  })

  it('a pinch zooms harder per pixel, and line deltas count as pixels', () => {
    expect(wheelBoardZoom(1, -10, 0, true)).toBeCloseTo(Math.exp(0.1))
    expect(wheelBoardZoom(1, -3, 1, false)).toBeCloseTo(wheelBoardZoom(1, -48, 0, false))
  })

  it('never leaves the bounds', () => {
    expect(wheelBoardZoom(MAX_BOARD_ZOOM, -1000, 0, false)).toBe(MAX_BOARD_ZOOM)
    expect(wheelBoardZoom(MIN_BOARD_ZOOM, 1000, 0, false)).toBe(MIN_BOARD_ZOOM)
  })
})

describe('scrollForZoom', () => {
  it('keeps the point under the cursor fixed', () => {
    // Content x 150 sits under cursor 100 at scroll 50, zoom 1; at zoom 2 it
    // is content x 300, so the scroll must be 200.
    expect(scrollForZoom(50, 100, 1, 2)).toBe(200)
    expect(scrollForZoom(200, 100, 2, 1)).toBe(50)
  })

  it('never scrolls past the start', () => {
    expect(scrollForZoom(0, 100, 1, 0.5)).toBe(0)
  })
})

describe('isPan', () => {
  it('is a pan only past the threshold', () => {
    expect(isPan(2, 2)).toBe(false)
    expect(isPan(3, 3)).toBe(true)
    expect(isPan(0, -4)).toBe(true)
  })
})

describe('boardZoomLabel', () => {
  it('reads as a whole percentage', () => {
    expect(boardZoomLabel(1)).toBe('100%')
    expect(boardZoomLabel(1.25)).toBe('125%')
    expect(boardZoomLabel(0.8)).toBe('80%')
  })
})
