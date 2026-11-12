import { describe, expect, it } from 'vitest'
import { LANE_COLORS, collapseRefs, layout, relativeTime } from './gitGraph'
import type { GraphCommit, GraphEdge } from './gitGraph'

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents })
const e = (kind: GraphEdge['kind'], from: number, to: number, color: number): GraphEdge => ({
  kind,
  from,
  to,
  color,
})
const byKind = (edges: GraphEdge[], kind: GraphEdge['kind']) => edges.filter((x) => x.kind === kind)

// Newest first. M merges F (second parent) into main; B1 is the fork point.
//   M --- F
//   |     |
//   A     |
//   |    /
//   B1 --
//   |
//   R
const FORK_MERGE: GraphCommit[] = [
  c('M', 'A', 'F'),
  c('F', 'B1'),
  c('A', 'B1'),
  c('B1', 'R'),
  c('R'),
]

describe('layout', () => {
  it('linear history is one lane in column 0', () => {
    const rows = layout([c('a', 'b'), c('b', 'c'), c('c')])
    expect(rows.map((r) => [r.col, r.lanes, r.overflow])).toEqual([
      [0, 1, false],
      [0, 1, false],
      [0, 1, false],
    ])
    expect(rows[0].edges).toEqual([e('out', 0, 0, rows[0].color)])
    expect(rows[1].edges).toEqual([e('in', 0, 0, rows[0].color), e('out', 0, 0, rows[0].color)])
    expect(rows[2].edges).toEqual([e('in', 0, 0, rows[0].color)])
  })

  it('fork: two children of one commit converge into the parent', () => {
    const rows = layout([c('x', 'p'), c('y', 'p'), c('p')])
    expect(rows[0].col).toBe(0)
    expect(rows[1].col).toBe(1) // y starts a second lane
    expect(rows[1].lanes).toBe(2)
    // y's out edge bends into the existing lane of p (column 0)
    expect(byKind(rows[1].edges, 'out')).toEqual([e('out', 1, 0, rows[0].color)])
    // p receives column 0 only; column 1 was freed
    expect(rows[2].lanes).toBe(1)
    expect(rows[2].col).toBe(0)
  })

  it('merge: first parent continues in the node lane, second opens a lane', () => {
    const rows = layout(FORK_MERGE)
    const m = rows[0]
    expect(m.col).toBe(0)
    const outs = byKind(m.edges, 'out')
    expect(outs).toHaveLength(2)
    expect(outs[0]).toMatchObject({ from: 0, to: 0, color: m.color })
    expect(outs[1]).toMatchObject({ from: 0, to: 1 })
    expect(outs[1].color).not.toBe(m.color)
    expect(m.lanes).toBe(2)
    // F sits in column 1, A in column 0; B1 joins both
    expect(rows[1].col).toBe(1)
    expect(rows[2].col).toBe(0)
    // A (column 0) bends into the lane already waiting for B1 (column 1), freeing 0
    expect(byKind(rows[2].edges, 'out')).toEqual([e('out', 0, 1, rows[1].color)])
    expect(rows[3].col).toBe(1)
    expect(byKind(rows[3].edges, 'in')).toEqual([e('in', 1, 1, rows[1].color)])
  })

  it('octopus merge opens one lane per extra parent', () => {
    const rows = layout([c('m', 'a', 'b', 'd'), c('a'), c('b'), c('d')])
    const outs = byKind(rows[0].edges, 'out')
    expect(outs.map((x) => x.to)).toEqual([0, 1, 2])
    expect(new Set(outs.map((x) => x.color)).size).toBe(3)
    expect(rows[0].lanes).toBe(3)
    expect([rows[1].col, rows[2].col, rows[3].col]).toEqual([0, 1, 2])
  })

  it('a root ends its lane at the node', () => {
    const rows = layout([c('a', 'r'), c('r')])
    expect(byKind(rows[1].edges, 'out')).toEqual([])
    expect(byKind(rows[1].edges, 'in')).toHaveLength(1)
  })

  it('two roots: the second root starts its own lane and both end', () => {
    const rows = layout([c('a', 'r1'), c('b', 'r2'), c('r1'), c('r2')])
    expect(rows[1].col).toBe(1)
    expect(rows[2].col).toBe(0)
    expect(rows[3].col).toBe(1)
    expect(byKind(rows[3].edges, 'out')).toEqual([])
    expect(rows[3].edges).toContainEqual(e('in', 1, 1, rows[1].color))
  })

  it('missing parents: lanes run through to the last row', () => {
    const rows = layout([c('a', 'x'), c('b', 'y')])
    expect(rows[1].edges).toContainEqual(e('through', 0, 0, rows[0].color))
    expect(rows[1].edges).toContainEqual(e('out', 1, 1, rows[1].color))
    expect(rows[1].lanes).toBe(2)
  })

  it('prefix stability: every split of a fork+merge history', () => {
    const full = layout(FORK_MERGE)
    for (let n = 0; n <= FORK_MERGE.length; n++) {
      const head = layout(FORK_MERGE.slice(0, n))
      expect(full.slice(0, n)).toEqual(head)
    }
    const wide: GraphCommit[] = [
      c('m1', 'a', 'b'),
      c('a', 'c'),
      c('b', 'c', 'd'),
      c('c', 'e'),
      c('d', 'e'),
      c('e'),
    ]
    const all = layout(wide)
    for (let n = 1; n < wide.length; n++) {
      expect(all.slice(0, n)).toEqual(layout(wide.slice(0, n)))
    }
  })

  it('parent before child: the impossible edge is dropped cleanly', () => {
    // P is listed before its child C (clock skew); C names P as a parent.
    const rows = layout([c('P', 'Q'), c('C', 'P'), c('Q')])
    expect(rows).toHaveLength(3)
    expect(byKind(rows[1].edges, 'out')).toEqual([])
    // P's own lane (to Q) still reaches Q and nothing dangles afterwards
    expect(rows[2].edges.some((x) => x.kind === 'in' && x.from === 0)).toBe(true)
    expect(rows[2].edges.filter((x) => x.kind === 'through')).toEqual([])
  })

  it('self-parent and repeated parents are ignored', () => {
    const rows = layout([c('a', 'a', 'b', 'b'), c('b')])
    expect(byKind(rows[0].edges, 'out')).toHaveLength(1)
  })

  it('duplicate hashes are skipped (no row, no crash)', () => {
    const rows = layout([c('a', 'b'), c('b'), c('a', 'b'), c('b')])
    expect(rows.map((r) => r.hash)).toEqual(['a', 'b'])
  })

  it('lane cap: columns past the cap fold into the last column', () => {
    const rows = layout([c('m', 'a', 'b', 'd', 'e', 'f'), c('a'), c('b'), c('d'), c('e'), c('f')], {
      maxLanes: 3,
    })
    expect(rows[0].overflow).toBe(true)
    expect(rows[0].lanes).toBe(3)
    for (const r of rows) {
      expect(r.lanes).toBeLessThanOrEqual(3)
      expect(r.col).toBeLessThanOrEqual(2)
      for (const x of r.edges) {
        expect(x.from).toBeLessThanOrEqual(2)
        expect(x.to).toBeLessThanOrEqual(2)
      }
    }
    // the node at logical column 4 is drawn in the overflow column
    expect(rows[5].col).toBe(2)
    expect(rows[5].overflow).toBe(true)
    // a narrow history under the cap never flags
    expect(layout(FORK_MERGE, { maxLanes: 3 }).every((r) => !r.overflow)).toBe(true)
  })

  it('a lane keeps its colour for its whole life', () => {
    const rows = layout([c('m', 'a', 'f'), c('f', 'g'), c('a', 'b'), c('g', 'h'), c('b'), c('h')])
    const fColor = rows[0].edges.find((x) => x.kind === 'out' && x.to === 1)!.color
    expect(rows[1].color).toBe(fColor)
    expect(rows[2].edges).toContainEqual(e('through', 1, 1, fColor))
    expect(rows[3].color).toBe(fColor) // g continues f's lane
    expect(rows[3].col).toBe(1)
    expect(rows[4].edges).toContainEqual(e('through', 1, 1, fColor))
  })

  it('freed columns are reused', () => {
    // side lane (column 1) closes at s2, then a new branch must take column 1 again
    const rows = layout([
      c('m', 'a', 's1'),
      c('s1', 's2'),
      c('a', 'b'),
      c('s2', 'b'),
      c('b', 'n'),
      c('t', 'n'),
      c('n'),
    ])
    expect(rows[0].lanes).toBe(2)
    expect(rows[4].lanes).toBe(1) // lane 1 freed after s2 joined b
    expect(rows[5].col).toBe(1) // t reuses column 1
    expect(Math.max(...rows.map((r) => r.lanes))).toBe(2)
  })

  it('5,000 commits across 30 branches lays out quickly', () => {
    const N = 5000
    const B = 30
    const commits: GraphCommit[] = []
    const last: (string | undefined)[] = new Array(B).fill(undefined)
    // build oldest-first on 30 interleaved branches, then reverse
    for (let i = 0; i < N; i++) {
      const b = i % B
      const hash = `h${i}`
      commits.push(c(hash, ...(last[b] ? [last[b]!] : [])))
      last[b] = hash
    }
    commits.reverse()
    layout(commits, { maxLanes: 40 }) // warm up
    const t0 = performance.now()
    const rows = layout(commits, { maxLanes: 40 })
    const dt = performance.now() - t0
    expect(rows).toHaveLength(N)
    expect(Math.max(...rows.map((r) => r.lanes))).toBe(B)
    // Generous: the whole suite runs in parallel; alone this takes a few ms.
    expect(dt).toBeLessThan(500)
  })

  it('colours stay within the palette', () => {
    const many: GraphCommit[] = [c('m', ...Array.from({ length: 20 }, (_, i) => `p${i}`))]
    for (const x of layout(many, { maxLanes: 30 })[0].edges) expect(x.color).toBeLessThan(LANE_COLORS)
  })
})

