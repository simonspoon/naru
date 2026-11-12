import { describe, expect, it } from 'vitest'
import {
  RICH_MAX_CHARS,
  RICH_MAX_LINES,
  RICH_MAX_LINE_CHARS,
  changeStarts,
  emptyDiffReason,
  hastLines,
  highlightRows,
  initialDiffMode,
  inlineLines,
  isRichDiff,
  markSegs,
  parseDiff,
  segStyle,
  stripCr,
  wordDiff,
} from './diffModel'
import type { DiffRow, Seg } from './diffModel'

const HEAD = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
]

const diffOf = (...lines: string[]) => lines.join('\n') + '\n'

/** `kind old|new` per row, the shape most assertions want. */
const shape = (rows: DiffRow[]) =>
  rows.map((r) =>
    r.kind === 'hunk' || r.kind === 'meta'
      ? `${r.kind} ${r.text}`
      : `${r.kind} ${r.left ? `${r.left.no}:${r.left.text}` : '-'} | ${r.right ? `${r.right.no}:${r.right.text}` : '-'}`,
  )

describe('parseDiff', () => {
  it('pairs removed with added lines and numbers both sides from the hunk header', () => {
    const p = parseDiff(
      diffOf(
        ...HEAD,
        '@@ -10,4 +10,5 @@ fn main() {',
        ' keep',
        '-old one',
        '-old two',
        '+new one',
        '+new two',
        '+new three',
        ' tail',
      ),
    )
    expect(shape(p.rows)).toEqual([
      'hunk @@ -10,4 +10,5 @@ fn main() {',
      'ctx 10:keep | 10:keep',
      'chg 11:old one | 11:new one',
      'chg 12:old two | 12:new two',
      'add - | 13:new three',
      'ctx 13:tail | 14:tail',
    ])
    expect([p.added, p.removed]).toEqual([3, 2])
    expect(p.truncated).toBe(false)
    expect(p.file.binary).toBe(false)
  })

  it('restarts the numbers at every hunk', () => {
    const p = parseDiff(
      diffOf(...HEAD, '@@ -1,2 +1,2 @@', '-a', '+b', ' c', '@@ -40 +40,2 @@', ' x', '+y'),
    )
    expect(shape(p.rows).slice(3)).toEqual([
      'hunk @@ -40 +40,2 @@',
      'ctx 40:x | 40:x',
      'add - | 41:y',
    ])
  })

  it('reads an added file, and a root commit, as all lines added', () => {
    const p = parseDiff(
      diffOf(
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        'index 0000000..3333333',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,2 @@',
        '+one',
        '+two',
      ),
    )
    expect(p.file.isNew).toBe(true)
    expect(shape(p.rows).slice(1)).toEqual(['add - | 1:one', 'add - | 2:two'])
    expect([p.added, p.removed]).toEqual([2, 0])
    expect(emptyDiffReason(p)).toBeNull()
  })

  it('reads a deleted file as all lines removed', () => {
    const p = parseDiff(
      diffOf(
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        'index 3333333..0000000',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-one',
        '-two',
      ),
    )
    expect(p.file.deleted).toBe(true)
    expect(shape(p.rows).slice(1)).toEqual(['del 1:one | -', 'del 2:two | -'])
    expect([p.added, p.removed]).toEqual([0, 2])
  })

  it('names a rename without a content change', () => {
    const p = parseDiff(
      diffOf(
        'diff --git a/old name.txt b/new name.txt',
        'similarity index 100%',
        'rename from old name.txt',
        'rename to new name.txt',
      ),
    )
    expect(p.rows).toEqual([])
    expect(p.file.renameFrom).toBe('old name.txt')
    expect(p.file.renameTo).toBe('new name.txt')
    expect(emptyDiffReason(p)).toBe('Renamed without content changes.')
  })

  it('keeps the hunks of a rename with a content change', () => {
    const p = parseDiff(
      diffOf(
        'diff --git a/a.txt b/b.txt',
        'similarity index 80%',
        'rename from a.txt',
        'rename to b.txt',
        'index 1111111..2222222 100644',
        '--- a/a.txt',
        '+++ b/b.txt',
        '@@ -1 +1 @@',
        '-x',
        '+y',
      ),
    )
    expect(p.file.renameFrom).toBe('a.txt')
    expect(shape(p.rows).slice(1)).toEqual(['chg 1:x | 1:y'])
    expect(emptyDiffReason(p)).toBeNull()
  })

  it('names a mode-only change', () => {
    const p = parseDiff(
      diffOf('diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'),
    )
    expect(p.rows).toEqual([])
    expect(emptyDiffReason(p)).toBe(
      'File mode changed from 100644 to 100755, no content change.',
    )
  })

  it('names an empty file added or deleted', () => {
    const added = parseDiff(
      diffOf('diff --git a/e b/e', 'new file mode 100644', 'index 0000000..e69de29'),
    )
    expect(emptyDiffReason(added)).toBe('Empty file added.')
    const deleted = parseDiff(
      diffOf('diff --git a/e b/e', 'deleted file mode 100644', 'index e69de29..0000000'),
    )
    expect(emptyDiffReason(deleted)).toBe('Empty file deleted.')
  })

  it('names a binary file, new or changed, and gives it no rows', () => {
    const p = parseDiff(
      diffOf(
        'diff --git a/logo.png b/logo.png',
        'new file mode 100644',
        'index 0000000..4444444',
        'Binary files /dev/null and b/logo.png differ',
      ),
    )
    expect(p.file.binary).toBe(true)
    expect(p.rows).toEqual([])
    expect(emptyDiffReason(p)).toBe('Binary file, no text diff.')
  })

  it('gives no reason for a hunkless shape it does not know, nor for an empty diff', () => {
    expect(emptyDiffReason(parseDiff('something else entirely\n'))).toBeNull()
    const empty = parseDiff('')
    expect(empty.rows).toEqual([])
    expect(emptyDiffReason(empty)).toBeNull()
  })

  it('attaches "No newline at end of file" to the line before it, on the right side', () => {
    const p = parseDiff(
      diffOf(
        ...HEAD,
        '@@ -1,2 +1,2 @@',
        ' a',
        '-last',
        '\\ No newline at end of file',
        '+last!',
        '\\ No newline at end of file',
      ),
    )
    expect(p.rows).toHaveLength(3)
    const chg = p.rows[2]
    if (chg.kind !== 'chg') throw new Error('expected a changed row')
    expect(chg.left).toEqual({ no: 2, text: 'last', noEol: true })
    expect(chg.right).toEqual({ no: 2, text: 'last!', noEol: true })
    expect([p.added, p.removed]).toEqual([1, 1])
  })

  it('marks only the side that lost or gained the final newline', () => {
    const p = parseDiff(
      diffOf(...HEAD, '@@ -1 +1 @@', '-end', '\\ No newline at end of file', '+end'),
    )
    const chg = p.rows[1]
    if (chg.kind !== 'chg') throw new Error('expected a changed row')
    expect(chg.left?.noEol).toBe(true)
    expect(chg.right?.noEol).toBeUndefined()
  })

  it('marks both sides when a context line has no final newline', () => {
    const p = parseDiff(
      diffOf(...HEAD, '@@ -1,2 +1,2 @@', '-a', '+b', ' end', '\\ No newline at end of file'),
    )
    const ctx = p.rows[2]
    if (ctx.kind !== 'ctx') throw new Error('expected a context row')
    expect(ctx.left?.noEol).toBe(true)
    expect(ctx.right?.noEol).toBe(true)
  })

  it('reports the truncation notice, after a cut line and before any hunk', () => {
    const p = parseDiff(
      [...HEAD, '@@ -1,3 +1,3 @@', ' a', '+half a li', '[diff truncated]'].join('\n'),
    )
    expect(p.truncated).toBe(true)
    expect(shape(p.rows).slice(1)).toEqual([
      'ctx 1:a | 1:a',
      'add - | 2:half a li',
      'meta [diff truncated]',
    ])
    expect(emptyDiffReason(p)).toBeNull()
    const early = parseDiff('diff --git a/x b/x\n[diff truncated]')
    expect(early.truncated).toBe(true)
    expect(early.rows).toEqual([])
  })

  it('does not take a content line that reads like the notice for it', () => {
    const p = parseDiff(diffOf(...HEAD, '@@ -1 +1 @@', '-[diff truncated]', '+x'))
    expect(p.truncated).toBe(false)
  })

  it('keeps carriage returns, lossy bytes and a very long line as text', () => {
    const long = 'x'.repeat(50_000)
    const p = parseDiff(
      diffOf(...HEAD, '@@ -1,3 +1,3 @@', '-crlf\r', '+crlf', ' caf�\r', `+${long}`),
    )
    expect(shape(p.rows).slice(1)).toEqual([
      'chg 1:crlf\r | 1:crlf',
      'ctx 2:caf�\r | 2:caf�\r',
      `add - | 3:${long}`,
    ])
  })

  it('treats a bare empty line inside a hunk as an empty context line', () => {
    const p = parseDiff(diffOf(...HEAD, '@@ -1,2 +1,2 @@', '', '-a', '+b'))
    expect(shape(p.rows).slice(1)).toEqual(['ctx 1: | 1:', 'chg 2:a | 2:b'])
  })

  it('never reads a file header as content', () => {
    const p = parseDiff(diffOf(...HEAD, '@@ -1 +1 @@', '--- not a header', '+++ nor this'))
    expect(shape(p.rows).slice(1)).toEqual(['chg 1:-- not a header | 1:++ nor this'])
  })
})

