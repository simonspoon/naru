import { describe, expect, it } from 'vitest'
import {
  contextLabel,
  elapsedLabel,
  emptyMeterHistory,
  endsInHead,
  METER_BARS,
  METER_FRAMES_PER_BAR,
  pushMeterHistory,
} from './liveHead'
import type { LiveButton } from './liveSession'

describe('elapsedLabel', () => {
  it('zero-pads both halves', () => {
    expect(elapsedLabel(0, 0)).toBe('00:00')
    expect(elapsedLabel(0, 9_000)).toBe('00:09')
    expect(elapsedLabel(0, 61_000)).toBe('01:01')
  })

  it('rolls hours into minutes rather than growing a third field', () => {
    expect(elapsedLabel(0, 3_661_000)).toBe('61:01')
  })

  it('floors, and clamps a clock-skewed future start at zero', () => {
    expect(elapsedLabel(0, 1_999)).toBe('00:01')
    expect(elapsedLabel(10_000, 0)).toBe('00:00')
  })
})

describe('pushMeterHistory', () => {
  it('returns the same array on the frames between bars', () => {
    const history = emptyMeterHistory()
    for (let tick = 1; tick < METER_FRAMES_PER_BAR; tick += 1) {
      expect(pushMeterHistory(history, 0.5, tick)).toBe(history)
    }
  })

  it('scrolls one bar in on the right and one off the left', () => {
    let history = emptyMeterHistory()
    history = pushMeterHistory(history, 0.25, 0)
    history = pushMeterHistory(history, 0.5, METER_FRAMES_PER_BAR)
    expect(history).toHaveLength(METER_BARS)
    expect(history.slice(-2)).toEqual([0.25, 0.5])
    expect(history[0]).toBe(0)
  })

  it('keeps its length whatever it is handed, and clamps the level', () => {
    expect(pushMeterHistory([], 0.5, 0)).toHaveLength(METER_BARS)
    expect(pushMeterHistory([], 4, 0).at(-1)).toBe(1)
    expect(pushMeterHistory([], -1, 0).at(-1)).toBe(0)
  })

  it('drops the oldest once the row is full', () => {
    let history = emptyMeterHistory()
    for (let bar = 1; bar <= METER_BARS; bar += 1) {
      history = pushMeterHistory(history, bar / 100, bar * METER_FRAMES_PER_BAR)
    }
    expect(history[0]).toBe(0.01)
    history = pushMeterHistory(history, 0.99, (METER_BARS + 1) * METER_FRAMES_PER_BAR)
    expect(history[0]).toBe(0.02)
    expect(history.at(-1)).toBe(0.99)
  })
})

describe('endsInHead', () => {
  const end: LiveButton = { label: 'End', action: 'stop', disabled: false }

  it('takes a real End into the panel head', () => {
    expect(endsInHead(end)).toBe(true)
  })

  it('leaves the header its own presses, and its in-flight feedback', () => {
    expect(endsInHead(null)).toBe(false)
    expect(endsInHead({ label: 'Go live', action: 'start', disabled: false })).toBe(false)
    expect(endsInHead({ label: 'Listen', action: 'listen', disabled: false })).toBe(false)
    // `Going live…` is labelled `stop` while the spawn runs: it stays in the
    // header, which is where the person pressed and is still looking.
    expect(endsInHead({ label: 'Going live…', action: 'stop', disabled: true })).toBe(
      false,
    )
  })
})

describe('contextLabel', () => {
  it('is null when unknown, never a fake zero', () => {
    expect(contextLabel(null)).toBeNull()
    expect(contextLabel(undefined)).toBeNull()
    expect(contextLabel(-1)).toBeNull()
  })
  it('is compact', () => {
    expect(contextLabel(950)).toBe('950 ctx')
    expect(contextLabel(38_500)).toBe('38.5k ctx')
    expect(contextLabel(40_000)).toBe('40k ctx')
    expect(contextLabel(1_200_000)).toBe('1.2M ctx')
    expect(contextLabel(999_960)).toBe('1M ctx')
  })
})
