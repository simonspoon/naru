import { useEffect, useRef } from 'react'
import { simEnvelope, smoothLevel } from '../liveBand'
import type { LiveIndicator } from '../liveIndicator'
import { indicatorLabel } from '../liveIndicator'
import {
  BAR_SLOT,
  easeRgb,
  easeToward,
  GLOW_ALPHA,
  hexToRgb,
  isSettled,
  levelFromRms,
  markFrame,
  markMode,
  paletteFor,
  type Rgb,
} from '../liveMark'

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
 * The Naru waveform mark (mesa task 1544), the header's one picture of the
 * conversation. An SVG of the favicon's seven bars, painted straight into
 * attributes from a single rAF loop — React renders it once; state, level and
 * the reduced-motion query reach the loop through refs, so a 60fps animation
 * never costs a render. `liveMark.ts` owns what each state looks like.
 *
 * Levels: `level` is the microphone's raw RMS (the hub's own state, already
 * throttled at the source); `speechRms` reads the playback analyser live
 * (`speechTap.ts`) and answers null when the output could not be tapped, in
 * which case speaking falls back to the simulated envelope.
 */
export function NaruMark({
  state,
  level,
  speechRms,
  micReady = false,
}: {
  state: LiveIndicator | null
  level: number
  speechRms: () => number | null
  micReady?: boolean
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const stateRef = useRef(state)
  const levelRef = useRef(level)
  const rmsRef = useRef(speechRms)

  useEffect(() => {
    stateRef.current = state
    levelRef.current = level
    rmsRef.current = speechRms
  }, [state, level, speechRms])

  useEffect(() => {
    const svg = svgRef.current
    if (svg === null) return
    const groups = [...svg.querySelectorAll<SVGGElement>('g.mark-bar')]
    const colours = [...svg.querySelectorAll<SVGLineElement>('line.mark-c')]
    const cores = [...svg.querySelectorAll<SVGLineElement>('line.mark-core')]

    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = media.matches
    const onChange = (e: MediaQueryListEvent): void => {
      reduced = e.matches
    }
    media.addEventListener('change', onChange)

    // Eased values the frame actually paints: every one chases its target so
    // a state change is a glide, never a snap.
    const idle = paletteFor('idle')
    const cur = {
      bars: idle.bars.map(hexToRgb) as Rgb[],
      glowRgb: hexToRgb(idle.glow),
      scale: 0.9,
      glow: 0,
      barScale: new Array<number>(7).fill(1),
      core: 0.35,
      opacity: 1,
      lv: 0,
    }
    let last = performance.now()
    const start = last
    let raf = 0
    let painted: number[] | null = null
    const frame = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const t = (now - start) / 1000
      const mode = markMode(stateRef.current)

      // The real level of this mode's side of the conversation.
      let raw = 0
      if (mode === 'hear') raw = levelFromRms(levelRef.current)
      else if (mode === 'speak') {
        const rms = rmsRef.current()
        raw = rms === null ? 0.35 + 0.65 * simEnvelope(t * (reduced ? 0.5 : 1) * 1.7) : levelFromRms(rms)
      }
      cur.lv = smoothLevel(cur.lv, raw)

      const target = markFrame(mode, t, cur.lv, reduced)
      const pal = paletteFor(mode)
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
      if (isSettled(painted, vec, 0.001)) {
        raf = requestAnimationFrame(frame)
        return
      }
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
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      media.removeEventListener('change', onChange)
    }
  }, [])

  return (
    <svg
      ref={svgRef}
      className="naru-mark"
      viewBox="0 0 64 64"
      strokeLinecap="round"
      role="status"
      aria-label={`${state === null ? 'Naru' : indicatorLabel(state)}${micReady ? ', mic ready' : ''}`}
    >
      {X.map((x, i) => (
        <g key={x} className="mark-bar">
          <line x1={x} y1={Y[i][0]} x2={x} y2={Y[i][1]} stroke="#07030f" strokeWidth={6} strokeOpacity={0.55} />
          <line className="mark-c" x1={x} y1={Y[i][0]} x2={x} y2={Y[i][1]} stroke="#4a4366" strokeWidth={4} />
          <line className="mark-core" x1={x} y1={Y[i][0]} x2={x} y2={Y[i][1]} stroke="#f1e6ff" strokeWidth={1.2} />
        </g>
      ))}
    </svg>
  )
}
