import type { AgentSession } from './types/AgentSession'
import { isRunningAgent } from './agentProject'
import type { Status } from './types/Status'
import type { TaskSummary } from './types/TaskSummary'

/** How many *live* Claude Code sessions look like they are working on this
 * task — what drives the kanban card's live marker (mesa task 663).
 *
 * The link is by session name: both watchers spawn with
 * `format!("{}: {}", project.name, task.name)` (`src/api.rs`), and the
 * frontend holds both halves, so it reconstructs that exact string and
 * compares. Liveness is the existing `isRunningAgent` — the one predicate,
 * shared with the Agents sidebar.
 *
 * **This is deliberately best-effort, and a decoration only.** There is no
 * stored task↔session link (no column, no migration, no route), so the match
 * lapses silently in several ordinary cases and must always degrade to "no
 * animation":
 * - sessions started from the Agents sidebar's "add agent" button carry no
 *   `--name` at all (`DEFAULT_AGENT_SPAWN` has no `{name}`) and never match;
 * - a user-replaced `queue-watcher` command template that
 *   drops `{name}` loses the animation and nothing else;
 * - if a task's `description` (and so its derived `name`) changed after
 *   dispatch, the match lapses;
 * - two tasks in one project whose first 50 chars are identical share a
 *   derived `name`, so both animate.
 *
 * `projectName`/`sessions` are nullable so the not-yet-loaded and
 * failed-fetch cases (`/api/agents` is gated and 502s with no `claude`
 * binary) are the same "0" as no match. */
export function liveAgentCount(
  task: Pick<TaskSummary, 'name'>,
  projectName: string | null,
  sessions: AgentSession[] | null,
): number {
  if (projectName === null || sessions === null) return 0
  const wanted = `${projectName}: ${task.name}`
  return sessions.filter((s) => s.name === wanted && isRunningAgent(s)).length
}

/** How many `done` cards the Board renders before the first "load more"
 *  (mesa task 664), and how many each click adds. */
export const DONE_INITIAL = 20
export const DONE_PAGE = 50

/** Render cap for the Board's `done` column — a *view* limit only: the
 *  fetch (`GET /api/tasks?project=<id>`) still returns every task and the
 *  column header still reports the full total, so a truncated column never
 *  reads as missing data.
 *
 *  Only `done` is capped; the four working columns are returned untouched.
 *  Callers apply this **after** the recency sort and **before** nesting, so
 *  "the last 20" is a literal count of the 20 most recently completed rows —
 *  a subtask whose parent falls outside the cut simply renders at top level,
 *  which `nestColumn` already handles.
 *
 *  `hidden` is what the button's label reports; 0 means no button. */
export function capColumn<T>(
  status: string,
  tasks: T[],
  shown: number,
): { visible: T[]; hidden: number } {
  if (status !== 'done' || tasks.length <= shown) {
    return { visible: tasks, hidden: 0 }
  }
  return { visible: tasks.slice(0, shown), hidden: tasks.length - shown }
}

// Per-workflow canvas view state (pan + zoom), persisted browser-local so each
// workflow reopens at the pan/zoom the user left it. This lives only on the
// user's machine (localStorage), keyed by workflow id — never on the server
// and never shared across devices.

const KEY = (workflowId: number) => `naru-workflow-view-${workflowId}`

/** The pan/zoom transform applied to the canvas content layer. Mirrors the
 *  React Flow `Viewport` shape in WorkflowCanvas; kept structural so a saved view
 *  round-trips unchanged. */
export type BoardView = {
  tx: number
  ty: number
  scale: number
}

/** Load the saved view for a board, or null if none is stored / it is
 *  unreadable. Validates the shape so a corrupt entry falls back to the
 *  default rather than throwing. */
export function loadBoardView(workflowId: number): BoardView | null {
  const raw = localStorage.getItem(KEY(workflowId))
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as BoardView).tx === 'number' &&
      typeof (v as BoardView).ty === 'number' &&
      typeof (v as BoardView).scale === 'number'
    ) {
      return v as BoardView
    }
  } catch {
    // Corrupt entry — fall through to the default.
  }
  return null
}

