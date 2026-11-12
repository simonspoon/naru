// The pure half of the Git tab's History graph (naru task 2735): the lane
// layout drawn left of each commit row (gitk / Fork style), plus two small
// helpers the row text needs. No DOM, no React — covered by `gitGraph.test.ts`.
//
// HOW TO DRAW ONE ROW (for the SVG renderer)
//   A row is a fixed-height box, `row.lanes` columns wide (x = col * COL_W +
//   COL_W / 2), y from 0 (top edge of the row) to H (bottom edge), node at H/2.
//   1. For each edge in `row.edges`, pick a colour from `edge.color` (0..N-1,
//      N = `LANE_COLORS`, mapped to theme tokens by the renderer).
//   2. kind 'through': vertical line (from, 0) -> (from, H). `to === from`.
//   3. kind 'in': from (edge.from, 0) down to the node (edge.to, H/2); when
//      from !== to it bends (curve or diagonal) towards the node column.
//   4. kind 'out': from the node (edge.from, H/2) down to (edge.to, H); when
//      from !== to it bends away from the node column.
//   5. Draw edges first, then the node dot at (row.col, H/2) in `row.color`.
//   6. A root has no 'out' edge; a commit with no known child has no 'in' edge
//      at its own column. Lanes whose parent is on a later page simply keep
//      emitting 'through' edges to the last row.
//   7. When `row.overflow` is true something at/after column `maxLanes` was
//      folded into the last column (index maxLanes - 1): draw a "+N"-style
//      marker there. `row.lanes` never exceeds `maxLanes`.
//   8. Rows are independent: draw each from its own record only.
//
// Prefix stability: the layout is a single forward pass, so row i depends only
// on commits 0..i; `layout(a.concat(b))` rows [0, a.length) deep-equal
// `layout(a)`. Page appends never repaint drawn rows.

/** Number of distinct colour indices; edge/node colours are in 0..N-1. */
export const LANE_COLORS = 8

/** Default lane cap (phone callers pass fewer). */
export const DEFAULT_MAX_LANES = 8

/** One commit in display order (newest first). Structural, full shas. */
export type GraphCommit = { hash: string; parents: string[] }

/** One line segment of a row. See the header for how to draw each kind. */
export type GraphEdge = {
  kind: 'through' | 'in' | 'out'
  /** Column at the top of the row ('through'/'in') or at the node ('out'). */
  from: number
  /** Column at the bottom of the row ('through'/'out') or at the node ('in'). */
  to: number
  /** Colour index 0..LANE_COLORS-1; a lane keeps it for its whole life. */
  color: number
}

/** Everything one row needs to draw its own graph cell. */
export type GraphRow = {
  hash: string
  /** Node column. */
  col: number
  /** Node colour index. */
  color: number
  /** Columns this row occupies, 1..maxLanes (width of the SVG). */
  lanes: number
  edges: GraphEdge[]
  /** True when the node or an edge was folded into the last column. */
  overflow: boolean
}

export type LayoutOptions = { maxLanes?: number }

/**
 * Lay out `commits` (newest first). Robustness rules:
 * - A parent already emitted above its child (clock skew) is dropped: no edge.
 * - A repeated hash (paging overlap) is SKIPPED: it yields no row, so rows can
 *   be fewer than commits; match rows to commits by `row.hash`, not by index.
 * - Parents listed twice, or a commit listing itself, are ignored.
 */
export function layout(commits: GraphCommit[], opts: LayoutOptions = {}): GraphRow[] {
  const cap = Math.max(1, Math.floor(opts.maxLanes ?? DEFAULT_MAX_LANES))
  // lanes[i] = hash the lane in column i is waiting for (null = free column).
  const lanes: (string | null)[] = []
  const laneColor: number[] = []
  const seen = new Set<string>()
  let nextColor = 0
  const rows: GraphRow[] = []

  const freshColor = () => nextColor++ % LANE_COLORS
  const freeCol = () => {
    const i = lanes.indexOf(null)
    return i === -1 ? lanes.length : i
  }
  const setLane = (i: number, hash: string, color: number) => {
    lanes[i] = hash
    laneColor[i] = color
  }

  for (const c of commits) {
    if (seen.has(c.hash)) continue
    seen.add(c.hash)

    const topLen = lanes.length
    let col = lanes.indexOf(c.hash)
    const raw: GraphEdge[] = []
    let color: number
    if (col === -1) {
      col = freeCol()
      color = freshColor()
    } else {
      color = laneColor[col]
    }
    for (let i = 0; i < topLen; i++) {
      if (lanes[i] === null) continue
      if (lanes[i] === c.hash) raw.push({ kind: 'in', from: i, to: col, color: laneColor[i] })
      else raw.push({ kind: 'through', from: i, to: i, color: laneColor[i] })
    }
    for (let i = 0; i < topLen; i++) if (lanes[i] === c.hash) lanes[i] = null

    let first = true
    const done = new Set<string>()
    for (const p of c.parents) {
      if (seen.has(p) || done.has(p)) continue
      done.add(p)
      const j = lanes.indexOf(p)
      if (j !== -1) {
        raw.push({ kind: 'out', from: col, to: j, color: laneColor[j] })
      } else if (first) {
        setLane(col, p, color)
        raw.push({ kind: 'out', from: col, to: col, color })
      } else {
        const k = freeCol()
        const kc = freshColor()
        setLane(k, p, kc)
        raw.push({ kind: 'out', from: col, to: k, color: kc })
      }
      first = false
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      laneColor.pop()
    }

    // Apply the cap: columns >= cap fold into the last column.
    let overflow = col >= cap
    let maxCol = Math.min(col, cap - 1)
    const edges: GraphEdge[] = []
    const keys = new Set<string>()
    for (const e of raw) {
      if (e.from >= cap || e.to >= cap) overflow = true
      const f = Math.min(e.from, cap - 1)
      const t = Math.min(e.to, cap - 1)
      const key = `${e.kind}:${f}:${t}`
      if (keys.has(key)) continue
      keys.add(key)
      edges.push({ kind: e.kind, from: f, to: t, color: e.color })
      if (f > maxCol) maxCol = f
      if (t > maxCol) maxCol = t
    }
    rows.push({ hash: c.hash, col: Math.min(col, cap - 1), color, lanes: maxCol + 1, edges, overflow })
  }
  return rows
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`

/** "just now" … "2 years ago". Future or unparseable input is returned as is. */
export function relativeTime(iso: string, now: Date): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const ms = now.getTime() - t
  if (Number.isNaN(ms) || ms < 0) return iso
  if (ms < MIN) return 'just now'
  if (ms < HOUR) return plural(Math.floor(ms / MIN), 'minute')
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour')
  const days = Math.floor(ms / DAY)
  if (days === 1) return 'yesterday'
  if (days < 7) return plural(days, 'day')
  if (days < 30) return plural(Math.floor(days / 7), 'week')
  if (days < 365) return plural(Math.max(1, Math.floor(days / 30.4375)), 'month')
  return plural(Math.floor(days / 365), 'year')
}

/** Show at most `max` refs; `hidden` is how many were left out (for "+N"). */
export function collapseRefs<T>(refs: T[], max: number): { shown: T[]; hidden: number } {
  const m = Math.max(0, Math.floor(max))
  const shown = refs.slice(0, m)
  return { shown, hidden: refs.length - shown.length }
}
