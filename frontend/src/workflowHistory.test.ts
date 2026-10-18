import { describe, expect, it } from 'vitest'
import { diffRevisions, isUnchanged, revisionEntries, snapshotLines } from './workflowHistory'
import type { WorkflowRevision } from './types/WorkflowRevision'
import type { WorkflowSnapshot } from './types/WorkflowSnapshot'

function snap(titles: string[], ids = titles.map((_, i) => i + 1)): WorkflowSnapshot {
  return {
    name: 'W',
    description: null,
    enabled: true,
    types: [],
    nodes: titles.map((t, i) => ({
      id: ids[i],
      kind: 'cli',
      title: t,
      config: { command: `echo ${t}`, a: 1 },
      x: 0,
      y: 0,
    })),
    edges: titles.length > 1
      ? [{ from_node: ids[0], to_node: ids[1], branch: null, from_pin: null, to_pin: null }]
      : [],
  }
}

function rev(n: number, snapshot: WorkflowSnapshot): WorkflowRevision {
  return { id: n, workflow_id: 1, rev: n, author: 'cli', reason: 'edit', created_at: '2026-10-18 10:00:00', snapshot }
}

describe('snapshotLines', () => {
  it('names nodes and edges by title, not id', () => {
    const lines = snapshotLines(snap(['A', 'B']))
    expect(lines).toContain('node [cli] "A" at 0,0')
    expect(lines).toContain('edge "A" -> "B"')
  })

  it('sorts config keys so equal configs print the same', () => {
    const a = snap(['A'])
    const b = snap(['A'])
    b.nodes[0].config = { a: 1, command: 'echo A' }
    expect(snapshotLines(a)).toEqual(snapshotLines(b))
  })
})

describe('diffRevisions', () => {
  it('is empty of changes for a renumbered restore', () => {
    expect(isUnchanged(diffRevisions(snap(['A', 'B']), snap(['A', 'B'], [10, 11])))).toBe(true)
  })

  it('marks an added node as + and a removed one as -', () => {
    const d = diffRevisions(snap(['A', 'B']), snap(['A', 'C']))
    expect(d.some((l) => l.kind === 'disk-only' && l.text.includes('"C"'))).toBe(true)
    expect(d.some((l) => l.kind === 'mesa-only' && l.text.includes('"B"'))).toBe(true)
  })
})

describe('revisionEntries', () => {
  it('counts against the older neighbour; the oldest has none', () => {
    const entries = revisionEntries([rev(2, snap(['A', 'B', 'C'])), rev(1, snap(['A', 'B']))])
    expect(entries[1].added).toBeNull()
    expect(entries[0].added).toBeGreaterThan(0)
    expect(entries[0].removed).toBe(0)
  })
})
