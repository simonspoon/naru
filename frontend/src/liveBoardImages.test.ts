import { describe, expect, it } from 'vitest'
import {
  IMAGE_GRAB,
  MIN_IMAGE_EDGE,
  moveImage,
  nextImageId,
  placeImage,
  resizeImage,
  type InkImage,
} from './liveBoardImages'

const box = { width: 800, height: 500 }
const origin = { x: 0, y: 0 }

function image(over: Partial<InkImage> = {}): InkImage {
  return { id: 1, src: 'data:image/png;base64,AAAA', x: 100, y: 100, width: 200, height: 100, ...over }
}

describe('nextImageId', () => {
  it('is one past the largest, and 1 for none', () => {
    expect(nextImageId([])).toBe(1)
    expect(nextImageId([image({ id: 4 }), image({ id: 2 })])).toBe(5)
  })
})

describe('placeImage', () => {
  it('centres a small picture at its own size', () => {
    expect(placeImage({ width: 200, height: 100 }, box, 0, origin)).toEqual({
      width: 200,
      height: 100,
      x: 300,
      y: 200,
    })
  })

  it('scales a big picture down to 60% of the box, keeping its aspect, never up', () => {
    const placed = placeImage({ width: 4000, height: 1000 }, box, 0, origin)
    expect(placed.width).toBe(480)
    expect(placed.height).toBe(120)
    expect(placeImage({ width: 10, height: 10 }, box, 0, origin).width).toBe(10)
  })

  it('cascades later drops and stays inside the box', () => {
    const first = placeImage({ width: 200, height: 100 }, box, 0, origin)
    const second = placeImage({ width: 200, height: 100 }, box, 1, origin)
    expect(second.x - first.x).toBe(24)
    const last = placeImage({ width: 700, height: 100 }, box, 7, origin)
    expect(last.x + last.width).toBeLessThanOrEqual(box.width)
  })

  it('lands in the visible window of a scrolled board', () => {
    const placed = placeImage({ width: 200, height: 100 }, box, 0, { x: 50, y: 900 })
    expect(placed.x).toBe(350)
    expect(placed.y).toBe(1100)
  })
})

describe('moveImage', () => {
  it('moves by the delta', () => {
    const moved = moveImage(image(), 10, -20, box, origin)
    expect([moved.x, moved.y]).toEqual([110, 80])
  })

  it('keeps a grab handle inside the box on every side', () => {
    const far = moveImage(image(), 5000, 5000, box, origin)
    expect(far.x).toBe(box.width - IMAGE_GRAB)
    expect(far.y).toBe(box.height - IMAGE_GRAB)
    const gone = moveImage(image(), -5000, -5000, box, origin)
    expect(gone.x + gone.width).toBe(IMAGE_GRAB)
    expect(gone.y + gone.height).toBe(IMAGE_GRAB)
  })

  it('does not mutate and keeps the size', () => {
    const before = image()
    const moved = moveImage(before, 5, 5, box, origin)
    expect(before.x).toBe(100)
    expect([moved.width, moved.height]).toEqual([200, 100])
  })
})

describe('resizeImage', () => {
  it('keeps the aspect ratio and the top-left corner', () => {
    const bigger = resizeImage(image(), 100, 50, box)
    expect(bigger.width).toBe(300)
    expect(bigger.height).toBe(150)
    expect([bigger.x, bigger.y]).toEqual([100, 100])
  })

  it('floors the shorter edge at the minimum', () => {
    const small = resizeImage(image(), -5000, -5000, box)
    expect(small.height).toBe(MIN_IMAGE_EDGE)
    expect(small.width).toBe(MIN_IMAGE_EDGE * 2)
    const tall = resizeImage(image({ width: 100, height: 400 }), -5000, -5000, box)
    expect(tall.width).toBe(MIN_IMAGE_EDGE)
  })

  it('caps the growth', () => {
    const huge = resizeImage(image(), 1e6, 1e6, box)
    expect(huge.width).toBeLessThanOrEqual(4000)
  })
})
