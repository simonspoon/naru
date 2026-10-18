// Pure logic behind the Gestures first-run setup wizard (naru task 1975):
// steps, permission mapping, calibration rows, safety defaults, starter cards
// and the try-it strip. The host's setup calls are the optional
// `GestureSetupBridge` below, in the `libraryBridge` pattern.

import { detectNativeHost } from './nativeHost'
import { hostSetupBridge } from './gestureSetupHost'
import { newBinding, type GestureBinding, type GestureBridge, type GestureSeen } from './gestureBindings'

export const WIZARD_STEPS = ['Camera', 'Calibrate', 'Safety', 'First binding'] as const
export type WizardStep = 1 | 2 | 3 | 4

export type PermState = 'granted' | 'denied' | 'notDetermined'
export type Permissions = { camera: PermState; accessibility: PermState }

/** One calibration reading (the host's `calibrationSample`). */
export type CalibrationSample = {
  handDetected: boolean
  lighting: 'ok' | 'dark' | 'bright' | 'unknown'
  distance: 'ok' | 'tooClose' | 'tooFar' | 'none'
  fps: number
  fpsOk: boolean
}

export type SafetyDefaults = {
  armBeforeFiring: boolean
  holdS: number
  cooldownS: number
  confirmRisky: boolean
  pauseOnCall: boolean
  killSwitch: boolean
}

export type SetupState = { done: boolean; safety: SafetyDefaults | null }

export type GestureSetupBridge = {
  loadSetup: () => Promise<SetupState>
  saveSetup: (s: SetupState) => Promise<void>
  permissions: () => Promise<Permissions>
  requestCamera: () => Promise<Permissions>
  requestAccessibility: () => Promise<Permissions>
  openSettings: (pane: 'camera' | 'accessibility') => void
  /** Pushed whenever the app becomes active; returns the stop function. */
  onPermissionsChanged: (cb: (p: Permissions) => void) => () => void
  /** Starts the calibration stream (holds the camera); returns the stop function. */
  calibrate: (cb: (s: CalibrationSample) => void) => () => void
}

/** The setup calls: the host's own when it offers them, else built over the
 *  `naruLive` transport; none outside the Mac app, so no wizard shows. */
export function setupBridge(b: GestureBridge): GestureSetupBridge | null {
  const s = b as unknown as Partial<GestureSetupBridge>
  if (
    typeof s.loadSetup === 'function' && typeof s.saveSetup === 'function' && typeof s.permissions === 'function' &&
    typeof s.requestCamera === 'function' && typeof s.requestAccessibility === 'function' &&
    typeof s.openSettings === 'function' && typeof s.onPermissionsChanged === 'function' && typeof s.calibrate === 'function'
  ) {
    return s as GestureSetupBridge
  }
  const host = detectNativeHost(window as unknown as Record<string, unknown>)
  return host ? hostSetupBridge(host) : null
}

/** Show the wizard on the first turn-on only. */
export function shouldAutoOpen(wasOn: boolean, nowOn: boolean, done: boolean): boolean {
  return !wasOn && nowOn && !done
}

export const RECOVERY_TEXT =
  'Access is off. Open System Settings → Privacy & Security, switch Naru on, then come back.'

export type PermView = { chip: string; tone: 'ok' | 'warn' | 'wait'; recovery: boolean; canAsk: boolean }

/** How a permission reads on step 1; `null` = no reply yet. */
export function permView(state: PermState | null): PermView {
  if (state === null) return { chip: 'Checking…', tone: 'wait', recovery: false, canAsk: false }
  if (state === 'granted') return { chip: 'Allowed', tone: 'ok', recovery: false, canAsk: false }
  if (state === 'denied') return { chip: 'Not allowed', tone: 'warn', recovery: true, canAsk: false }
  return { chip: 'Not asked yet', tone: 'warn', recovery: false, canAsk: true }
}

/** Next is held until the camera is allowed; Skip for now is always open. */
export function canLeaveCamera(p: Permissions | null): boolean {
  return p?.camera === 'granted'
}

export type CheckRow = { id: string; label: string; value: string; tone: 'ok' | 'warn' | 'wait' | 'off'; hint?: string }

