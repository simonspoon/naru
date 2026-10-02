/**
 * Pictures the person drops or pastes onto a whiteboard (mesa task 1580) — the
 * placement and resize arithmetic, kept here beside a test while
 * `LiveBoardPanel.tsx` owns the pointer and the DOM.
 *
 * An image is part of the board's **ink**: held in this browser per board id
 * beside the strokes (`liveInk.ts`), flattened into the same PNG at send time
 * under the strokes, never stored by the server. Its box is in the same
 * content coordinates a stroke's points are (CSS px, scroll included).
 */

/** One placed picture. Never mutated: a move or resize is a new object. */
export interface InkImage {
  /** Unique among the board's images; the React key and the edit handle. */
  id: number
  /** A data URL of the picture's bytes. */
  src: string
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** The smallest an image may be resized to, CSS px on the shorter edge. */
export const MIN_IMAGE_EDGE = 32

/** How much of an image must stay inside the board when it is moved, CSS px —
 *  enough to find and grab it again. */
export const IMAGE_GRAB = 24

/** A freshly placed image takes at most this share of the board's box. */
const FIT_SHARE = 0.6

/** Each image already on the board shifts the next one by this much, so a
 *  second drop does not sit exactly on the first. */
const CASCADE = 24

/** An id no image on the board has. */
export function nextImageId(images: readonly InkImage[]): number {
  return images.reduce((max, image) => Math.max(max, image.id), 0) + 1
}

/**
 * Where a newly dropped picture lands: scaled down (never up) to fit within
 * 60% of the visible `box`, centred in it, shifted by `count` cascade steps
 * for the images already there, and kept inside the box. `origin` is the
 * box's top-left in content coordinates (the content box's scroll).
 */
export function placeImage(
  natural: Size,
  box: Size,
  count: number,
  origin: { x: number; y: number },
): Pick<InkImage, 'x' | 'y' | 'width' | 'height'> {
  const nw = Math.max(1, natural.width)
  const nh = Math.max(1, natural.height)
  const scale = Math.min(1, (box.width * FIT_SHARE) / nw, (box.height * FIT_SHARE) / nh)
  const width = Math.max(1, Math.round(nw * scale))
  const height = Math.max(1, Math.round(nh * scale))
  const shift = (count % 8) * CASCADE
  const x = Math.round((box.width - width) / 2) + shift
  const y = Math.round((box.height - height) / 2) + shift
  return {
    width,
    height,
    x: origin.x + Math.max(0, Math.min(x, box.width - width)),
    y: origin.y + Math.max(0, Math.min(y, box.height - height)),
  }
}

/**
 * `image` moved by (`dx`, `dy`), kept so at least [`IMAGE_GRAB`] px of it
 * stays inside `bounds` — the content box's visible size at `origin` — and it
 * can always be picked up again.
 */
export function moveImage(
  image: InkImage,
  dx: number,
  dy: number,
  bounds: Size,
  origin: { x: number; y: number },
): InkImage {
  const grab = (extent: number) => Math.min(IMAGE_GRAB, extent)
  const x = Math.min(
    origin.x + bounds.width - grab(image.width),
    Math.max(origin.x - image.width + grab(image.width), image.x + dx),
  )
  const y = Math.min(
    origin.y + bounds.height - grab(image.height),
    Math.max(origin.y - image.height + grab(image.height), image.y + dy),
  )
  return { ...image, x, y }
}

/**
 * `image` resized from its bottom-right corner dragged by (`dx`, `dy`),
 * keeping its aspect ratio: the width follows the average of the two drags
 * (the vertical one converted through the aspect), clamped between
 * [`MIN_IMAGE_EDGE`] on the shorter edge and four times the `bounds` on the
 * longer. The top-left corner stays where it is.
 */
export function resizeImage(image: InkImage, dx: number, dy: number, bounds: Size): InkImage {
  const aspect = image.width / Math.max(1, image.height)
  const wanted = image.width + (dx + dy * aspect) / 2
  const minWidth = aspect >= 1 ? MIN_IMAGE_EDGE * aspect : MIN_IMAGE_EDGE
  const maxWidth = Math.max(minWidth, Math.max(bounds.width, bounds.height * aspect) * 4)
  const width = Math.round(Math.min(maxWidth, Math.max(minWidth, wanted)))
  return { ...image, width, height: Math.max(1, Math.round(width / aspect)) }
}
