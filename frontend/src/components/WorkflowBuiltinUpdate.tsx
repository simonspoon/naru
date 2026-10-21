import { useState } from 'react'
import { getWorkflowBuiltinUpdate, resolveWorkflowBuiltinUpdate } from '../api'
import { diffLineClass, diffMark } from '../librarySync'
import { useFetch } from '../useFetch'
import {
  builtinRepoints,
  builtinUpdateDiff,
  builtinUpdateHead,
  builtinUpdateNote,
} from '../workflowBuiltin'
import { isUnchanged } from '../workflowHistory'

/**
 * The review panel for a customised copy whose built-in moved on (naru task
 * 2052): the copy against the current built-in, and two answers. Keep moves
 * the base forward and changes nothing; Take replaces the graph with the
 * built-in's as one new revision (undone from History). Nothing happens until
 * one is pressed. Mirrors the Library's `LibraryBuiltinReview`.
 */
export function WorkflowBuiltinUpdate({
  workflowId,
  onDone,
  onClose,
}: {
  workflowId: number
  /** Called after an answer, with the note to show; the caller refetches. */
  onDone: (note: string) => void
  onClose: () => void
}) {
  const { data, error } = useFetch(
    () => getWorkflowBuiltinUpdate(workflowId),
    `workflow-builtin-update-${workflowId}`,
  )
  const [confirmingTake, setConfirmingTake] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function resolve(action: 'take' | 'keep') {
    if (!data) return
    setSaving(true)
    setSaveError(null)
    resolveWorkflowBuiltinUpdate(workflowId, action).then(
      () => {
        setSaving(false)
        setConfirmingTake(false)
        onDone(builtinUpdateNote(action, data.builtin_rev))
      },
      (err: unknown) => {
        setSaving(false)
        setSaveError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  const diff = builtinUpdateDiff(data.mine, data.builtin)
  const repoints = builtinRepoints(data.mine, data.builtin)

  return (
    <div
      className="library-override-diff library-builtin-review workflow-builtin-update"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <p className="muted">
        {builtinUpdateHead(data)} <span className="library-diff-removed">-</span> your copy
        {' · '}
        <span className="library-diff-added">+</span> {data.builtin_name}
      </p>
      {isUnchanged(diff) ? (
        <p className="muted">No differences in the graph.</p>
      ) : (
        <pre className="library-sync-difflines">
          {diff.map((line, i) => (
            <div key={i} className={diffLineClass(line)}>
              <span className="library-diff-mark">{diffMark(line)}</span>
              {line.text}
            </div>
          ))}
        </pre>
      )}
      {repoints.map((r) => (
        <p key={r.title} className="muted">
          Taking this re-points “{r.title}” from {r.from || 'nothing'} to {r.to || 'nothing'}.
        </p>
      ))}
      <div className="inline-edit-actions">
        {confirmingTake ? (
          <span className="confirm-delete">
            <span className="confirm-message">
              Replace your graph with the built-in's? Undo from History.
            </span>
            <button
              type="button"
              className="danger"
              disabled={saving}
              onClick={() => resolve('take')}
            >
              confirm
            </button>
            <button type="button" disabled={saving} onClick={() => setConfirmingTake(false)}>
              cancel
            </button>
          </span>
        ) : (
          <button type="button" disabled={saving} onClick={() => setConfirmingTake(true)}>
            Take the new built-in
          </button>
        )}
        <button type="button" disabled={saving} onClick={() => resolve('keep')}>
          Keep mine
        </button>
      </div>
      {saveError !== null && <p className="error">{saveError}</p>}
    </div>
  )
}
