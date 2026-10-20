import type { ReactElement } from 'react'
import { easeRgb, easeToward, GLOW_ALPHA, hexToRgb, isSettled, type Rgb } from '../../liveMark'
import type { MarkSkin } from '../../markSkin'
import { faceFrame, type FaceFrame } from '../../markSkinFrames'
import { hostStyle, nextGradientId } from './paint'

/** The features' ink: a deep violet-black that reads on every state palette. */
const INK = '#140a26'
const COLOUR_RATE = 5
const SHAPE_RATE = 14
/** Eyelids close faster than anything else eases, or a blink would be lost. */
const LID_RATE = 60

// Geometry in the 64x64 viewBox.
const EYES = [23, 41]
const EYE_Y = 30
const MOUTH_Y = 43

/**
 * The face skin (naru task 2121): a round head in the state palette's
 * gradient that blinks, speaks with the voice, leans in to listen and looks up
 * and aside to think. The numbers are `markSkinFrames.ts::faceFrame`'s; this
 * only writes them into the SVG.
 */
export const face: MarkSkin<ReactElement[]> = {
  id: 'face',
  markup: () => [
    <defs key="defs">
      <radialGradient className="face-grad" cx="40%" cy="34%" r="72%">
        <stop className="face-stop" offset="0" />
        <stop className="face-stop" offset="0.55" />
        <stop className="face-stop" offset="1" />
      </radialGradient>
    </defs>,
    <g key="head" className="face-head">
      <circle cx={32} cy={33} r={25} fill="none" stroke="#07030f" strokeWidth={3} strokeOpacity={0.5} />
      <circle className="face-fill" cx={32} cy={33} r={25} />
      <ellipse cx={23} cy={20} rx={8} ry={4.5} fill="#ffffff" fillOpacity={0.28} transform="rotate(-28 23 20)" />
      {EYES.map((x) => (
        <g key={x} className="face-eye">
          <ellipse className="face-pupil" cx={x} cy={EYE_Y} rx={3.6} ry={5} fill={INK} />
          <circle className="face-glint" cx={x + 1.2} cy={EYE_Y - 1.8} r={1.2} fill="#ffffff" />
        </g>
      ))}
      {EYES.map((x) => (
        <line
          key={`b${x}`}
          className="face-brow"
          x1={x - 4}
          y1={EYE_Y - 9}
          x2={x + 4}
          y2={EYE_Y - 9}
          stroke={INK}
          strokeWidth={2.2}
        />
      ))}
      <path className="face-mouth" fill={INK} stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
    </g>,
  ],
  mount(svg, idle) {
    const id = nextGradientId('face')
    const grad = svg.querySelector<SVGRadialGradientElement>('radialGradient.face-grad')!
    grad.id = id
    svg.querySelector('circle.face-fill')!.setAttribute('fill', `url(#${id})`)
    const stops = [...svg.querySelectorAll<SVGStopElement>('stop.face-stop')]
    const head = svg.querySelector<SVGGElement>('g.face-head')!
    const pupils = [...svg.querySelectorAll<SVGEllipseElement>('ellipse.face-pupil')]
    const glints = [...svg.querySelectorAll<SVGCircleElement>('circle.face-glint')]
    const brows = [...svg.querySelectorAll<SVGLineElement>('line.face-brow')]
    const mouth = svg.querySelector<SVGPathElement>('path.face-mouth')!

    // The gradient runs light centre → edge: palette slots 3, 2, 1.
    const slots = (bars: string[]): Rgb[] => [3, 2, 1].map((s) => hexToRgb(bars[s]))
    let colours = slots(idle.bars)
    let glowRgb = hexToRgb(idle.glow)
    let cur: FaceFrame = faceFrame('idle', 0, 0, false)
    let painted: number[] | null = null
    return {
      paint({ mode, level, palette, reduced, t, dt }) {
        const target = faceFrame(mode, t, level, reduced)
        colours = colours.map((c, i) => easeRgb(c, slots(palette.bars)[i], dt, COLOUR_RATE))
        glowRgb = easeRgb(glowRgb, hexToRgb(palette.glow), dt, COLOUR_RATE)
        const next = {} as FaceFrame
        for (const k of Object.keys(target) as (keyof FaceFrame)[]) {
          const rate = k === 'eyeOpen' ? LID_RATE : k === 'opacity' ? COLOUR_RATE : SHAPE_RATE
          next[k] = easeToward(cur[k], target[k], dt, rate)
        }
        cur = next

        const vec = [...colours.flat().map((v) => v / 255), ...glowRgb.map((v) => v / 255), ...Object.values(cur)]
        if (isSettled(painted, vec, 0.001)) return
        painted = vec

        stops.forEach((s, i) => {
          const [r, g, b] = colours[i]
          s.setAttribute('stop-color', `rgb(${r | 0},${g | 0},${b | 0})`)
        })
        head.setAttribute('transform', `rotate(${cur.tilt.toFixed(2)} 32 36)`)
        const rx = 3.6 * cur.eyeSize
        const ry = Math.max(0.6, 5 * cur.eyeSize * cur.eyeOpen)
        pupils.forEach((e, i) => {
          e.setAttribute('cx', (EYES[i] + cur.gazeX).toFixed(2))
          e.setAttribute('cy', (EYE_Y + cur.gazeY).toFixed(2))
          e.setAttribute('rx', rx.toFixed(2))
          e.setAttribute('ry', ry.toFixed(2))
        })
        glints.forEach((c, i) => {
          c.setAttribute('cx', (EYES[i] + cur.gazeX + 1.2 * cur.eyeSize).toFixed(2))
          c.setAttribute('cy', (EYE_Y + cur.gazeY - 1.8 * cur.eyeSize * cur.eyeOpen).toFixed(2))
          c.setAttribute('opacity', Math.max(0, cur.eyeOpen * 1.4 - 0.4).toFixed(3))
        })
        const browY = EYE_Y - 9 - 2 * (cur.eyeSize - 1) * 5 + cur.browLift
        brows.forEach((l, i) => {
          // The left brow lifts and slants with the thinking tilt, the right
          // dips a little the other way.
          const lift = i === 0 ? -0.12 * cur.browTilt : 0
          const angle = i === 0 ? -cur.browTilt : 0.4 * cur.browTilt
          l.setAttribute('y1', (browY + lift).toFixed(2))
          l.setAttribute('y2', (browY + lift).toFixed(2))
          l.setAttribute('transform', `rotate(${angle.toFixed(2)} ${EYES[i]} ${(browY + lift).toFixed(2)})`)
        })
        const half = 6 * cur.mouthWidth
        const corner = MOUTH_Y - 2.5 * cur.smile
        const upper = MOUTH_Y + 3 * cur.smile
        const lower = upper + 14 * cur.mouthOpen
        const f = (v: number): string => v.toFixed(2)
        mouth.setAttribute(
          'd',
          `M${f(32 - half)} ${f(corner)}Q32 ${f(upper)} ${f(32 + half)} ${f(corner)}Q32 ${f(lower)} ${f(32 - half)} ${f(corner)}Z`,
        )
        hostStyle(svg, cur.scale, cur.opacity, cur.glow, glowRgb, GLOW_ALPHA)
      },
    }
  },
}
