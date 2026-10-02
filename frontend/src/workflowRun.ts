// Pure logic for showing a workflow run (mesa task 1607): which node a step
// paints, how long a step took, and what a workflow's trigger reads as in the
// list. The canvas and the run panel only render what these answer.

import type { Workflow } from './types/Workflow'
import type { WorkflowRun } from './types/WorkflowRun'
import type { WorkflowStepStatus } from './types/WorkflowStepStatus'

/** The step status each node of `run` ended with, keyed by node id. A node a
 *  run did not record (added after it ran) is simply absent. */
export function stepStatusByNode(run: WorkflowRun | null): Map<number, WorkflowStepStatus> {
  const out = new Map<number, WorkflowStepStatus>()
  for (const s of run?.steps ?? []) out.set(s.node_id, s.status)
  return out
}

/** The class a node card wears for its step's status; none before any run. */
export function stepClass(status: WorkflowStepStatus | undefined): string {
  return status === undefined ? '' : `step-${status}`
}

export function stepCounts(run: WorkflowRun): Record<WorkflowStepStatus, number> {
  const counts: Record<WorkflowStepStatus, number> = { ok: 0, skipped: 0, failed: 0 }
  for (const s of run.steps) counts[s.status] += 1
  return counts
}

/** A step's duration: whole milliseconds under a second, else seconds to one
 *  decimal. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** One line for a finished run: `succeeded · 3 ok, 2 skipped`, or the failure. */
export function runSummary(run: WorkflowRun): string {
  const c = stepCounts(run)
  const parts = [`${c.ok} ok`]
  if (c.skipped > 0) parts.push(`${c.skipped} skipped`)
  if (c.failed > 0) parts.push(`${c.failed} failed`)
  const base = `${run.status} · ${parts.join(', ')}`
  return run.error ? `${base} — ${run.error}` : base
}

/** What a workflow's trigger reads as in the list: its mode, plus the phrase a
 *  voice request would say; "no trigger" when the graph has none yet. */
export function triggerLabel(w: Pick<Workflow, 'trigger' | 'trigger_phrase'>): string {
  if (w.trigger === null) return 'no trigger'
  return w.trigger_phrase ? `${w.trigger} · “${w.trigger_phrase}”` : w.trigger
}
