import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { simEnvelope, smoothLevel } from '../liveBand'
import { EQ_BAR_PX, EQ_COLOR_VAR, EQ_GAIN_FLOOR, EQ_GAP_PX, eqBarCount, eqBarHeight, eqGain, eqMode } from '../liveEq'
import type { EqMode } from '../liveEq'
import type { LiveIndicator } from '../liveIndicator'
import { levelFromRms, MARK_FRAME_MS, markFrameDue, markFrameWait } from '../liveMark'
import { cssVar, onThemeChange } from '../theme'

/** The tallest bar, CSS px: inside the header's bottom padding. */
const MAX_BAR_PX = 8
/** The canvas is taller than the bars by the glow's reach above them. */
const CANVAS_PX = 14
const GLOW_PX = 5

interface EqLive {
  mode: EqMode | null
  level: number
  speechRms: () => number | null
}

/**
 * The header equalizer (naru task 2610, `liveEq.ts`): a click-through canvas
 * along the page header's bottom border. Mounted only while something is
 * happening — plus the short fade after — so an idle header has no element
 * and no loop. One timer-paced rAF loop at most 30fps (naru task 2606, the
 * mark's own `markFrameDue`/`markFrameWait`); levels are the mark's: the
 * microphone's RMS for the person, the playback tap (or the simulated
 * envelope) for Naru.
 */
export function LiveEq({
  state,
  level,
  speechRms,
}: {
  state: LiveIndicator | null
  level: number
  speechRms: () => number | null
}) {
  const mode = eqMode(state)
  const live = useRef<EqLive>({ mode, level, speechRms })
  useEffect(() => {
    live.current = { mode, level, speechRms }
  }, [mode, level, speechRms])

  // Still drawing the fade-out after the activity ended.
  const [fading, setFading] = useState(false)
  const [prev, setPrev] = useState(mode)
  if (mode !== prev) {
    setPrev(mode)
    setFading(mode === null)
  }
  const on = mode !== null || fading
  // Bumped when the loop ends itself, so activity that resumed in the same
  // render starts a fresh one.
  const [epoch, setEpoch] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!on || canvas === null) return
    return runEqLoop(canvas, live, () => {
      setFading(false)
      setEpoch((e) => e + 1)
    })
  }, [on, epoch])

  if (!on) return null
  return <canvas ref={canvasRef} className="live-eq" aria-hidden="true" />
}

function runEqLoop(canvas: HTMLCanvasElement, live: RefObject<EqLive>, done: () => void): () => void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    done()
    return () => {}
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let colors: Record<EqMode, string> = { user: '', naru: '', think: '' }
  const readColors = (): void => {
    colors = {
      user: cssVar(EQ_COLOR_VAR.user, '#29e6ff'),
      naru: cssVar(EQ_COLOR_VAR.naru, '#b06bff'),
      think: cssVar(EQ_COLOR_VAR.think, '#ffb02b'),
    }
  }
  readColors()
  const offTheme = onThemeChange(readColors)

  let shown: EqMode = live.current.mode ?? 'think'
  let gain = 0
  let lv = 0
  let last = performance.now()
  const start = last
  let raf = 0
  let timer = 0
  let stopped = false
  const frame = (now: number): void => {
    if (!markFrameDue(last, now, MARK_FRAME_MS)) {
      raf = requestAnimationFrame(frame)
      return
    }
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const t = ((now - start) / 1000) * (reduced ? 0.5 : 1)
    const cur = live.current
    if (cur.mode !== null) shown = cur.mode
    gain = eqGain(gain, cur.mode !== null, dt)
    if (cur.mode === null && gain < EQ_GAIN_FLOOR) {
      stopped = true
      done()
      return
    }

    let raw = 0
    if (shown === 'user') raw = levelFromRms(cur.level)
    else if (shown === 'naru') {
      const rms = cur.speechRms()
      raw = rms === null ? 0.35 + 0.65 * simEnvelope(t * 1.7) : levelFromRms(rms)
    }
    lv = smoothLevel(lv, raw, dt * 60)

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const pw = Math.round(w * dpr)
    const ph = Math.round(CANVAS_PX * dpr)
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw
      canvas.height = ph
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, CANVAS_PX)
    ctx.fillStyle = colors[shown]
    ctx.shadowColor = colors[shown]
    ctx.shadowBlur = GLOW_PX * dpr
    ctx.beginPath()
    const n = eqBarCount(w)
    // The leftover width split evenly, so the row sits centred.
    const x0 = (w - (n * (EQ_BAR_PX + EQ_GAP_PX) - EQ_GAP_PX)) / 2
    for (let i = 0; i < n; i++) {
      const h = Math.max(1, eqBarHeight(shown, i, t, lv) * gain * MAX_BAR_PX)
      ctx.rect(x0 + i * (EQ_BAR_PX + EQ_GAP_PX), CANVAS_PX - h, EQ_BAR_PX, h)
    }
    ctx.fill()

    timer = window.setTimeout(
      () => (raf = requestAnimationFrame(frame)),
      markFrameWait(now, performance.now(), MARK_FRAME_MS),
    )
  }
  raf = requestAnimationFrame(frame)
  return () => {
    if (!stopped) {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
    offTheme()
  }
}
