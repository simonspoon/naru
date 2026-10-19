import { useState } from 'react'
import { listWorkflowRevisions, restoreWorkflowRevision } from '../api'
import { BUILTIN_TITLE } from '../workflowBuiltin'
import { diffLineClass, diffMark } from '../librarySync'
import { formatTimestamp, timeAgo } from '../time'
import { useFetch } from '../useFetch'
import {
  diffRevisions,
  isUnchanged,
  revisionEntries,
  revisionLabel,
  snapshotLines,
} from '../workflowHistory'

/**
 * A workflow's version history (naru task 2053): every revision down the left,
 * newest first, and beside it the selected one's diff against the previous
 * revision — or against any other the "compare with" menu names — or its whole
 * graph as text. Restore writes the graph back as a new `restore of N`
 * revision; nothing is deleted. Reuses the Library history's look.
 */
export function WorkflowHistory({
  workflowId,
  onRestored,
  readOnly = false,
}: {
  /** A built-in: revisions are readable, never restorable (naru task 2103). */
  readOnly?: boolean
  workflowId: number
  /** Called after a restore so the caller refetches the graph. */
  onRestored: () => void
}) {
  const {
    data: revisions,
    error,
    refetch,
  } = useFetch(() => listWorkflowRevisions(workflowId), `workflow-revisions-${workflowId}`)
  const [selected, setSelected] = useState<number | null>(null)
  const [compare, setCompare] = useState<number | null>(null)
  const [tab, setTab] = useState<'diff' | 'full'>('diff')
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  if (error) return <p className="error">{error}</p>
  if (!revisions) return <p className="muted">Loading…</p>
  if (revisions.length === 0) return <p className="muted">No history yet.</p>

  const entries = revisionEntries(revisions)
  const entry = entries.find((e) => e.revision.rev === selected) ?? entries[0]
  const index = entries.indexOf(entry)
  const isLatest = index === 0
  // What the shown revision is diffed against: the chosen one, else the
  // previous (older) revision, else nothing (the oldest).
  const other =
    revisions.find((r) => r.rev === compare && r.rev !== entry.revision.rev) ??
    revisions[index + 1] ??
    null
  // `-` is always the older of the two, `+` the newer.
  const [older, newer] =
    other !== null && other.rev > entry.revision.rev
      ? [entry.revision, other]
      : [other, entry.revision]
  const diff = older !== null && newer !== null ? diffRevisions(older.snapshot, newer.snapshot) : null

  function pick(rev: number) {
    setSelected(rev)
    setCompare(null)
    setConfirming(false)
    setRestoreError(null)
    setNote(null)
  }

  function restore() {
    const rev = entry.revision.rev
    setRestoring(true)
    setRestoreError(null)
    restoreWorkflowRevision(workflowId, rev).then(
      () => {
        setRestoring(false)
        setConfirming(false)
        setSelected(null)
        setCompare(null)
        setNote(`Restored #${rev} as #${revisions!.length + 1}`)
        refetch()
        onRestored()
      },
      (err: unknown) => {
        setRestoring(false)
        setRestoreError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  return (
    <div className="library-history workflow-history">
      <ul className="library-history-list">
        {entries.map((e) => (
          <li key={e.revision.id}>
            <button
              type="button"
              aria-label={revisionLabel(e.revision)}
              className={
                e.revision.rev === entry.revision.rev
                  ? 'library-history-version selected'
                  : 'library-history-version'
              }
              onClick={() => pick(e.revision.rev)}
            >
              <span>
                #{e.revision.rev} {e.revision.reason}
                <span className="muted library-history-source">
                  {e.revision.author} ·{' '}
                  <span title={formatTimestamp(e.revision.created_at)}>
                    {timeAgo(e.revision.created_at)}
                  </span>
                </span>
              </span>
              {e.added !== null && e.removed !== null && (
                <span className="library-history-counts">
                  <span className="library-diff-added">+{e.added}</span>
                  <span className="library-diff-removed">-{e.removed}</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="library-history-detail">
        <div className="library-history-tabs">
          <button
            type="button"
            className={tab === 'diff' ? 'selected' : undefined}
            onClick={() => setTab('diff')}
          >
            diff
          </button>
          <button
            type="button"
            className={tab === 'full' ? 'selected' : undefined}
            onClick={() => setTab('full')}
          >
            full
          </button>
          <label className="workflow-history-compare">
            compare with…{' '}
            <select
              value={compare ?? ''}
              onChange={(e) => setCompare(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">previous</option>
              {revisions
                .filter((r) => r.rev !== entry.revision.rev)
                .map((r) => (
                  <option key={r.id} value={r.rev}>
                    #{r.rev} {r.reason}
                  </option>
                ))}
            </select>
          </label>
          {confirming ? (
            <>
              <span className="muted">
                Restore #{entry.revision.rev}? Creates a new revision; nothing is deleted.
              </span>
              <button type="button" disabled={restoring} onClick={restore}>
                {restoring ? 'restoring…' : 'confirm'}
              </button>
              <button type="button" disabled={restoring} onClick={() => setConfirming(false)}>
                cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label={`Restore revision ${entry.revision.rev}`}
              disabled={isLatest || restoring || readOnly}
              title={
                readOnly
                  ? BUILTIN_TITLE
                  : isLatest
                    ? 'This is the current revision'
                    : undefined
              }
              onClick={() => setConfirming(true)}
            >
              restore
            </button>
          )}
        </div>
        {note !== null && <p className="muted">{note}</p>}
        {restoreError !== null && <p className="error">{restoreError}</p>}
        {tab === 'diff' && older !== null && newer !== null && (
          <p className="muted">
            #{newer.rev} vs #{older.rev} (<span className="library-diff-removed">-</span> older,{' '}
            <span className="library-diff-added">+</span> newer)
          </p>
        )}
        {tab === 'diff' && diff === null && <p className="muted">Initial revision</p>}
        {tab === 'diff' && diff !== null && isUnchanged(diff) && (
          <p className="muted">No differences.</p>
        )}
        {tab === 'diff' && diff !== null && !isUnchanged(diff) && (
          <pre className="library-sync-difflines">
            {diff.map((line, i) => (
              <div key={i} className={diffLineClass(line)}>
                <span className="library-diff-mark">{diffMark(line)}</span>
                {line.text}
              </div>
            ))}
          </pre>
        )}
        {(tab === 'full' || diff === null) && (
          <pre className="library-version-body">
            {snapshotLines(entry.revision.snapshot).join('\n')}
          </pre>
        )}
      </div>
    </div>
  )
}
