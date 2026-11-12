import { describe, expect, it } from 'vitest'
import {
  MAX_FIND_MATCHES,
  anchorAfterStep,
  applyEdits,
  boxNeedsReveal,
  expandReplacement,
  findMatches,
  findSegments,
  matchIndexFrom,
  matchLabel,
  replaceEdits,
  scrollLeftForBox,
  scrollTopForBox,
  stepMatch,
  type FindMatch,
} from './fileFind'

const PLAIN = { caseSensitive: false, wholeWord: false }
const CASE = { caseSensitive: true, wholeWord: false }
const WORD = { caseSensitive: false, wholeWord: true }
const REGEX = { caseSensitive: false, wholeWord: false, regex: true }

/** Matches as the substrings they cover, which is what a failure needs to
 * read like — a list of offset pairs says nothing about what was found. */
function found(text: string, query: string, options = PLAIN): string[] {
  return findMatches(text, query, options).matches.map((m) =>
    text.slice(m.start, m.end),
  )
}

function offsets(text: string, query: string, options = PLAIN): number[] {
  return findMatches(text, query, options).matches.map((m) => m.start)
}

describe('findMatches', () => {
  it('finds every occurrence, in order', () => {
    expect(offsets('abcabc', 'bc')).toEqual([1, 4])
  })

  it('answers half-open ranges that slice back to the query', () => {
    expect(findMatches('xxabyy', 'ab', PLAIN).matches).toEqual([
      { start: 2, end: 4 },
    ])
    expect(found('xxabyy', 'ab')).toEqual(['ab'])
  })

  it('finds a match at the very start and at the very end', () => {
    expect(offsets('abXab', 'ab')).toEqual([0, 3])
  })

  it('finds a whole-file match', () => {
    expect(offsets('abc', 'abc')).toEqual([0])
  })

  it('has no matches for an empty query', () => {
    expect(findMatches('abc', '', PLAIN)).toEqual({ matches: [], capped: false })
  })

  it('has no matches in empty text', () => {
    expect(offsets('', 'a')).toEqual([])
  })

  it('has no matches for a query longer than the text', () => {
    expect(offsets('ab', 'abc')).toEqual([])
  })

  it('does not overlap: `aa` in `aaaa` is two matches, not three', () => {
    expect(offsets('aaaa', 'aa')).toEqual([0, 2])
  })

  it('matches across a newline', () => {
    expect(offsets('a\nb', '\nb')).toEqual([1])
  })

  it('matches whitespace and punctuation literally', () => {
    expect(offsets('a( )b( )', '( )')).toEqual([1, 5])
  })

  it('treats the query as text, never as a pattern', () => {
    // A regex engine would read this as "any character"; a literal scan finds
    // only the real dot.
    expect(offsets('a.c abc', '.')).toEqual([1])
    expect(offsets('aaa', '.*')).toEqual([])
  })

  it('is case-insensitive by default', () => {
    expect(offsets('Foo foo FOO', 'foo')).toEqual([0, 4, 8])
  })

  it('respects caseSensitive', () => {
    expect(offsets('Foo foo FOO', 'foo', CASE)).toEqual([4])
    expect(offsets('Foo foo FOO', 'FOO', CASE)).toEqual([8])
  })

  it('keeps offsets exact for a character whose lowercase is longer', () => {
    // 'İ'.toLowerCase() is two code units; lowercasing the whole file would
    // shift every offset after it. The match must still point at the real 'x'.
    const text = 'İx'
    expect(findMatches(text, 'x', PLAIN).matches).toEqual([
      { start: 1, end: 2 },
    ])
    expect(text.slice(1, 2)).toBe('x')
  })

  describe('wholeWord', () => {
    it('rejects a match glued to a word character on either side', () => {
      expect(offsets('cat concat cats cat.', 'cat', WORD)).toEqual([0, 16])
    })

    it('accepts a match at the very start and end of the text', () => {
      expect(offsets('cat', 'cat', WORD)).toEqual([0])
    })

    it('counts digits and underscore as word characters', () => {
      expect(offsets('cat1 _cat cat', 'cat', WORD)).toEqual([10])
    })

    it('draws a boundary only on the sides the query itself ends in a word', () => {
      // `(x` has no word character on its left edge, so `f(x)` still matches.
      expect(offsets('f(x)', '(x', WORD)).toEqual([1])
    })

    it('demands no boundary at all for an all-punctuation query', () => {
      expect(offsets('a->b->c', '->', WORD)).toEqual([1, 4])
    })

    it('combines with caseSensitive', () => {
      expect(
        offsets('Cat cat concat', 'cat', {
          caseSensitive: true,
          wholeWord: true,
        }),
      ).toEqual([4])
    })
  })

  describe('the cap', () => {
    it('reports capped:false when the file is under it', () => {
      const res = findMatches('a'.repeat(10), 'a', PLAIN)
      expect(res.matches).toHaveLength(10)
      expect(res.capped).toBe(false)
    })

    it('reports capped:false at exactly the cap', () => {
      const res = findMatches('a'.repeat(MAX_FIND_MATCHES), 'a', PLAIN)
      expect(res.matches).toHaveLength(MAX_FIND_MATCHES)
      expect(res.capped).toBe(false)
    })

    it('stops one past the cap and says so', () => {
      const res = findMatches('a'.repeat(MAX_FIND_MATCHES + 50), 'a', PLAIN)
      expect(res.matches).toHaveLength(MAX_FIND_MATCHES)
      expect(res.capped).toBe(true)
    })
  })

  it('terminates on a long file of nothing but matches', () => {
    // The guard against a scan that fails to advance: if this ever loops, the
    // suite hangs rather than fails, which is the point of pinning it.
    expect(findMatches('ab'.repeat(500), 'ab', PLAIN).matches).toHaveLength(500)
  })
})

