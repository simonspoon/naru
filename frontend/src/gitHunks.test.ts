import { describe, expect, it } from 'vitest'
import { parseDiff } from './diffModel'
import {
  applyRange,
  hunkLostLines,
  hunkOfRow,
  lineAt,
  lineIndex,
  parseHunks,
  picksFor,
  picksSubject,
  selectRange,
  toggle,
  wholeHunk,
} from './gitHunks'

const HEAD = 'diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n'
// Hunk 0: body idx 0 ctx, 1 '-', 2 '+', 3 '+', 4 ctx. Hunk 1: 0 '-', 1 '+' (marker after it), 2 ctx.
const TWO = `${HEAD}@@ -1,3 +1,4 @@
 one
-two
+TWO
+two-b
 three
@@ -10,2 +11,3 @@ fn x
-ten
\\ No newline at end of file
+TEN
\\ No newline at end of file
 eleven
`

describe('parseHunks', () => {
  const m = parseHunks(TWO)

  it('indexes hunks and body lines, leaving the no-newline marker out', () => {
    expect(m.hunks.map((h) => h.lines.map((l) => l.kind))).toEqual([
      [' ', '-', '+', '+', ' '],
      ['-', '+', ' '],
    ])
    expect(m.hunks[1].lines.map((l) => l.idx)).toEqual([0, 1, 2])
    expect(m.selectable.map((l) => l.key)).toEqual(['0:1', '0:2', '0:3', '1:0', '1:1'])
  })

  it('numbers lines exactly as parseDiff does', () => {
    const rows = parseDiff(TWO).rows
    for (const row of rows) {
      if (row.kind === 'chg' || row.kind === 'del' || row.kind === 'add') {
        if (row.left) expect(lineAt(m, 'left', row.left.no)?.text).toBe(row.left.text)
        if (row.right) expect(lineAt(m, 'right', row.right.no)?.text).toBe(row.right.text)
      }
    }
    expect(lineAt(m, 'left', 2)).toMatchObject({ key: '0:1', kind: '-' })
    expect(lineAt(m, 'right', 2)).toMatchObject({ key: '0:2', kind: '+', no: 2 })
    expect(lineAt(m, 'right', 3)?.key).toBe('0:3')
    expect(lineAt(m, 'left', 1)).toBeUndefined() // a context line is not selectable
    expect(lineIndex(m)('right', 11)?.key).toBe('1:1')
  })

  it('maps a hunk row of parseDiff to its hunk index', () => {
    const rows = parseDiff(TWO).rows
    const map = hunkOfRow(rows)
    expect([...map.values()]).toEqual([0, 1])
    for (const i of map.keys()) expect(rows[i].kind).toBe('hunk')
  })

  it('reads a header without a ,count and CRLF text', () => {
    const d = `${HEAD}@@ -5 +5 @@\r\n-old\r\n+new\r\n`
    const one = parseHunks(d)
    expect(one.selectable.map((l) => [l.key, l.kind, l.no])).toEqual([
      ['0:0', '-', 5],
      ['0:1', '+', 5],
    ])
    expect(hunkLostLines(one, 0)).toEqual(['-old', '+new'])
  })

  it('has no hunks for a diff without a header', () => {
    expect(parseHunks('').hunks).toEqual([])
    expect(parseHunks('Binary files a and b differ\n').selectable).toEqual([])
  })
})

describe('selection', () => {
  const m = parseHunks(TWO)

  it('toggles one line', () => {
    const on = toggle(new Set(), '0:1')
    expect([...on]).toEqual(['0:1'])
    expect(toggle(on, '0:1').size).toBe(0)
  })

  it('selects a range across hunks in diff order, either direction', () => {
    expect(selectRange(m, '0:3', '1:0')).toEqual(['0:3', '1:0'])
    expect(selectRange(m, '1:1', '0:2')).toEqual(['0:2', '0:3', '1:0', '1:1'])
    expect(selectRange(m, '0:1', 'nope')).toEqual([])
  })

  it('applyRange adds to or removes from a base', () => {
    const base = new Set(['0:1'])
    expect([...applyRange(base, m, '0:2', '0:3', true)].sort()).toEqual(['0:1', '0:2', '0:3'])
    expect([...applyRange(new Set(['0:1', '0:2']), m, '0:1', '0:2', false)]).toEqual([])
    expect(base.size).toBe(1)
  })

  it('groups the picks by hunk, sorted, with lines listed', () => {
    const sel = new Set(['1:1', '0:3', '0:1'])
    expect(picksFor(m, sel)).toEqual([
      { index: 0, lines: [1, 3] },
      { index: 1, lines: [1] },
    ])
    expect(picksFor(m, new Set(['0:0', '9:9']))).toEqual([]) // context / unknown keys
    expect(wholeHunk(2)).toEqual([{ index: 2 }])
  })

  it('lists what discarding a hunk loses', () => {
    expect(hunkLostLines(m, 0)).toEqual(['-two', '+TWO', '+two-b'])
    expect(hunkLostLines(m, 5)).toEqual([])
  })

  it('names what a control acts on', () => {
    expect(picksSubject('a.ts', wholeHunk(1))).toBe('hunk 2 of a.ts')
    expect(picksSubject('a.ts', [{ index: 0, lines: [1, 2] }, { index: 1, lines: [0] }])).toBe(
      '3 selected lines of a.ts',
    )
    expect(picksSubject('a.ts', [{ index: 0, lines: [1] }])).toBe('1 selected line of a.ts')
  })
})
