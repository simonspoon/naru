import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getAgentOrbit, getCcSessionChat, getCcSubagentChat, getSystemStats } from '../api'
import {
  C,
  DOT_PX,
  DOT_R,
  HOVER_TURNS,
  NARU_R,
  NODE_R,
  RING,
  SUB_PX,
  TITLE_PX,
  chatTurns,
  fitView,
  groupQueue,
  jobHref,
  layoutOrbit,
  loadCollapsed,
  orbitBoxes,
  panView,
  pct,
  placeHover,
  queuedHref,
  saveCollapsed,
  sparkPoints,
  squash,
  subagentRef,
  boostY,
  safeBoost,
  screenBox,
  textBoost,
  orbitIndicator,
  orbitPalettes,
  zoomView,
  type HoverTurn,
  type Pt,
  type ViewBox,
  type WatchPanel,
} from '../agentOrbit'
import { NaruMark } from '../components/NaruMark'
import { currentLiveMarkFeed, subscribeLiveMarkFeed } from '../liveMarkFeed'
import { cssVar, onThemeChange } from '../theme'
import { BURST_MAX, chipOffset, chipSide, chipText, newBursts, type Burst, type NodeTools } from '../toolBurst'
import type { AgentOrbit } from '../types/AgentOrbit'
import type { CcSessionChat } from '../types/CcSessionChat'
import type { OrbitAgent } from '../types/OrbitAgent'
import type { OrbitNaru } from '../types/OrbitNaru'
import type { SystemStats } from '../types/SystemStats'
import { useFetch } from '../useFetch'

// Agent watcher: the orbit map (naru tasks 2541, 2551, docs/agent-watcher.md).
// Naru at the centre with its own sub-agents, running jobs placed by age with
// their sub-agents on the outer side, a hover block with the newest messages
// of whatever is under the pointer, the queue grouped by project, and host
// sparklines. Drawing only — where things go lives in agentOrbit.ts.

/** Where a hover block's messages come from. */
type HoverSrc =
  | { kind: 'session'; sessionId: string }
  | { kind: 'subagent'; sessionId: string; agentId: string }
  | { kind: 'naru' }
  | { kind: 'none' }
/** `anchor` is the pointed-at element, measured on every render so the block follows it as it ages outward. */
type Hover = { key: string; title: string; detail: string | null; src: HoverSrc; anchor: Element }

/**
 * The centre orb (naru task 2632): the live mark, wearing what this browser's
 * conversation wears (`liveMarkFeed.ts`, published by LiveHub) — or, when it
 * is not in one, the server poll's state, without level. Decorative: the
 * conversation head's mark is the one that announces state. Colours are the
 * removed header strip's (`orbitPalettes`), re-read on a theme change.
 */
function CentreMark({ naru, box }: { naru: OrbitNaru; box: { left: number; top: number; size: number } }) {
  const feed = useSyncExternalStore(subscribeLiveMarkFeed, currentLiveMarkFeed)
  const [palettes, setPalettes] = useState(() => orbitPalettes((n) => cssVar(n, '')))
  useEffect(() => onThemeChange(() => setPalettes(orbitPalettes((n) => cssVar(n, '')))), [])
  return (
    <div className="orbit-naru-mark" style={{ left: box.left, top: box.top, width: box.size, height: box.size }}>
      <NaruMark
        decorative
        state={feed ? feed.state : orbitIndicator(naru)}
        level={feed?.level ?? 0}
        speechRms={feed?.speechRms ?? noSpeech}
        offer={feed?.offer ?? false}
        palettes={palettes}
      />
    </div>
  )
}

/** The centre mark's box, in map units. */
const MARK_PX = 116

const noSpeech = (): number | null => null

/** A sub-agent's hover source: its transcript when the key names one (a workflow step's does not). */
function agentSrc(agent: OrbitAgent, transcript: boolean): HoverSrc {
  const ref = transcript ? subagentRef(agent.key) : null
  return ref ? { kind: 'subagent', ...ref } : { kind: 'none' }
}