describe('matchIndexFrom', () => {
  const matches: FindMatch[] = [
    { start: 10, end: 12 },
    { start: 20, end: 22 },
    { start: 30, end: 32 },
  ]

  it('is -1 with nothing to land on', () => {
    expect(matchIndexFrom([], 0, true)).toBe(-1)
    expect(matchIndexFrom([], 0, false)).toBe(-1)
  })

  it('takes the first match at or after the caret, going forward', () => {
    expect(matchIndexFrom(matches, 0, true)).toBe(0)
    expect(matchIndexFrom(matches, 10, true)).toBe(0)
    expect(matchIndexFrom(matches, 11, true)).toBe(1)
    expect(matchIndexFrom(matches, 20, true)).toBe(1)
  })

  it('wraps to the first match when the caret is past the last one', () => {
    expect(matchIndexFrom(matches, 999, true)).toBe(0)
  })

  it('takes the last match before the caret, going back', () => {
    expect(matchIndexFrom(matches, 31, false)).toBe(2)
    expect(matchIndexFrom(matches, 30, false)).toBe(1)
    expect(matchIndexFrom(matches, 21, false)).toBe(1)
  })

  it('wraps to the last match when the caret is before the first one', () => {
    expect(matchIndexFrom(matches, 0, false)).toBe(2)
  })
})

describe('anchorAfterStep', () => {
  const matches: FindMatch[] = [
    { start: 10, end: 12 },
    { start: 20, end: 22 },
    { start: 30, end: 32 },
  ]

  it('re-anchors on the match just stepped to', () => {
    expect(anchorAfterStep(matches, 0, 5)).toBe(10)
    expect(anchorAfterStep(matches, 2, 5)).toBe(30)
  })

  it('keeps the anchor it had when there is no match to take one from', () => {
    expect(anchorAfterStep([], 0, 7)).toBe(7)
    expect(anchorAfterStep(matches, -1, 7)).toBe(7)
    expect(anchorAfterStep(matches, 3, 7)).toBe(7)
    expect(anchorAfterStep(matches, 1.5, 7)).toBe(7)
  })

  it('makes a refined query narrow in place rather than restart', () => {
    // The failure it exists for: walk down to a later match, then grow the
    // query. Anchored where the search opened, the next result is back near
    // the top; anchored on the current match, it is the next one along.
    const text = 'foo foobar foo foobar'
    const opened = 0
    const first = findMatches(text, 'foo', PLAIN).matches
    const stepped = stepMatch(first, 0, true)
    const anchor = anchorAfterStep(first, stepped, opened)
    const narrowed = findMatches(text, 'foobar', PLAIN).matches
    expect(matchIndexFrom(narrowed, anchor, true)).toBe(0)
    // …and once the user has walked past the first `foobar`, refining stays
    // there instead of jumping back to it.
    const later = anchorAfterStep(first, 3, opened)
    expect(matchIndexFrom(narrowed, later, true)).toBe(1)
    expect(matchIndexFrom(narrowed, opened, true)).toBe(0)
  })
})

