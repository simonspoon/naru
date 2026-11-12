import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { DiscardPlan } from '../gitActions'

/**
 * The modal every destructive working-tree action goes through (naru task
 * 2738). All text comes from `discardPlan` (gitActions.ts); this only lays it
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
  plan: DiscardPlan
  onResolve: (ok: boolean) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const bodyId = useId()

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    return () => {
      // The opener may have been unmounted by the refetch; then focus stays
      // wherever the browser puts it.
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // Marked as well as stopped, like CreateTaskModal: the live
        // conversation's Escape stands down for one another listener claimed.
        e.preventDefault()
        e.stopPropagation()
        onResolve(false)
      } else if (e.key === 'Tab') {
        const box = boxRef.current
        if (!box) return
        const items = Array.from(
          box.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
        )
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        const at = document.activeElement
        if (!box.contains(at)) {
          e.preventDefault()
          first.focus()
        } else if (e.shiftKey && at === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && at === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onResolve])

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
          <ul
            className={`git-confirm-paths${plan.mono ? ' git-confirm-lines' : ''}`}
            tabIndex={0}
            aria-label={plan.listLabel ?? 'Affected paths'}
          >
            {plan.listed.map((p, i) => (
              <li key={`${i}:${p}`}>{p}</li>
            ))}
            {plan.more > 0 && <li className="muted">and {plan.more} more</li>}
          </ul>
          {plan.consequences.map((c) => (
            <p key={c} className="git-confirm-consequence">
              {c}
            </p>
          ))}
          <p className="git-confirm-irreversible">{plan.irreversible}</p>
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
