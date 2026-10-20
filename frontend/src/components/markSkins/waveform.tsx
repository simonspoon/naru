import type { ReactElement } from 'react'
import { BAR_SLOT, easeRgb, easeToward, GLOW_ALPHA, hexToRgb, isSettled, markFrame, type Rgb } from '../../liveMark'
import type { MarkSkin } from '../../markSkin'

// The favicon's bar geometry (frontend/public/favicon.svg), 64x64 viewBox.
const X = [8, 16, 24, 32, 40, 48, 56]
const Y: [number, number][] = [
  [28, 36],
  [21, 43],
  [14, 50],
  [8, 56],
  [14, 50],
  [21, 43],
  [28, 36],
]

/** Colour/scale ease rates, per second: colour is the slower, calmer one. */
const COLOUR_RATE = 5
const SHAPE_RATE = 14

/**
 * The built-in skin (mesa task 1544, a skin since naru task 2120): the
 * favicon's seven bars. `liveMark.ts` owns what each state looks like.
 */
export const waveform: MarkSkin<ReactElement[]> = {
  id: 'waveform',
  markup: () =>
    X.map((x, i) => (
      <g key={x} className="mark-bar">
        <line x1={x} y1={Y[i][0]} x2={x} y2={Y[i][1]} stroke="#07030f" strokeWidth={6} strokeOpacity={0.55} />
        <line className="mark-c" x1={x} y1={Y[i][0]} x2={x} y2={Y[i][1]} stroke="#4a4366" strokeWidth={4} />
        <line className="mark-core" x1={x} y1={Y[i][0]} x2={x} y2={Y[i][1]} stroke="#f1e6ff" strokeWidth={1.2} />
      </g>
    )),
  mount(svg, idle) {
    const groups = [...svg.querySelectorAll<SVGGElement>('g.mark-bar')]
    const colours = [...svg.querySelectorAll<SVGLineElement>('line.mark-c')]
    const cores = [...svg.querySelectorAll<SVGLineElement>('line.mark-core')]

    // Eased values the frame actually paints: every one chases its target so
    // a state change is a glide, never a snap.
    const cur = {
      bars: idle.bars.map(hexToRgb) as Rgb[],
      glowRgb: hexToRgb(idle.glow),
      scale: 0.9,
      glow: 0,
      barScale: new Array<number>(7).fill(1),
      core: 0.35,
      opacity: 1,
    }
    let painted: number[] | null = null
    return {
      paint({ mode, level, palette: pal, reduced, t, dt }) {
        const target = markFrame(mode, t, level, reduced)
        cur.bars = cur.bars.map((c, i) => easeRgb(c, hexToRgb(pal.bars[i]), dt, COLOUR_RATE))
        cur.glowRgb = easeRgb(cur.glowRgb, hexToRgb(pal.glow), dt, COLOUR_RATE)
        cur.scale = easeToward(cur.scale, target.scale, dt, SHAPE_RATE)
        cur.glow = easeToward(cur.glow, target.glow, dt, SHAPE_RATE)
        cur.core = easeToward(cur.core, target.core, dt, COLOUR_RATE)
        cur.opacity = easeToward(cur.opacity, target.opacity, dt, COLOUR_RATE)
        cur.barScale = cur.barScale.map((b, i) => easeToward(b, target.bars[i], dt, SHAPE_RATE))

        // Skip the writes on a frame where nothing visible moved (a settled
        // paused mark); colour is compared in whole channel steps.
        const vec = [
          ...cur.bars.flatMap((c) => c.map((v) => v / 255)),
          ...cur.glowRgb.map((v) => v / 255),
          cur.scale,
          cur.glow,
          cur.core,
          cur.opacity,
          ...cur.barScale,
        ]
        if (isSettled(painted, vec, 0.001)) return
        painted = vec

        colours.forEach((line, i) => {
          const [r, g, b] = cur.bars[BAR_SLOT[i]]
          line.setAttribute('stroke', `rgb(${r | 0},${g | 0},${b | 0})`)
        })
        cores.forEach((line) => line.setAttribute('stroke-opacity', cur.core.toFixed(3)))
        groups.forEach((g, i) => {
          g.style.transform = `scaleY(${cur.barScale[i].toFixed(3)})`
        })
        svg.style.transform = `scale(${cur.scale.toFixed(3)})`
        svg.style.opacity = cur.opacity.toFixed(3)
        const [gr, gg, gb] = cur.glowRgb
        svg.style.filter =
          cur.glow > 0.01
            ? `drop-shadow(0 0 ${(3 + 9 * cur.glow).toFixed(1)}px rgba(${gr | 0},${gg | 0},${gb | 0},${(GLOW_ALPHA * Math.min(1, cur.glow)).toFixed(3)}))`
            : 'none'
      },
    }
  },
}
