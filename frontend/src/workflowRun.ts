// Pure logic for showing a workflow run (mesa task 1607): which node a step
// paints, how long a step took, and what a workflow's trigger reads as in the
// list. The canvas and the run panel only render what these answer.

import type { Workflow } from './types/Workflow'
import type { WorkflowEdge } from './types/WorkflowEdge'
import type { WorkflowGate } from './types/WorkflowGate'
import type { WorkflowNodeKind } from './types/WorkflowNodeKind'
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

/** The nodes whose step in `run` failed but was handled (naru task 2536):
 *  the node has a wired failure exit, so the run went on past it. Read from
 *  the graph as it is now — the run does not record its edges. */
export function handledFailures(
  run: WorkflowRun | null,
  edges: readonly Pick<WorkflowEdge, 'from_node' | 'branch' | 'kind'>[],
): Set<number> {
  const out = new Set<number>()
  for (const s of run?.steps ?? [])
    if (s.status === 'failed' && edges.some((e) => e.from_node === s.node_id && e.kind === 'exec' && e.branch === 'failure'))
      out.add(s.node_id)
  return out
}

export function stepCounts(run: WorkflowRun): Record<WorkflowStepStatus, number> {
  const counts: Record<WorkflowStepStatus, number> = {
    running: 0,
    ok: 0,
    skipped: 0,
    failed: 0,
  }
  for (const s of run.steps) counts[s.status] += 1
  return counts
}

/** The run to show live: the newest `running` one (runs come newest first),
 *  or null when nothing is in progress. */
export function runningRunId(runs: Pick<WorkflowRun, 'id' | 'status'>[] | null): number | null {
  return runs?.find((r) => r.status === 'running')?.id ?? null
}

/** How often to poll the run list: fast while this page started a run or one
 *  is `running` (CLI, watcher, voice), slow otherwise to notice a new one. */
export function runPollMs(startedHere: boolean, runningId: number | null): number {
  return startedHere || runningId !== null ? 1000 : 5000
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
  if (c.running > 0) parts.push(`${c.running} running`)
  if (c.skipped > 0) parts.push(`${c.skipped} skipped`)
  if (c.failed > 0) parts.push(`${c.failed} failed`)
  const base = `${run.status} · ${parts.join(', ')}`
  return run.error ? `${base} — ${run.error}` : base
}

/** What a workflow's trigger reads as in the list: its mode, plus the phrase a
 *  voice request would say or an ambient trigger's events; "no trigger" when the graph has none yet. */
export function triggerLabel(w: Pick<Workflow, 'trigger' | 'trigger_phrase'> & Partial<Pick<Workflow, 'trigger_events'>>): string {
  if (w.trigger === null) return 'no trigger'
  if (w.trigger === 'ambient' && w.trigger_events && w.trigger_events.length > 0)
    return `ambient · ${w.trigger_events.join(', ')}`
  return w.trigger_phrase ? `${w.trigger} · “${w.trigger_phrase}”` : w.trigger
}

/** A run's gates keyed by node id (naru task 1993); a node that gated twice
 *  keeps its newest. `gates` come newest first, so the first one seen wins. */
export function gateByNode(gates: readonly WorkflowGate[] | null): Map<number, WorkflowGate> {
  const out = new Map<number, WorkflowGate>()
  for (const g of gates ?? []) if (!out.has(g.node_id)) out.set(g.node_id, g)
  return out
}

/** What a gate card says: waiting, or how it was decided (a timeout is a
 *  rejection and says so). */
export function gateBadge(gate: WorkflowGate): { text: string; tone: 'waiting' | 'approved' | 'rejected' } {
  if (gate.status === 'pending') return { text: 'waiting', tone: 'waiting' }
  if (gate.status === 'approved') return { text: 'approved', tone: 'approved' }
  return { text: gate.reason ? `rejected — ${gate.reason}` : 'rejected', tone: 'rejected' }
}

/** The node kinds whose card offers a live output panel (naru task 2531). */
export function hasOutputPanel(kind: WorkflowNodeKind): boolean {
  return kind === 'cli' || kind === 'script'
}

/** What a node's output panel shows for `run`: the step's status and its
 *  stdout/stderr log so far, or null when the run has no step for it yet. A
 *  step written before logs existed falls back to its output and error. */
export function stepOutput(
  run: WorkflowRun | null,
  nodeId: number,
): { status: WorkflowStepStatus; text: string } | null {
  const step = run?.steps.find((s) => s.node_id === nodeId)
  if (!step) return null
  const text = step.log ?? [step.output, step.error ?? ''].filter((t) => t !== '').join('\n')
  return { status: step.status, text }
}
