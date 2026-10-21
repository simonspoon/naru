import { diffRevisions } from './workflowHistory'
import type { LibraryDiffLine } from './types/LibraryDiffLine'
import type { Workflow } from './types/Workflow'
import type { WorkflowBuiltinUpdate } from './types/WorkflowBuiltinUpdate'
import type { WorkflowSnapshot } from './types/WorkflowSnapshot'
import type { WorkflowView } from './types/WorkflowView'

/** A built-in is shipped with Naru, installed and updated on `serve` start
 * and read-only except for its on/off switch (naru task 2103). */
export function isBuiltin(w: Pick<Workflow, 'builtin'>): boolean {
  return w.builtin === true
}

/** Why an edit control is disabled on a built-in. */
export const BUILTIN_TITLE = 'Shipped with Naru; read-only. Duplicate to customise.'

/** The one-line note under a built-in's header. */
export const BUILTIN_NOTE =
  'Built-in workflows are managed by Naru and updated on upgrade. Duplicate to customise.'

/** What the duplicate button says: on a built-in it makes a customisable copy. */
export function duplicateLabel(w: Pick<Workflow, 'builtin'>): string {
  return isBuiltin(w) ? 'Duplicate to customise' : 'duplicate'
}

/** The disabled-control tooltip, or undefined when editing is allowed. */
export function readOnlyTitle(readOnly: boolean): string | undefined {
  return readOnly ? BUILTIN_TITLE : undefined
}

/** The headline of the "Install built-ins" result (naru task 2118). A
 * reseeded built-in counts too, so it says "installed or updated". */
export function installHeadline(r: { created: Pick<WorkflowView, 'workflow'>[] }): string {
  const n = r.created.length
  if (n === 0) return 'All built-ins already installed.'
  return `Installed or updated ${n} built-in workflow${n === 1 ? '' : 's'}.`
}

/** One result line per workflow: its name and whether it is on. */
export function installLine(v: Pick<WorkflowView, 'workflow'>): string {
  return `${v.workflow.name} — ${v.workflow.enabled ? 'on' : 'off'}`
}

/** The badge on a customised copy whose built-in has a newer revision than the
 * one it was based on (naru task 2052), or null when there is nothing to offer. */
export function builtinUpdateBadge(w: Pick<Workflow, 'builtin_updated' | 'name'>): {
  text: string
  title: string
  label: string
} | null {
  if (w.builtin_updated !== true) return null
  return {
    text: 'update available',
    title: 'A newer built-in version is available. Nothing changes until you choose.',
    label: `Update available for ${w.name}, review`,
  }
}

/** The copy against the current built-in: `-` only in the copy, `+` only in the built-in. */
export function builtinUpdateDiff(mine: WorkflowSnapshot, builtin: WorkflowSnapshot): LibraryDiffLine[] {
  return diffRevisions(mine, builtin)
}

/** The panel's head line: which built-in revision the copy was made from. */
export function builtinUpdateHead(o: Pick<WorkflowBuiltinUpdate, 'base_rev' | 'builtin_rev'>): string {
  return o.base_rev === null
    ? 'Base unknown; compared with the current built-in.'
    : `Your copy was made from built-in revision ${o.base_rev}; the built-in is now at ${o.builtin_rev}.`
}

/** A subworkflow node that taking the built-in would point somewhere else. */
export type Repoint = { title: string; from: string; to: string }

/** Subworkflow nodes (matched by title) the built-in names a different workflow in
 * than the copy does — the copy's `(custom)` child gets re-pointed at the built-in's. */
export function builtinRepoints(mine: WorkflowSnapshot, builtin: WorkflowSnapshot): Repoint[] {
  const target = (c: unknown): string => {
    const w = (c as { workflow?: unknown } | null)?.workflow
    return typeof w === 'string' ? w : ''
  }
  const out: Repoint[] = []
  for (const b of builtin.nodes) {
    if (b.kind !== 'subworkflow') continue
    const m = mine.nodes.find((n) => n.kind === 'subworkflow' && n.title === b.title)
    if (m && target(m.config) !== target(b.config)) {
      out.push({ title: b.title, from: target(m.config), to: target(b.config) })
    }
  }
  return out
}

/** The note after an answer. */
export function builtinUpdateNote(action: 'take' | 'keep', builtinRev: number): string {
  return action === 'take'
    ? `Replaced with built-in revision ${builtinRev}. Undo from History.`
    : 'Kept your version.'
}
