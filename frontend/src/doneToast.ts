// Task-done toast logic (mesa task 1556): which tasks newly entered `done`
// between two polls of `GET /api/tasks?status=done`, and the toast stack they
// feed. Pure, so the predicates are unit-tested rather than living in the
// component.

export interface DoneTask {
  id: number
  name: string
  project_id: number
}

export interface DoneToast {
  /** Unique per toast, so a task that is reopened and closed again gets a new one. */
  key: number
  taskId: number
  name: string
  projectId: number
  /** Resolved by the component; null when the project is not known. */
  project: string | null
}

/** How long a toast stays before it dismisses itself. */
export const TOAST_MS = 6000
/** The most toasts on screen; the oldest are dropped past it. */
export const TOAST_MAX = 4

export const DONE_POLL_MS = 2000

/**
 * Compare a poll of the done tasks against the ids already seen. The first
 * poll (`seen === null`) only seeds — tasks already done at mount never toast.
 * The returned set is exactly the ids done now, so a task that leaves `done`
 * and returns toasts again, and one still done never toasts twice.
 */
export function detectDone(
  seen: ReadonlySet<number> | null,
  done: readonly DoneTask[],
): { seen: Set<number>; fresh: DoneTask[] } {
  const next = new Set(done.map((t) => t.id))
  if (seen === null) return { seen: next, fresh: [] }
  return { seen: next, fresh: done.filter((t) => !seen.has(t.id)) }
}

/** Append toasts for `fresh` (keys from `nextKey`), newest last, capped at `TOAST_MAX`. */
export function pushToasts(
  stack: readonly DoneToast[],
  fresh: readonly DoneTask[],
  projectNames: ReadonlyMap<number, string>,
  nextKey: number,
): DoneToast[] {
  const added = fresh.map((t, i) => ({
    key: nextKey + i,
    taskId: t.id,
    name: t.name,
    projectId: t.project_id,
    project: projectNames.get(t.project_id) ?? null,
  }))
  return [...stack, ...added].slice(-TOAST_MAX)
}

export function dismissToast(stack: readonly DoneToast[], key: number): DoneToast[] {
  return stack.filter((t) => t.key !== key)
}

/** The hash that opens a task's panel on its project's board. */
export function toastHref(t: Pick<DoneToast, 'projectId' | 'taskId'>): string {
  return `#/projects/${t.projectId}/tasks/${t.taskId}`
}