describe('stepMatch', () => {
  const three: FindMatch[] = [
    { start: 0, end: 1 },
    { start: 5, end: 6 },
    { start: 9, end: 10 },
  ]

  it('is -1 with no matches', () => {
    expect(stepMatch([], 0, true)).toBe(-1)
    expect(stepMatch([], -1, false)).toBe(-1)
  })

  it('advances and wraps at the end', () => {
    expect(stepMatch(three, 0, true)).toBe(1)
    expect(stepMatch(three, 1, true)).toBe(2)
    expect(stepMatch(three, 2, true)).toBe(0)
  })

  it('retreats and wraps at the start', () => {
    expect(stepMatch(three, 2, false)).toBe(1)
    expect(stepMatch(three, 1, false)).toBe(0)
    expect(stepMatch(three, 0, false)).toBe(2)
  })

  it('enters at the near end from no selection', () => {
    expect(stepMatch(three, -1, true)).toBe(0)
    expect(stepMatch(three, -1, false)).toBe(2)
  })

  it('enters at the near end from an index the list no longer has', () => {
    expect(stepMatch(three, 99, true)).toBe(0)
    expect(stepMatch(three, 99, false)).toBe(2)
    expect(stepMatch(three, 1.5, true)).toBe(0)
  })

  it('stays put on a single match', () => {
    const one = [{ start: 2, end: 3 }]
    expect(stepMatch(one, 0, true)).toBe(0)
    expect(stepMatch(one, 0, false)).toBe(0)
  })
})

describe('matchLabel', () => {
  it('says so when there is nothing', () => {
    expect(matchLabel(-1, 0, false)).toBe('No results')
    expect(matchLabel(0, 0, false)).toBe('No results')
  })

  it('counts from one', () => {
    expect(matchLabel(0, 7, false)).toBe('1 of 7')
    expect(matchLabel(6, 7, false)).toBe('7 of 7')
  })

  it('clamps an index the list cannot hold', () => {
    expect(matchLabel(-1, 7, false)).toBe('1 of 7')
    expect(matchLabel(99, 7, false)).toBe('7 of 7')
  })

  it('marks a capped count', () => {
    expect(matchLabel(0, MAX_FIND_MATCHES, true)).toBe(`1 of ${MAX_FIND_MATCHES}+`)
  })
})

describe('findSegments', () => {
  it('is one plain run when there is nothing to mark', () => {
    expect(findSegments('abc', [])).toEqual([{ text: 'abc', match: -1 }])
  })

  it('is empty for empty text', () => {
    expect(findSegments('', [])).toEqual([])
  })

  it('splits around a match in the middle', () => {
    expect(findSegments('aXXb', [{ start: 1, end: 3 }])).toEqual([
      { text: 'a', match: -1 },
      { text: 'XX', match: 0 },
      { text: 'b', match: -1 },
    ])
  })

  it('has no empty leading or trailing run', () => {
    expect(findSegments('ab', [{ start: 0, end: 2 }])).toEqual([
      { text: 'ab', match: 0 },
    ])
  })

  it('numbers the runs by match index', () => {
    expect(
      findSegments('a1b2c', [
        { start: 1, end: 2 },
        { start: 3, end: 4 },
      ]),
    ).toEqual([
      { text: 'a', match: -1 },
      { text: '1', match: 0 },
      { text: 'b', match: -1 },
      { text: '2', match: 1 },
      { text: 'c', match: -1 },
    ])
  })

  it('rebuilds the text exactly', () => {
    const text = 'the cat sat on the cat'
    const { matches } = findMatches(text, 'cat', PLAIN)
    expect(
      findSegments(text, matches)
        .map((s) => s.text)
        .join(''),
    ).toBe(text)
  })

  it('skips a range past the end of the text', () => {
    expect(findSegments('ab', [{ start: 5, end: 7 }])).toEqual([
      { text: 'ab', match: -1 },
    ])
  })

  it('skips an empty or inverted range', () => {
    expect(findSegments('ab', [{ start: 1, end: 1 }])).toEqual([
      { text: 'ab', match: -1 },
    ])
    expect(findSegments('ab', [{ start: 2, end: 0 }])).toEqual([
      { text: 'ab', match: -1 },
    ])
  })

  it('clips a range that runs off the end', () => {
    expect(findSegments('ab', [{ start: 1, end: 9 }])).toEqual([
      { text: 'a', match: -1 },
      { text: 'b', match: 0 },
    ])
  })
})