export function AgentWatcherView({ active = true }: { active?: boolean } = {}) {
  const poll = active ? 5000 : undefined
  const { data, error } = useFetch(getAgentOrbit, 'agent-orbit', { pollMs: poll })
  const { data: stats } = useFetch(getSystemStats, 'system-stats', { pollMs: poll })
  const [hover, setHover] = useState<Hover | null>(null)
  const [statsCollapsed, setStatsCollapsed] = usePanel('stats')
  const [queueCollapsed, setQueueCollapsed] = usePanel('queue')
  // null = fitted to the content on every update; the first pan or zoom
  // makes it the person's, held across live updates until Fit (naru task 2564).
  const [view, setView] = useState<ViewBox | null>(null)
  const [svg, setSvg] = useState<SVGSVGElement | null>(null)
  const shown = useRef<ViewBox | null>(null)
  const clearHover = useCallback(() => setHover(null), [])
  const { dragged, pressed } = usePanZoom(svg, shown, setView, clearHover)
  const px = useSize(svg)
  const layout = data ? layoutOrbit(data.jobs, data.naru.agents, data.now) : null
  const bursts = useBursts(data)
  // Labels grow when the whole map is squeezed into a narrow tab (meet
  // scaling: the tighter axis wins), never into each other (safeBoost).
  const boostFor = (v: ViewBox) => (layout ? safeBoost(layout, textBoost(px ? Math.min(px.w / v.w, px.h / v.h) : 1)) : 1)
  // The auto-fit takes the grown labels in, so none is cut at the edge.
  const fit0 = layout ? fitView(orbitBoxes(layout)) : null
  const vb = view ?? (layout && fit0 ? fitView(orbitBoxes(layout, boostFor(fit0))) : null)
  const b = vb ? boostFor(vb) : 1
  useLayoutEffect(() => {
    shown.current = vb
  })

  if (error) return <div className="agent-watch"><p className="error">{error}</p></div>
  if (!data) return <div className="agent-watch"><p className="muted">Loading…</p></div>

  if (!layout || !vb) return null
  const point = (h: Omit<Hover, 'anchor'>) => ({
    onMouseEnter: (e: React.MouseEvent<SVGElement>) => {
      if (!pressed.current) setHover({ ...h, anchor: e.currentTarget })
    },
    onMouseLeave: () => setHover(null),
  })
  const groups = groupQueue(data.queue, data.projects)
  const nodeAt = anchors(layout)

  return (
    <div className="agent-watch">
      {!data.agentsAvailable && <p className="muted">Agent sessions unavailable: no sub-agents shown.</p>}
      {/* The map is a pan/zoom canvas (naru task 2564); the queue floats in its
          top-right corner, the stats strip sits below it so it covers no node. */}
      <div className="agent-watch-canvas">
        <svg
          ref={setSvg}
          className="orbit"
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          role="img"
          aria-label="Running jobs around Naru"
          onClickCapture={(e) => {
            // A drag that ends over a job is a pan, not a click on its link.
            if (dragged.current) {
              e.preventDefault()
              e.stopPropagation()
            }
          }}
        >
          <defs>
            <filter id="orbit-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="10" />
            </filter>
          </defs>
          <circle className="orbit-ring" cx={C} cy={C} r={RING} />
          <g style={{ stroke: 'var(--violet)' }}>
            {layout.naru.map((d) => (
              <line
                key={d.agent.key}
                className={`orbit-twig${d.agent.state === 'waiting' ? ' waiting' : ''}`}
                x1={C}
                y1={C}
                x2={d.at.x}
                y2={d.at.y}
              />
            ))}
          </g>
          {layout.jobs.map((l) => (
            <g key={`spokes-${l.job.kind}-${l.job.id}`} style={{ stroke: l.job.color }}>
              <line className="orbit-spoke" x1={C} y1={C} x2={l.at.x} y2={l.at.y} />
              {l.dots.map((d) => (
                <line
                  key={d.agent.key}
                  className={`orbit-twig${d.agent.state === 'waiting' ? ' waiting' : ''}`}
                  x1={l.at.x}
                  y1={l.at.y}
                  x2={d.at.x}
                  y2={d.at.y}
                />
              ))}
            </g>
          ))}

          <g
            className="orbit-naru"
            {...point({ key: 'naru', title: 'Naru', detail: data.naru.active ? data.naru.state : 'not live', src: { kind: 'naru' } })}
          >
            <circle cx={C} cy={C} r={NARU_R} className="orbit-naru-disc" />
            <text className="orbit-naru-name" x={C} y={C + NARU_R - 18} textAnchor="middle" fontSize={TITLE_PX}>
              Naru
            </text>
          </g>

          {layout.naru.map((d) => (
            <g
              key={d.agent.key}
              className={`orbit-dot ${d.agent.state}`}
              style={{ color: 'var(--violet)' }}
              {...point({ key: d.agent.key, title: d.agent.label, detail: d.agent.detail, src: agentSrc(d.agent, true) })}
            >
              {d.agent.state === 'working' && (
                <circle cx={d.at.x} cy={d.at.y} r={DOT_R + 8} fill="currentColor" filter="url(#orbit-glow)" opacity={0.6} />
              )}
              <circle className="orbit-dot-disc" cx={d.at.x} cy={d.at.y} r={DOT_R} />
              <text x={d.at.x} y={boostY(d.at.y, d.textY, b)} textAnchor="middle" fontSize={DOT_PX * b}>
                {d.text}
              </text>
            </g>
          ))}

          {layout.jobs.map((l) => {
            const jobSrc: HoverSrc = l.job.sessionId ? { kind: 'session', sessionId: l.job.sessionId } : { kind: 'none' }
            return (
              <a key={`${l.job.kind}-${l.job.id}`} href={jobHref(l.job)} className={`orbit-job ${l.job.state}`} aria-label={`${l.job.title}, ${l.sub}`}>
                <g {...point({ key: `${l.job.kind}-${l.job.id}`, title: l.job.title, detail: l.sub, src: jobSrc })}>
                  {l.job.state === 'working' && (
                    <circle cx={l.at.x} cy={l.at.y} r={NODE_R + 10} fill={l.job.color} filter="url(#orbit-glow)" opacity={0.4} />
                  )}
                  <circle className="orbit-node" cx={l.at.x} cy={l.at.y} r={NODE_R} style={{ stroke: l.job.color }} />
                  <text className="orbit-title" x={l.at.x} y={boostY(l.at.y, l.titleY, b)} textAnchor="middle" fontSize={TITLE_PX * b}>
                    {l.title}
                  </text>
                  <text className="orbit-sub" x={l.at.x} y={boostY(l.at.y, l.subY, b)} textAnchor="middle" fontSize={SUB_PX * b}>
                    {l.sub}
                  </text>
                </g>
                {l.dots.map((d) => (
                  <g
                    key={d.agent.key}
                    className={`orbit-dot ${d.agent.state}`}
                    style={{ color: l.job.color }}
                    {...point({ key: d.agent.key, title: d.agent.label, detail: d.agent.detail, src: agentSrc(d.agent, l.job.kind === 'task') })}
                  >
                    {d.agent.state === 'working' && (
                      <circle cx={d.at.x} cy={d.at.y} r={DOT_R + 8} fill="currentColor" filter="url(#orbit-glow)" opacity={0.6} />
                    )}
                    <circle className="orbit-dot-disc" cx={d.at.x} cy={d.at.y} r={DOT_R} />
                    <text x={d.at.x} y={boostY(d.at.y, d.textY, b)} textAnchor="middle" fontSize={DOT_PX * b}>
                      {d.text}
                    </text>
                  </g>
                ))}
              </a>
            )
          })}
          <g className="orbit-bursts" aria-hidden="true">
            {bursts.map((bu) => {
              const from = nodeAt.get(bu.node)
              if (!from) return null
              const fs = DOT_PX * b * CHIP_SCALE
              const width = (text: string) => text.length * fs * 0.6 + fs
              // The side away from the centre, unless the widest chip would
              // leave the view there and fit on the other side.
              const reach = from.r + 6 + CHIP_FLIGHT * b + Math.max(...bu.chips.map((c) => width(chipText(c))))
              const fits = (sd: 1 | -1) => (sd > 0 ? from.at.x + reach <= vb.x + vb.w : from.at.x - reach >= vb.x)
              const side = fits(from.side) || !fits(-from.side as 1 | -1) ? from.side : (-from.side as 1 | -1)
              return (
                <g key={bu.id} transform={`translate(${from.at.x + side * (from.r + 6)} ${from.at.y})`}>
                  {bu.chips.map((c, i) => {
                    const off = chipOffset(side, i, bu.chips.length, CHIP_FLIGHT * b, fs)
                    const text = chipText(c)
                    // The chip grows away from its node: its near edge is at the offset.
                    const w = width(text)
                    const x0 = side > 0 ? 0 : -w
                    return (
                      <g
                        key={i}
                        className={`orbit-chip ${c.kind}${c.error ? ' error' : ''}`}
                        style={{ '--dx': `${off.x}px`, '--dy': `${off.y}px`, animationDelay: `${i * CHIP_STAGGER_S}s` } as React.CSSProperties}
                      >
                        <rect x={x0} y={-fs * 0.75} width={w} height={fs * 1.5} rx={fs * 0.45} />
                        <text x={x0 + w / 2} y={fs * 0.33} textAnchor="middle" fontSize={fs}>
                          {text}
                        </text>
                      </g>
                    )
                  })}
                </g>
              )
            })}
          </g>
          {layout.jobs.length === 0 && (
            <text className="orbit-sub" x={C} y={C + RING} textAnchor="middle" fontSize={SUB_PX * b}>
              Nothing running
            </text>
          )}
        </svg>
        {active && px && (
          // The disc's upper part, so the "Naru" label inside it stays clear.
          <CentreMark naru={data.naru} box={screenBox(vb, px, { x: C, y: C - NARU_R + 4 + MARK_PX / 2 }, MARK_PX)} />
        )}
        <div className="orbit-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => setView(zoomView(vb, 1.25, centre(vb)))}>+</button>
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => setView(zoomView(vb, 0.8, centre(vb)))}>−</button>
          <button type="button" aria-label="Fit to content" title="Fit to content" onClick={() => setView(null)}>Fit</button>
        </div>
        <section className={`orbit-queue${queueCollapsed ? ' collapsed' : ''}`}>
          <PanelToggle collapsed={queueCollapsed} onToggle={() => setQueueCollapsed(!queueCollapsed)}>
            <span className="orbit-panel-title">Queue ({data.queue.length})</span>
          </PanelToggle>
          {!queueCollapsed && (
            <div className="orbit-queue-list">
              {groups.length === 0 ? (
                <p className="muted">Nothing queued</p>
              ) : (
                groups.map((g) => (
                  <div key={g.key} className={`orbit-group${g.workflow ? ' workflow' : ''}`} style={g.workflow ? undefined : { '--proj': g.color } as React.CSSProperties}>
                    <h3>{g.name}</h3>
                    {g.items.map((q) => (
                      <a
                        key={`${q.kind}-${q.id}`}
                        href={queuedHref(q)}
                        className={`orbit-item${q.kind === 'workflow' ? ' workflow' : ''}${q.blocked ? ' blocked' : ''}`}
                        style={q.kind === 'workflow' ? undefined : ({ '--proj': q.color } as React.CSSProperties)}
                        title={q.title}
                      >
                        {q.title}
                      </a>
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
        </section>
        {hover && <HoverBlock hover={hover} naru={data.naru} />}
      </div>
      {stats && <StatGraphs stats={stats} collapsed={statsCollapsed} onToggle={() => setStatsCollapsed(!statsCollapsed)} />}
    </div>
  )
}

/** How far a chip flies out sideways from its node's edge, in viewBox units (before label boost). */
const CHIP_FLIGHT = 40
/** A chip's text against a dot label's: a touch larger, as it is read in passing. */
const CHIP_SCALE = 1.15
/** Delay between the chips of one burst, and one chip's whole life (the CSS animation's length). */
const CHIP_STAGGER_S = 0.2
const CHIP_LIFE_MS = 2400

/** Every node a burst can leave: where it is, its painted radius and which side its chips go. */
function anchors(layout: ReturnType<typeof layoutOrbit>) {
  const m = new Map<string, { at: Pt; r: number; side: 1 | -1 }>()
  const centre: Pt = { x: C, y: C }
  m.set('naru', { at: centre, r: NARU_R, side: 1 })
  for (const d of layout.naru) m.set(d.agent.key, { at: d.at, r: DOT_R, side: chipSide(centre, d.at) })
  for (const l of layout.jobs) {
    const job = { at: l.at, r: NODE_R, side: chipSide(centre, l.at) }
    m.set(`${l.job.kind}-${l.job.id}`, job)
    // A sub-agent with no dot of its own (past the cluster cap) bursts from its job.
    for (const a of l.job.agents) m.set(a.key, job)
    for (const d of l.dots) m.set(d.agent.key, { at: d.at, r: DOT_R, side: chipSide(l.at, d.at) })
  }
  return m
}

/** The orbit's nodes and their tool calls, keyed as `anchors` keys them. */
function feedNodes(o: AgentOrbit): NodeTools[] {
  const nodes: NodeTools[] = [{ node: 'naru', tools: o.naru.tools, agents: o.naru.agents }]
  for (const a of o.naru.agents) nodes.push({ node: a.key, tools: a.tools })
  for (const j of o.jobs) {
    nodes.push({ node: `${j.kind}-${j.id}`, tools: j.tools, agents: j.kind === 'task' ? j.agents : [] })
    for (const a of j.agents) nodes.push({ node: a.key, tools: a.tools })
  }
  return nodes
}

/** The bursts in flight: each feed's new tool calls, dropped once their chips have faded. */
function useBursts(data: AgentOrbit | null | undefined): (Burst & { id: number })[] {
  const [live, setLive] = useState<(Burst & { id: number })[]>([])
  const seen = useRef<Set<string> | null>(null)
  const next = useRef(0)
  // Each burst's own timer outlives the next feed; only unmounting clears them.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const all = timers.current
    return () => all.forEach(clearTimeout)
  }, [])
  useEffect(() => {
    if (!data) return
    const { bursts, seen: s } = newBursts(feedNodes(data), seen.current)
    seen.current = s
    if (bursts.length === 0) return
    const added = bursts.map((bu) => ({ ...bu, id: next.current++ }))
    const ids = new Set(added.map((a) => a.id))
    setLive((l) => [...l, ...added])
    const t = setTimeout(() => {
      timers.current.delete(t)
      setLive((l) => l.filter((x) => !ids.has(x.id)))
    }, CHIP_LIFE_MS + (BURST_MAX - 1) * CHIP_STAGGER_S * 1000 + 200)
    timers.current.add(t)
  }, [data])
  return live
}

/** An element's size in CSS pixels, kept current as it resizes. */
function useSize(el: Element | null): { w: number; h: number } | null {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return size
}

const centre = (v: ViewBox): Pt => ({ x: v.x + v.w / 2, y: v.y + v.h / 2 })

/**
 * Drag to pan, wheel (or a trackpad pinch, which arrives as a ctrl-wheel) and
 * a two-finger pinch to zoom about the pointer. Screen pixels are turned into
 * viewBox units through the SVG's own screen matrix; `shown` is the view on
 * screen, the start point while `view` is still the auto-fit. `dragged` says
 * the press moved far enough to be a drag (its click is dropped), `pressed`
 * that a press is down; `onDrag` fires as a drag begins.
 */
function usePanZoom(
  svg: SVGSVGElement | null,
  shown: React.RefObject<ViewBox | null>,
  setView: React.Dispatch<React.SetStateAction<ViewBox | null>>,
  onDrag: () => void,
) {
  const dragged = useRef(false)
  const pressed = useRef(false)
  useEffect(() => {
    if (!svg) return
    const toView = (cx: number, cy: number): Pt => {
      const m = svg.getScreenCTM()
      if (!m) return { x: 0, y: 0 }
      const p = new DOMPoint(cx, cy).matrixTransform(m.inverse())
      return { x: p.x, y: p.y }
    }
    const unit = () => svg.getScreenCTM()?.a || 1
    const change = (f: (v: ViewBox) => ViewBox) =>
      setView((v) => {
        const from = v ?? shown.current
        return from ? f(from) : v
      })
    const zoom = (factor: number, cx: number, cy: number) => {
      const at = toView(cx, cy)
      change((v) => zoomView(v, factor, at))
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      zoom(Math.exp(-px * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY)
    }
    const ptrs = new Map<number, { x: number; y: number }>()
    let start = { x: 0, y: 0 }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      if (e.pointerType === 'mouse') ptrs.clear()
      if (ptrs.size === 0) {
        dragged.current = false
        start = { x: e.clientX, y: e.clientY }
      }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
      pressed.current = true
    }
    const onMove = (e: PointerEvent) => {
      const last = ptrs.get(e.pointerId)
      if (!last) return
      // A release we never saw (a ctrl-click's context menu, say): no button held, no press.
      if (e.pointerType === 'mouse' && e.buttons === 0) return onUp(e)
      const now = { x: e.clientX, y: e.clientY }
      if (!dragged.current && Math.hypot(now.x - start.x, now.y - start.y) > 4) {
        dragged.current = true
        onDrag()
      }
      if (ptrs.size === 1) {
        if (dragged.current) {
          const k = unit()
          change((v) => panView(v, (now.x - last.x) / k, (now.y - last.y) / k))
        }
      } else if (ptrs.size === 2) {
        const other = [...ptrs].find(([id]) => id !== e.pointerId)![1]
        const before = Math.hypot(last.x - other.x, last.y - other.y)
        const after = Math.hypot(now.x - other.x, now.y - other.y)
        if (before > 0) zoom(after / before, (now.x + other.x) / 2, (now.y + other.y) / 2)
      }
      ptrs.set(e.pointerId, now)
    }
    const onUp = (e: PointerEvent) => {
      if (!ptrs.delete(e.pointerId) || ptrs.size > 0) return
      pressed.current = false
      // The click a drag ends with fires right after this; later ones (a
      // keyboard Enter on a job link) must go through.
      setTimeout(() => (dragged.current = false))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    svg.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      svg.removeEventListener('wheel', onWheel)
      svg.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [svg, shown, setView, onDrag])
  return { dragged, pressed }
}

/** The newest few messages of whatever the pointer is on, beside it and never off screen. */
function HoverBlock({ hover, naru }: { hover: Hover; naru: OrbitNaru }) {
  const ref = useRef<HTMLDivElement>(null)
  const { src } = hover
  const load = useCallback((): Promise<CcSessionChat | null> => {
    if (src.kind === 'session') return getCcSessionChat(src.sessionId, 40)
    if (src.kind === 'subagent') return getCcSubagentChat(src.sessionId, src.agentId, 40)
    return Promise.resolve(null)
  }, [src])
  const { data, error } = useFetch(load, hover.key, { pollMs: 5000 })
  const turns: HoverTurn[] =
    src.kind === 'naru'
      ? naru.recent.slice(-HOVER_TURNS).map((t) => ({ who: t.role === 'user' ? 'you' : 'naru', text: squash(t.text) }))
      : data
        ? chatTurns(data)
        : []
  const empty =
    src.kind === 'none'
      ? 'No transcript to show.'
      : error
        ? 'Transcript unavailable.'
        : src.kind !== 'naru' && !data
          ? 'Reading…'
          : turns.length === 0
            ? 'Nothing said yet.'
            : null

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const at = placeHover(hover.anchor.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight)
    el.style.left = `${at.left}px`
    el.style.top = `${at.top}px`
    el.style.visibility = 'visible'
  })

  return (
    <div ref={ref} className="orbit-hover" role="tooltip">
      <div className="orbit-hover-head">
        <strong>{squash(hover.title, 80)}</strong>
        {hover.detail && <span>{squash(hover.detail, 120)}</span>}
      </div>
      {empty ? (
        <p className="muted">{empty}</p>
      ) : (
        turns.map((t, i) => (
          <p key={i} className={`orbit-hover-turn ${t.who}`}>
            <span className="orbit-hover-who">{t.who}</span>
            {t.text}
          </p>
        ))
      )}
    </div>
  )
}

/** A side panel's collapsed state, remembered in this browser. */
function usePanel(panel: WatchPanel): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(panel))
  const set = (next: boolean) => {
    setCollapsed(next)
    saveCollapsed(panel, next)
  }
  return [collapsed, set]
}

/** A panel's head: one button that collapses or expands it. */
function PanelToggle({ collapsed, onToggle, children }: { collapsed: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="orbit-panel-toggle" aria-expanded={!collapsed} onClick={onToggle}>
      {children}
      <span className="orbit-panel-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
    </button>
  )
}

function StatGraphs({ stats, collapsed, onToggle }: { stats: SystemStats; collapsed: boolean; onToggle: () => void }) {
  const h = stats.history
  const mem = h.map((s) => pct(s.memUsedBytes, s.memTotalBytes) ?? 0)
  const gpu = h.flatMap((s) => (s.gpuPct == null ? [] : [s.gpuPct]))
  const disk = pct(stats.sample.diskUsedBytes, stats.sample.diskTotalBytes)
  const rows: { name: string; cls: string; values: number[] | null; now: number | null }[] = [
    { name: 'CPU', cls: 'cpu', values: h.map((s) => s.cpuPct), now: stats.sample.cpuPct },
    { name: 'MEM', cls: 'mem', values: mem, now: pct(stats.sample.memUsedBytes, stats.sample.memTotalBytes) },
    { name: 'GPU', cls: 'gpu', values: stats.gpuAvailable ? gpu : null, now: stats.gpuAvailable ? stats.sample.gpuPct : null },
  ]
  const now = (v: number | null) => (v == null ? '—' : `${Math.round(v)}%`)
  if (collapsed) {
    return (
      <section className="orbit-stats collapsed">
        <PanelToggle collapsed onToggle={onToggle}>
          <span className="sr-only">System stats</span>
          {[...rows.map((r) => ({ name: r.name, cls: r.cls, now: r.now })), { name: 'DISK', cls: 'disk', now: disk }].map((r) => (
            <span key={r.name} className={`orbit-stat-mini orbit-stat ${r.cls}`}>
              <span className="orbit-stat-name">{r.name}</span>
              <span className="orbit-stat-now">{now(r.now)}</span>
            </span>
          ))}
        </PanelToggle>
      </section>
    )
  }
  return (
    <section className="orbit-stats">
      <PanelToggle collapsed={false} onToggle={onToggle}>
        <span className="orbit-panel-title">System</span>
      </PanelToggle>
      {rows.map((r) => (
        <div key={r.name} className={`orbit-stat ${r.cls}`}>
          <span className="orbit-stat-name">{r.name}</span>
          {r.values ? (
            <svg className="orbit-spark" viewBox="0 0 120 30" preserveAspectRatio="none">
              <polyline points={sparkPoints(r.values, 120, 30)} />
            </svg>
          ) : (
            <span className="orbit-spark muted">unavailable</span>
          )}
          <span className="orbit-stat-now">{now(r.now)}</span>
        </div>
      ))}
      <div className="orbit-stat disk">
        <span className="orbit-stat-name">DISK</span>
        <span className="orbit-meter">
          <span style={{ width: `${disk ?? 0}%` }} />
        </span>
        <span className="orbit-stat-now">{now(disk)}</span>
      </div>
    </section>
  )
}
