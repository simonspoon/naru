import { parseTimestamp, timeAgo } from './time'
import type { Project } from './types/Project'
import type { Workflow } from './types/Workflow'

/** On/off for a workflow: it runs by itself exactly when its trigger is a
 * `time` one (`serve --watch-workflows` is what fires it). Manual and voice
 * workflows run only when asked, so they read "off"; there is no stored
 * enabled flag. */
export function isScheduled(w: Workflow): boolean {
  return w.trigger === 'time'
}

/** The project's name, or `—` for a global workflow. */
export function projectLabel(w: Workflow, projects: Project[]): string {
  if (w.project_id === null) return '—'
  return projects.find((p) => p.id === w.project_id)?.name ?? `project ${w.project_id}`
}

/** "succeeded 3m ago" / "failed 1h ago" / "running 2m ago" / "never". */
export function lastRunLabel(w: Workflow, now: number = Date.now()): string {
  if (w.last_run_at === null) return 'never'
  const status = w.last_run_status ?? 'ran'
  return `${status} ${timeAgo(w.last_run_at, now)}`
}

/** When the newest failed run started, as an age, or `—`. */
export function lastFailureLabel(w: Workflow, now: number = Date.now()): string {
  return w.last_failure_at === null ? '—' : timeAgo(w.last_failure_at, now)
}

/** The next scheduled run. Only a scheduled workflow has one: a time workflow
 * that never ran on its timer (null) or whose stamp has passed is due on the
 * watcher's next tick. */
export function nextRunLabel(w: Workflow, now: number = Date.now()): string {
  if (!isScheduled(w)) return '—'
  if (w.next_run_at === null) return 'due'
  const secs = Math.ceil((parseTimestamp(w.next_run_at).getTime() - now) / 1000)
  if (secs <= 0) return 'due'
  const mins = Math.ceil(secs / 60)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.floor(hours / 24)}d`
}

/** Where a row opens: the owning project's workflow view. A global workflow
 * has no project page to open in, so it has no link. */
export function workflowHref(w: Workflow): string | null {
  return w.project_id === null ? null : `#/projects/${w.project_id}/workflows/${w.id}`
}