/** The measured twin of the above — what the editor uses under soft wrap, where
 * a logical line is several visual rows and the arithmetic undershoots. */
describe('scrollTopForBox', () => {
  const view = 100

  it('does not move for a box already on screen', () => {
    expect(scrollTopForBox(0, 20, view, 0)).toBe(0)
    expect(scrollTopForBox(60, 40, view, 0)).toBe(0)
    expect(scrollTopForBox(200, 20, view, 150)).toBe(150)
  })

  it('scrolls up to a box above the viewport', () => {
    expect(scrollTopForBox(40, 20, view, 100)).toBe(40)
  })

  it('scrolls down the minimum to reveal a box below it', () => {
    expect(scrollTopForBox(140, 20, view, 0)).toBe(60)
  })

  it('reveals the bottom of a box taller than one row (a wrapped match)', () => {
    expect(scrollTopForBox(90, 60, view, 0)).toBe(50)
  })

  it('never scrolls above the top', () => {
    expect(scrollTopForBox(-30, 20, view, 40)).toBe(0)
  })

  it('leaves the scroll alone when it cannot measure', () => {
    expect(scrollTopForBox(NaN, 20, view, 40)).toBe(40)
    expect(scrollTopForBox(200, NaN, view, 40)).toBe(40)
    expect(scrollTopForBox(200, 20, 0, 40)).toBe(40)
    expect(scrollTopForBox(200, 20, NaN, 40)).toBe(40)
  })
})

describe('boxNeedsReveal', () => {
  // A 600px scrollport with a 60px sticky header block over its top and a
  // 30px status bar over its bottom, in viewport coordinates.
  const bandTop = 60
  const bandBottom = 570

  it('says no for a match already inside the readable band', () => {
    // The whole point: stepping between two matches on screen must not scroll
    // the pane, the way `scrollTopForBox` already refuses to for the editor.
    expect(boxNeedsReveal(100, 18, bandTop, bandBottom)).toBe(false)
    expect(boxNeedsReveal(bandTop, 18, bandTop, bandBottom)).toBe(false)
    expect(boxNeedsReveal(bandBottom - 18, 18, bandTop, bandBottom)).toBe(false)
  })

  it('says yes for a match off either end', () => {
    expect(boxNeedsReveal(-40, 18, bandTop, bandBottom)).toBe(true)
    expect(boxNeedsReveal(900, 18, bandTop, bandBottom)).toBe(true)
  })

  it('counts a match behind a sticky bar as not readable', () => {
    // Inside the scrollport, painted over by the header or the status bar —
    // exactly what makes the band narrower than the port.
    expect(boxNeedsReveal(bandTop - 5, 18, bandTop, bandBottom)).toBe(true)
    expect(boxNeedsReveal(bandBottom - 5, 18, bandTop, bandBottom)).toBe(true)
  })

  it('reveals rather than guesses when it cannot measure', () => {
    expect(boxNeedsReveal(NaN, 18, bandTop, bandBottom)).toBe(true)
    expect(boxNeedsReveal(100, NaN, bandTop, bandBottom)).toBe(true)
    expect(boxNeedsReveal(100, 18, NaN, bandBottom)).toBe(true)
    expect(boxNeedsReveal(100, 18, bandTop, NaN)).toBe(true)
    // A band with no height at all — an unmounted or zero-height pane.
    expect(boxNeedsReveal(100, 18, 200, 200)).toBe(true)
    expect(boxNeedsReveal(100, 18, 300, 200)).toBe(true)
  })
})