export function saveBoardView(workflowId: number, view: BoardView): void {
  localStorage.setItem(KEY(workflowId), JSON.stringify(view))
}

// "Hide subtasks" board toggle (naru task 1943): one global, per-browser
// switch, default off. Machine-local like the canvas view above.
export const HIDE_SUBTASKS_KEY = 'naru-board-hide-subtasks'

export function loadHideSubtasks(): boolean {
  try {
    return localStorage.getItem(HIDE_SUBTASKS_KEY) === '1'
  } catch {
    return false
  }
}

export function saveHideSubtasks(hide: boolean): void {
  try {
    if (hide) localStorage.setItem(HIDE_SUBTASKS_KEY, '1')
    else localStorage.removeItem(HIDE_SUBTASKS_KEY)
  } catch {
    // Storage unavailable — the toggle just won't persist.
  }
}

/** Drop child tasks (`parent_id` set) when `hide` is on; identity otherwise. */
export function hideSubtasks<T extends { parent_id: number | null }>(
  tasks: T[],
  hide: boolean,
): T[] {
  return hide ? tasks.filter((t) => t.parent_id === null) : tasks
}

// "Hide child-project tasks" board toggle (naru task 1948): same shape as the
// hide-subtasks switch above — one global, per-browser flag, default off.
export const HIDE_CHILD_PROJECTS_KEY = 'naru-board-hide-child-projects'

export function loadHideChildProjects(): boolean {
  try {
    return localStorage.getItem(HIDE_CHILD_PROJECTS_KEY) === '1'
  } catch {
    return false
  }
}

export function saveHideChildProjects(hide: boolean): void {
  try {
    if (hide) localStorage.setItem(HIDE_CHILD_PROJECTS_KEY, '1')
    else localStorage.removeItem(HIDE_CHILD_PROJECTS_KEY)
  } catch {
    // Storage unavailable — the toggle just won't persist.
  }
}

/** True when any task belongs to a project other than the board's own, i.e.
 *  the board aggregates child-project tasks. */
export function hasChildProjectTasks(
  tasks: { project_id: number }[],
  boardProjectId: number,
): boolean {
  return tasks.some((t) => t.project_id !== boardProjectId)
}

/** Drop tasks of other (child) projects when `hide` is on; identity otherwise. */
export function hideChildProjectTasks<T extends { project_id: number }>(
  tasks: T[],
  boardProjectId: number,
  hide: boolean,
): T[] {
  return hide ? tasks.filter((t) => t.project_id === boardProjectId) : tasks
}

// Collapsed kanban columns (naru task 1650): which status columns a project's
// board has folded into a strip, remembered per project, browser-local.
const COLLAPSIBLE: readonly string[] = ['backlog', 'todo', 'in_progress', 'done']

export const collapsedColumnsKey = (projectId: number) => `naru-board-collapsed-${projectId}`

/** The saved collapsed statuses for a project; unreadable, corrupt or
 *  unknown entries fall back to / are dropped from "all expanded". */
export function loadCollapsedColumns(projectId: number): Status[] {
  try {
    const raw = localStorage.getItem(collapsedColumnsKey(projectId))
    if (raw === null) return []
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return COLLAPSIBLE.filter((s) => v.includes(s)) as Status[]
  } catch {
    return []
  }
}

export function saveCollapsedColumns(projectId: number, list: Status[]): void {
  try {
    if (list.length > 0) {
      localStorage.setItem(collapsedColumnsKey(projectId), JSON.stringify(list))
    } else {
      localStorage.removeItem(collapsedColumnsKey(projectId))
    }
  } catch {
    // Storage unavailable — the collapse just won't persist.
  }
}

/** `list` with `status` added if absent, removed if present. */
export function toggleCollapsed(list: Status[], status: Status): Status[] {
  return list.includes(status) ? list.filter((s) => s !== status) : [...list, status]
}
