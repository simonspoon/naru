import { describe, expect, it } from 'vitest'
import {
  closeLabel,
  dirtyPaths,
  diskChange,
  isDirty,
  needsCloseConfirm,
  splitBulkClose,
  tabLabel,
  type DraftState,
} from './fileDirty'
import type { TabsState } from './fileTabs'
import { DEFAULT_RATIO } from './fileTabs'

/** A tab's draft state, defaulting to the shape a never-edited file has. */
function ui(patch: Partial<DraftState> = {}): DraftState {
  return { editing: false, draft: '', baseline: '', ...patch }
}

/** One-pane state over `tabs`, showing the first of them. */
function single(tabs: string[]): TabsState {
  return {
    left: { tabs, active: tabs[0] ?? null },
    right: null,
    focused: 'left',
    ratio: DEFAULT_RATIO,
  }
}

/** A split, each pane given its own strip. */
function split(left: string[], right: string[]): TabsState {
  return {
    left: { tabs: left, active: left[0] ?? null },
    right: { tabs: right, active: right[0] ?? null },
    focused: 'left',
    ratio: DEFAULT_RATIO,
  }
}

describe('isDirty', () => {
  it('is false for a file nobody has typed in', () => {
    expect(isDirty(undefined)).toBe(false)
    expect(isDirty(ui())).toBe(false)
  })

  it('is false for a draft equal to its baseline', () => {
    expect(isDirty(ui({ editing: true, draft: 'a\n', baseline: 'a\n' }))).toBe(
      false,
    )
  })

  it('is true once the draft diverges', () => {
    expect(isDirty(ui({ editing: true, draft: 'a\nb', baseline: 'a\n' }))).toBe(
      true,
    )
  })

  it('sees a difference of trailing whitespace only', () => {
    expect(isDirty(ui({ editing: true, draft: 'a \n', baseline: 'a\n' }))).toBe(
      true,
    )
  })

  it('is false for a path with no draft, whatever the leftover text says', () => {
    expect(isDirty(ui({ editing: false, draft: 'typed', baseline: '' }))).toBe(
      false,
    )
  })

  it('is false again once a save moves the baseline onto the draft', () => {
    expect(isDirty(ui({ editing: true, draft: 'saved', baseline: 'saved' }))).toBe(
      false,
    )
  })

  it('treats an emptied file as dirty', () => {
    expect(isDirty(ui({ editing: true, draft: '', baseline: 'gone' }))).toBe(true)
  })
})

describe('dirtyPaths', () => {
  it('is empty for an empty map', () => {
    expect(dirtyPaths(new Map())).toEqual(new Set())
  })

  it('collects only the diverged, edited entries', () => {
    const map = new Map<string, DraftState>([
      ['a.ts', ui({ editing: true, draft: 'x', baseline: '' })],
      ['b.ts', ui({ editing: true, draft: 'same', baseline: 'same' })],
      ['c.ts', ui({ editing: false, draft: 'abandoned', baseline: '' })],
      ['d.ts', ui({ editing: true, draft: '', baseline: 'was here' })],
    ])
    expect(dirtyPaths(map)).toEqual(new Set(['a.ts', 'd.ts']))
  })
})

describe('needsCloseConfirm', () => {
  const dirty = new Set(['a.ts'])

  it('is false for a clean tab', () => {
    expect(needsCloseConfirm(single(['b.ts']), 'left', 'b.ts', dirty)).toBe(false)
  })

  it('is true for the only tab holding a dirty file', () => {
    expect(needsCloseConfirm(single(['a.ts']), 'left', 'a.ts', dirty)).toBe(true)
  })

  it('is false for a path the named pane does not hold', () => {
    expect(needsCloseConfirm(single(['b.ts']), 'left', 'a.ts', dirty)).toBe(false)
  })

  it('is false for the right pane while unsplit', () => {
    expect(needsCloseConfirm(single(['a.ts']), 'right', 'a.ts', dirty)).toBe(
      false,
    )
  })

  it('is false while the other pane still holds the same file', () => {
    const state = split(['a.ts'], ['a.ts'])
    expect(needsCloseConfirm(state, 'left', 'a.ts', dirty)).toBe(false)
    expect(needsCloseConfirm(state, 'right', 'a.ts', dirty)).toBe(false)
  })

  it('is true again in a split where only one pane holds it', () => {
    const state = split(['a.ts', 'b.ts'], ['c.ts'])
    expect(needsCloseConfirm(state, 'left', 'a.ts', dirty)).toBe(true)
  })
})

