import { useState } from 'react'
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflowLog,
  listWorkflowRuns,
  runWorkflow,
  updateWorkflow,
} from '../api'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { InlineEdit } from '../components/InlineEdit'
import { useLiveContext } from '../liveContext'
import { formatTimestamp, timeAgo } from '../time'
import { useFetch } from '../useFetch'
import { WorkflowCanvas } from '../WorkflowCanvas'
import { formatDuration, runSummary, stepClass } from '../workflowRun'
import type { WorkflowRun } from '../types/WorkflowRun'

/** One finished run, step by step: status, timing and what each node produced
 *  or why it failed. */
function RunSteps({ run }: { run: WorkflowRun }) {
  return (
    <div className="workflow-run">
      <p className={run.status === 'failed' ? 'error' : 'muted'}>
        run #{run.id} · {run.trigger} · {runSummary(run)}
      </p>
      {run.input !== '' && (
        <p className="muted workflow-step-io">
          input: <code>{run.input}</code>
        </p>
      )}
      <ol className="workflow-steps">
        {run.steps.map((s) => (
          <li key={s.node_id} className={`workflow-step ${stepClass(s.status)}`}>
            <div className="workflow-step-head">
              <span className="workflow-step-status">{s.status}</span>
              <b>{s.title}</b>
              <span className="muted">
                {s.kind} · {formatDuration(s.duration_ms)}
              </span>
            </div>
            {s.error && <pre className="workflow-step-out error">{s.error}</pre>}
            {s.output !== '' && <pre className="workflow-step-out">{s.output}</pre>}
          </li>
        ))}
      </ol>
    </div>
  )
}