describe('stripCr', () => {
  it('splits one trailing carriage return off', () => {
    expect(stripCr('a\r')).toEqual({ text: 'a', cr: true })
    expect(stripCr('a')).toEqual({ text: 'a', cr: false })
    expect(stripCr('a\rb')).toEqual({ text: 'a\rb', cr: false })
    expect(stripCr('')).toEqual({ text: '', cr: false })
  })
})

describe('isRichDiff', () => {
  it('is on for an ordinary diff', () => {
    expect(isRichDiff(diffOf(...HEAD, '@@ -1 +1 @@', '-a', '+b'))).toBe(true)
    expect(isRichDiff('')).toBe(true)
  })

  it('is off past the line limit, which a 5,000-line diff is', () => {
    expect(isRichDiff('+x\n'.repeat(RICH_MAX_LINES - 1))).toBe(true)
    expect(isRichDiff('+x\n'.repeat(RICH_MAX_LINES + 1))).toBe(false)
    expect(isRichDiff('+x\n'.repeat(5000))).toBe(false)
  })

  it('is off past the size limit, however few the lines', () => {
    expect(isRichDiff('+' + 'x'.repeat(RICH_MAX_CHARS))).toBe(false)
  })
})

describe('wordDiff', () => {
  const marked = (text: string, rs: [number, number][]) => rs.map(([a, b]) => text.slice(a, b))

  it('marks the one word that changed', () => {
    const a = 'const total = count + 1'
    const b = 'const total = amount + 1'
    const d = wordDiff(a, b)
    expect(marked(a, d!.old)).toEqual(['count'])
    expect(marked(b, d!.new)).toEqual(['amount'])
  })

  it('marks an insertion on the new side only', () => {
    const a = 'call(a, b)'
    const b = 'call(a, b, c)'
    const d = wordDiff(a, b)
    expect(d!.old).toEqual([])
    expect(marked(b, d!.new)).toEqual([', c'])
  })

  it('marks several separate changes and joins adjacent tokens', () => {
    const a = 'let x = foo(1) + bar.baz'
    const b = 'let y = foo(2) + bar->qux'
    const d = wordDiff(a, b)
    expect(marked(a, d!.old)).toEqual(['x', '1', '.baz'])
    expect(marked(b, d!.new)).toEqual(['y', '2', '->qux'])
  })

  it('marks an indentation change', () => {
    const d = wordDiff('  return x', '    return x')
    expect(d!.old).toEqual([[0, 2]])
    expect(d!.new).toEqual([[0, 4]])
  })

  it('has nothing to mark between identical lines', () => {
    expect(wordDiff('same', 'same')).toEqual({ old: [], new: [] })
  })

  it('declines when a side is empty or the lines share no word', () => {
    expect(wordDiff('', 'x')).toBeNull()
    expect(wordDiff('x', '')).toBeNull()
    expect(wordDiff('alpha beta', 'gamma delta')).toBeNull()
    expect(wordDiff('foo(alpha)', 'bar(beta)')).toBeNull()
    // One shared word in two otherwise different lines is not an edit.
    expect(wordDiff('return `hello ${name}`', 'const who = name.trim()')).toBeNull()
  })

  it('declines a line over the per-line limit', () => {
    const long = 'a '.repeat(RICH_MAX_LINE_CHARS)
    expect(wordDiff(long, long + 'b')).toBeNull()
  })

  it('keeps astral and lossy characters whole', () => {
    const a = 'say 🦀 to caf�'
    const b = 'say 🦊 to caf�'
    const d = wordDiff(a, b)
    expect(marked(a, d!.old)).toEqual(['🦀'])
    expect(marked(b, d!.new)).toEqual(['🦊'])
  })

  it('still marks the middle of a line with too many tokens to align', () => {
    // 600 one-character tokens a side: a 601 x 601 table is past the cap.
    const head = 'word '.repeat(80)
    const a = `${head}${'+'.repeat(600)} tail`
    const b = `${head}${'-'.repeat(600)} tail`
    const d = wordDiff(a, b)
    expect(d!.old).toEqual([[head.length, a.length - 5]])
    expect(d!.new).toEqual([[head.length, b.length - 5]])
  })
})

