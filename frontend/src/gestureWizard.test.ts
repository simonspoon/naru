import { describe, expect, it } from 'vitest'
import {
  COOLDOWN_RANGE,
  DEFAULT_SAFETY,
  HOLD_RANGE,
  STARTERS,
  calibrationRows,
  canLeaveCamera,
  checkMark,
  clampStep,
  permView,
  setupBridge,
  shouldAutoOpen,
  starterBindings,
  tryItText,
  type CalibrationSample,
  type Permissions,
} from './gestureWizard'

const granted: Permissions = { camera: 'granted', accessibility: 'notDetermined' }
const good: CalibrationSample = { handDetected: true, lighting: 'ok', distance: 'ok', fps: 30, fpsOk: true }

describe('shouldAutoOpen', () => {
  it('opens only on the first turn-on', () => {
    expect(shouldAutoOpen(false, true, false)).toBe(true)
    expect(shouldAutoOpen(false, true, true)).toBe(false)
    expect(shouldAutoOpen(true, true, false)).toBe(false)
    expect(shouldAutoOpen(true, false, false)).toBe(false)
  })
})

describe('permissions', () => {
  it('maps states to the chip and recovery', () => {
    expect(permView(null).chip).toBe('Checking…')
    expect(permView('granted').tone).toBe('ok')
    expect(permView('denied').recovery).toBe(true)
    expect(permView('notDetermined').canAsk).toBe(true)
  })
  it('holds Next until the camera is allowed', () => {
    expect(canLeaveCamera(null)).toBe(false)
    expect(canLeaveCamera({ camera: 'denied', accessibility: 'granted' })).toBe(false)
    expect(canLeaveCamera(granted)).toBe(true)
  })
})

describe('calibrationRows', () => {
  it('reads a good sample as five ticks', () => {
    const rows = calibrationRows(granted, good)
    expect(rows.map((r) => r.value)).toEqual(['granted', 'yes', 'good', 'good', '30 fps'])
    expect(rows.every((r) => r.tone === 'ok')).toBe(true)
  })
  it('warns on a dark room without blocking', () => {
    const l = calibrationRows(granted, { ...good, lighting: 'dark' })[2]
    expect(l).toMatchObject({ value: 'a bit dark', tone: 'warn' })
    expect(l.hint).toBe('Add light in front of you')
  })
  it('flags distance, no hand and low fps', () => {
    const rows = calibrationRows(granted, { handDetected: false, lighting: 'ok', distance: 'tooClose', fps: 12, fpsOk: false })
    expect(rows[1]).toMatchObject({ value: 'no', tone: 'warn' })
    expect(rows[3].value).toBe('too close')
    expect(rows[4]).toMatchObject({ value: '12 fps', tone: 'warn' })
  })
  it('shows checking before a sample and unavailable without the camera', () => {
    expect(calibrationRows(granted, null)[1].value).toBe('Checking…')
    const off = calibrationRows({ camera: 'denied', accessibility: 'denied' }, null)
    expect(off[0].tone).toBe('warn')
    expect(off.slice(1).every((r) => r.value === 'unavailable')).toBe(true)
  })
  it('marks with text', () => {
    expect(checkMark('warn')).toEqual({ mark: '⚠', word: 'Warning' })
    expect(checkMark('ok').mark).toBe('✓')
  })
})

describe('safety', () => {
  it('has the specified defaults', () => {
    expect(DEFAULT_SAFETY).toEqual({
      armBeforeFiring: true,
      holdS: 0.8,
      cooldownS: 2,
      confirmRisky: true,
      pauseOnCall: true,
      killSwitch: true,
    })
  })
  it('clamps and snaps numbers', () => {
    expect(clampStep(0.84, HOLD_RANGE)).toBe(0.8)
    expect(clampStep(99, HOLD_RANGE)).toBe(3)
    expect(clampStep(-1, COOLDOWN_RANGE)).toBe(0)
    expect(clampStep(NaN, HOLD_RANGE)).toBe(0.2)
  })
})

describe('starters', () => {
  it('builds bindings carrying the cooldown', () => {
    const bs = starterBindings(STARTERS[0], { ...DEFAULT_SAFETY, cooldownS: 3 })
    expect(bs).toHaveLength(1)
    expect(bs[0]).toMatchObject({ gesture: 'palm-hold', action: 'toggle-mic', cooldownS: 3, enabled: true })
  })
  it('swipe makes next and previous', () => {
    expect(starterBindings(STARTERS[2], DEFAULT_SAFETY).map((b) => b.action)).toEqual(['next-task', 'prev-task'])
  })
})

describe('tryItText', () => {
  const palm = STARTERS[0]
  it('prompts before a gesture is seen', () => {
    expect(tryItText(null, null)).toBe('Try it now: pick a starter first')
    expect(tryItText(palm, null)).toBe('Try it now: hold your palm up')
    expect(tryItText(palm, { gesture: 'fist-hold', heldS: 1, needS: 1 })).toBe('Try it now: hold your palm up')
  })
  it('reports the real score', () => {
    expect(tryItText(palm, { gesture: 'palm-hold', heldS: 1, needS: 1, score: 0.88 })).toBe(
      'Try it now: hold your palm up… recognized 88%. Mic toggled.',
    )
  })
  it('shows progress while holding', () => {
    expect(tryItText(palm, { gesture: 'palm-hold', heldS: 0.4, needS: 1 })).toBe('Try it now: hold your palm up… 40%')
  })
})

describe('setupBridge', () => {
  it('needs every call', () => {
    expect(setupBridge({} as never)).toBeNull()
    const fn = () => undefined
    const full = { loadSetup: fn, saveSetup: fn, permissions: fn, requestCamera: fn, requestAccessibility: fn, openSettings: fn, onPermissionsChanged: fn, calibrate: fn }
    expect(setupBridge(full as never)).not.toBeNull()
  })
})
