import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RATIO,
  MAX_RATIO,
  MIN_RATIO,
  activateTab,
  bulkCloseTargets,
  clampMenu,
  clampRatio,
  closeSubtree,
  closeTab,
  closeTabs,
  collapseSplit,
  cycleTab,
  dropIndex,
  emptyTabsState,
  focusPane,
  moveTab,
  openFile,
  openFileBeside,
  openPaths,
  renameSubtree,
  setRatio,
  splitPane,
  splitWithTab,
  type TabRect,
  type TabsState,
} from './fileTabs'

/** Three files open in one pane, the last one active — what three tree
 *  clicks leave behind. */
function three(): TabsState {
  return ['a.rs', 'b.ts', 'c.md'].reduce(openFile, emptyTabsState())
}

/** `three()` split, so both panes hold something. */
function split(): TabsState {
  return splitPane(three())!
}

/** Every invariant `TabsState` documents, asserted on a result rather than
 *  assumed — the transitions below all rebuild the object by hand. */
function assertWellFormed(state: TabsState) {
  if (state.right === null) expect(state.focused).toBe('left')
  for (const pane of [state.left, state.right]) {
    if (pane === null) continue
    expect(new Set(pane.tabs).size).toBe(pane.tabs.length)
    if (pane.tabs.length === 0) expect(pane.active).toBeNull()
    else expect(pane.tabs).toContain(pane.active)
  }
}

describe('openFile', () => {
  it('appends and activates, in click order', () => {
    const s = three()
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(s.left.active).toBe('c.md')
    expect(s.right).toBeNull()
    assertWellFormed(s)
  })

  it('re-opening an open file activates it without adding a tab', () => {
    const s = openFile(three(), 'a.rs')
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(s.left.active).toBe('a.rs')
    assertWellFormed(s)
  })

  it('opens into whichever pane has focus', () => {
    const s = openFile(split(), 'd.py')
    expect(s.focused).toBe('right')
    expect(s.right!.tabs).toEqual(['c.md', 'd.py'])
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    assertWellFormed(s)
  })

  it('re-focuses the other pane rather than duplicating a file it holds', () => {
    // Right pane focused, holding only c.md; a.rs lives in the left pane.
    const s = openFile(split(), 'a.rs')
    expect(s.focused).toBe('left')
    expect(s.left.active).toBe('a.rs')
    expect(s.right!.tabs).toEqual(['c.md'])
    assertWellFormed(s)
  })
})

