import type { Workflow } from './types/Workflow'

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
