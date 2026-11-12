import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { getProjectGitCommitInfo } from '../api'
import { useFetch } from '../useFetch'
import { plural } from '../gitActions'
import type { CommitOutcome, CommitRequest } from '../gitActions'
import {
  activeFields,
  adoptStaleAmend,
  afterSuccess,
  amendConfirmPlan,
  amendState,
  amendingNow,
  applyPrepared,
  commitButtonLabel,
  commitState,
  composeMessage,
  createSubmitGuard,
  draftKey,
  dropStaleAmend,
  loadDraft,
  STALE_AMEND_REASON,
  saveDraft,
  staleAmend,
  staleAmendText,
  startAmend,
  stopAmend,
  subjectGuide,
  successText,
  withFields,
} from '../gitCommit'

/**
 * The commit box (naru task 2740, docs/git-tab.md "Commit box"): subject, body,
 * Amend switch and the commit button, under the Staged section. Every rule is
 * in `gitCommit.ts` and the gate in `gitActions.ts`; this lays them out. The
 * parent remounts it per project / repo / worktree (`key`), so a draft never
 * crosses worktrees. Repo text is only ever a text node.
 */
export function GitCommitBox({
  projectId,
  repo,
  worktreePath,
  diffWorktree,
  stagedCount,
  stagedDigest,
  hasConflicts,
  busy,
  rev,
  branch,
  onCommit,
  onOpenCommit,
}: {
  projectId: number
  repo: string | undefined
  /** Full path of the worktree; null = unknown (the box is off). */
  worktreePath: string | null
  /** The worktree as the read routes want it (null = the default one). */
  diffWorktree: string | null
  stagedCount: number
  /** `staged_digest` of the view the staged list is drawn from. */
  stagedDigest: string
  hasConflicts: boolean
  /** A write of the working tree is in flight (this commit included). */
  busy: boolean
  /** Bumped when a write settled: the commit info is read again. */
  rev: number
  branch: string
  onCommit: (req: CommitRequest) => Promise<CommitOutcome>
  onOpenCommit: (sha: string) => void
}) {
  const key = draftKey(projectId, repo, worktreePath)
  const { data, refetch } = useFetch(
    () => getProjectGitCommitInfo(projectId, diffWorktree ?? undefined, repo),
    `git-commit-info-${projectId}-${repo ?? ''}-${diffWorktree ?? ''}`,
  )
  const info = data?.info ?? null

  const firstRev = useRef(true)
  useEffect(() => {
    if (firstRev.current) {
      firstRev.current = false
      return
    }
    void refetch()
  }, [rev, refetch])

  const [draft, setDraft] = useState(() => loadDraft(key))
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
    saveDraft(key, draft)
  }, [draft, key])

  // Git's prepared message (a merge's), once, when the info first arrives.
  const [preparedDone, setPreparedDone] = useState(false)
  if (info !== null && !preparedDone) {
    setPreparedDone(true)
    const next = applyPrepared(draft, info)
    if (next !== draft) setDraft(next)
  }

  const [sending, setSending] = useState(false)
  const guard = useRef(createSubmitGuard())
  const [success, setSuccess] = useState<{ hash: string; short: string; amended: boolean } | null>(
    null,
  )
  const [error, setError] = useState<{ prefix: string; message: string } | null>(null)
  const reasonId = useId()

  const amending = amendingNow(draft, info)
  const amend = amendState(info)
  const stale = staleAmend(draft, info)
  const amendOff = amend.disabled || stale !== null
  const amendReason = stale !== null ? STALE_AMEND_REASON : amend.reason
  const fields = activeFields(draft, amending)
  const guide = subjectGuide(fields.subject)
  const state = commitState({
    worktree: worktreePath,
    busy: busy || sending,
    info,
    hasConflicts,
    stagedCount,
    subject: fields.subject,
    amending,
  })
  const label = commitButtonLabel({ worktree: worktreePath, amending, stagedCount, info })

  const edit = (f: Partial<typeof fields>) => {
    setSuccess(null)
    setDraft(withFields(draft, amending, f))
  }

  async function submit() {
    if (!state.canCommit || info === null || worktreePath === null) return
    // Two keydowns can land before React re-renders: latch synchronously.
    if (!guard.current.enter()) return
    const wasAmending = amending
    const head = info.head
    setSending(true)
    setSuccess(null)
    setError(null)
    try {
      const out = await onCommit({
        message: composeMessage(fields.subject, fields.body),
        stagedDigest,
        amend: wasAmending,
        expectedHead: wasAmending ? head?.hash : undefined,
        published: wasAmending && info.head_published,
        merge: wasAmending && head?.is_merge === true,
        plan: (wasAmending ? amendConfirmPlan(info, worktreePath, branch) : null) ?? undefined,
      })
      if (out.ok) {
        // The box may be gone (worktree switched mid-flight): store it directly too.
        const next = afterSuccess(draftRef.current, wasAmending)
        saveDraft(key, next)
        setDraft(next)
        setSuccess({
          hash: out.result.hash,
          short: out.result.short_hash,
          amended: out.result.amended,
        })
      } else if (out.reason === 'error') {
        setError({ prefix: out.prefix, message: out.message })
      } else if (out.reason === 'no-worktree') {
        setError({ prefix: 'Nothing was sent:', message: 'The worktree path is unknown.' })
      }
    } finally {
      guard.current.leave()
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return
    if (!(e.target as HTMLElement).matches('[data-commit-subject], [data-commit-body]')) return
    e.preventDefault()
    e.stopPropagation()
    void submit()
  }

  const toggleAmend = (on: boolean) => {
    if (info?.head == null) return
    setSuccess(null)
    setDraft(on ? startAmend(draft, info.head) : stopAmend(draft, info.head))
  }

  const target =
    info === null ? '' : info.detached ? `detached at ${info.head?.short_hash ?? 'HEAD'}` : (info.branch ?? '')
  const busyWord = amending ? 'Amending…' : 'Committing…'

  return (
    <div className="git-commit" data-commit="" onKeyDown={onKeyDown}>
      <p className="git-commit-target" data-commit-target="">
        {target !== '' && <span className="git-branch">{target}</span>}
        <span
          className="muted git-commit-path"
          title={worktreePath ?? undefined}
          data-commit-path=""
        >
          {worktreePath ?? 'unknown worktree'}
        </span>
      </p>
      {info !== null && (
        <p className="muted git-commit-identity" data-commit-identity="">
          {info.author_name !== null && info.author_email !== null
            ? `${info.author_name} <${info.author_email}>`
            : 'No author identity set'}
        </p>
      )}
      <div className="git-commit-subjectrow">
        <input
          type="text"
          className="git-commit-subject"
          data-commit-subject=""
          aria-label="Commit subject"
          placeholder="Commit subject"
          autoComplete="off"
          spellCheck
          readOnly={sending}
          value={fields.subject}
          onChange={(e) => edit({ subject: e.target.value.replace(/[\r\n]+/g, ' ') })}
        />
        <span
          className={`git-commit-count ${guide.level}`}
          data-commit-count={guide.level}
          title="Subject length: 50 is the guide, 72 the usual limit. Never blocks."
        >
          {guide.text}
        </span>
      </div>
      <textarea
        className="git-commit-body"
        data-commit-body=""
        aria-label="Commit body"
        placeholder="Body (optional)"
        rows={4}
        spellCheck
        readOnly={sending}
        value={fields.body}
        onChange={(e) => edit({ body: e.target.value })}
      />
      <p className="muted git-commit-staged" data-commit-staged="">
        {plural(stagedCount, 'file')} staged
      </p>
      {amend.offered && (
        <label
          className={`git-commit-amend${amendOff ? ' disabled' : ''}`}
          title={amendReason ?? undefined}
        >
          <input
            type="checkbox"
            data-commit-amend=""
            checked={amending}
            disabled={amendOff || busy || sending}
            onChange={(e) => toggleAmend(e.target.checked)}
          />
          <span>Amend last commit{info?.head ? ` (${info.head.short_hash})` : ''}</span>
        </label>
      )}
      {amend.offered && amendReason !== null && (
        <p className="muted git-commit-note" data-commit-amend-reason="">
          {amendReason}
        </p>
      )}
      {stale !== null && (
        <div className="git-commit-warning" data-commit-stale-amend="">
          <p>{staleAmendText(stale)}</p>
          <div className="git-commit-actions">
            {amend.offered && !amend.disabled && info?.head && (
              <button
                type="button"
                data-commit-stale-use=""
                disabled={busy || sending}
                onClick={() => info.head && setDraft(adoptStaleAmend(draft, info.head))}
              >
                Use my text for the new commit
              </button>
            )}
            <button
              type="button"
              data-commit-stale-drop=""
              disabled={busy || sending}
              onClick={() => setDraft(dropStaleAmend(draft))}
            >
              Discard it
            </button>
          </div>
        </div>
      )}
      {state.warnings.map((w) => (
        <p key={w} className="git-commit-warning" data-commit-warning="">
          {w}
        </p>
      ))}
      <div className="git-commit-actions">
        <button
          type="button"
          className="git-commit-button"
          data-commit-button=""
          aria-label={label}
          title={state.reason ?? label}
          aria-busy={sending}
          aria-describedby={state.reason !== null ? reasonId : undefined}
          disabled={!state.canCommit || sending}
          onClick={() => void submit()}
        >
          {sending ? busyWord : label}
        </button>
        {state.reason !== null && (
          <span className="muted git-commit-reason" id={reasonId} data-commit-reason="">
            {state.reason}
          </span>
        )}
      </div>
      {success !== null && (
        <p className="git-commit-success" role="status" data-commit-success="">
          {success.amended ? 'Amended ' : 'Committed '}
          <button
            type="button"
            className="git-commit-sha"
            data-commit-open=""
            title={`Open ${success.short} in History`}
            aria-label={`${successText(success.amended, success.short)}: open in History`}
            onClick={() => onOpenCommit(success.hash)}
          >
            {success.short}
          </button>
        </p>
      )}
      {error !== null && (
        <div className="git-commit-error" role="alert" data-commit-error="">
          <div className="git-commit-error-body">
            <strong>{error.prefix}</strong>
            <pre className="git-commit-error-msg" tabIndex={0}>
              {error.message}
            </pre>
          </div>
          <button
            type="button"
            className="git-wt-alert-close"
            aria-label="Dismiss"
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
