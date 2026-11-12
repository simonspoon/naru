import { describe, expect, it } from 'vitest'
import {
  edgePath,
  focusRefreshable,
  laneX,
  mergePage,
  orderRefs,
  refClass,
  refText,
  rowLabel,
  statTotals,
  subjectOrPlaceholder,
  totalsLabel,
} from './gitHistory'
import type { GitRef } from './types/GitRef'

const ref = (kind: GitRef['kind'], name: string, is_head = false): GitRef => ({
  kind,
  name,
  is_head,
})

describe('mergePage', () => {
  it('appends new hashes in order and drops repeats', () => {
    const a = [{ hash: '1' }, { hash: '2' }]
    expect(mergePage(a, [{ hash: '2' }, { hash: '3' }, { hash: '3' }])).toEqual([
      { hash: '1' },
      { hash: '2' },
      { hash: '3' },
    ])
  })
  it('returns the same array when nothing is new', () => {
    const a = [{ hash: '1' }]
    expect(mergePage(a, [{ hash: '1' }])).toBe(a)
  })
})

describe('focusRefreshable', () => {
  it('only while one page is loaded', () => {
    expect(focusRefreshable(1)).toBe(true)
    expect(focusRefreshable(2)).toBe(false)
    expect(focusRefreshable(0)).toBe(false)
  })
})

describe('orderRefs / refText / refClass', () => {
  const refs = [
    ref('tag', 'v1'),
    ref('remote', 'origin/main'),
    ref('branch', 'dev'),
    ref('other', 'stash'),
    ref('branch', 'main', true),
  ]
  it('puts HEAD first, then branch, remote, tag, other', () => {
    expect(orderRefs(refs).map((r) => r.name)).toEqual(['main', 'dev', 'origin/main', 'v1', 'stash'])
  })
  it('does not mutate its input', () => {
    orderRefs(refs)
    expect(refs[0].name).toBe('v1')
  })
  it('labels', () => {
    expect(refText(ref('branch', 'main', true))).toBe('HEAD → main')
    expect(refText(ref('head', 'HEAD', true))).toBe('HEAD (detached)')
    expect(refText(ref('tag', 'v1'))).toBe('◇ v1')
    expect(refText(ref('remote', 'origin/x'))).toBe('origin/x')
    expect(refClass(ref('head', 'HEAD', true))).toBe('detached')
    expect(refClass(ref('branch', 'main', true))).toBe('head')
    expect(refClass(ref('remote', 'o/x'))).toBe('remote')
  })
})

describe('statTotals', () => {
  it('sums and counts binaries', () => {
    const f = (added: number | null, deleted: number | null) => ({
      status: 'M',
      path: 'p',
      orig_path: null,
      added,
      deleted,
    })
    const t = statTotals([f(3, 1), f(null, null), f(2, 0)])
    expect(t).toEqual({ files: 3, added: 5, deleted: 1, binary: 1 })
    expect(totalsLabel(t)).toBe('3 files, +5 −1, 1 binary')
    expect(totalsLabel(statTotals([f(1, 2)]))).toBe('1 file, +1 −2')
  })
})

describe('subjectOrPlaceholder / rowLabel', () => {
  it('flags blank subjects', () => {
    expect(subjectOrPlaceholder('  ')).toEqual({ text: '(no message)', empty: true })
    expect(subjectOrPlaceholder('x')).toEqual({ text: 'x', empty: false })
  })
  it('builds the aria label', () => {
    expect(
      rowLabel(
        { subject: 's', author: 'a', short_hash: 'abc', parents: ['1', '2'], refs: [ref('tag', 'v1')] },
        '2 days ago',
      ),
    ).toBe('s, a, 2 days ago, abc, merge commit, refs: v1')
  })
})

describe('edgePath', () => {
  it('draws straight and curved edges', () => {
    expect(edgePath({ kind: 'through', from: 1, to: 1, color: 0 }, 30)).toBe(`M${laneX(1)} 0V30`)
    expect(edgePath({ kind: 'in', from: 0, to: 0, color: 0 }, 30)).toBe(`M${laneX(0)} 0V15`)
    expect(edgePath({ kind: 'out', from: 0, to: 0, color: 0 }, 30)).toBe(`M${laneX(0)} 15V30`)
    const curve = edgePath({ kind: 'out', from: 0, to: 2, color: 0 }, 30)
    expect(curve.startsWith(`M${laneX(0)} 15C`)).toBe(true)
    expect(curve.endsWith(`${laneX(2)} 30`)).toBe(true)
  })
})