describe('relativeTime', () => {
  const now = new Date('2026-06-15T12:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const MIN = 60_000
  const H = 60 * MIN
  const D = 24 * H

  it.each([
    [10_000, 'just now'],
    [5 * MIN, '5 minutes ago'],
    [MIN, '1 minute ago'],
    [3 * H, '3 hours ago'],
    [H, '1 hour ago'],
    [D, 'yesterday'],
    [4 * D, '4 days ago'],
    [21 * D, '3 weeks ago'],
    [150 * D, '4 months ago'],
    [31 * D, '1 month ago'],
    [800 * D, '2 years ago'],
  ])('%d ms ago -> %s', (ms, want) => {
    expect(relativeTime(ago(ms), now)).toBe(want)
  })

  it('returns future and unparseable input unchanged', () => {
    const future = new Date(now.getTime() + H).toISOString()
    expect(relativeTime(future, now)).toBe(future)
    expect(relativeTime('not a date', now)).toBe('not a date')
    expect(relativeTime('', now)).toBe('')
  })
})

describe('collapseRefs', () => {
  it('shows all when under the max', () => {
    expect(collapseRefs(['a', 'b'], 3)).toEqual({ shown: ['a', 'b'], hidden: 0 })
  })
  it('hides the tail past the max', () => {
    expect(collapseRefs([1, 2, 3, 4, 5], 2)).toEqual({ shown: [1, 2], hidden: 3 })
  })
  it('max 0 or negative hides everything; empty input is empty', () => {
    expect(collapseRefs([1, 2], 0)).toEqual({ shown: [], hidden: 2 })
    expect(collapseRefs([1, 2], -4)).toEqual({ shown: [], hidden: 2 })
    expect(collapseRefs([], 3)).toEqual({ shown: [], hidden: 0 })
  })
})
