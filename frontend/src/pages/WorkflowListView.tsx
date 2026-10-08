import { useState } from 'react'
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  listWorkflows,
  runWorkflow,
  updateWorkflow,
} from '../api'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { PlayIcon } from '../components/WorkflowIcon'
import { useLiveContext } from '../liveContext'
import { formatTimestamp, timeAgo } from '../time'
import { useFetch } from '../useFetch'
import { runSummary, triggerLabel } from '../workflowRun'
import { toggleLabel } from '../workflowOverview'
import type { WorkflowRun } from '../types/WorkflowRun'

/**
 * Lists a project's workflows and creates new ones. A workflow is a graph the
 * engine walks (docs/workflows.md); this is just the index — the builder lives
 * in WorkflowBuilderView. Rendered in place inside ProjectTasksPage's frame
 * (project header + tab row supply the surrounding chrome), so it carries no
 * header or back link of its own.
 */
export function WorkflowListView({ projectId }: { projectId: number }) {
  const { data: workflows, error, refetch } = useFetch(
    () => listWorkflows(projectId),
    `workflows-${projectId}`,
  )
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  // The newest run started from this list, per workflow id: its summary and
  // whether it is still going, shown on the row it belongs to.
  const [runs, setRuns] = useState<Record<number, WorkflowRun | 'running' | string>>({})
  // The index selects nothing — the workflows are links, and opening one is
  // what gives the conversation something to talk about (mesa task 888).
  useLiveContext({ kind: 'workflows', id: null, label: null, detail: null })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    createWorkflow({ name: name.trim(), project_id: projectId }).then(
      (w) => {
        setName('')
        setCreateError(null)
        refetch()
        window.location.hash = `#/projects/${projectId}/workflows/${w.id}`
      },
      (err: unknown) => setCreateError(err instanceof Error ? err.message : String(err)),
    )
  }

  function toggle(id: number, enabled: boolean) {
    updateWorkflow(id, { enabled: !enabled }).then(
      () => refetch(),
      (err: unknown) => setCreateError(err instanceof Error ? err.message : String(err)),
    )
  }

  function duplicate(id: number) {
    duplicateWorkflow(id).then(
      (v) => {
        setCreateError(null)
        refetch()
        window.location.hash = `#/projects/${projectId}/workflows/${v.workflow.id}`
      },
      (err: unknown) => setCreateError(err instanceof Error ? err.message : String(err)),
    )
  }

  function run(id: number) {
    setRuns((r) => ({ ...r, [id]: 'running' }))
    runWorkflow(id).then(
      (done) => setRuns((r) => ({ ...r, [id]: done })),
      (err: unknown) =>
        setRuns((r) => ({
          ...r,
          // A string that is not 'running' is the error a run could not start with.
          [id]: `could not run: ${err instanceof Error ? err.message : String(err)}`,
        })),
    )
  }

  return (
    <>
      <form className="create-form" onSubmit={submit}>
        <input
          type="text"
          value={name}
          placeholder="new workflow name"
          required
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit">create</button>
        {createError && <span className="error">{createError}</span>}
      </form>

      {error ? (
        <p className="error">{error}</p>
      ) : !workflows ? (
        <p className="muted">Loading…</p>
      ) : workflows.length === 0 ? (
        <p className="muted">No workflows yet.</p>
      ) : (
        <ul className="card-list">
          {workflows.map((w) => {
            const last = runs[w.id]
            return (
              <li key={w.id} className="workflow-row">
                <div className="workflow-row-main">
                  <a
                    className="workflow-row-title"
                    href={`#/projects/${projectId}/workflows/${w.id}`}
                  >
                    {w.name}
                  </a>
                  {!w.enabled && <span className="muted workflow-off-tag"> · disabled</span>}
                  {w.description && <p className="muted workflow-row-desc">{w.description}</p>}
                  <div className="muted meta-line">
                    <span className="workflow-trigger">{triggerLabel(w)}</span>
                    <span> · </span>
                    <span title={formatTimestamp(w.updated_at)}>updated {timeAgo(w.updated_at)}</span>
                  </div>
                  {last !== undefined && (
                    <div
                      className={`workflow-row-run meta-line ${
                        typeof last === 'object' && last.status === 'failed' ? 'error' : 'muted'
                      }`}
                    >
                      {last === 'running'
                        ? 'running…'
                        : typeof last === 'string'
                          ? last
                          : runSummary(last)}
                    </div>
                  )}
                </div>
                <div className="workflow-row-actions">
                  <button
                    type="button"
                    className="workflow-run-btn"
                    disabled={last === 'running'}
                    onClick={() => run(w.id)}
                  >
                    <PlayIcon /> run
                  </button>
                  <button type="button" onClick={() => toggle(w.id, w.enabled)}>
                    {toggleLabel(w)}
                  </button>
                  <button type="button" onClick={() => duplicate(w.id)}>
                    duplicate
                  </button>
                  <ConfirmDelete
                    label="delete"
                    message="Deletes this workflow, its nodes and its edges."
                    onDelete={() => deleteWorkflow(w.id).then(refetch)}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
