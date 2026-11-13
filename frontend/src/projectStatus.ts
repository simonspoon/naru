// The per-project status chips (palette rows, the header's project switcher):
// queued = `todo` tasks, running = `in_progress` tasks — the board's own
// columns — a branch name when it is not the default, and a dot when the
// working tree is dirty or ahead of its upstream. Fetched once in App and
// aggregated here so every consumer shows the same numbers.

import type { GitStatus } from './types/GitStatus'
import type { Status } from './types/Status'

export interface ProjectStatus {
  queued: number
  running: number
  /** Branch name only when it is not `main`/`master`; null otherwise. */
  branch: string | null
  /** Uncommitted changes or unpushed commits. */
  dirty: boolean
}

export const NO_STATUS: ProjectStatus = { queued: 0, running: 0, branch: null, dirty: false }

const DEFAULT_BRANCHES = ['main', 'master']

export function buildStatuses(
  tasks: { project_id: number; status: Status }[],
  git: { project_id: number; git: GitStatus }[],
): Map<number, ProjectStatus> {
  const out = new Map<number, ProjectStatus>()
  const get = (id: number): ProjectStatus => {
    let s = out.get(id)
    if (!s) {
      s = { ...NO_STATUS }
      out.set(id, s)
    }
    return s
  }
  for (const t of tasks) {
    if (t.status === 'todo') get(t.project_id).queued++
    else if (t.status === 'in_progress') get(t.project_id).running++
  }
  for (const g of git) {
    const s = get(g.project_id)
    s.branch = DEFAULT_BRANCHES.includes(g.git.branch) ? null : g.git.branch
    s.dirty = g.git.dirty > 0 || g.git.ahead > 0
  }
  return out
}

export function statusFor(map: Map<number, ProjectStatus>, id: number): ProjectStatus {
  return map.get(id) ?? NO_STATUS
}
