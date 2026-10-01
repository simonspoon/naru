import { useEffect, useRef, useState } from 'react'
import { listProjects, listTasks } from '../api'
import {
  DONE_POLL_MS,
  TOAST_MS,
  detectDone,
  dismissToast,
  pushToasts,
  seedCursor,
  toastHref,
  type DoneState,
  type DoneToast,
} from '../doneToast'

// Task-done toasts (mesa task 1556), mounted once at app level. The web UI
// does not live-sync, so this polls the one cross-project read that already
// exists — `GET /api/tasks?status=done&updated_since=<cursor>` — so the reply
// is only what changed lately, never every done task. The cursor is the
// newest server `updated_at` seen (`doneToast.ts`); the first poll seeds from
// the client clock a minute back and only records ids, so nothing already done
// at mount toasts. Paused while the tab is hidden.
export function DoneToasts() {
  const [toasts, setToasts] = useState<DoneToast[]>([])
  const state = useRef<DoneState | null>(null)
  const nextKey = useRef(0)

  useEffect(() => {
    let cancelled = false
    // A request outlasting the interval must not let a second tick share its
    // cursor and seen set, or one task toasts twice.
    let inFlight = false
    // Fixed at mount so a failing seed poll or a hidden tab cannot drift it.
    const seedFrom = seedCursor(new Date())
    const tick = async () => {
      if (document.hidden || inFlight) return
      inFlight = true
      try {
        const seed = state.current === null
        const cur = state.current ?? { cursor: seedFrom, seen: new Set<number>() }
        const done = await listTasks({ status: 'done', updatedSince: cur.cursor })
        if (cancelled) return
        const r = detectDone(cur, done, seed)
        state.current = r.state
        if (r.fresh.length === 0) return
        // Names are read fresh only when something fired; a failure just
        // leaves the project line off.
        const names = new Map<number, string>()
        try {
          for (const p of await listProjects(true)) names.set(p.id, p.name)
        } catch {
          /* project line is decoration */
        }
        if (cancelled) return
        const key = nextKey.current
        nextKey.current += r.fresh.length
        setToasts((s) => pushToasts(s, r.fresh, names, key))
      } catch {
        /* the next tick retries */
      } finally {
        inFlight = false
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), DONE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  if (toasts.length === 0) return null
  return (
    <div className="done-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <DoneToastCard
          key={t.key}
          toast={t}
          onDismiss={() => setToasts((s) => dismissToast(s, t.key))}
        />
      ))}
    </div>
  )
}

function DoneToastCard({
  toast,
  onDismiss,
}: {
  toast: DoneToast
  onDismiss: () => void
}) {
  // The ref keeps a new sibling's re-render from restarting this timer.
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  })
  useEffect(() => {
    const id = window.setTimeout(() => dismiss.current(), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [])
  return (
    <a
      className="done-toast"
      href={toastHref(toast)}
      onClick={onDismiss}
      title={toast.name}
    >
      <span className="done-toast-check" aria-hidden="true">
        ✓
      </span>
      <span className="done-toast-body">
        <span className="done-toast-title">Task done</span>
        <span className="done-toast-name">
          #{toast.taskId} {toast.name}
        </span>
        {toast.project && <span className="done-toast-project">{toast.project}</span>}
      </span>
    </a>
  )
}
