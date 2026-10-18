import { diffLines } from './libraryOverride'
import type { LibraryDiffLine } from './types/LibraryDiffLine'
import type { WorkflowRevision } from './types/WorkflowRevision'
import type { WorkflowSnapshot } from './types/WorkflowSnapshot'

/**
 * Pure decisions for a workflow's History view (naru task 2053): turning a
 * revision's snapshot into the text lines two revisions are diffed over, and
 * the revision list into the entries the view renders.
 *
 * Lines name nodes and edges by kind and title, never by id, so a restore that
 * renumbers nodes is not a change; name and enabled are not part of the graph.
 * `core::workflow::snapshot_lines` builds the same lines for the CLI — keep
 * the two in step.
 */

/** JSON with object keys sorted, so equal configs print identically. */
function stable(value: unknown, indent: string): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      )
    }
    return v
  }
  return JSON.stringify(sort(value), null, 2)
    .split('\n')
    .map((l) => indent + l)
    .join('\n')
}

/** The snapshot as the lines a diff compares. */
export function snapshotLines(snap: WorkflowSnapshot): string[] {
  const out: string[] = []
  if (snap.description !== null) out.push(`description: ${snap.description}`)
  for (const t of snap.types) {
    out.push(`type ${t.name} { ${t.fields.map((f) => `${f.name}: ${f.ty}`).join(', ')} }`)
  }
  const title = (id: number) => snap.nodes.find((n) => n.id === id)?.title ?? `#${id}`
  const nodes = [...snap.nodes].sort((a, b) =>
    a.kind === b.kind ? (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) : a.kind < b.kind ? -1 : 1,
  )
  for (const n of nodes) {
    out.push(`node [${n.kind}] "${n.title}" at ${n.x},${n.y}`)
    out.push(...stable(n.config, '  ').split('\n'))
  }
  const edges = snap.edges.map((e) => {
    let l = `edge "${title(e.from_node)}" -> "${title(e.to_node)}"`
    if (e.branch !== null) l += ` [${e.branch}]`
    if (e.from_pin !== null || e.to_pin !== null) l += ` (${e.from_pin ?? ''} -> ${e.to_pin ?? ''})`
    return l
  })
  edges.sort()
  return [...out, ...edges]
}

/** The line diff of `from` (older) → `to`: `-` only in from, `+` only in to. */
export function diffRevisions(from: WorkflowSnapshot, to: WorkflowSnapshot): LibraryDiffLine[] {
  return diffLines(snapshotLines(from).join('\n'), snapshotLines(to).join('\n'))
}

/** True when a diff states no change. */
export function isUnchanged(diff: LibraryDiffLine[]): boolean {
  return diff.every((l) => l.kind === 'context' && (l.mesa_line !== null || l.disk_line !== null))
}

/** One row of the revision list. */
export type RevisionEntry = {
  revision: WorkflowRevision
  /** Lines added / removed against the previous revision; null for the oldest
   * or when the diff is incomplete (a marker line). */
  added: number | null
  removed: number | null
}

/** The list rows, in the order the revisions arrived (newest first). */
export function revisionEntries(revisions: WorkflowRevision[]): RevisionEntry[] {
  return revisions.map((revision, i) => {
    if (i === revisions.length - 1) return { revision, added: null, removed: null }
    const diff = diffRevisions(revisions[i + 1].snapshot, revision.snapshot)
    if (diff.some((l) => l.mesa_line === null && l.disk_line === null)) {
      return { revision, added: null, removed: null }
    }
    return {
      revision,
      added: diff.filter((l) => l.kind === 'disk-only').length,
      removed: diff.filter((l) => l.kind === 'mesa-only').length,
    }
  })
}

/** The label a revision's reason reads as, with its number. */
export function revisionLabel(r: WorkflowRevision): string {
  return `Revision ${r.rev}, ${r.reason}, ${r.author}, ${r.created_at}`
}
