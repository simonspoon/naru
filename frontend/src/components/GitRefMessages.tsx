import type { GitRefOps } from '../useGitRefOps'

/**
 * The status line, the error alert and the notice of the branch and stash
 * actions (naru task 2741). Sticks to the bottom of the side panel's scroller;
 * `GitRepoPane` shows the same block above the content when the panel is closed
 * (a drawer) so a write started from History is never silent. Git's message is
 * a plain-text `<pre>`; nothing here retries.
 */
export function GitRefMessages({ ops }: { ops: GitRefOps }) {
  const { alert, notice, status } = ops
  if (status === null && alert === null && notice === null) return null
  return (
    <div className="git-side-msgs" data-side-msgs="">
      {status !== null && (
        <p className="git-side-status muted" role="status" data-side-status="">
          {status}
        </p>
      )}
      {alert !== null && (
        <div className="git-side-alert" role="alert" data-side-alert="">
          <div className="git-wt-alert-body">
            <strong>{alert.prefix}</strong>
            <pre className="git-wt-alert-msg">{alert.message}</pre>
            {alert.stashSwitch !== null && (
              <button
                type="button"
                className="git-side-stashswitch"
                data-side-act="stash-switch"
                title={`Stash all changes, untracked files included, then switch to ${alert.stashSwitch}`}
                aria-disabled={ops.busy || ops.dialogOpen ? 'true' : undefined}
                onClick={() => {
                  if (!ops.busy && !ops.dialogOpen && alert.stashSwitch !== null) {
                    void ops.stashSwitch(alert.stashSwitch)
                  }
                }}
              >
                Stash and switch
              </button>
            )}
          </div>
          <button
            type="button"
            className="git-wt-alert-close"
            aria-label="Dismiss"
            onClick={ops.dismiss}
          >
            ×
          </button>
        </div>
      )}
      {notice !== null && (
        <div className="git-side-notice" role="status" data-side-notice="">
          <span className="git-side-notice-text">{notice}</span>
          <button
            type="button"
            className="git-wt-alert-close"
            aria-label="Dismiss"
            onClick={ops.dismiss}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
