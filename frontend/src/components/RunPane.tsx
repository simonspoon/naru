import { useEffect, useRef, useState } from 'react'
import { getRun, interruptRun, sendRunMessage, stopRun } from '../api'
import { isNearBottom } from '../agentChat'
import {
  runControls,
  runEntries,
  type RunEntry,
  type SubagentGroup,
} from '../runEvents'
import { useFetch } from '../useFetch'

const TAIL = 500

/**
 * A run pane's body (naru task 1832): the live event view of one `naru run`
 * job — `GET /api/runs/{id}` polled while the run is not over, rendered as a
 * transcript, with a composer (send) and Interrupt / Stop gated by
 * `runControls`.
 *
 * Everything in an entry is untrusted model or tool text and is rendered as a
 * plain text node: never HTML, markdown or a URL.
 */
export function RunPane({ runId, paused }: { runId: string; paused: boolean }) {
  const [terminal, setTerminal] = useState(false)
  const { data, error, refetch } = useFetch(
    () => getRun(runId, TAIL),
    `run-${runId}`,
    // Polling stops once the run is over, and while nobody can see the pane.
    { pollMs: paused || terminal ? undefined : 1500 },
  )
  const job = data?.job ?? null
  const controls = runControls(job)
  const over = job !== null && !controls.send
  // Adjusted during render (not in an effect), as `useFetch` does for its key.
  if (over !== terminal) setTerminal(over)

  const entries = data ? runEntries(data.events) : []
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [data])

  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  function act(call: () => Promise<unknown>, onOk?: () => void) {
    setBusy(true)
    setActionError(null)
    call().then(
      () => {
        setBusy(false)
        onOk?.()
        followRef.current = true
        void refetch()
      },
      (err: unknown) => {
        setBusy(false)
        setActionError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  function submit() {
    const t = text.trim()
    if (t === '' || busy || !controls.send) return
    act(() => sendRunMessage(runId, t), () => setText(''))
  }

  return (
    <div className="agent-chat-pane run-pane">
      <div className="muted agent-child-pane-meta">
        <span>{job?.status ?? (error !== null ? 'unavailable' : 'loading…')}</span>
        {job?.model && <span>{job.model}</span>}
        {job && (job.pending_messages ?? 0) > 0 && <span>{job.pending_messages} queued</span>}
        <span className="run-pane-controls">
          <button
            type="button"
            disabled={!controls.interrupt || busy}
            onClick={() => act(() => interruptRun(runId))}
          >
            interrupt
          </button>
          <button
            type="button"
            disabled={!controls.stop || busy}
            onClick={() => act(() => stopRun(runId))}
          >
            stop
          </button>
        </span>
      </div>
      <div
        className="agent-chat run-pane-log"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          followRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
        }}
      >
        {data === null && error === null && <p className="agent-chat-hint">loading…</p>}
        {error !== null && <p className="agent-chat-hint">Not updating — {error}</p>}
        {data !== null && entries.length === 0 && (
          <p className="agent-chat-hint">This run has not produced anything yet.</p>
        )}
        {entries.map((e, i) => (
          <RunEntryRow key={i} entry={e} />
        ))}
      </div>
      <form
        className="agent-chat-composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {actionError !== null && <p className="error">{actionError}</p>}
        <div className="agent-chat-composer-row">
          <textarea
            className="agent-chat-input"
            rows={1}
            value={text}
            disabled={!controls.send}
            placeholder={controls.send ? 'message this run…' : 'this run is over'}
            aria-label="message this run"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              submit()
            }}
          />
          <button type="submit" disabled={!controls.send || busy || text.trim() === ''}>
            send
          </button>
        </div>
      </form>
    </div>
  )
}

function RunEntryRow({ entry }: { entry: RunEntry }) {
  switch (entry.kind) {
    case 'text':
      return (
        <div className="agent-chat-bubble agent-chat-response">
          <div className="run-pane-text">{entry.text}</div>
        </div>
      )
    case 'user':
      return (
        <div className="agent-chat-bubble agent-chat-prompt">
          <div className="run-pane-text">{entry.text}</div>
        </div>
      )
    case 'tool':
      return (
        <>
          <div className="agent-chat-tool" title={entry.target}>
            <span className="agent-chat-tool-name">{entry.name}</span>
            <span className="agent-chat-tool-target">{entry.target}</span>
          </div>
          {entry.subagent && <SubagentFold group={entry.subagent} />}
        </>
      )
    case 'subagent':
      return <SubagentFold group={entry} />
    case 'tool_result':
      return (
        <div className={`agent-chat-tool run-pane-result${entry.isError ? ' run-pane-error' : ''}`}>
          <span className="agent-chat-tool-name">{entry.isError ? 'error' : '↳'}</span>
          <span className="run-pane-result-text">
            {entry.text}
            {entry.truncated ? ' …' : ''}
          </span>
        </div>
      )
    case 'result':
      return (
        <div className={`run-pane-note${entry.isError ? ' run-pane-error' : ''}`}>
          {entry.isError ? 'turn failed' : 'turn done'} · {entry.subtype}
          {entry.costUsd !== null ? ` · $${entry.costUsd.toFixed(4)}` : ''}
        </div>
      )
    case 'lifecycle':
      return <div className="run-pane-note">{entry.label}</div>
    case 'raw':
      return <div className="run-pane-note">{entry.text}</div>
  }
}

/** A subagent's folded work: "label · N events", expanding to its rows. */
function SubagentFold({ group }: { group: SubagentGroup }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="run-pane-subagent">
      <button
        type="button"
        className="run-pane-subagent-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? '▾' : '▸'} {group.label} · {group.count} events
      </button>
      {open && (
        <div className="run-pane-subagent-body">
          {group.entries.map((e, i) => (
            <RunEntryRow key={i} entry={e} />
          ))}
        </div>
      )}
    </div>
  )
}
