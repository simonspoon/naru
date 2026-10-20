import type { Rgb } from '../../liveMark'

// Every mark on a page shares one document, so each mounted painter's
// gradient needs its own id (the nav orb, the panel head and the Settings
// previews can all be on screen at once).
let gradients = 0

/** A fresh, page-unique gradient id for one mounted painter. */
export function nextGradientId(skin: string): string {
  gradients += 1
  return `naru-mark-${skin}-${gradients}`
}

/**
 * The host svg's whole-mark scale, opacity and glow — written in full on every
 * painted frame, since a skin swap keeps the same `<svg>` and the previous
 * skin's values would otherwise stay on it.
 */
export function hostStyle(svg: SVGSVGElement, scale: number, opacity: number, glow: number, rgb: Rgb, alpha: number): void {
  svg.style.transform = `scale(${scale.toFixed(3)})`
  svg.style.opacity = opacity.toFixed(3)
  const [r, g, b] = rgb
  svg.style.filter =
    glow > 0.01
      ? `drop-shadow(0 0 ${(3 + 9 * glow).toFixed(1)}px rgba(${r | 0},${g | 0},${b | 0},${(alpha * Math.min(1, glow)).toFixed(3)}))`
      : 'none'
}
