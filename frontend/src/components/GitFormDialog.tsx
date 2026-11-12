import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { branchNameProblem, stashMessageProblem } from '../gitRefs'
import type { RefCtx } from '../gitRefs'
import { useModal } from './useModal'

/** What the form is for; the title, the name it starts with and the switch
 * checkbox come from the caller (`gitRefs.ts`). */
export type FormSpec =
  | {
      kind: 'create'
      title: string
      /** Where the new branch starts, for the note under the title. */
      from: string
      switchDefault: boolean
      /** Why "Switch to it" is off (an operation in progress), else null. */
      switchOff: string | null
      /** The create button's source: carried back on submit. */
      source: { kind: 'head' } | { kind: 'commit'; sha: string } | { kind: 'remote'; name: string }
    }
  | { kind: 'rename'; name: string; current: boolean }
  | { kind: 'stash' }

export type FormValues = { name: string; switch: boolean; message: string; untracked: boolean }

/**
 * The branch and stash forms (naru task 2741): a sibling of `GitConfirmDialog`
 * with the same shell (portal, `.create-task-backdrop` so the global shortcuts
 * stand down, focus trap and Esc through `useModal`), but focus starts on the
 * input, Enter submits, and the scrim only dismisses while nothing has been
 * typed. `onSubmit` resolves to git's failure text (shown inline, in a `<pre>`,
 * the dialog stays open) or null on success. All text from the repo is a text
 * node.
 */
export function GitFormDialog({
  spec,
  ctx,
  existing,
  busy,
  suspended,
  onSubmit,
  onCancel,
}: {
  spec: FormSpec
  ctx: RefCtx
  /** Local branch names, for the "already exists" check. */
  existing: string[]
  busy: boolean
  /** A confirm is on top: this dialog's keys stand down. */
  suspended: boolean
  onSubmit: (v: FormValues) => Promise<{ prefix: string; message: string } | null>
  onCancel: () => void
}) {
  const boxRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const problemId = useId()
  const initialName = spec.kind === 'rename' ? spec.name : ''
  const [name, setName] = useState(initialName)
  const [message, setMessage] = useState('')
  const [untracked, setUntracked] = useState(false)
  const [sw, setSw] = useState(spec.kind === 'create' && spec.switchOff === null && spec.switchDefault)
  const [fail, setFail] = useState<{ prefix: string; message: string } | null>(null)

  useModal({ boxRef, initial: inputRef, onEscape: onCancel, active: !suspended })

  const isStash = spec.kind === 'stash'
  const problem = isStash
    ? stashMessageProblem(message)
    : branchNameProblem(name, existing, spec.kind === 'rename' ? spec.name : undefined)
  const empty = isStash ? false : name.trim() === ''
  const off = problem !== null || empty || busy
  const dirty = isStash ? message !== '' || untracked : name !== initialName
  const title =
    spec.kind === 'create'
      ? spec.title
      : spec.kind === 'rename'
        ? `Rename branch ${spec.name}`
        : `Stash changes in ${ctx.branch}`
  const submitLabel =
    spec.kind === 'create' ? (sw ? 'Create and switch' : 'Create branch') : spec.kind === 'rename' ? 'Rename' : 'Stash changes'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (off) return
    setFail(null)
    const out = await onSubmit({ name: name.trim(), switch: sw, message, untracked })
    if (out !== null) setFail(out)
  }

  return createPortal(
    <div
      className="create-task-backdrop git-confirm-backdrop"
      data-git-form="backdrop"
      onClick={() => {
        if (!dirty && !busy) onCancel()
      }}
      // React bubbles portal events to the Git tab's own key handler.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <form
        ref={boxRef}
        className="git-confirm git-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-git-form="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        noValidate
      >
        <h3 id={titleId} className="git-confirm-title">
          {title}
        </h3>
        <p className="git-confirm-target">
          In worktree <code>{ctx.worktree}</code> on branch <code>{ctx.branch}</code>
        </p>
        {spec.kind === 'create' && (
          <p className="git-form-note muted">
            {spec.from}
            {ctx.detached && spec.source.kind === 'head' && ' (HEAD is detached: the new branch keeps these commits).'}
          </p>
        )}
        {spec.kind === 'rename' && spec.current && (
          <p className="git-form-note muted">Renaming the branch checked out here.</p>
        )}
        {spec.kind === 'stash' && (
          <p className="git-form-note muted">
            Stashes are shared by all worktrees. This stashes the changes of this worktree.
          </p>
        )}
        {isStash ? (
          <label className="git-form-field">
            <span>Message (optional)</span>
            <input
              ref={inputRef}
              type="text"
              className="git-form-input"
              data-git-form="message"
              value={message}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={problem !== null}
              aria-describedby={problem !== null ? problemId : undefined}
              onChange={(e) => {
                setMessage(e.target.value)
                setFail(null)
              }}
            />
          </label>
        ) : (
          <label className="git-form-field">
            <span>{spec.kind === 'rename' ? 'New name' : 'Branch name'}</span>
            <input
              ref={inputRef}
              type="text"
              className="git-form-input"
              data-git-form="name"
              value={name}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={problem !== null}
              aria-describedby={problem !== null ? problemId : undefined}
              onFocus={(e) => {
                if (spec.kind === 'rename') e.currentTarget.select()
              }}
              onChange={(e) => {
                setName(e.target.value)
                setFail(null)
              }}
            />
          </label>
        )}
        {problem !== null && (
          <p id={problemId} className="git-form-error" role="status" data-git-form="error">
            {problem}
          </p>
        )}
        {isStash && (
          <label className="git-form-check">
            <input
              type="checkbox"
              data-git-form="untracked"
              checked={untracked}
              onChange={(e) => setUntracked(e.target.checked)}
            />
            <span>Include untracked files</span>
          </label>
        )}
        {spec.kind === 'create' && (
          <label
            className={`git-form-check${spec.switchOff !== null ? ' disabled' : ''}`}
            title={spec.switchOff ?? undefined}
          >
            <input
              type="checkbox"
              data-git-form="switch"
              checked={sw}
              disabled={spec.switchOff !== null}
              onChange={(e) => setSw(e.target.checked)}
            />
            <span>Switch to it</span>
          </label>
        )}
        {spec.kind === 'create' && spec.switchOff !== null && (
          <p className="git-form-note muted">{spec.switchOff}</p>
        )}
        {fail !== null && (
          <div className="git-form-fail" role="alert">
            <strong>{fail.prefix}</strong>
            <pre className="git-wt-alert-msg" data-git-form="fail">
              {fail.message}
            </pre>
          </div>
        )}
        <div className="git-confirm-buttons">
          <button type="button" data-git-form="cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="git-form-submit"
            data-git-form="submit"
            disabled={off}
            aria-busy={busy}
          >
            {busy ? '…' : submitLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