describe('tabLabel / closeLabel', () => {
  it('name the file plainly when clean', () => {
    expect(tabLabel('src/a.ts', false)).toBe('src/a.ts')
    expect(closeLabel('src/a.ts', false)).toBe('Close src/a.ts')
  })

  it('say so in words when dirty', () => {
    expect(tabLabel('src/a.ts', true)).toContain('unsaved changes')
    expect(closeLabel('src/a.ts', true)).toContain('unsaved changes')
  })

  it('keep the full path in both, since basenames collide', () => {
    expect(tabLabel('src/a.ts', true)).toContain('src/a.ts')
    expect(closeLabel('src/a.ts', true)).toContain('src/a.ts')
  })
})

describe('splitBulkClose', () => {
  it('keeps dirty tabs open behind the confirm and closes the clean ones now', () => {
    const s = single(['a.rs', 'b.ts', 'c.md'])
    expect(splitBulkClose(s, 'left', ['a.rs', 'b.ts', 'c.md'], new Set(['b.ts']))).toEqual({
      now: ['a.rs', 'c.md'],
      ask: ['b.ts'],
    })
  })

  it('a dirty path the other pane also holds closes now — nothing is discarded', () => {
    const s = split(['a.rs', 'b.ts'], ['b.ts'])
    expect(splitBulkClose(s, 'left', ['a.rs', 'b.ts'], new Set(['b.ts']))).toEqual({
      now: ['a.rs', 'b.ts'],
      ask: [],
    })
  })

  it('an edit-mode tab with no changes is clean', () => {
    const dirty = dirtyPaths(new Map([['a.rs', ui({ editing: true, draft: 'x', baseline: 'x' })]]))
    expect(splitBulkClose(single(['a.rs']), 'left', ['a.rs'], dirty)).toEqual({ now: ['a.rs'], ask: [] })
  })
})

describe('diskChange', () => {
  it('has nothing to do for a file with no draft', () => {
    expect(diskChange(undefined, 'new')).toBe('none')
    expect(diskChange(ui({ draft: 'old', baseline: 'old' }), 'new')).toBe('none')
  })

  it('has nothing to do while the disk still holds the baseline', () => {
    expect(diskChange(ui({ editing: true, draft: 'a', baseline: 'a' }), 'a')).toBe('none')
    expect(diskChange(ui({ editing: true, draft: 'typed', baseline: 'a' }), 'a')).toBe('none')
  })

  it('reloads a clean draft when the disk moves', () => {
    expect(diskChange(ui({ editing: true, draft: 'a', baseline: 'a' }), 'b')).toBe('reload')
  })

  it('never reloads over unsaved work: that is a conflict', () => {
    expect(diskChange(ui({ editing: true, draft: 'mine', baseline: 'a' }), 'theirs')).toBe(
      'conflict',
    )
  })

  it('is not a conflict when the disk now says what the draft does', () => {
    expect(diskChange(ui({ editing: true, draft: 'same', baseline: 'a' }), 'same')).toBe(
      'reload',
    )
  })

  it('stops being a conflict once "keep mine" moves the baseline onto the disk', () => {
    expect(diskChange(ui({ editing: true, draft: 'mine', baseline: 'theirs' }), 'theirs')).toBe(
      'none',
    )
  })
})
