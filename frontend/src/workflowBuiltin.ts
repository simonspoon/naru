import type { Workflow } from './types/Workflow'
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
