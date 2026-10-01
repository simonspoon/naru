// Task-done toast logic (mesa task 1556): which tasks newly entered `done`
// between two polls of `GET /api/tasks?status=done&updated_since=<cursor>`,
// and the toast stack they feed. Pure, so the predicates are unit-tested rather than living in the
// component.

export interface DoneTask {
  id: number
  name: string
  project_id: number
  /** Server clock, `YYYY-MM-DD HH:MM:SS` UTC. */
  updated_at: string
}

export interface DoneToast {
  /** Unique per toast. */
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

/** Naru's timestamp text for a client clock, `secondsAgo` before `now`. */
export function seedCursor(now: Date, secondsAgo = 60): string {
  return new Date(now.getTime() - secondsAgo * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')
}

export interface DoneState {
  /** The `updated_since` the next poll asks for. */
  cursor: string
  /** Every id already seen (toasted or seeded) this page life. */
  seen: ReadonlySet<number>
}

/**
 * Fold one poll of `status=done&updated_since=<cursor>` into the state. The
 * cursor only moves to the newest `updated_at` the server reported, so the
 * client clock is used for the seed alone. The filter is `>=`, so the row at
 * the cursor comes back next time; the id set is what stops it toasting twice,
 * and a task toasts at most once per page life. The seed poll (`seed: true`)
 * only records ids.
 */
export function detectDone(
  state: DoneState,
  done: readonly DoneTask[],
  seed = false,
): { state: DoneState; fresh: DoneTask[] } {
  const seen = new Set(state.seen)
  let cursor = state.cursor
  const fresh: DoneTask[] = []
  for (const t of done) {
    if (!seen.has(t.id)) {
      seen.add(t.id)
      if (!seed) fresh.push(t)
    }
    if (t.updated_at > cursor) cursor = t.updated_at
  }
  return { state: { cursor, seen }, fresh }
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