describe('hastLines', () => {
  it('splits text at newlines and carries nested token classes outermost first', () => {
    const root = {
      type: 'root',
      children: [
        { type: 'text', value: 'a ' },
        {
          type: 'element',
          properties: { className: ['token', 'string'] },
          children: [
            { type: 'text', value: '"x\ny' },
            {
              type: 'element',
              properties: { className: ['token', 'interpolation'] },
              children: [{ type: 'text', value: '${z}' }],
            },
            { type: 'text', value: '"' },
          ],
        },
        { type: 'text', value: '\n\nend' },
      ],
    }
    expect(hastLines(root)).toEqual([
      [
        { text: 'a ', classes: [] },
        { text: '"x', classes: ['string'] },
      ],
      [
        { text: 'y', classes: ['string'] },
        { text: '${z}', classes: ['string', 'interpolation'] },
        { text: '"', classes: ['string'] },
      ],
      [],
      [{ text: 'end', classes: [] }],
    ])
  })

  it('answers one empty line for empty input', () => {
    expect(hastLines({ type: 'root', children: [] })).toEqual([[]])
  })
})

describe('highlightRows', () => {
  const upper = (code: string): Seg[][] =>
    code.split('\n').map((l) => [{ text: l.toUpperCase(), classes: ['k'] }])
  const rows = parseDiff(
    diffOf(...HEAD, '@@ -1,2 +1,2 @@', ' a\r', '-b', '+c', '@@ -9 +9,2 @@', ' d', '+e'),
  ).rows

  it('highlights each hunk side as one block, without carriage returns', () => {
    const calls: string[] = []
    const out = highlightRows(rows, (code) => {
      calls.push(code)
      return upper(code)
    })
    expect(calls).toEqual(['a\nb', 'a\nc', 'd', 'd\ne'])
    expect(out.left[1]).toEqual([{ text: 'A', classes: ['k'] }])
    expect(out.left[2]).toEqual([{ text: 'B', classes: ['k'] }])
    expect(out.right[2]).toEqual([{ text: 'C', classes: ['k'] }])
    expect(out.left[0]).toBeUndefined()
    expect(out.left[5]).toBeUndefined()
    expect(out.right[5]).toEqual([{ text: 'E', classes: ['k'] }])
  })

  it('leaves a hunk plain when the highlighter throws or miscounts lines', () => {
    const thrown = highlightRows(rows, () => {
      throw new Error('bad grammar')
    })
    expect(thrown).toEqual({ left: [], right: [] })
    const short = highlightRows(rows, () => [[]])
    expect(short.left[1]).toBeUndefined()
    // The second hunk's old side is one line, so a one-line answer fits it.
    expect(short.left[4]).toEqual([])
  })

  it('leaves a side plain when it holds a line over the limit', () => {
    const long = 'x'.repeat(RICH_MAX_LINE_CHARS + 1)
    const r = parseDiff(diffOf(...HEAD, '@@ -1,2 +1,2 @@', ' a', '-b', `+${long}`)).rows
    const out = highlightRows(r, upper)
    expect(out.left[1]).toBeDefined()
    expect(out.right[1]).toBeUndefined()
  })
})

