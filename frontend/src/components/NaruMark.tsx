import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement, RefObject } from 'react'
import { markSkinRenderUrl } from '../api'
import { simEnvelope, smoothLevel } from '../liveBand'
import type { LiveIndicator } from '../liveIndicator'
import { indicatorLabel } from '../liveIndicator'
import { levelFromRms, markMode, paletteFor } from '../liveMark'
import { currentMarkSkin, isCustomMarkSkin, subscribeMarkSkin } from '../markSkin'
import type { MarkInput, MarkSkin } from '../markSkin'
import { frameMessage, MARK_SKIN_READY_MS, nextSkinState, themeMessage } from '../markSkinCustom'
import type { SkinLoadState } from '../markSkinCustom'
import { cssVar, onThemeChange } from '../theme'
import { SKINS } from './markSkins'

/** What the loop reads every frame, kept in one ref so it never re-renders. */
interface MarkLive {
  state: LiveIndicator | null
  level: number
  speechRms: () => number | null
  offer: boolean
  brandIdle: boolean
}

type MarkAria = { 'aria-hidden': true } | { role: 'status'; 'aria-label': string }

/**
 * The Naru mark (mesa task 1544), the header's one picture of the
 * conversation, painted straight into attributes from a single rAF loop —
 * React renders it once; state, level and the reduced-motion query reach the
 * loop through refs, so a 60fps animation never costs a render. What it looks
 * like is the current skin's (naru task 2120, `markSkin.ts`): this host works
 * out the mode, level and palette each frame and hands them to the skin's
 * painter; a skin change re-renders once and re-mounts the painter. A custom
 * skin (naru task 2122, `custom-<n>`) is a sandboxed iframe the same loop
 * posts each frame to, falling back to the waveform when it breaks.
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
  skin: skinOverride,
  onSkinState,
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
  /** Draw this skin rather than the current one (the Settings previews). */
  skin?: string
  /** A custom skin's load state as it changes (the Settings picker). */
  onSkinState?: (state: SkinLoadState) => void
}) {
  const live = useRef<MarkLive>({ state, level, speechRms, offer, brandIdle })
  useEffect(() => {
    live.current = { state, level, speechRms, offer, brandIdle }
  }, [state, level, speechRms, offer, brandIdle])

  const chosen = useSyncExternalStore(subscribeMarkSkin, currentMarkSkin)
  const id = skinOverride ?? chosen
  const aria: MarkAria = decorative
    ? { 'aria-hidden': true }
    : {
        role: 'status',
        'aria-label': `${state === null ? 'Naru' : indicatorLabel(state)}${micReady ? ', mic ready' : ''}`,
      }

  if (isCustomMarkSkin(id)) {
    return <CustomMark key={id} id={id} live={live} aria={aria} onSkinState={onSkinState} />
  }
  return <SvgMark skin={SKINS[id] ?? SKINS.waveform} live={live} aria={aria} />
}

/**
 * Runs the one rAF loop for a mounted mark: each frame works out the mode,
 * the level of that mode's side of the conversation and the palette, and
 * hands them to `paint`. Answers the disposer.
 */
function runMarkLoop(live: RefObject<MarkLive>, paint: (input: MarkInput) => void): () => void {
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
    const cur = live.current
    const mode = markMode(cur.state, cur.offer)

    // The real level of this mode's side of the conversation.
    let raw = 0
    if (mode === 'hear') raw = levelFromRms(cur.level)
    else if (mode === 'speak') {
      const rms = cur.speechRms()
      raw = rms === null ? 0.35 + 0.65 * simEnvelope(t * (reduced ? 0.5 : 1) * 1.7) : levelFromRms(rms)
    }
    lv = smoothLevel(lv, raw)

    paint({ mode, level: lv, palette: paletteFor(mode, cur.brandIdle), reduced, t, dt })
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  return () => {
    cancelAnimationFrame(raf)
    media.removeEventListener('change', onChange)
  }
}

/** A built-in skin: its markup in the host's svg, its painter on the loop. */
function SvgMark({ skin, live, aria }: { skin: MarkSkin<ReactElement[]>; live: RefObject<MarkLive>; aria: MarkAria }) {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const svg = svgRef.current
    if (svg === null) return
    const painter = skin.mount(svg, paletteFor('idle', live.current.brandIdle))
    return runMarkLoop(live, (input) => painter.paint(input))
  }, [skin, live])

  return (
    <svg ref={svgRef} className="naru-mark" viewBox="0 0 64 64" strokeLinecap="round" {...aria}>
      {skin.markup()}
    </svg>
  )
}

/**
 * A custom skin (naru task 2122, `docs/mark-skins.md`): its document in an
 * opaque-origin `sandbox="allow-scripts"` iframe (the render route adds the
 * artifact CSP and the `naruMark` bootstrap), sent every frame and the theme
 * on ready and on each theme change. No `mark-ready` within
 * `MARK_SKIN_READY_MS`, or a `mark-error` at any time, swaps in the waveform
 * for good (`markSkinCustom.ts::nextSkinState`); a missing skin's 404 page
 * never announces itself, so the timer catches it too.
 */
function CustomMark({
  id,
  live,
  aria,
  onSkinState,
}: {
  id: string
  live: RefObject<MarkLive>
  aria: MarkAria
  onSkinState?: (state: SkinLoadState) => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [load, setLoad] = useState<SkinLoadState>('loading')
  const report = useRef(onSkinState)
  useEffect(() => {
    report.current = onSkinState
  }, [onSkinState])
  useEffect(() => {
    report.current?.(load)
  }, [load])

  const failed = load === 'fallback'
  useEffect(() => {
    if (failed) return
    const post = (message: unknown): void => {
      frameRef.current?.contentWindow?.postMessage(message, '*')
    }
    const sendTheme = (): void => post(themeMessage((name) => cssVar(name, '')))
    const onMessage = (e: MessageEvent): void => {
      const win = frameRef.current?.contentWindow
      const fromFrame = win != null && e.source === win
      if (!fromFrame) return
      if ((e.data as { naru?: unknown } | null)?.naru === 'mark-ready') sendTheme()
      setLoad((s) => nextSkinState(s, { kind: 'message', fromFrame, data: e.data }))
    }
    window.addEventListener('message', onMessage)
    const timer = window.setTimeout(() => setLoad((s) => nextSkinState(s, { kind: 'timeout' })), MARK_SKIN_READY_MS)
    const offTheme = onThemeChange(sendTheme)
    const stopLoop = runMarkLoop(live, (input) => post(frameMessage(input)))
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
      offTheme()
      stopLoop()
    }
  }, [failed, live])

  return (
    <span className="naru-mark naru-mark-frame" data-skin-state={load} {...aria}>
      {failed ? (
        <SvgMark skin={SKINS.waveform} live={live} aria={{ 'aria-hidden': true }} />
      ) : (
        <iframe
          ref={frameRef}
          sandbox="allow-scripts"
          src={markSkinRenderUrl(id)}
          title=""
          aria-hidden="true"
          tabIndex={-1}
        />
      )}
    </span>
  )
}
