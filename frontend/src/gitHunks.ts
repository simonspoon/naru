// The pure half of hunk and line staging (naru task 2739, docs/git-tab.md
// "Hunk and line staging"): the working-tree diff's raw text read into hunks
// and body lines with the server's 0-based indices, the line selection rules,
// and the request's `hunks` array. No DOM, no React — covered by
// `gitHunks.test.ts`.
//
// The numbering is the contract's, not the renderer's: a hunk's index is the
// ordinal of its `@@` header, a body line's index counts the lines after that
// header that start with ' ', '+' or '-' (the "\ No newline at end of file"
// marker is not counted). Line numbers are assigned exactly as `parseDiff`
// assigns them, so a rendered cell finds its line by (side, number).

import type { GitHunkBody } from './api'
import type { DiffRow } from './diffModel'

/** One entry of a request's `hunks`: a whole hunk (no `lines`) or the 0-based
 * body-line indices inside it. */
export type HunkPick = GitHunkBody['hunks'][number]

export type BodyLine = {
  kind: ' ' | '+' | '-'
  /** The line's number in the old / new version; null on the side it is not in. */
  oldNo: number | null
  newNo: number | null
  /** 0-based index among the hunk's body lines. */
  idx: number
  /** The line without its marker. */
  text: string
}

export type Hunk = { index: number; lines: BodyLine[] }

/** A changed line a person can select. `key` is `hunk:idx`, the selection's id. */
export type PickLine = {
  key: string
  hunk: number
  idx: number
  kind: '+' | '-'
  /** Number in the line's own version: old for '-', new for '+'. */
  no: number
  text: string
}

export type HunkModel = {
  hunks: Hunk[]
  /** Every changed line in diff order, across hunks. */
  selectable: PickLine[]
}

export const lineKey = (hunk: number, idx: number): string => `${hunk}:${idx}`

/** Reads the raw diff the way `parseDiff` does (same hunk header, same numbers). */
export function parseHunks(diff: string): HunkModel {
  const hunks: Hunk[] = []
  const selectable: PickLine[] = []
  const lines = diff.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let oldNo = 0
  let newNo = 0
  let cur: Hunk | null = null
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      cur = { index: hunks.length, lines: [] }
      hunks.push(cur)
      continue
    }
    // Before the first hunk (headers) and after it (the truncation notice, a
    // second file's header) nothing is a body line; the marker is no line.
    if (cur === null || line.startsWith('\\')) continue
    const c = line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : line === '' || line.startsWith(' ') ? ' ' : null
    if (c === null) continue
    const body: BodyLine = {
      kind: c,
      oldNo: c === '+' ? null : oldNo++,
      newNo: c === '-' ? null : newNo++,
      idx: cur.lines.length,
      text: line.slice(1),
    }
    cur.lines.push(body)
    if (c !== ' ') {
      selectable.push({
        key: lineKey(cur.index, body.idx),
        hunk: cur.index,
        idx: body.idx,
        kind: c,
        no: (c === '-' ? body.oldNo : body.newNo) as number,
        text: body.text,
      })
    }
  }
  return { hunks, selectable }
}

/** For each `hunk` row of `parseDiff(...).rows`, the hunk index it heads. */
export function hunkOfRow(rows: DiffRow[]): Map<number, number> {
  const out = new Map<number, number>()
  rows.forEach((row, i) => {
    if (row.kind === 'hunk') out.set(i, out.size)
  })
  return out
}

/** The selectable line at (`side`, `no`): old numbers for removed lines on the
 * left, new numbers for added lines on the right. Both are unique per side. */
export function lineAt(model: HunkModel, side: 'left' | 'right', no: number): PickLine | undefined {
  const kind = side === 'left' ? '-' : '+'
  return model.selectable.find((l) => l.kind === kind && l.no === no)
}

/** `lineAt` for a whole render: a map from `side:no` for O(1) lookups. */
export function lineIndex(model: HunkModel): (side: 'left' | 'right', no: number) => PickLine | undefined {
  const map = new Map<string, PickLine>()
  for (const l of model.selectable) map.set(`${l.kind === '-' ? 'left' : 'right'}:${l.no}`, l)
  return (side, no) => map.get(`${side}:${no}`)
}

/** The keys from `from` to `to` inclusive, in diff order (either direction). */
export function selectRange(model: HunkModel, from: string, to: string): string[] {
  const a = model.selectable.findIndex((l) => l.key === from)
  const b = model.selectable.findIndex((l) => l.key === to)
  if (a < 0 || b < 0) return []
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return model.selectable.slice(lo, hi + 1).map((l) => l.key)
}

export function toggle(sel: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(sel)
  if (!next.delete(key)) next.add(key)
  return next
}

/** `base` with the range added (or removed). */
export function applyRange(
  base: ReadonlySet<string>,
  model: HunkModel,
  from: string,
  to: string,
  add: boolean,
): Set<string> {
  const next = new Set(base)
  for (const k of selectRange(model, from, to)) {
    if (add) next.add(k)
    else next.delete(k)
  }
  return next
}

/** The request's `hunks` for a selection: grouped by hunk, hunks and lines
 * sorted. Keys that are not a selectable line of this model are dropped. */
export function picksFor(model: HunkModel, sel: ReadonlySet<string>): HunkPick[] {
  const byHunk = new Map<number, number[]>()
  for (const l of model.selectable) {
    if (!sel.has(l.key)) continue
    const list = byHunk.get(l.hunk) ?? []
    list.push(l.idx)
    byHunk.set(l.hunk, list)
  }
  return [...byHunk.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, lines]) => ({ index, lines: lines.sort((a, b) => a - b) }))
}

export const wholeHunk = (index: number): HunkPick[] => [{ index }]

/** What discarding a hunk loses: each added / removed line, marker included. */
export function hunkLostLines(model: HunkModel, index: number): string[] {
  return (model.hunks[index]?.lines ?? [])
    .filter((l) => l.kind !== ' ')
    .map((l) => `${l.kind}${l.text.replace(/\r$/, '')}`)
}

/** What a control acts on, for labels and failure texts: "hunk 2 of a.ts",
 * "3 hunks of a.ts", "3 selected lines of a.ts". */
export function picksSubject(path: string, picks: HunkPick[]): string {
  const lines = picks.reduce((n, p) => n + (p.lines?.length ?? 0), 0)
  if (picks.some((p) => p.lines !== undefined)) {
    return `${lines} selected ${lines === 1 ? 'line' : 'lines'} of ${path}`
  }
  if (picks.length === 1) return `hunk ${picks[0].index + 1} of ${path}`
  return `${picks.length} hunks of ${path}`
}
