import { describe, expect, it } from 'vitest'
import {
  actionText,
  conflictWarning,
  draftError,
  filterActions,
  gestureBridge,
  newBinding,
  seenText,
  whenText,
  type GestureBinding,
} from './gestureBindings'

const b = (o: Partial<GestureBinding>): GestureBinding => ({ ...newBinding(), action: 'toggle-mic', ...o })

describe('filterActions', () => {
  it('searches across categories by name or sub-label', () => {
    expect(filterActions('mic', 'Navigate').map((a) => a.id)).toEqual(['toggle-mic'])
    expect(filterActions('on↔off', null).map((a) => a.id)).toEqual(['toggle-mic'])
    expect(filterActions('zzz', null)).toEqual([])
  })
  it('filters by category when the search is blank', () => {
    expect(filterActions('', 'Navigate').every((a) => a.category === 'Navigate')).toBe(true)
  })
})

describe('whenText / actionText', () => {
  it('summarises conditions', () => {
    expect(whenText(b({}))).toBe('anywhere')
    expect(whenText(b({ page: 'tasks' }))).toBe('Tasks page')
    expect(whenText(b({ page: 'live', micLive: true, naruFocused: true }))).toBe('Live page, mic live, Naru focused')
  })
  it('spells out a non-toggle behavior', () => {
    expect(actionText(b({ behavior: 'on' }))).toBe('Toggle mic (always on)')
    expect(actionText(b({ action: 'run-workflow', behavior: 'on' }))).toBe('Run workflow')
  })
})

describe('conflictWarning', () => {
  it('warns on the same gesture with overlapping pages', () => {
    const other = b({ id: 'x', action: 'pause-voice', page: 'live' })
    expect(conflictWarning(b({ page: 'any' }), [other])).toBe(
      'Palm hold is also used by Pause voice on the Live page. Conditions keep them apart.',
    )
  })
  it('stays quiet for disjoint pages or other gestures', () => {
    const other = b({ id: 'x', page: 'live' })
    expect(conflictWarning(b({ page: 'tasks' }), [other])).toBeNull()
    expect(conflictWarning(b({ gesture: 'fist-hold' }), [other])).toBeNull()
  })
})

describe('draftError', () => {
  it('needs an action and a non-negative cooldown', () => {
    expect(draftError(b({ action: '' }))).not.toBeNull()
    expect(draftError(b({ cooldownS: -1 }))).not.toBeNull()
    expect(draftError(b({ cooldownS: 0 }))).toBeNull()
  })
})

describe('seenText', () => {
  it('reads the live strip', () => {
    const bs = [b({})]
    expect(seenText(false, null, bs)).toBe('Gestures are off')
    expect(seenText(true, null, bs)).toBe('No gesture seen')
    expect(seenText(true, { gesture: 'palm-hold', heldS: 0.9, needS: 1 }, bs)).toBe(
      'Seen: palm hold, 0.9s of 1s → Toggle mic',
    )
  })
})

describe('gestureBridge', () => {
  it('is null without a complete host API', () => {
    expect(gestureBridge({})).toBeNull()
    expect(gestureBridge({ naruGestures: { load() {} } })).toBeNull()
  })
})
