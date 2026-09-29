import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampLiveLayoutRatio,
  DEFAULT_ARRANGEMENT,
  DEFAULT_LIVE_LAYOUT_RATIO,
  dividerToRatio,
  loadBoardHidden,
  loadChatHidden,
  loadLiveSwapped,
  paneOrder,
  saveBoardHidden,
  saveChatHidden,
  saveLiveSwapped,
  togglePane,
  visiblePanes,
  loadLiveArrangement,
  loadLiveLayout,
  loadLiveLayoutRatio,
  MAX_LIVE_LAYOUT_RATIO,
  MIN_LIVE_LAYOUT_RATIO,
  saveLiveArrangement,
  saveLiveLayoutRatio,
} from './liveLayout'

describe('clampLiveLayoutRatio', () => {
  it('passes an in-range ratio through untouched', () => {
    expect(clampLiveLayoutRatio(0.4)).toBe(0.4)
  })

  it('floors and ceilings at the divider travel limits', () => {
    expect(clampLiveLayoutRatio(0)).toBe(MIN_LIVE_LAYOUT_RATIO)
    expect(clampLiveLayoutRatio(1)).toBe(MAX_LIVE_LAYOUT_RATIO)
  })

  it('answers the even split on a non-finite ratio', () => {
    expect(clampLiveLayoutRatio(NaN)).toBe(DEFAULT_LIVE_LAYOUT_RATIO)
    expect(clampLiveLayoutRatio(Infinity)).toBe(DEFAULT_LIVE_LAYOUT_RATIO)
  })
})

describe('arrangement load/save', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to stacked with nothing stored', () => {
    expect(loadLiveArrangement()).toBe(DEFAULT_ARRANGEMENT)
    expect(DEFAULT_ARRANGEMENT).toBe('stacked')
  })

  it('round-trips a saved arrangement', () => {
    saveLiveArrangement('side')
    expect(loadLiveArrangement()).toBe('side')
    saveLiveArrangement('stacked')
    expect(loadLiveArrangement()).toBe('stacked')
  })

  it('falls back to the default on a hand-edited value', () => {
    localStorage.setItem('mesa-live-arrangement', 'diagonal')
    expect(loadLiveArrangement()).toBe('stacked')
  })
})

describe('ratio load/save', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to an even split with nothing stored', () => {
    expect(loadLiveLayoutRatio()).toBe(DEFAULT_LIVE_LAYOUT_RATIO)
  })

  it('round-trips a saved ratio', () => {
    saveLiveLayoutRatio(0.3)
    expect(loadLiveLayoutRatio()).toBe(0.3)
  })

  it('clamps a stored value that is out of range', () => {
    localStorage.setItem('mesa-live-panel-ratio', '2')
    expect(loadLiveLayoutRatio()).toBe(MAX_LIVE_LAYOUT_RATIO)
  })

  it('answers the default on a corrupt stored value', () => {
    for (const bad of ['', 'wide', 'null', '{"r":0.4}']) {
      localStorage.setItem('mesa-live-panel-ratio', bad)
      expect(loadLiveLayoutRatio()).toBe(DEFAULT_LIVE_LAYOUT_RATIO)
    }
  })
})

describe('hidden and swapped flags', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('default to showing, unswapped — nothing stored means no opinion', () => {
    expect(loadBoardHidden()).toBe(false)
    expect(loadChatHidden()).toBe(false)
    expect(loadLiveSwapped()).toBe(false)
  })

  it('round-trip independently of each other', () => {
    saveBoardHidden(true)
    expect(loadBoardHidden()).toBe(true)
    expect(loadChatHidden()).toBe(false)
    saveChatHidden(true)
    saveLiveSwapped(true)
    saveBoardHidden(false)
    expect(loadBoardHidden()).toBe(false)
    expect(loadChatHidden()).toBe(true)
    expect(loadLiveSwapped()).toBe(true)
  })

  it('writes no key at all for the false state a fresh browser starts in', () => {
    saveBoardHidden(true)
    saveBoardHidden(false)
    expect(localStorage.getItem('mesa-live-board-hidden')).toBeNull()
  })

  it('ignores the retired collapsed keys', () => {
    localStorage.setItem('mesa-live-board-collapsed', 'true')
    localStorage.setItem('mesa-live-chat-collapsed', 'true')
    expect(loadBoardHidden()).toBe(false)
    expect(loadChatHidden()).toBe(false)
  })
})

describe('loadLiveLayout', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('assembles the built-in defaults with nothing stored', () => {
    expect(loadLiveLayout()).toEqual({
      arrangement: 'stacked',
      ratio: DEFAULT_LIVE_LAYOUT_RATIO,
      boardHidden: false,
      chatHidden: false,
      swapped: false,
    })
  })

  it('assembles whatever each preference has stored', () => {
    saveLiveArrangement('side')
    saveLiveLayoutRatio(0.25)
    saveBoardHidden(true)
    saveLiveSwapped(true)
    expect(loadLiveLayout()).toEqual({
      arrangement: 'side',
      ratio: 0.25,
      boardHidden: true,
      chatHidden: false,
      swapped: true,
    })
  })
})

describe('visiblePanes', () => {
  it('shows both by default when there is a board', () => {
    expect(visiblePanes({ boardHidden: false, chatHidden: false }, true)).toEqual({
      board: true,
      chat: true,
    })
  })

  it('never shows a board with no history', () => {
    expect(visiblePanes({ boardHidden: false, chatHidden: false }, false)).toEqual({
      board: false,
      chat: true,
    })
  })

  it('keeps the chat up when nothing else is', () => {
    expect(visiblePanes({ boardHidden: false, chatHidden: true }, false).chat).toBe(true)
    expect(visiblePanes({ boardHidden: true, chatHidden: true }, true)).toEqual({
      board: false,
      chat: true,
    })
  })
})

describe('togglePane', () => {
  const both = { boardHidden: false, chatHidden: false }

  it('hides one pane and shows it again', () => {
    const hidden = togglePane(both, 'board', true)
    expect(hidden).toEqual({ boardHidden: true, chatHidden: false })
    expect(togglePane(hidden, 'board', true)).toEqual(both)
  })

  it('hiding the last visible pane shows the other instead', () => {
    expect(togglePane({ boardHidden: true, chatHidden: false }, 'chat', true)).toEqual({
      boardHidden: false,
      chatHidden: true,
    })
    expect(togglePane({ boardHidden: false, chatHidden: true }, 'board', true)).toEqual({
      boardHidden: true,
      chatHidden: false,
    })
  })

  it('changes nothing without a board history', () => {
    expect(togglePane(both, 'chat', false)).toBe(both)
    expect(togglePane(both, 'board', false)).toBe(both)
  })
})

describe('paneOrder and dividerToRatio', () => {
  it('lays the board first unless swapped', () => {
    expect(paneOrder(false)).toEqual(['board', 'chat'])
    expect(paneOrder(true)).toEqual(['chat', 'board'])
  })

  it('reads a drag as the board share whichever pane is first', () => {
    expect(dividerToRatio(0.3, false)).toBe(0.3)
    expect(dividerToRatio(0.3, true)).toBeCloseTo(0.7)
    expect(dividerToRatio(0, true)).toBe(MAX_LIVE_LAYOUT_RATIO)
  })
})
