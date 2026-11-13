// Fuzzy matching, ranking and highlight segmentation for the command palette.
// Pure on purpose (vitest reaches it; the component only draws the result).
//
// A query matches a label when its characters appear in the label in order
// (a subsequence), case-insensitively and ignoring whitespace in the query.
// Ranking, best first: a contiguous run at the very start of the label, a
// contiguous run at a word start, a contiguous run anywhere, then scattered
// subsequences — word-start hits and runs inside a scattered match score
// higher, gaps cost.

export interface FuzzyMatch {
  score: number
  /** Indices into the label of the matched characters, ascending. */
  indices: number[]
}

function isWordStart(text: string, i: number): boolean {
  return i === 0 || !/[a-z0-9]/i.test(text[i - 1])
}

function cleanQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, '')
}

/** Matches `query` against `text`, or null when it is not a subsequence. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = cleanQuery(query)
  if (q === '') return { score: 0, indices: [] }
  const t = text.toLowerCase()
  // A contiguous hit beats any scattered one: take the first word-start
  // occurrence, else the first occurrence.
  let at = t.indexOf(q)
  if (at >= 0) {
    let best = at
    while (best >= 0 && !isWordStart(text, best)) best = t.indexOf(q, best + 1)
    if (best >= 0) at = best
    const bonus = at === 0 ? 3000 : isWordStart(text, at) ? 2000 : 1000
    return {
      score: bonus - at - text.length / 100,
      indices: Array.from({ length: q.length }, (_, k) => at + k),
    }
  }
  // Scattered: try every start of the first character, match greedily after.
  let best: FuzzyMatch | null = null
  for (let start = t.indexOf(q[0]); start >= 0; start = t.indexOf(q[0], start + 1)) {
    const indices = [start]
    let from = start + 1
    for (let k = 1; k < q.length; k++) {
      const j = t.indexOf(q[k], from)
      if (j < 0) break
      indices.push(j)
      from = j + 1
    }
    if (indices.length !== q.length) break // later starts have even less room
    let score = 0
    for (let k = 0; k < indices.length; k++) {
      if (isWordStart(text, indices[k])) score += 40
      if (k > 0) {
        const gap = indices[k] - indices[k - 1] - 1
        score += gap === 0 ? 25 : -Math.min(gap, 20)
      }
    }
    score -= indices[0] * 2 + text.length / 100
    if (best === null || score > best.score) best = { score, indices }
  }
  return best
}

export interface Rankable {
  label: string
  /** Extra words matched when the label does not match (never highlighted). */
  keywords?: string
  /** Subtracted from the score: pushes a row below its plain siblings. */
  penalty?: number
}

export interface Ranked<T> {
  item: T
  indices: number[]
}

/**
 * Filters `items` to those matching `query` and sorts them best first (ties
 * keep their input order). An empty query returns everything unranked, in
 * input order, with nothing highlighted.
 */
export function rankItems<T extends Rankable>(items: T[], query: string): Ranked<T>[] {
  if (cleanQuery(query) === '') return items.map((item) => ({ item, indices: [] }))
  const scored: { item: T; indices: number[]; score: number; order: number }[] = []
  items.forEach((item, order) => {
    const m = fuzzyMatch(query, item.label)
    if (m) {
      scored.push({ item, indices: m.indices, score: m.score - (item.penalty ?? 0), order })
      return
    }
    // A keyword hit ranks below any label hit of the same penalty.
    const k = item.keywords ? fuzzyMatch(query, item.keywords) : null
    if (k) scored.push({ item, indices: [], score: k.score - 5000 - (item.penalty ?? 0), order })
  })
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.map(({ item, indices }) => ({ item, indices }))
}

export interface Segment {
  text: string
  hit: boolean
}

/** Splits `text` into runs of matched / unmatched characters for `<mark>`. */
export function segments(text: string, indices: number[]): Segment[] {
  const hit = new Set(indices)
  const out: Segment[] = []
  for (let i = 0; i < text.length; i++) {
    const h = hit.has(i)
    const last = out[out.length - 1]
    if (last && last.hit === h) last.text += text[i]
    else out.push({ text: text[i], hit: h })
  }
  return out
}

export interface PanelTarget {
  /** The tab's route segment, or `create-task` for the command. */
  key: string
  label: string
  hash: string
  /** True for the Create task command, which is not a panel. */
  command: boolean
}

/**
 * What a project drills into in the palette (naru task 2806): its panels in
 * tab-strip order with Board, the default, first, then the Create task
 * command. `tabs` is the project's real tab list (`PANE_TABS`), passed in so
 * this stays a pure function of what the tab strip shows.
 */
export function projectPanelTargets(
  projectId: number,
  tabs: readonly string[],
  label: (tab: string) => string,
): PanelTarget[] {
  const ordered = [...tabs.filter((t) => t === 'board'), ...tabs.filter((t) => t !== 'board')]
  return [
    ...ordered.map((tab) => ({
      key: tab,
      label: label(tab),
      hash: tab === 'board' ? `#/projects/${projectId}` : `#/projects/${projectId}/${tab}`,
      command: false,
    })),
    {
      key: 'create-task',
      label: 'Create task',
      hash: `#/projects/${projectId}/create-task`,
      command: true,
    },
  ]
}