describe('scrollLeftForBox', () => {
  const view = 100
  const gutter = 30

  it('does not move for a box already in the readable band', () => {
    expect(scrollLeftForBox(40, 20, view, 0, gutter)).toBe(0)
    expect(scrollLeftForBox(240, 20, view, 200, gutter)).toBe(200)
  })

  it('scrolls right the minimum to reveal a box past the right edge', () => {
    expect(scrollLeftForBox(140, 20, view, 0, gutter)).toBe(60)
  })

  it('clears the gutter rather than parking the box under it', () => {
    // Without the lead-in this answers 40 — the match's left edge exactly at
    // `scrollLeft`, which is where the opaque gutter paints.
    expect(scrollLeftForBox(40, 20, view, 100, gutter)).toBe(10)
    // Already clear of it by more than the gutter: nothing to do.
    expect(scrollLeftForBox(140, 20, view, 100, gutter)).toBe(100)
    // Behind the gutter without being off screen still counts as hidden.
    expect(scrollLeftForBox(120, 20, view, 100, gutter)).toBe(90)
  })

  it('never scrolls past the start of the line, gutter or not', () => {
    expect(scrollLeftForBox(10, 20, view, 100, gutter)).toBe(0)
    expect(scrollLeftForBox(0, 20, view, 100, gutter)).toBe(0)
  })

  it('behaves as the plain reveal with no gutter to clear', () => {
    expect(scrollLeftForBox(40, 20, view, 100, 0)).toBe(40)
    expect(scrollLeftForBox(40, 20, view, 100, NaN)).toBe(40)
    expect(scrollLeftForBox(40, 20, view, 100, -50)).toBe(40)
  })

  it('leaves the scroll alone when it cannot measure', () => {
    expect(scrollLeftForBox(NaN, 20, view, 40, gutter)).toBe(40)
    expect(scrollLeftForBox(200, NaN, view, 40, gutter)).toBe(40)
    expect(scrollLeftForBox(200, 20, 0, 40, gutter)).toBe(40)
  })

  it("corrects what the viewer's scrollIntoView leaves behind", () => {
    // The viewer reaches this from a *different* starting point than the
    // editor: `scrollIntoView({inline: 'nearest'})` has already run, so the
    // match is on screen — flush against the scrollport's left edge, which is
    // the one place the sticky gutter paints over. The input is therefore
    // "already revealed" (`left === scrollLeft`) and the answer must still
    // move, or the step reports success with nothing visible.
    expect(scrollLeftForBox(200, 20, view, 200, gutter)).toBe(170)
    // And a match `scrollIntoView` genuinely put in the clear is left alone,
    // so the correction cannot turn into a second scroll of its own.
    expect(scrollLeftForBox(240, 20, view, 200, gutter)).toBe(200)
    // Wrapped, the viewer has no gutter and nothing to scroll sideways: the
    // same call is a no-op rather than a special case at the call site.
    expect(scrollLeftForBox(200, 20, view, 200, 0)).toBe(200)
  })
})