/** The step-2 checks list. `null` sample = nothing seen yet. */
export function calibrationRows(p: Permissions | null, s: CalibrationSample | null): CheckRow[] {
  const camera: CheckRow = {
    id: 'camera',
    label: 'Camera permission',
    value: p === null ? 'Checking…' : p.camera === 'granted' ? 'granted' : 'not granted',
    tone: p === null ? 'wait' : p.camera === 'granted' ? 'ok' : 'warn',
  }
  if (p && p.camera !== 'granted') {
    const off = (id: string, label: string): CheckRow => ({ id, label, value: 'unavailable', tone: 'off' })
    return [camera, off('hand', 'Hand detected'), off('lighting', 'Lighting'), off('distance', 'Distance'), off('fps', 'Frame rate')]
  }
  if (!s) {
    const wait = (id: string, label: string): CheckRow => ({ id, label, value: 'Checking…', tone: 'wait' })
    return [camera, wait('hand', 'Hand detected'), wait('lighting', 'Lighting'), wait('distance', 'Distance'), wait('fps', 'Frame rate')]
  }
  const lighting: CheckRow =
    s.lighting === 'ok'
      ? { id: 'lighting', label: 'Lighting', value: 'good', tone: 'ok' }
      : s.lighting === 'dark'
        ? { id: 'lighting', label: 'Lighting', value: 'a bit dark', tone: 'warn', hint: 'Add light in front of you' }
        : s.lighting === 'bright'
          ? { id: 'lighting', label: 'Lighting', value: 'too bright', tone: 'warn', hint: 'Reduce the light behind you' }
          : { id: 'lighting', label: 'Lighting', value: 'unknown', tone: 'off' }
  const distance: CheckRow =
    s.distance === 'ok'
      ? { id: 'distance', label: 'Distance', value: 'good', tone: 'ok' }
      : s.distance === 'tooClose'
        ? { id: 'distance', label: 'Distance', value: 'too close', tone: 'warn' }
        : s.distance === 'tooFar'
          ? { id: 'distance', label: 'Distance', value: 'too far', tone: 'warn' }
          : { id: 'distance', label: 'Distance', value: 'no hand', tone: 'off' }
  return [
    camera,
    { id: 'hand', label: 'Hand detected', value: s.handDetected ? 'yes' : 'no', tone: s.handDetected ? 'ok' : 'warn' },
    lighting,
    distance,
    { id: 'fps', label: 'Frame rate', value: `${Math.round(s.fps)} fps`, tone: s.fpsOk ? 'ok' : 'warn' },
  ]
}

/** The mark beside a row; text, so colour is never the only signal. */
export function checkMark(tone: CheckRow['tone']): { mark: string; word: string } {
  if (tone === 'ok') return { mark: '✓', word: 'OK' }
  if (tone === 'warn') return { mark: '⚠', word: 'Warning' }
  if (tone === 'wait') return { mark: '…', word: 'Checking' }
  return { mark: '–', word: 'Unavailable' }
}

export const DEFAULT_SAFETY: SafetyDefaults = {
  armBeforeFiring: true,
  holdS: 0.8,
  cooldownS: 2,
  confirmRisky: true,
  pauseOnCall: true,
  killSwitch: true,
}

export const HOLD_RANGE = { min: 0.2, max: 3, step: 0.1 }
export const COOLDOWN_RANGE = { min: 0, max: 10, step: 0.5 }

/** Keeps a typed number inside its range and on its step. */
export function clampStep(v: number, r: { min: number; max: number; step: number }): number {
  if (!Number.isFinite(v)) return r.min
  const c = Math.min(r.max, Math.max(r.min, v))
  return Math.round(Math.round(c / r.step) * r.step * 100) / 100
}

export const secondsText = (s: number): string => `${Math.round(s * 10) / 10} s`

export type Starter = {
  id: string
  label: string
  popular?: boolean
  /** Gestures whose recognition counts for "Try it now". */
  gestures: string[]
  /** The sentence after the percentage once it fires. */
  done: string
  hint: string
  bindings: { gesture: string; action: string }[]
}

export const STARTERS: Starter[] = [
  {
    id: 'palm-mic',
    label: 'Palm hold → Toggle mic',
    popular: true,
    gestures: ['palm-hold'],
    done: 'Mic toggled.',
    hint: 'hold your palm up',
    bindings: [{ gesture: 'palm-hold', action: 'toggle-mic' }],
  },
  {
    id: 'fist-pause',
    label: 'Fist hold → Pause voice',
    gestures: ['fist-hold'],
    done: 'Voice paused.',
    hint: 'hold your fist up',
    bindings: [{ gesture: 'fist-hold', action: 'pause-voice' }],
  },
  {
    id: 'swipe-tasks',
    label: 'Swipe → Next/previous',
    gestures: ['swipe-right', 'swipe-left'],
    done: 'Task changed.',
    hint: 'swipe across the box',
    bindings: [
      { gesture: 'swipe-right', action: 'next-task' },
      { gesture: 'swipe-left', action: 'prev-task' },
    ],
  },
]

/** Bindings for a starter, carrying the safety step's choices. */
export function starterBindings(s: Starter, safety: SafetyDefaults): GestureBinding[] {
  return s.bindings.map((x) => ({
    ...newBinding(),
    gesture: x.gesture,
    action: x.action,
    cooldownS: safety.cooldownS,
    ask: safety.confirmRisky && x.action === 'lock-screen',
  }))
}

/** The result strip. `seen` is the host's last event; the percentage is the
 *  host's score when it sends one, else how much of the hold completed. */
export function tryItText(s: Starter | null, seen: GestureSeen | null): string {
  if (!s) return 'Try it now: pick a starter first'
  if (!seen || !s.gestures.includes(seen.gesture)) return `Try it now: ${s.hint}`
  const frac = seen.score ?? (seen.needS > 0 ? seen.heldS / seen.needS : 1)
  const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100)
  const complete = seen.needS <= 0 || seen.heldS >= seen.needS
  return complete
    ? `Try it now: ${s.hint}… recognized ${pct}%. ${s.done}`
    : `Try it now: ${s.hint}… ${pct}%`
}

/** Setup state to store when the wizard ends. */
export function finishedSetup(safety: SafetyDefaults): SetupState {
  return { done: true, safety }
}
