import type { CcModelChange } from './types/CcModelChange'
import type { CcScorecardRow } from './types/CcScorecardRow'
import { shortModel } from './sessionGraph'

// Pure helpers for the Scorecard section of the CC dashboard's Skills & Agents
// tab (mesa task 1514). Kept out of the .tsx so the formatting and the change
// list ordering are testable.

/** Wall seconds → `45s` / `3m 05s` / `1h 02m`. Sub-second values round to 0s. */
export function fmtWall(secs: number): string {
  const s = Math.max(0, Math.round(secs))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Per-run dollars: cents-level precision, because a haiku run is fractions of one. */
export function fmtRunCost(n: number): string {
  if (n === 0) return '$0.00'
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
}

/** Turns per run: one decimal, dropping a trailing `.0`. */
export function fmtTurns(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/** Task outcome cell: `done 3/4 · requeued 1`, or `—` when no run linked to a task. */
export function fmtTaskOutcome(r: CcScorecardRow): string {
  if (r.task_runs === 0) return '—'
  return `done ${r.task_done}/${r.task_runs} · requeued ${r.task_requeued}`
}

/** A stable React/table key for a row: one row per (agent, model). */
export function scorecardRowKey(r: CcScorecardRow): string {
  return `${r.agent}\u0000${r.model}`
}

/** `?since=&until=` for the endpoint, blank inputs omitted; `''` when both are. */
export function scorecardQuery(since: string, until: string): string {
  const p = new URLSearchParams()
  if (since.trim() !== '') p.set('since', since.trim())
  if (until.trim() !== '') p.set('until', until.trim())
  const q = p.toString()
  return q === '' ? '' : `?${q}`
}

function modelWithEffort(model: string | null, effort: string | null): string {
  const m = shortModel(model) ?? 'unset'
  return effort ? `${m} (${effort})` : m
}

/** `opus → sonnet (high)`; a first version reads `set to opus`. */
export function fmtModelChange(c: CcModelChange): string {
  const to = modelWithEffort(c.to_model, c.to_effort)
  if (c.from_model == null && c.from_effort == null) return `set to ${to}`
  return `${modelWithEffort(c.from_model, c.from_effort)} → ${to}`
}

/** Newest first, and the date part only (the stored `at` is `YYYY-MM-DD HH:MM:SS`). */
export function sortedChanges(changes: CcModelChange[]): CcModelChange[] {
  return [...changes].sort(
    (a, b) => b.at.localeCompare(a.at) || a.agent.localeCompare(b.agent),
  )
}

export function changeDate(c: CcModelChange): string {
  return c.at.slice(0, 10)
}
