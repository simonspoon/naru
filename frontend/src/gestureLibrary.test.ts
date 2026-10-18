import { describe, expect, it } from 'vitest'
import { newBinding } from './gestureBindings'
import {
  combinedScore,
  motionOverlaps,
  partsError,
  BUILTIN_GESTURES,
  addTry,
  allCaptured,
  canDelete,
  consistency,
  consistencyWord,
  duplicateName,
  duplicateOf,
  gestureError,
  lookalike,
  lookalikeText,
  nextTake,
  overlapsWith,
  poseMotionText,
  takeStatus,
  tryText,
  usedBy,
} from './gestureLibrary'

const palm = BUILTIN_GESTURES[0]

describe('library rules', () => {
  it('built-ins are not deletable but can be duplicated', () => {
    expect(canDelete(palm)).toBe(false)
    const d = duplicateOf(palm, BUILTIN_GESTURES)
    expect(d.name).toBe('Palm hold copy')
    expect(d.builtin).toBe(false)
    expect(canDelete(d)).toBe(true)
    expect(duplicateName('Palm hold', [...BUILTIN_GESTURES, d])).toBe('Palm hold copy 2')
  })
  it('formats pose and motion', () => {
    expect(poseMotionText(palm)).toBe('open palm · still')
  })
  it('usedBy lists bound actions or null', () => {
    const b = { ...newBinding(), gesture: 'palm-hold', action: 'toggle-mic' }
    expect(usedBy(palm, [b])).toBe('Toggle mic')
    expect(usedBy(BUILTIN_GESTURES[1], [b])).toBeNull()
  })
  it('validates name and hold time', () => {
    expect(gestureError({ ...palm, name: ' ' }, BUILTIN_GESTURES)).toMatch(/Name/)
    expect(gestureError({ ...palm, id: 'x', name: 'palm HOLD' }, BUILTIN_GESTURES)).toMatch(/already/)
    expect(gestureError({ ...palm, holdS: 9 }, BUILTIN_GESTURES)).toMatch(/Hold time/)
    expect(gestureError(palm, BUILTIN_GESTURES)).toBeNull()
  })
})

describe('takes and consistency', () => {
  it('is null until two takes', () => {
    expect(consistency([[1, 0], null, null])).toBeNull()
  })
  it('identical takes are 100, orthogonal 0', () => {
    expect(consistency([[1, 2], [1, 2], null])).toBe(100)
    expect(consistency([[1, 0], [0, 1], null])).toBe(0)
  })
  it('is the mean of pairwise similarity', () => {
    // a=b, c orthogonal to both: (100+0+0)/3
    expect(consistency([[1, 0], [1, 0], [0, 1]])).toBe(33)
  })
  it('words', () => {
    expect([consistencyWord(95), consistencyWord(80), consistencyWord(40), consistencyWord(null)]).toEqual(['great', 'ok', 'low', ''])
  })
  it('statuses and progress', () => {
    const t = [[1], null, null]
    expect(takeStatus(0, t, 1)).toBe('captured')
    expect(takeStatus(1, t, 1)).toBe('holding')
    expect(takeStatus(2, t, 1)).toBe('waiting')
    expect(nextTake(t)).toBe(1)
    expect(allCaptured(t)).toBe(false)
    expect(allCaptured([[1], [1], [1]])).toBe(true)
    expect(nextTake([[1], [1], [1]])).toBeNull()
  })
})

describe('try and lookalike', () => {
  it('keeps five tries, newest first', () => {
    let t: ReturnType<typeof addTry> = []
    for (const s of [10, 20, 30, 40, 50, 84]) t = addTry(t, s, 70)
    expect(t.map((x) => x.score)).toEqual([84, 50, 40, 30, 20])
    expect(t[0].ok).toBe(true)
    expect(t[1].ok).toBe(false)
  })
  it('result text flips with the threshold', () => {
    expect(tryText('Figure eight', 84, 70)).toBe('✓ Recognized: Figure eight (match 84%)')
    expect(tryText('Figure eight', 84, 90)).toBe('Not recognized (84%)')
  })
  it('lookalike at or above the minimum warns with exact text', () => {
    const l = lookalike([{ name: 'Fist', overlap: 20 }, { name: 'Circle', overlap: 62 }])
    expect(l && lookalikeText(l)).toBe('Close to Circle, 62% overlap. Raise strictness or re-record.')
    expect(lookalike([{ name: 'Fist', overlap: 49 }])).toBeNull()
    expect(lookalike([{ name: 'Fist', overlap: 50 }])).not.toBeNull()
    expect(lookalike([])).toBeNull()
  })
  it('overlaps only against gestures with takes', () => {
    const o = overlapsWith([1, 0], [palm, { ...palm, name: 'Call me', takes: [[1, 0]] }])
    expect(o).toEqual([{ name: 'Call me', overlap: 100 }])
  })
})

describe('motion recording', () => {
  const circle = [1, 0, 0, 1, -1, 0, 0, -1]
  const eight = [1, 0, -1, 0, 1, 0, -1, 0]
  it('rates matching paths consistent and unlike paths not', () => {
    expect(consistency([circle, circle.map((x) => x * 1.02), circle])).toBeGreaterThanOrEqual(80)
    expect(consistency([circle, eight, [0, 1, 0, -1, 0, 1, 0, -1]])).toBeLessThan(50)
  })
  it('flags a similar path as a lookalike and ignores pose-only gestures', () => {
    const g = (motionTakes?: number[][]) => ({ id: 'a', name: 'Circle', pose: 'custom', motion: 'custom', holdS: 0, hand: 'either' as const, builtin: false, motionTakes })
    expect(lookalike(motionOverlaps(circle, [g([circle])]))?.name).toBe('Circle')
    expect(lookalike(motionOverlaps(circle, [g()]))).toBeNull()
  })
  it('needs a recorded part, and scores by the weakest', () => {
    expect(partsError(false, false, true, true)).not.toBeNull()
    expect(partsError(true, true, true, false)).not.toBeNull()
    expect(partsError(true, false, true, false)).toBeNull()
    expect(combinedScore(90, 60)).toBe(60)
    expect(combinedScore(null, null)).toBeNull()
  })
  it('reports a recording motion take', () => {
    expect(takeStatus(0, [null, null, null], 0, 'recording')).toBe('recording')
  })
})
