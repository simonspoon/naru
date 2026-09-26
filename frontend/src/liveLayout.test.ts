import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampLiveLayoutRatio,
  DEFAULT_ARRANGEMENT,
  DEFAULT_LIVE_LAYOUT_RATIO,
  loadBoardCollapsed,
  loadChatCollapsed,
  loadLiveArrangement,
  loadLiveLayout,
  loadLiveLayoutRatio,
  MAX_LIVE_LAYOUT_RATIO,
  MIN_LIVE_LAYOUT_RATIO,
  saveBoardCollapsed,
  saveChatCollapsed,
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

describe('collapsed flags', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('default to expanded — nothing stored means no opinion', () => {
    expect(loadBoardCollapsed()).toBe(false)
    expect(loadChatCollapsed()).toBe(false)
  })

  it('round-trip independently of each other', () => {
    saveBoardCollapsed(true)
    expect(loadBoardCollapsed()).toBe(true)
    expect(loadChatCollapsed()).toBe(false)
    saveChatCollapsed(true)
    expect(loadChatCollapsed()).toBe(true)
    saveBoardCollapsed(false)
    expect(loadBoardCollapsed()).toBe(false)
    expect(loadChatCollapsed()).toBe(true)
  })

  it('writes no key at all for the false state a fresh browser starts in', () => {
    saveBoardCollapsed(true)
    saveBoardCollapsed(false)
    expect(localStorage.getItem('mesa-live-board-collapsed')).toBeNull()
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
      boardCollapsed: false,
      chatCollapsed: false,
    })
  })

  it('assembles whatever each preference has stored', () => {
    saveLiveArrangement('side')
    saveLiveLayoutRatio(0.25)
    saveBoardCollapsed(true)
    expect(loadLiveLayout()).toEqual({
      arrangement: 'side',
      ratio: 0.25,
      boardCollapsed: true,
      chatCollapsed: false,
    })
  })
})
