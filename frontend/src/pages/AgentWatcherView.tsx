import { useCallback, useLayoutEffect, useRef, useState } from 'react'
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
  VIEW,
  chatTurns,
  groupQueue,
  jobHref,
  layoutOrbit,
  pct,
  placeHover,
  queuedHref,
  sparkPoints,
  squash,
  subagentRef,
  voiceMotion,
  type HoverTurn,
} from '../agentOrbit'
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

const BARS = [0.35, 0.7, 1, 0.65, 0.3]

/** Where a hover block's messages come from. */
type HoverSrc =
  | { kind: 'session'; sessionId: string }
  | { kind: 'subagent'; sessionId: string; agentId: string }
  | { kind: 'naru' }
  | { kind: 'none' }
/** `anchor` is the pointed-at element, measured on every render so the block follows it as it ages outward. */
type Hover = { key: string; title: string; detail: string | null; src: HoverSrc; anchor: Element }

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

  if (error) return <div className="agent-watch"><p className="error">{error}</p></div>
  if (!data) return <div className="agent-watch"><p className="muted">Loading…</p></div>

  const layout = layoutOrbit(data.jobs, data.naru.agents, data.now)
  const point = (h: Omit<Hover, 'anchor'>) => ({
    onMouseEnter: (e: React.MouseEvent<SVGElement>) => setHover({ ...h, anchor: e.currentTarget }),
    onMouseLeave: () => setHover(null),
  })
  const groups = groupQueue(data.queue, data.projects)
  const motion = voiceMotion(data.naru)

  return (
    <div className="agent-watch">
      <div className="agent-watch-head">
        <h1>Agent watcher</h1>
        <span className="agent-watch-count">
          {data.jobs.length} running · {data.queue.length} queued
        </span>
      </div>
      {!data.agentsAvailable && <p className="muted">Agent sessions unavailable: no sub-agents shown.</p>}
      <div className="agent-watch-body">
        <svg className="orbit" viewBox={`0 0 ${VIEW} ${VIEW}`} role="img" aria-label="Running jobs around Naru">
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
            className={`orbit-naru ${motion}`}
            {...point({ key: 'naru', title: 'Naru', detail: data.naru.active ? data.naru.state : 'not live', src: { kind: 'naru' } })}
          >
            <circle cx={C} cy={C} r={NARU_R + 14} className="orbit-naru-glow" filter="url(#orbit-glow)" />
            <circle cx={C} cy={C} r={NARU_R} className="orbit-naru-disc" />
            {BARS.map((h, i) => (
              <rect
                key={i}
                className="orbit-bar"
                x={C - 36 + i * 15}
                y={C - 18 - h * 32}
                width={9}
                height={h * 64}
                rx={4.5}
                style={{ animationDelay: `${i * 0.13}s` }}
              />
            ))}
            <text className="orbit-naru-name" x={C} y={C + 50} textAnchor="middle" fontSize={TITLE_PX}>
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
              <text x={d.at.x} y={d.textY} textAnchor="middle" fontSize={DOT_PX}>
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
                  <text className="orbit-title" x={l.at.x} y={l.titleY} textAnchor="middle" fontSize={TITLE_PX}>
                    {l.title}
                  </text>
                  <text className="orbit-sub" x={l.at.x} y={l.subY} textAnchor="middle" fontSize={SUB_PX}>
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
                    <text x={d.at.x} y={d.textY} textAnchor="middle" fontSize={DOT_PX}>
                      {d.text}
                    </text>
                  </g>
                ))}
              </a>
            )
          })}
          {layout.jobs.length === 0 && (
            <text className="orbit-sub" x={C} y={C + RING} textAnchor="middle" fontSize={SUB_PX}>
              Nothing running
            </text>
          )}
        </svg>
        {hover && <HoverBlock hover={hover} naru={data.naru} />}

        <aside className="agent-watch-side">
          {stats && <StatGraphs stats={stats} />}
          <section className="orbit-queue">
            <h2>Queue</h2>
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
          </section>
        </aside>
      </div>
    </div>
  )
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

function StatGraphs({ stats }: { stats: SystemStats }) {
  const h = stats.history
  const mem = h.map((s) => pct(s.memUsedBytes, s.memTotalBytes) ?? 0)
  const gpu = h.flatMap((s) => (s.gpuPct == null ? [] : [s.gpuPct]))
  const disk = pct(stats.sample.diskUsedBytes, stats.sample.diskTotalBytes)
  const rows: { name: string; cls: string; values: number[] | null; now: number | null }[] = [
    { name: 'CPU', cls: 'cpu', values: h.map((s) => s.cpuPct), now: stats.sample.cpuPct },
    { name: 'MEM', cls: 'mem', values: mem, now: pct(stats.sample.memUsedBytes, stats.sample.memTotalBytes) },
    { name: 'GPU', cls: 'gpu', values: stats.gpuAvailable ? gpu : null, now: stats.gpuAvailable ? stats.sample.gpuPct : null },
  ]
  return (
    <section className="orbit-stats">
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
          <span className="orbit-stat-now">{r.now == null ? '—' : `${Math.round(r.now)}%`}</span>
        </div>
      ))}
      <div className="orbit-stat disk">
        <span className="orbit-stat-name">DISK</span>
        <span className="orbit-meter">
          <span style={{ width: `${disk ?? 0}%` }} />
        </span>
        <span className="orbit-stat-now">{disk == null ? '—' : `${Math.round(disk)}%`}</span>
      </div>
    </section>
  )
}
