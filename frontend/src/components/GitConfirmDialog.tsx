import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ConfirmPlan } from '../gitActions'
import { useModal } from './useModal'

/**
 * The modal every destructive working-tree action goes through (naru task
 * 2738) and every branch or stash action that loses something (task 2741).
 * All text comes from the plan builders in gitActions.ts; this only lays it
 * out. Focus starts on Cancel and is trapped inside the dialog, Esc, the scrim
 * and Cancel all say no, and there is no "don't ask again". The backdrop
 * carries `.create-task-backdrop` so `shouldIgnoreShortcut()` stands down for
 * the global single-key shortcuts while it is open (docs/keyboard.md). Rendered
 * into `document.body` so a transformed Custom-layout pane cannot trap its
 * `position: fixed`.
 */
export function GitConfirmDialog({
  plan,
  onResolve,
}: {
  plan: ConfirmPlan
  onResolve: (ok: boolean) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const bodyId = useId()

  useModal({ boxRef, initial: cancelRef, onEscape: () => onResolve(false) })

  return createPortal(
    <div
      className="create-task-backdrop git-confirm-backdrop"
      data-git-confirm="backdrop"
      onClick={() => onResolve(false)}
      // React bubbles portal events to the Git tab's own key handler.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        ref={boxRef}
        className="git-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-git-confirm="dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="git-confirm-title">
          {plan.title}
        </h3>
        <div id={bodyId}>
          <p className="git-confirm-target">
            In worktree <code>{plan.worktree}</code> on branch <code>{plan.branch}</code>
          </p>
          {(plan.listed.length > 0 || plan.more > 0) && (
            <ul
              className={`git-confirm-paths${plan.mono ? ' git-confirm-lines' : ''}`}
              tabIndex={0}
              aria-label={plan.listLabel ?? 'Affected paths'}
            >
              {plan.listed.map((p, i) => (
                <li key={`${i}:${p}`}>{p}</li>
              ))}
              {plan.more > 0 && <li className="muted">{plan.moreLabel ?? `and ${plan.more} more`}</li>}
            </ul>
          )}
          {plan.consequences.map((c) => (
            <p key={c} className="git-confirm-consequence">
              {c}
            </p>
          ))}
          {plan.irreversible !== undefined && (
            <p className="git-confirm-irreversible">{plan.irreversible}</p>
          )}
        </div>
        <div className="git-confirm-buttons">
          <button
            type="button"
            ref={cancelRef}
            data-git-confirm="cancel"
            onClick={() => onResolve(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="danger git-confirm-danger"
            data-git-confirm="confirm"
            onClick={() => onResolve(true)}
          >
            {plan.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
