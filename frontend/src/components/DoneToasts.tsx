import { useEffect, useRef, useState } from 'react'
import { listProjects, listTasks } from '../api'
import {
  DONE_POLL_MS,
  TOAST_MS,
  detectDone,
  dismissToast,
  pushToasts,
  toastHref,
  type DoneToast,
} from '../doneToast'

// Task-done toasts (mesa task 1556), mounted once at app level. The web UI
// does not live-sync, so this polls the one cross-project read that already
// exists — `GET /api/tasks?status=done` — and diffs it (`doneToast.ts`); the
// first poll only seeds, so nothing already done at mount toasts. Paused while
// the tab is hidden.
export function DoneToasts() {
  const [toasts, setToasts] = useState<DoneToast[]>([])
  const seen = useRef<Set<number> | null>(null)
  const nextKey = useRef(0)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const done = await listTasks({ status: 'done' })
        if (cancelled) return
        const r = detectDone(seen.current, done)
        seen.current = r.seen
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
