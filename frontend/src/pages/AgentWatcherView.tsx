import { getAgentOrbit, getSystemStats } from '../api'
import {
  C,
  DOT_PX,
  DOT_R,
  NARU_R,
  NODE_R,
  RING,
  SUB_PX,
  TITLE_PX,
  VIEW,
  groupQueue,
  jobHref,
  layoutJobs,
  pct,
  queuedHref,
  sparkPoints,
  voiceMotion,
} from '../agentOrbit'
import type { SystemStats } from '../types/SystemStats'
import { useFetch } from '../useFetch'

// Agent watcher: the orbit map (naru task 2541, docs/agent-watcher.md). Naru
// at the centre, running jobs on the ring with their sub-agents on the outer
// side, the queue grouped by project, and host sparklines. Drawing only —
// where things go lives in agentOrbit.ts.

const NODE_CIRC = 2 * Math.PI * NODE_R
const BARS = [0.35, 0.7, 1, 0.65, 0.3]

export function AgentWatcherView({ active = true }: { active?: boolean } = {}) {
  const poll = active ? 5000 : undefined
  const { data, error } = useFetch(getAgentOrbit, 'agent-orbit', { pollMs: poll })
  const { data: stats } = useFetch(getSystemStats, 'system-stats', { pollMs: poll })

  if (error) return <div className="agent-watch"><p className="error">{error}</p></div>
  if (!data) return <div className="agent-watch"><p className="muted">Loading…</p></div>

  const layout = layoutJobs(data.jobs)
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
          {layout.map((l) => (
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

          <g className={`orbit-naru ${motion}`}>
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

          {layout.map((l) => {
            const done = Math.max(0, Math.min(1, l.job.progress))
            return (
              <a key={`${l.job.kind}-${l.job.id}`} href={jobHref(l.job)} className={`orbit-job ${l.job.state}`}>
                <title>{`${l.job.title}\n${l.sub}`}</title>
                {l.job.state === 'working' && (
                  <circle cx={l.at.x} cy={l.at.y} r={NODE_R + 10} fill={l.job.color} filter="url(#orbit-glow)" opacity={0.4} />
                )}
                <circle className="orbit-node" cx={l.at.x} cy={l.at.y} r={NODE_R} />
                <circle
                  cx={l.at.x}
                  cy={l.at.y}
                  r={NODE_R}
                  fill="none"
                  stroke={l.job.color}
                  strokeWidth={8}
                  strokeLinecap="round"
                  strokeDasharray={`${done * NODE_CIRC} ${NODE_CIRC}`}
                  transform={`rotate(-90 ${l.at.x} ${l.at.y})`}
                />
                <text className="orbit-pct" x={l.at.x} y={l.at.y + 8} textAnchor="middle" fontSize={22}>
                  {Math.round(done * 100)}%
                </text>
                <text className="orbit-title" x={l.at.x} y={l.titleY} textAnchor="middle" fontSize={TITLE_PX}>
                  {l.title}
                </text>
                <text className="orbit-sub" x={l.at.x} y={l.subY} textAnchor="middle" fontSize={SUB_PX}>
                  {l.sub}
                </text>
                {l.dots.map((d) => (
                  <g key={d.agent.key} className={`orbit-dot ${d.agent.state}`} style={{ color: l.job.color }}>
                    <title>{d.agent.detail ? `${d.agent.label}: ${d.agent.detail}` : d.agent.label}</title>
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
          {layout.length === 0 && (
            <text className="orbit-sub" x={C} y={C + RING} textAnchor="middle" fontSize={SUB_PX}>
              Nothing running
            </text>
          )}
        </svg>

        <aside className="agent-watch-side">
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
          {stats && <StatGraphs stats={stats} />}
        </aside>
      </div>
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