describe('markSegs', () => {
  const segs: Seg[] = [
    { text: 'const ', classes: ['keyword'] },
    { text: 'total', classes: [] },
    { text: ' = 1', classes: ['number'] },
  ]
  const flat = (ps: ReturnType<typeof markSegs>) =>
    ps.map((p) => `${p.marked ? '*' : ''}${p.text}`)

  it('passes segments through when nothing is marked', () => {
    expect(markSegs(segs, [])).toEqual(segs.map((s) => ({ ...s, marked: false })))
  })

  it('cuts a segment at a mark and lets a mark span segments', () => {
    const out = markSegs(segs, [
      [2, 4],
      [8, 13],
    ])
    expect(flat(out)).toEqual(['co', '*ns', 't ', 'to', '*tal', '* =', ' 1'])
    expect(out.map((p) => p.text).join('')).toBe('const total = 1')
    expect(out[4].classes).toEqual([])
    expect(out[5].classes).toEqual(['number'])
  })

  it('handles marks at both ends and an empty line', () => {
    expect(flat(markSegs([{ text: 'abc', classes: [] }], [[0, 1], [2, 3]]))).toEqual([
      '*a',
      'b',
      '*c',
    ])
    expect(markSegs([{ text: '', classes: [] }], [[0, 3]])).toEqual([])
  })
})

