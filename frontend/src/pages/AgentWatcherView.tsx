import { useState } from 'react'
import { getAgentWatch } from '../api'
import {
  WINDOWS,
  childrenOf,
  orderRows,
  rowColor,
  rowHref,
  rowSegments,
  segmentBox,
  shouldAlert,
  ticks,
  toolLabel,
} from '../agentWatch'
import { modelColor } from '../sessionDetail'
import { shortModel } from '../sessionGraph'
import { useFetch } from '../useFetch'

// Agent watcher: a full-page live timeline of every running agent, its
// subagents and its shells (naru task 1909, docs/agent-watcher.md). Drawing
// only — what a bar means lives in agentWatch.ts.

const KIND_MARK = { session: '', subagent: '↳ ', shell: '⌁ ' }
const TOOL_MARK = '⚙ ' as const

function windowLabel(m: number): string {
  return m < 60 ? `${m}m` : `${m / 60}h`
}

export function AgentWatcherView({ active = true }: { active?: boolean } = {}) {
  const [mins, setMins] = useState(15)
  const { data, error } = useFetch(() => getAgentWatch(mins), `agent-watch-${mins}`, {
    pollMs: active ? 5000 : undefined,
  })

  const ordered = data ? orderRows(data.rows, data.now, data.now - mins * 60) : []
  const running = data ? data.rows.filter((r) => r.kind === 'session').length : 0
  const windowStart = data ? data.now - mins * 60 : 0

  return (
    <div className="agent-watch">
      <div className="agent-watch-head">
        <h1>
          <span className={`live-dot ${running > 0 ? 'on' : 'off'}`} />
          Agent watcher
        </h1>
        <div className="agent-watch-meta">
          {data && (
            <span>
              <strong>{running}</strong> {running === 1 ? 'agent' : 'agents'} running
            </span>
          )}
          <div className="cc-window">
            {WINDOWS.map((m) => (
              <button
                key={m}
                type="button"
                className={m === mins ? 'active' : ''}
                onClick={() => setMins(m)}
              >
                {windowLabel(m)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {data && shouldAlert(data.rows, data.now) && (
        <p className="agent-watch-banner" role="alert">
          Nobody is working: every agent has been quiet or waiting for 5+ minutes.
        </p>
      )}

      {error ? (
        <p className="error">{error}</p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : ordered.length === 0 ? (
        <p className="muted">No agents running.</p>
      ) : (
        <div className="agent-watch-chart">
          <div className="agent-watch-axis">
            <div className="agent-watch-label" />
            <div className="agent-watch-track">
              {ticks(mins).map((t) => (
                <span key={t.label} className="agent-watch-tick" style={{ left: `${t.pct}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
          {ordered.map(({ row, depth, tool }) =>
            tool ? (
              <a
                key={`${row.key}/tool-${tool.from}-${tool.name}`}
                className="agent-watch-row child tool"
                href={rowHref(row)}
                title={toolLabel(tool)}
              >
                <div className="agent-watch-label">
                  <span className="agent-watch-name">
                    {TOOL_MARK}
                    {tool.name}
                  </span>
                  {tool.summary && <span className="agent-watch-model agent-watch-name">{tool.summary}</span>}
                </div>
                <div className="agent-watch-track">
                  {(() => {
                    const box = segmentBox({ ...tool, state: 'active' }, windowStart, data.now)
                    return (
                      <span
                        className="agent-watch-seg active"
                        style={
                          {
                            left: `${box.left}%`,
                            width: `${box.width}%`,
                            '--seg': rowColor(row),
                          } as React.CSSProperties
                        }
                      />
                    )
                  })()}
                  <span className="agent-watch-now" />
                </div>
              </a>
            ) : (
            <a
              key={row.key}
              className={`agent-watch-row${depth === 1 ? ' child' : ''}`}
              href={rowHref(row)}
            >
              <div className="agent-watch-label" title={row.detail ?? row.label}>
                <span className="agent-watch-name">
                  {KIND_MARK[row.kind]}
                  {row.label}
                </span>
                {row.model && <span className="agent-watch-model">{shortModel(row.model)}</span>}
              </div>
              <div className="agent-watch-track">
                {rowSegments(row, childrenOf(data.rows, row), data.now, windowStart).map((seg) => {
                  const box = segmentBox(seg, windowStart, data.now)
                  return (
                    <span
                      key={`${seg.state}-${seg.from}`}
                      className={`agent-watch-seg ${seg.state}`}
                      style={
                        {
                          left: `${box.left}%`,
                          width: `${box.width}%`,
                          '--seg': rowColor(row),
                        } as React.CSSProperties
                      }
                    />
                  )
                })}
                <span className="agent-watch-now" />
              </div>
            </a>
            ),
          )}
          <div className="agent-watch-legend muted">
            <span><i className="agent-watch-swatch" style={{ background: modelColor('opus') }} /> opus</span>
            <span><i className="agent-watch-swatch" style={{ background: modelColor('sonnet') }} /> sonnet</span>
            <span><i className="agent-watch-swatch" style={{ background: modelColor('haiku') }} /> haiku</span>
            <span><i className="agent-watch-swatch waiting" /> waiting</span>
            <span><i className="agent-watch-swatch quiet" /> quiet</span>
            <span><i className="agent-watch-swatch output" /> shell output</span>
            <span><i className="agent-watch-swatch stalled" /> stalled</span>
          </div>
        </div>
      )}
    </div>
  )
}