describe('closeTab', () => {
  it('activates the right-hand neighbour', () => {
    const s = closeTab(activateTab(three(), 'left', 'b.ts'), 'left', 'b.ts')
    expect(s.left.tabs).toEqual(['a.rs', 'c.md'])
    expect(s.left.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('falls back to the left-hand neighbour for the last tab', () => {
    const s = closeTab(three(), 'left', 'c.md')
    expect(s.left.active).toBe('b.ts')
    assertWellFormed(s)
  })

  it('leaves the active tab alone when closing another one', () => {
    const s = closeTab(three(), 'left', 'a.rs')
    expect(s.left.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('closing everything in a single pane leaves the empty state', () => {
    const s = ['c.md', 'b.ts', 'a.rs'].reduce((acc, p) => closeTab(acc, 'left', p), three())
    expect(s.left.tabs).toEqual([])
    expect(s.left.active).toBeNull()
    expect(s.right).toBeNull()
    assertWellFormed(s)
  })

  it('collapses the split when a pane empties, survivor keeps its tabs', () => {
    const s = closeTab(split(), 'right', 'c.md')
    expect(s.right).toBeNull()
    expect(s.focused).toBe('left')
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    assertWellFormed(s)
  })

  it('collapses onto the right pane when the left one empties', () => {
    let s = split()
    for (const p of ['a.rs', 'b.ts', 'c.md']) s = closeTab(s, 'left', p)
    expect(s.right).toBeNull()
    expect(s.left.tabs).toEqual(['c.md'])
    expect(s.left.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('is a no-op for a path that pane does not hold', () => {
    const s = three()
    expect(closeTab(s, 'left', 'nope.rs')).toBe(s)
    expect(closeTab(s, 'right', 'a.rs')).toBe(s)
  })
})

describe('renameSubtree', () => {
  it('keeps a renamed file in place, active and open', () => {
    const s = renameSubtree(activateTab(three(), 'left', 'b.ts'), 'b.ts', 'z.ts')
    expect(s.left.tabs).toEqual(['a.rs', 'z.ts', 'c.md'])
    expect(s.left.active).toBe('z.ts')
    assertWellFormed(s)
  })

  it('rewrites every tab under a renamed directory, in both panes', () => {
    let s = ['src/a.rs', 'src/deep/b.rs', 'src2/keep.rs'].reduce(
      openFile,
      emptyTabsState(),
    )
    s = splitPane(s)! // right pane holds src2/keep.rs
    s = openFile(s, 'src/a.rs') // …and re-focuses left, where it lives
    s = renameSubtree(s, 'src', 'lib')
    expect(s.left.tabs).toEqual(['lib/a.rs', 'lib/deep/b.rs', 'src2/keep.rs'])
    expect(s.left.active).toBe('lib/a.rs')
    // A sibling whose name merely starts with the renamed one is untouched:
    // `src2` is not under `src`.
    expect(s.right!.tabs).toEqual(['src2/keep.rs'])
    assertWellFormed(s)
  })

  it('drops the duplicate when a rename lands on an already-open path', () => {
    const s = renameSubtree(three(), 'a.rs', 'c.md')
    expect(s.left.tabs).toEqual(['c.md', 'b.ts'])
    expect(s.left.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('dedupes per pane, leaving the other pane its own copy', () => {
    // Both panes hold c.md (splitPane copies it); renaming a.rs onto it must
    // collide in the left pane only.
    const s = renameSubtree(split(), 'a.rs', 'c.md')
    expect(s.left.tabs).toEqual(['c.md', 'b.ts'])
    expect(s.right!.tabs).toEqual(['c.md'])
    assertWellFormed(s)
  })

  it('is a no-op for an unopened path, or a rename to the same name', () => {
    const s = three()
    expect(renameSubtree(s, 'nope.rs', 'other.rs')).toBe(s)
    expect(renameSubtree(s, 'a.rs', 'a.rs')).toBe(s)
    expect(renameSubtree(emptyTabsState(), 'a.rs', 'b.rs').left.active).toBeNull()
  })
})

describe('closeSubtree', () => {
  it('closes one file exactly as closeTab would', () => {
    const s = closeSubtree(activateTab(three(), 'left', 'b.ts'), 'b.ts')
    expect(s.left.tabs).toEqual(['a.rs', 'c.md'])
    expect(s.left.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('closes every tab under a deleted directory and keeps the rest', () => {
    const s = closeSubtree(
      ['src/a.rs', 'src/deep/b.rs', 'src2/keep.rs'].reduce(openFile, emptyTabsState()),
      'src',
    )
    expect(s.left.tabs).toEqual(['src2/keep.rs'])
    expect(s.left.active).toBe('src2/keep.rs')
    assertWellFormed(s)
  })

  it('collapses the split when it empties a pane', () => {
    const s = closeSubtree(split(), 'c.md')
    expect(s.right).toBeNull()
    expect(s.focused).toBe('left')
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts'])
    assertWellFormed(s)
  })

  it('empties both panes of a split without stranding one', () => {
    // Every open path is under `src`, so the loop has to keep going after the
    // collapse renamed the survivor to `left`.
    let s = ['src/a.rs', 'src/b.rs'].reduce(openFile, emptyTabsState())
    s = splitPane(s)!
    s = closeSubtree(s, 'src')
    expect(s.right).toBeNull()
    expect(s.left.tabs).toEqual([])
    expect(s.left.active).toBeNull()
    assertWellFormed(s)
  })

  it('is a no-op when nothing under the target is open', () => {
    const s = three()
    expect(closeSubtree(s, 'src')).toBe(s)
    expect(closeSubtree(s, 'a')).toBe(s)
  })
})

describe('splitPane / collapseSplit', () => {
  it('copies the active tab into a new focused right pane', () => {
    const s = split()
    expect(s.right!.tabs).toEqual(['c.md'])
    expect(s.right!.active).toBe('c.md')
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(s.focused).toBe('right')
    expect(s.ratio).toBe(DEFAULT_RATIO)
    assertWellFormed(s)
  })

  it('refuses to split twice, or with nothing open', () => {
    expect(splitPane(split())).toBeNull()
    expect(splitPane(emptyTabsState())).toBeNull()
  })

  it('collapses onto the focused pane', () => {
    expect(collapseSplit(split()).left.tabs).toEqual(['c.md'])
    expect(collapseSplit(focusPane(split(), 'left')).left.tabs).toEqual([
      'a.rs',
      'b.ts',
      'c.md',
    ])
    assertWellFormed(collapseSplit(split()))
  })

  it('is a no-op with no split to collapse', () => {
    const s = three()
    expect(collapseSplit(s)).toBe(s)
  })
})

describe('splitWithTab', () => {
  it('moves the dragged tab into a new right pane', () => {
    const s = splitWithTab(three(), { side: 'left', path: 'a.rs' })!
    expect(s.left.tabs).toEqual(['b.ts', 'c.md'])
    expect(s.right!.tabs).toEqual(['a.rs'])
    expect(s.focused).toBe('right')
    assertWellFormed(s)
  })

  it('refuses when it would empty the source pane, or when already split', () => {
    const one = openFile(emptyTabsState(), 'a.rs')
    expect(splitWithTab(one, { side: 'left', path: 'a.rs' })).toBeNull()
    expect(splitWithTab(split(), { side: 'left', path: 'a.rs' })).toBeNull()
  })
})

describe('dropIndex', () => {
  const rects: TabRect[] = [
    { left: 0, right: 100 },
    { left: 100, right: 200 },
    { left: 200, right: 300 },
  ]

  it('is the midpoint scheme', () => {
    expect(dropIndex(rects, 10)).toBe(0)
    expect(dropIndex(rects, 49)).toBe(0)
    expect(dropIndex(rects, 51)).toBe(1)
    expect(dropIndex(rects, 149)).toBe(1)
    expect(dropIndex(rects, 151)).toBe(2)
    expect(dropIndex(rects, 290)).toBe(3)
  })

  it('clamps outside the strip without a special case', () => {
    expect(dropIndex(rects, -500)).toBe(0)
    expect(dropIndex(rects, 5000)).toBe(3)
    expect(dropIndex([], 42)).toBe(0)
  })
})

describe('moveTab', () => {
  it('reorders within a strip', () => {
    const s = moveTab(three(), { side: 'left', path: 'c.md' }, 'left', 0)!
    expect(s.left.tabs).toEqual(['c.md', 'a.rs', 'b.ts'])
    expect(s.left.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('accounts for the dragged tab leaving its own slot on a rightward move', () => {
    const s = moveTab(three(), { side: 'left', path: 'a.rs' }, 'left', 3)!
    expect(s.left.tabs).toEqual(['b.ts', 'c.md', 'a.rs'])
    assertWellFormed(s)
  })

  it('writes nothing for a drop on itself or back at its own index', () => {
    const s = three()
    expect(moveTab(s, { side: 'left', path: 'b.ts' }, 'left', 1)).toBeNull()
    expect(moveTab(s, { side: 'left', path: 'b.ts' }, 'left', 2)).toBeNull()
    expect(moveTab(s, { side: 'left', path: 'a.rs' }, 'left', 0)).toBeNull()
    expect(moveTab(s, { side: 'left', path: 'c.md' }, 'left', 3)).toBeNull()
  })

  it('writes nothing for an unknown tab or a pane that is not there', () => {
    const s = three()
    expect(moveTab(s, { side: 'left', path: 'nope.rs' }, 'left', 0)).toBeNull()
    expect(moveTab(s, { side: 'left', path: 'a.rs' }, 'right', 0)).toBeNull()
  })

  it('moves across panes at the drop index and activates it there', () => {
    const s = moveTab(split(), { side: 'left', path: 'a.rs' }, 'right', 1)!
    expect(s.left.tabs).toEqual(['b.ts', 'c.md'])
    expect(s.right!.tabs).toEqual(['c.md', 'a.rs'])
    expect(s.right!.active).toBe('a.rs')
    expect(s.focused).toBe('right')
    assertWellFormed(s)
  })

  it('never mints a third copy when the destination already holds the path', () => {
    // Left and right both hold c.md after a split; dragging the left copy
    // across just closes it, since the right pane is already showing it.
    expect(moveTab(split(), { side: 'left', path: 'c.md' }, 'right', 0)).toBeNull()
    const s = moveTab(
      moveTab(split(), { side: 'left', path: 'a.rs' }, 'right', 0)!,
      { side: 'left', path: 'c.md' },
      'right',
      0,
    )!
    expect(s.left.tabs).toEqual(['b.ts'])
    expect(s.right!.tabs).toEqual(['a.rs', 'c.md'])
    expect(s.right!.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('collapses the split when the cross-pane move empties the source', () => {
    const s = moveTab(
      splitWithTab(three(), { side: 'left', path: 'a.rs' })!,
      { side: 'right', path: 'a.rs' },
      'left',
      0,
    )!
    expect(s.right).toBeNull()
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(s.left.active).toBe('a.rs')
    assertWellFormed(s)
  })
})

describe('ratio', () => {
  it('clamps to a pane neither side can zero out', () => {
    expect(clampRatio(0)).toBe(MIN_RATIO)
    expect(clampRatio(1)).toBe(MAX_RATIO)
    expect(clampRatio(0.4)).toBe(0.4)
    expect(clampRatio(Number.NaN)).toBe(DEFAULT_RATIO)
  })

  it('only applies while split', () => {
    const s = three()
    expect(setRatio(s, 0.3)).toBe(s)
    expect(setRatio(split(), 0.3).ratio).toBe(0.3)
  })
})

describe('openPaths', () => {
  it('deduplicates the path a split has in both panes', () => {
    expect(openPaths(split()).sort()).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(openPaths(emptyTabsState())).toEqual([])
  })
})

describe('focusPane', () => {
  it('cannot focus a pane that does not exist', () => {
    const s = three()
    expect(focusPane(s, 'right')).toBe(s)
    expect(focusPane(split(), 'left').focused).toBe('left')
  })
})

describe('cycleTab', () => {
  it('steps forward and back through the strip', () => {
    const s = three() // 'c.md' active, last of three
    expect(cycleTab(s, 'left', false)!.left.active).toBe('b.ts')
    expect(cycleTab(s, 'left', true)!.left.active).toBe('a.rs')
  })

  it('wraps at both ends rather than stopping', () => {
    const first = activateTab(three(), 'left', 'a.rs')
    expect(cycleTab(first, 'left', false)!.left.active).toBe('c.md')
    expect(cycleTab(first, 'left', true)!.left.active).toBe('b.ts')
  })

  it('steps the named pane only, and focuses it', () => {
    const s: TabsState = {
      left: { tabs: ['a.rs', 'b.ts'], active: 'a.rs' },
      right: { tabs: ['c.md', 'd.go'], active: 'c.md' },
      focused: 'left',
      ratio: DEFAULT_RATIO,
    }
    const next = cycleTab(s, 'right', true)!
    expect(next.right!.active).toBe('d.go')
    expect(next.left.active).toBe('a.rs')
    expect(next.focused).toBe('right')
  })

  it('is a no-op with nothing to step to', () => {
    expect(cycleTab(emptyTabsState(), 'left', true)).toBeNull()
    expect(cycleTab(three(), 'right', true)).toBeNull() // unsplit
    // A one-tab pane would wrap onto the tab already showing.
    expect(cycleTab(split(), 'right', true)).toBeNull()
  })

  it('leaves a well-formed state', () => {
    const s = cycleTab(three(), 'left', true)!
    assertWellFormed(s)
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
  })
})

describe('bulkCloseTargets', () => {
  const none = new Set<string>()
  it('names each action\'s tabs in strip order, in that pane only', () => {
    const s = three()
    expect(bulkCloseTargets(s, 'left', 'b.ts', 'others', none)).toEqual(['a.rs', 'c.md'])
    expect(bulkCloseTargets(s, 'left', 'a.rs', 'right', none)).toEqual(['b.ts', 'c.md'])
    expect(bulkCloseTargets(s, 'left', 'b.ts', 'all', none)).toEqual(['a.rs', 'b.ts', 'c.md'])
    // split(): right pane holds only c.md.
    expect(bulkCloseTargets(split(), 'right', 'c.md', 'all', none)).toEqual(['c.md'])
  })

  it('"saved" skips dirty tabs', () => {
    expect(bulkCloseTargets(three(), 'left', 'a.rs', 'saved', new Set(['b.ts']))).toEqual([
      'a.rs',
      'c.md',
    ])
  })

  it('is empty — a disabled item — when the action would do nothing', () => {
    const s = three()
    expect(bulkCloseTargets(s, 'left', 'c.md', 'right', none)).toEqual([])
    expect(bulkCloseTargets(split(), 'right', 'c.md', 'others', none)).toEqual([])
    expect(bulkCloseTargets(s, 'left', 'a.rs', 'saved', new Set(['a.rs', 'b.ts', 'c.md']))).toEqual([])
    expect(bulkCloseTargets(s, 'right', 'a.rs', 'all', none)).toEqual([]) // unsplit
    expect(bulkCloseTargets(s, 'left', 'nope', 'all', none)).toEqual([])
  })
})

describe('closeTabs', () => {
  it('closes the set and activates by closeTab\'s rule', () => {
    const s = activateTab(three(), 'left', 'a.rs')
    // a.rs active and closed with b.ts: its right neighbour that survives is c.md.
    const next = closeTabs(s, 'left', ['a.rs', 'b.ts'])
    expect(next.left).toEqual({ tabs: ['c.md'], active: 'c.md' })
    assertWellFormed(next)
    // Closing to the right of the active tab leaves it active.
    const right = closeTabs(s, 'left', ['b.ts', 'c.md'])
    expect(right.left).toEqual({ tabs: ['a.rs'], active: 'a.rs' })
  })

  it('closing all of the only pane leaves the empty state', () => {
    const next = closeTabs(three(), 'left', ['a.rs', 'b.ts', 'c.md'])
    expect(next).toEqual({ ...emptyTabsState(), ratio: DEFAULT_RATIO })
  })

  it('emptying the right pane collapses the split', () => {
    const next = closeTabs(split(), 'right', ['c.md'])
    expect(next.right).toBeNull()
    expect(next.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(next.focused).toBe('left')
  })

  it('emptying the left pane collapses onto the right, and never reaches into it', () => {
    const s: TabsState = {
      left: { tabs: ['a.rs', 'b.ts'], active: 'a.rs' },
      right: { tabs: ['b.ts', 'c.md'], active: 'b.ts' },
      focused: 'left',
      ratio: DEFAULT_RATIO,
    }
    // A stray extra path after the collapse must not close the survivor's copy.
    const next = closeTabs(s, 'left', ['a.rs', 'b.ts', 'c.md'])
    expect(next.right).toBeNull()
    expect(next.left).toEqual({ tabs: ['b.ts', 'c.md'], active: 'b.ts' })
    assertWellFormed(next)
  })

  it('a path open in both panes closes only in the named one', () => {
    const next = closeTabs(split(), 'left', ['c.md'])
    expect(next.left.tabs).toEqual(['a.rs', 'b.ts'])
    expect(next.right!.tabs).toEqual(['c.md'])
    expect(openPaths(next)).toContain('c.md')
  })
})

describe('clampMenu', () => {
  it('leaves a menu that fits where it was opened', () => {
    expect(clampMenu(100, 50, 180, 150, 1280, 800)).toEqual({ x: 100, y: 50 })
  })

  it('pulls a menu back inside the right and bottom edges, and at phone width', () => {
    expect(clampMenu(1250, 780, 180, 150, 1280, 800)).toEqual({ x: 1096, y: 646 })
    expect(clampMenu(300, 10, 180, 150, 375, 667)).toEqual({ x: 191, y: 10 })
    // Wider than the viewport: pinned to the left margin rather than off-screen.
    expect(clampMenu(10, 10, 400, 150, 375, 667).x).toBe(4)
  })
})

describe('openFileBeside', () => {
  it('opens a split with just that file when there is room', () => {
    const s = openFileBeside(three(), 'd.py', true)
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(s.right).toEqual({ tabs: ['d.py'], active: 'd.py' })
    expect(s.focused).toBe('right')
    assertWellFormed(s)
  })

  it('falls back to an ordinary open when it cannot split, or nothing is open', () => {
    expect(openFileBeside(three(), 'd.py', false)).toEqual(openFile(three(), 'd.py'))
    const empty = openFileBeside(emptyTabsState(), 'd.py', true)
    expect(empty.right).toBeNull()
    expect(empty.left.tabs).toEqual(['d.py'])
  })

  it('opens into the unfocused pane of a split, and focuses it', () => {
    // split(): right pane focused, holding c.md.
    const s = openFileBeside(split(), 'd.py', true)
    expect(s.focused).toBe('left')
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md', 'd.py'])
    expect(s.left.active).toBe('d.py')
    expect(s.right!.tabs).toEqual(['c.md'])
    assertWellFormed(s)
  })
})
