import { useEffect, useRef } from 'react'
import { getAmbientLog, getLive } from '../api'
import { ambientLines } from '../ambientLog'
import { useFetch } from '../useFetch'

// Ambient: what the audio server's ambient listener heard in the last couple
// of minutes, newest at the bottom (naru task 2375, docs/live.md "The Ambient
// view"). The lines live only in naru-audio's in-memory ring; this page polls
// the relay and keeps nothing. What a line means lives in ambientLog.ts.

/** The newest turn id never matters here, only the session: asking for the
 * turns after a huge cursor keeps the answer to the session alone. */
const NO_TURNS = Number.MAX_SAFE_INTEGER

export function AmbientView() {
  const { data, error } = useFetch(getAmbientLog, 'ambient-log', { pollMs: 1000 })
  const { data: live } = useFetch(() => getLive(NO_TURNS), 'ambient-live', { pollMs: 2000 })
  const on = live?.session?.ambient === true
  const lines = data ? ambientLines(data) : []

  // Follow the newest line unless the reader has scrolled up to read back.
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const newest = lines[lines.length - 1]?.key
  useEffect(() => {
    const el = scroller.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [newest])

  return (
    <div className="ambient-view">
      <div className="ambient-head">
        <h1>
          <span className={`live-dot ${on ? 'on' : 'off'}`} />
          Ambient
        </h1>
        <span className="muted">{on ? 'Listening' : 'Not listening'} · last 2 minutes, not saved</span>
      </div>
      {error ? (
        // Off, an unreachable log is expected news rather than a fault.
        <p className={on ? 'error' : 'muted'}>{error}</p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : lines.length === 0 ? (
        <p className="muted">Nothing heard in the last 2 minutes.</p>
      ) : (
        <div
          className="ambient-lines"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {lines.map((l) => (
            <p key={l.key} className={`ambient-line ambient-${l.kind}`}>
              <span className="ambient-speaker">{l.speaker}</span>
              <span className="ambient-text">{l.text}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
