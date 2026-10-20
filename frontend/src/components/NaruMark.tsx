import { useEffect, useRef, useSyncExternalStore } from 'react'
import { simEnvelope, smoothLevel } from '../liveBand'
import type { LiveIndicator } from '../liveIndicator'
import { indicatorLabel } from '../liveIndicator'
import { levelFromRms, markMode, paletteFor } from '../liveMark'
import { currentMarkSkin, subscribeMarkSkin } from '../markSkin'
import { SKINS } from './markSkins'

/**
 * The Naru mark (mesa task 1544), the header's one picture of the
 * conversation, painted straight into attributes from a single rAF loop —
 * React renders it once; state, level and the reduced-motion query reach the
 * loop through refs, so a 60fps animation never costs a render. What it looks
 * like is the current skin's (naru task 2120, `markSkin.ts`): this host works
 * out the mode, level and palette each frame and hands them to the skin's
 * painter; a skin change re-renders once and re-mounts the painter.
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
  decorative = false,
  offer = false,
  brandIdle = false,
}: {
  state: LiveIndicator | null
  level: number
  speechRms: () => number | null
  micReady?: boolean
  /** Hidden from assistive tech: a second mark (the floating orb) beside the
   *  head's, whose `role=status` already announces every state. */
  decorative?: boolean
  /** An ambient "can help" offer is glowing: the idle mark turns gold. */
  offer?: boolean
  /** Rest in the favicon's own colours rather than idle's dim slate (the nav). */
  brandIdle?: boolean
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const stateRef = useRef(state)
  const levelRef = useRef(level)
  const rmsRef = useRef(speechRms)
  const offerRef = useRef(offer)
  const brandRef = useRef(brandIdle)

  useEffect(() => {
    offerRef.current = offer
    brandRef.current = brandIdle
    stateRef.current = state
    levelRef.current = level
    rmsRef.current = speechRms
  }, [state, level, speechRms, offer, brandIdle])

  const skin = SKINS[useSyncExternalStore(subscribeMarkSkin, currentMarkSkin)] ?? SKINS.waveform

  useEffect(() => {
    const svg = svgRef.current
    if (svg === null) return
    const painter = skin.mount(svg, paletteFor('idle', brandRef.current))

    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = media.matches
    const onChange = (e: MediaQueryListEvent): void => {
      reduced = e.matches
    }
    media.addEventListener('change', onChange)

    let lv = 0
    let last = performance.now()
    const start = last
    let raf = 0
    const frame = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const t = (now - start) / 1000
      const mode = markMode(stateRef.current, offerRef.current)

      // The real level of this mode's side of the conversation.
      let raw = 0
      if (mode === 'hear') raw = levelFromRms(levelRef.current)
      else if (mode === 'speak') {
        const rms = rmsRef.current()
        raw = rms === null ? 0.35 + 0.65 * simEnvelope(t * (reduced ? 0.5 : 1) * 1.7) : levelFromRms(rms)
      }
      lv = smoothLevel(lv, raw)

      painter.paint({ mode, level: lv, palette: paletteFor(mode, brandRef.current), reduced, t, dt })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      media.removeEventListener('change', onChange)
    }
  }, [skin])

  return (
    <svg
      ref={svgRef}
      className="naru-mark"
      viewBox="0 0 64 64"
      strokeLinecap="round"
      {...(decorative
        ? { 'aria-hidden': true }
        : {
            role: 'status',
            'aria-label': `${state === null ? 'Naru' : indicatorLabel(state)}${micReady ? ', mic ready' : ''}`,
          })}
    >
      {skin.markup()}
    </svg>
  )
}
