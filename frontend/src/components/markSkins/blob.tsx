import type { ReactElement } from 'react'
import { easeRgb, easeToward, GLOW_ALPHA, hexToRgb, isSettled, type Rgb } from '../../liveMark'
import type { MarkSkin } from '../../markSkin'
import { BLOB_RADIUS, blobFrame, blobPath } from '../../markSkinFrames'
import { hostStyle, nextGradientId } from './paint'

const COLOUR_RATE = 5
const SHAPE_RATE = 14

/**
 * The blob skin (naru task 2121): a soft living shape in the state palette's
 * gradient that breathes at rest, wobbles and pulses with the voice and turns
 * slowly while thinking. The numbers are `markSkinFrames.ts::blobFrame`'s;
 * this only writes them into the SVG.
 */
export const blob: MarkSkin<ReactElement[]> = {
  id: 'blob',
  markup: () => [
    <defs key="defs">
      <radialGradient className="blob-grad" cx="38%" cy="32%" r="75%">
        <stop className="blob-stop" offset="0" />
        <stop className="blob-stop" offset="0.5" />
        <stop className="blob-stop" offset="1" />
      </radialGradient>
    </defs>,
    <path key="shadow" className="blob-shadow" fill="none" stroke="#07030f" strokeWidth={3} strokeOpacity={0.45} />,
    <path key="body" className="blob-body" />,
    <path key="core" className="blob-core" fillOpacity={0.35} />,
    <ellipse key="shine" cx={24} cy={21} rx={6.5} ry={3.6} fill="#ffffff" fillOpacity={0.32} transform="rotate(-30 24 21)" />,
  ],
  mount(svg, idle) {
    const id = nextGradientId('blob')
    svg.querySelector<SVGRadialGradientElement>('radialGradient.blob-grad')!.id = id
    const body = svg.querySelector<SVGPathElement>('path.blob-body')!
    body.setAttribute('fill', `url(#${id})`)
    const shadow = svg.querySelector<SVGPathElement>('path.blob-shadow')!
    const core = svg.querySelector<SVGPathElement>('path.blob-core')!
    const stops = [...svg.querySelectorAll<SVGStopElement>('stop.blob-stop')]

    // The gradient runs light centre → deep edge: palette slots 3, 2, 0.
    const slots = (bars: string[]): Rgb[] => [3, 2, 0].map((s) => hexToRgb(bars[s]))
    let colours = slots(idle.bars)
    let glowRgb = hexToRgb(idle.glow)
    const first = blobFrame('idle', 0, 0, false)
    const cur = { scale: first.scale, opacity: 1, glow: 0, spin: first.spin, radii: first.radii }
    let angle = 0
    let painted: number[] | null = null
    return {
      paint({ mode, level, palette, reduced, t, dt }) {
        const target = blobFrame(mode, t, level, reduced)
        colours = colours.map((c, i) => easeRgb(c, slots(palette.bars)[i], dt, COLOUR_RATE))
        glowRgb = easeRgb(glowRgb, hexToRgb(palette.glow), dt, COLOUR_RATE)
        cur.scale = easeToward(cur.scale, target.scale, dt, SHAPE_RATE)
        cur.opacity = easeToward(cur.opacity, target.opacity, dt, COLOUR_RATE)
        cur.glow = easeToward(cur.glow, target.glow, dt, SHAPE_RATE)
        cur.spin = easeToward(cur.spin, target.spin, dt, COLOUR_RATE)
        cur.radii = cur.radii.map((r, i) => easeToward(r, target.radii[i], dt, SHAPE_RATE))
        angle = (angle + cur.spin * dt) % 360

        const vec = [
          ...colours.flat().map((v) => v / 255),
          ...glowRgb.map((v) => v / 255),
          cur.scale,
          cur.opacity,
          cur.glow,
          cur.spin,
          ...cur.radii,
        ]
        if (isSettled(painted, vec, 0.001)) return
        painted = vec

        stops.forEach((s, i) => {
          const [r, g, b] = colours[i]
          s.setAttribute('stop-color', `rgb(${r | 0},${g | 0},${b | 0})`)
        })
        const d = blobPath(cur.radii, 32, 32, BLOB_RADIUS, angle)
        body.setAttribute('d', d)
        shadow.setAttribute('d', d)
        // A smaller, counter-turning inner glow: the same outline reversed.
        core.setAttribute('d', blobPath([...cur.radii].reverse(), 33, 34, BLOB_RADIUS * 0.55, -angle * 1.5))
        const [r, g, b] = colours[0]
        core.setAttribute('fill', `rgb(${r | 0},${g | 0},${b | 0})`)
        hostStyle(svg, cur.scale, cur.opacity, cur.glow, glowRgb, GLOW_ALPHA)
      },
    }
  },
}
