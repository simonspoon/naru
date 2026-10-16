import type { WorkflowCreate } from './api'

/** The trimmed name, or `null` when nothing is left to create. */
export function validWorkflowName(raw: string): string | null {
  const name = raw.trim()
  return name === '' ? null : name
}

/** The body for a global workflow: a name and deliberately no `project_id`. */
export function globalWorkflowBody(name: string): WorkflowCreate {
  return { name: name.trim() }
}

/** Where a freshly created global workflow opens: the global builder. */
export function createdWorkflowHref(id: number): string {
  return `#/workflows/${id}`
}
