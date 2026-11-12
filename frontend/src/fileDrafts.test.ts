import { afterEach, describe, expect, it, vi } from 'vitest'
import { stashDrafts, stashedDrafts } from './fileDrafts'
import type { DraftState } from './fileDirty'

const clean: DraftState = { editing: true, draft: 'a', baseline: 'a' }
const dirty: DraftState = { editing: true, draft: 'b', baseline: 'a' }

afterEach(() => {
  stashDrafts(1, new Map())
  stashDrafts(2, new Map())
  vi.restoreAllMocks()
})

describe('stashedDrafts', () => {
  it('hands back what was stashed, for the paths still open', () => {
    stashDrafts(1, new Map([['a.rs', dirty], ['b.rs', clean]]))
    expect([...stashedDrafts(1, ['a.rs', 'c.rs'])]).toEqual([['a.rs', dirty]])
  })

  it('keeps projects apart: the same path in another project inherits nothing', () => {
    stashDrafts(1, new Map([['src/main.rs', dirty]]))
    expect(stashedDrafts(2, ['src/main.rs']).size).toBe(0)
  })

  it('replaces a project state rather than merging into it', () => {
    stashDrafts(1, new Map([['a.rs', dirty]]))
    stashDrafts(1, new Map([['b.rs', clean]]))
    expect([...stashedDrafts(1, ['a.rs', 'b.rs']).keys()]).toEqual(['b.rs'])
  })
})

describe('the unload warning', () => {
  it('is armed exactly while some project holds a dirty draft', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const calls = (spy: typeof add) =>
      spy.mock.calls.filter(([type]) => type === 'beforeunload').length

    stashDrafts(1, new Map([['a.rs', clean]]))
    expect(calls(add)).toBe(0)

    stashDrafts(1, new Map([['a.rs', dirty]]))
    stashDrafts(1, new Map([['a.rs', { ...dirty, draft: 'bc' }]]))
    expect(calls(add)).toBe(1)

    // Another project going clean does not disarm it while this one is dirty.
    stashDrafts(2, new Map([['x.rs', clean]]))
    expect(calls(remove)).toBe(0)

    stashDrafts(1, new Map([['a.rs', clean]]))
    expect(calls(remove)).toBe(1)
  })

  it('asks the browser to confirm the unload', () => {
    stashDrafts(1, new Map([['a.rs', dirty]]))
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