describe('findMatches with a regex', () => {
  it('finds pattern matches as plain offset ranges', () => {
    expect(found('a1 b22 c333', '\\d+', REGEX)).toEqual(['1', '22', '333'])
    expect(offsets('a1 b22 c333', '\\d+', REGEX)).toEqual([1, 4, 8])
  })

  it('folds case unless told not to, and anchors per line', () => {
    expect(found('Foo\nfoo', '^foo$', REGEX)).toEqual(['Foo', 'foo'])
    expect(found('Foo\nfoo', '^foo$', { ...REGEX, caseSensitive: true })).toEqual(['foo'])
  })

  it('applies the whole-word rule to what matched', () => {
    expect(found('cat concat cats', 'c[a-z]t', { ...REGEX, wholeWord: true })).toEqual(['cat'])
  })

  it('reports an invalid pattern instead of throwing', () => {
    const res = findMatches('abc', '(', REGEX)
    expect(res.matches).toEqual([])
    expect(res.capped).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('skips empty matches and still terminates', () => {
    expect(found('baab', 'a*', REGEX)).toEqual(['aa'])
    expect(found('a\nb', '^', REGEX)).toEqual([])
  })

  it('is capped like the literal scan', () => {
    const res = findMatches('a'.repeat(MAX_FIND_MATCHES + 5), 'a', REGEX)
    expect(res.matches).toHaveLength(MAX_FIND_MATCHES)
    expect(res.capped).toBe(true)
  })

  it('leaves the literal scan literal: a pattern is typing until the toggle is on', () => {
    expect(found('a.c abc', 'a.c')).toEqual(['a.c'])
  })
})

describe('expandReplacement', () => {
  const groups = ['2026-11', '2026', '11']

  it('fills numbered groups, the whole match and a literal dollar', () => {
    expect(expandReplacement('$2/$1', groups)).toBe('11/2026')
    expect(expandReplacement('<$&>', groups)).toBe('<2026-11>')
    expect(expandReplacement('$$1', groups)).toBe('$1')
  })

  it('leaves a number naming no group as typed', () => {
    expect(expandReplacement('$3 $0 $x $', groups)).toBe('$3 $0 $x $')
  })

  it('reads two digits only when that group exists', () => {
    expect(expandReplacement('$10', groups)).toBe('20260')
    const many = ['m', ...Array.from({ length: 10 }, (_, i) => `g${i + 1}`)]
    expect(expandReplacement('$10', many)).toBe('g10')
  })

  it('treats a group that did not take part as empty', () => {
    expect(expandReplacement('[$1]', ['x', undefined])).toBe('[]')
  })
})

describe('replaceEdits', () => {
  /** Replace all, as the resulting text. */
  function all(text: string, query: string, replacement: string, options = PLAIN): string {
    return applyEdits(text, replaceEdits(text, query, replacement, options).edits)
  }

  it('replaces every literal match', () => {
    expect(all('foo bar foo', 'foo', 'baz')).toBe('baz bar baz')
  })

  it('respects case and whole word', () => {
    expect(all('Foo foo', 'foo', 'x', CASE)).toBe('Foo x')
    expect(all('cat concat', 'cat', 'dog', WORD)).toBe('dog concat')
  })

  it('takes a literal replacement verbatim, dollars included', () => {
    expect(all('price', 'price', '$1 $&')).toBe('$1 $&')
  })

  it('fills $1-style groups in regex mode', () => {
    expect(all('2026-11 and 1999-01', '(\\d{4})-(\\d{2})', '$2/$1', REGEX)).toBe(
      '11/2026 and 01/1999',
    )
  })

  it('fills groups per match even when the pattern looks around it', () => {
    expect(all('ab ac', '(?<=a)(\\w)', '<$1>', REGEX)).toBe('a<b> a<c>')
  })

  it('replaces with an empty string', () => {
    expect(all('a-b-c', '-', '')).toBe('abc')
  })

  it('does nothing with zero matches or an empty query', () => {
    expect(replaceEdits('abc', 'x', 'y', PLAIN)).toEqual({ edits: [] })
    expect(replaceEdits('abc', '', 'y', PLAIN)).toEqual({ edits: [] })
  })

  it('reports an invalid regex and replaces nothing', () => {
    const res = replaceEdits('abc', '[', 'y', REGEX)
    expect(res.edits).toEqual([])
    expect(res.error).toBeTruthy()
  })

  it('replaces past the display cap: all means all', () => {
    const text = 'a'.repeat(MAX_FIND_MATCHES + 50)
    const { edits } = replaceEdits(text, 'a', 'b', PLAIN)
    expect(edits).toHaveLength(MAX_FIND_MATCHES + 50)
    expect(applyEdits(text, edits)).toBe('b'.repeat(MAX_FIND_MATCHES + 50))
  })

  it('replaces only the match it is given', () => {
    const text = 'foo foo foo'
    const { edits } = replaceEdits(text, 'foo', 'x', PLAIN, { start: 4, end: 7 })
    expect(edits).toEqual([{ start: 4, end: 7, text: 'x' }])
    expect(applyEdits(text, edits)).toBe('foo x foo')
  })

  it('replaces one regex match with its own groups', () => {
    const text = 'k1=v1 k2=v2'
    const { edits } = replaceEdits(text, '(\\w+)=(\\w+)', '$2=$1', REGEX, { start: 6, end: 11 })
    expect(applyEdits(text, edits)).toBe('k1=v1 v2=k2')
  })

  it('replaces nothing for a match that is no longer one', () => {
    expect(replaceEdits('foo bar', 'foo', 'x', PLAIN, { start: 4, end: 7 }).edits).toEqual([])
  })
})