describe('segStyle', () => {
  const palette = {
    string: { color: 'red', background: 'yellow' },
    interpolation: { color: 'blue', fontStyle: 'italic' as const },
  }

  it('takes colour and font from the classes, inner last, and no background', () => {
    expect(segStyle(['string'], palette)).toEqual({ color: 'red' })
    expect(segStyle(['string', 'interpolation'], palette)).toEqual({
      color: 'blue',
      fontStyle: 'italic',
    })
  })

  it('is undefined for plain text and for a class the palette lacks', () => {
    expect(segStyle([], palette)).toBeUndefined()
    expect(segStyle(['nope'], palette)).toBeUndefined()
  })
})

describe('changeStarts and inlineLines', () => {
  const rows = parseDiff(
    diffOf(
      ...HEAD,
      '@@ -1,5 +1,5 @@',
      ' a',
      '-b',
      '-c',
      '+B',
      ' d',
      '+e',
      '@@ -20 +20 @@',
      '-x',
      '+y',
    ),
  ).rows

  it('finds the first row of every run of changes', () => {
    // rows: hunk, ctx a, chg b|B, del c, ctx d, add e, hunk, chg x|y
    expect(changeStarts(rows)).toEqual([2, 5, 7])
    expect(changeStarts([])).toEqual([])
  })

  it('prints removed lines before added ones within a run', () => {
    expect(
      inlineLines(rows).map((l) =>
        l.kind === 'hunk' || l.kind === 'meta'
          ? l.kind
          : `${l.kind} ${l.oldNo ?? '-'} ${l.newNo ?? '-'} ${l.cell.text} r${l.row}`,
      ),
    ).toEqual([
      'hunk',
      'ctx 1 1 a r1',
      'del 2 - b r2',
      'del 3 - c r3',
      'add - 2 B r2',
      'ctx 4 3 d r4',
      'add - 4 e r5',
      'hunk',
      'del 20 - x r7',
      'add - 20 y r7',
    ])
  })

  it('opens every change with a line of its starting row', () => {
    const lines = inlineLines(rows)
    for (const start of changeStarts(rows)) {
      const first = lines.find((l) => l.row === start)
      expect(first && first.kind !== 'ctx').toBe(true)
    }
  })
})

describe('initialDiffMode', () => {
  it('prefers the remembered pick', () => {
    expect(initialDiffMode('inline', false)).toBe('inline')
    expect(initialDiffMode('split', true)).toBe('split')
  })

  it('defaults to inline on a phone and split elsewhere', () => {
    expect(initialDiffMode(null, true)).toBe('inline')
    expect(initialDiffMode(null, false)).toBe('split')
    expect(initialDiffMode('sideways', true)).toBe('inline')
  })
})