function RecentRuns({
  workflowId,
  version,
  shownId,
  onShow,
}: {
  workflowId: number
  version: number
  shownId: number | null
  onShow: (run: WorkflowRun) => void
}) {
  const { data: runs, error } = useFetch(
    () => listWorkflowRuns(workflowId),
    `workflow-runs-${workflowId}-${version}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!runs) return <p className="muted">Loading…</p>
  if (runs.length === 0) return <p className="muted">No runs yet.</p>
  return (
    <ul className="workflow-runs">
      {runs.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className={`workflow-runs-row${r.id === shownId ? ' active' : ''}`}
            onClick={() => onShow(r)}
          >
            <span className="muted">#{r.id}</span>
            <span className={r.status === 'failed' ? 'error' : ''}>{runSummary(r)}</span>
            <span className="muted" title={formatTimestamp(r.started_at)}>
              {r.trigger} · {timeAgo(r.started_at)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** What `output` nodes with `target: log` have written; one named log, or
 *  every log when the name is blank. */
function LogPanel({ version }: { version: number }) {
  const [log, setLog] = useState('')
  const { data: lines, error } = useFetch(
    () => listWorkflowLog(log.trim() || undefined, 50),
    `workflow-log-${log.trim()}-${version}`,
  )
  return (
    <div className="workflow-log">
      <input
        type="text"
        value={log}
        placeholder="log name (blank = every log)"
        onChange={(e) => setLog(e.target.value)}
      />
      {error ? (
        <p className="error">{error}</p>
      ) : !lines ? (
        <p className="muted">Loading…</p>
      ) : lines.length === 0 ? (
        <p className="muted">Nothing logged.</p>
      ) : (
        <ul className="workflow-log-lines">
          {lines.map((l) => (
            <li key={l.id}>
              <span className="muted" title={formatTimestamp(l.created_at)}>
                {l.log}
              </span>
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One workflow rendered in place inside ProjectTasksPage's frame: its name
 * header with the ▶ Run button, the builder canvas, and the run panel (the
 * shown run's steps, recent runs, and the logs). The canvas owns node/edge
 * editing; this owns the workflow-level fields and running it.
 */
export function WorkflowBuilderView({
  projectId,
  workflowId,
  onDeleted,
}: {
  projectId: number
  workflowId: number
  /** Called after a delete instead of leaving for the list route (the dock panel has no route to leave). */
  onDeleted?: () => void
}) {
  const { data: view, error, refetch } = useFetch(
    () => getWorkflow(workflowId),
    `workflow-${workflowId}`,
  )
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [shown, setShown] = useState<WorkflowRun | null>(null)
  const [tab, setTab] = useState<'steps' | 'runs' | 'log'>('steps')
  // Bumped on every run so the recent-runs and log lists refetch.
  const [runVersion, setRunVersion] = useState(0)
  // What the person is looking at (mesa task 888) — reported ahead of the
  // early returns below, per the rules of hooks, so a workflow still loading
  // says which one it is. The name is the sayable handle; the id the identity.
  useLiveContext({
    kind: 'workflows',
    id: String(workflowId),
    label: view?.workflow.name ?? null,
    detail: null,
  })

  function run() {
    setRunning(true)
    setRunError(null)
    runWorkflow(workflowId, input).then(
      (done) => {
        setRunning(false)
        setShown(done)
        setTab('steps')
        setRunVersion((v) => v + 1)
      },
      (err: unknown) => {
        setRunning(false)
        setRunError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  if (error) return <p className="error">{error}</p>
  if (!view) return <p className="muted">Loading…</p>

  const wf = view.workflow

  return (
    <div className="workflow-page">
      <p>
        <a href={`#/projects/${projectId}/workflows`}>← workflows</a>
      </p>
      <div className="workflow-head">
        <h2 className="workflow-title">
          <InlineEdit
            value={wf.name}
            onSave={(name) => updateWorkflow(workflowId, { name }).then(() => refetch())}
          />
          <span className="muted workflow-title-tag"> · workflow</span>
        </h2>
        <div className="workflow-head-actions">
          <input
            type="text"
            className="workflow-run-input"
            value={input}
            placeholder="run input (optional)"
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="button" className="workflow-run-btn" disabled={running} onClick={run}>
            {running ? 'running…' : '▶ Run'}
          </button>
          <ConfirmDelete
            label="delete workflow"
            message={`Deletes this workflow, ${view.nodes.length} node(s) and ${view.edges.length} edge(s).`}
            onDelete={() =>
              deleteWorkflow(workflowId).then(() => {
                if (onDeleted) return onDeleted()
                window.location.hash = `#/projects/${projectId}/workflows`
              })
            }
          />
        </div>
      </div>
      <p className="muted">
        <InlineEdit
          value={wf.description ?? ''}
          multiline
          placeholder="no description — click to add"
          onSave={(d) =>
            updateWorkflow(workflowId, { description: d === '' ? null : d }).then(() => refetch())
          }
        />
      </p>
      {runError && <p className="error">could not run: {runError}</p>}

      {/* Keyed by workflow id: a switch remounts the canvas so React Flow
          re-reads that workflow's saved viewport (defaultViewport is
          mount-time). */}
      <WorkflowCanvas
        key={workflowId}
        view={view}
        run={shown}
        onChanged={refetch}
      />

      <div className="workflow-runpanel">
        <div className="tabs workflow-runtabs">
          {(['steps', 'runs', 'log'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={tab === t ? 'active' : ''}
              onClick={() => setTab(t)}
            >
              {t === 'steps' ? 'last run' : t === 'runs' ? 'recent runs' : 'log'}
            </button>
          ))}
        </div>
        {tab === 'steps' &&
          (shown ? <RunSteps run={shown} /> : <p className="muted">Run it to see each step here.</p>)}
        {tab === 'runs' && (
          <RecentRuns
            workflowId={workflowId}
            version={runVersion}
            shownId={shown?.id ?? null}
            onShow={(r) => {
              setShown(r)
              setTab('steps')
            }}
          />
        )}
        {tab === 'log' && <LogPanel version={runVersion} />}
      </div>
    </div>
  )
}
