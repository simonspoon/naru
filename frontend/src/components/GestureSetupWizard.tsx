import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GestureBinding, GestureSeen } from '../gestureBindings'
import {
  COOLDOWN_RANGE,
  DEFAULT_SAFETY,
  HOLD_RANGE,
  RECOVERY_TEXT,
  STARTERS,
  WIZARD_STEPS,
  calibrationRows,
  canLeaveCamera,
  checkMark,
  clampStep,
  finishedSetup,
  permView,
  secondsText,
  starterBindings,
  tryItText,
  type CalibrationSample,
  type GestureSetupBridge,
  type PermState,
  type Permissions,
  type SafetyDefaults,
  type WizardStep,
} from '../gestureWizard'

const GUIDE = 'Hold your hand inside the box, then move it close and far, left and right'
const PRIVACY = 'Camera runs only on this Mac. Nothing is saved or sent anywhere. You can pause it from the menu bar any time.'

type Toggle = 'armBeforeFiring' | 'confirmRisky' | 'pauseOnCall' | 'killSwitch'
const TOGGLES: { key: Toggle; label: string; hint?: string }[] = [
  { key: 'armBeforeFiring', label: 'Arm before firing' },
  { key: 'confirmRisky', label: 'Confirm risky actions' },
  { key: 'pauseOnCall', label: 'Pause when I am on a call' },
  { key: 'killSwitch', label: 'Kill switch gesture', hint: 'both palms up 2 s turns gestures off' },
]

/** First-run setup (naru task 1975): camera and Accessibility permission,
 *  calibration, safety defaults, a first binding. Only mounted inside the
 *  Mac app, which supplies `setup`. */
export function GestureSetupWizard({
  setup,
  initialSafety,
  seen,
  onSaveBindings,
  onClose,
}: {
  setup: GestureSetupBridge
  initialSafety: SafetyDefaults | null
  seen: GestureSeen | null
  onSaveBindings: (add: GestureBinding[]) => Promise<void>
  onClose: () => void
}) {
  const [step, setStep] = useState<WizardStep>(1)
  const [perms, setPerms] = useState<Permissions | null>(null)
  const [sample, setSample] = useState<CalibrationSample | null>(null)
  const [safety, setSafety] = useState<SafetyDefaults>(initialSafety ?? DEFAULT_SAFETY)
  const [starter, setStarter] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const picked = STARTERS.find((s) => s.id === starter) ?? null

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let live = true
    setup.permissions().then(
      (p) => live && setPerms(p),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    const stop = setup.onPermissionsChanged((p) => live && setPerms(p))
    return () => {
      live = false
      stop()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    title.current?.focus()
  }, [step])

  // The calibration stream holds the camera: it runs only while step 2 shows.
  const cameraOk = canLeaveCamera(perms)
  useEffect(() => {
    if (step !== 2 || !cameraOk) return
    const stop = setup.calibrate(setSample)
    return () => {
      stop()
      setSample(null)
    }
  }, [step, cameraOk]) // eslint-disable-line react-hooks/exhaustive-deps

  function ask(fn: () => Promise<Permissions>) {
    fn().then(setPerms, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : String(e))
    setSaving(false)
  }

  function saveSafetyAndNext() {
    setError(null)
    setup.saveSetup({ done: false, safety }).then(() => setStep(4), fail)
  }

  // Saves the chosen starter (if any), marks setup done, then `after`.
  function finish(withStarter: boolean, after: () => void) {
    setSaving(true)
    setError(null)
    const add = withStarter && picked ? starterBindings(picked, safety) : []
    ;(add.length ? onSaveBindings(add) : Promise.resolve())
      .then(() => setup.saveSetup(finishedSetup(safety)))
      .then(() => {
        setSaving(false)
        after()
      }, fail)
  }

  const setNum = (k: 'holdS' | 'cooldownS', v: string, r: typeof HOLD_RANGE) =>
    setSafety((s) => ({ ...s, [k]: clampStep(parseFloat(v), r) }))

  const rows = calibrationRows(perms, sample)

  return createPortal(
    <div className="create-task-backdrop" onClick={onClose}>
      <div className="create-task-modal gest-dialog gest-wiz" role="dialog" aria-label="Set up gestures" onClick={(e) => e.stopPropagation()}>
        <h3 ref={title} tabIndex={-1}>
          Set up gestures
        </h3>
        <p className="muted">
          {step === 3 ? 'So a wave at a friend never runs a script.' : step === 4 ? 'Pick a starter, try it, done.' : 'One minute. Then your hands can drive Naru.'}
        </p>
        <ol className="gest-steps">
          {WIZARD_STEPS.map((s, i) => {
            const n = i + 1
            const cur = n === step
            const done = n < step
            return (
              <li key={s} className={cur ? 'cur' : done ? 'done' : ''} aria-current={cur ? 'step' : undefined}>
                <span>{done ? '✓' : n}</span> {s}
              </li>
            )
          })}
        </ol>
        {error && <p className="error">{error}</p>}

        {step === 1 && (
          <>
            <PermRow setup={setup} label="Camera" state={perms?.camera ?? null} onAsk={() => ask(setup.requestCamera)} pane="camera" />
            <PermRow
              setup={setup}
              label="Accessibility (optional)"
              state={perms?.accessibility ?? null}
              onAsk={() => ask(setup.requestAccessibility)}
              pane="accessibility"
              note="Needed so a gesture can press a hotkey or run a shell command outside Naru. Skip it and only Naru's own actions work."
            />
            <div className="gest-lib-foot">
              <button type="button" className="gest-primary" disabled={!cameraOk} onClick={() => setStep(2)}>
                Next
              </button>
              <button type="button" onClick={() => setStep(2)}>
                Skip for now
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="gest-camera gest-wiz-cam muted">
              <span>{GUIDE}</span>
            </div>
            <ul className="gest-checks-list" aria-label="Checks">
              {rows.map((r) => {
                const m = checkMark(r.tone)
                return (
                  <li key={r.id} className={`gest-check gest-check-${r.tone}`}>
                    <span className="gest-check-mark" aria-hidden="true">
                      {m.mark}
                    </span>
                    <span className="gest-check-label">{r.label}</span>
                    <span className="gest-check-value">
                      <span className="sr-only">{m.word}: </span>
                      {r.value}
                    </span>
                    {r.hint && <span className="gest-check-hint">{r.hint}</span>}
                  </li>
                )
              })}
            </ul>
            <p className="muted gest-priv">{PRIVACY}</p>
            <div className="gest-lib-foot">
              <button type="button" className="gest-primary" onClick={() => setStep(3)}>
                Next
              </button>
              <button type="button" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" onClick={() => setStep(3)}>
                Skip
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            {TOGGLES.slice(0, 1).map((t) => (
              <SwitchRow key={t.key} t={t} on={safety[t.key]} flip={() => setSafety((s) => ({ ...s, [t.key]: !s[t.key] }))} />
            ))}
            <NumRow label="Default hold time" unit="Default hold time (seconds)" value={safety.holdS} range={HOLD_RANGE} onChange={(v) => setNum('holdS', v, HOLD_RANGE)} />
            <NumRow label="Cooldown after a fire" unit="Cooldown after a fire (seconds)" value={safety.cooldownS} range={COOLDOWN_RANGE} onChange={(v) => setNum('cooldownS', v, COOLDOWN_RANGE)} />
            {TOGGLES.slice(1).map((t) => (
              <SwitchRow key={t.key} t={t} on={safety[t.key]} flip={() => setSafety((s) => ({ ...s, [t.key]: !s[t.key] }))} />
            ))}
            <div className="gest-lib-foot">
              <button type="button" className="gest-primary" onClick={saveSafetyAndNext}>
                Next
              </button>
              <button type="button" onClick={() => setStep(2)}>
                Back
              </button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="gest-starters" role="radiogroup" aria-label="Starter bindings">
              {STARTERS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={starter === s.id}
                  className={`gest-starter${starter === s.id ? ' sel' : ''}`}
                  onClick={() => setStarter(s.id)}
                  onKeyDown={(e) => {
                    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
                    if (!d) return
                    e.preventDefault()
                    const i = (STARTERS.indexOf(s) + d + STARTERS.length) % STARTERS.length
                    setStarter(STARTERS[i].id)
                    ;(e.currentTarget.parentElement?.children[i] as HTMLElement | undefined)?.focus()
                  }}
                >
                  <span>{s.label}</span>
                  {s.popular && <span className="gest-chip">popular</span>}
                </button>
              ))}
            </div>
            <p className="gest-try" aria-live="polite">
              {tryItText(picked, seen)}
            </p>
            <div className="gest-lib-foot">
              <button type="button" className="gest-primary" disabled={!picked || saving} onClick={() => finish(true, onClose)}>
                {saving ? 'Saving…' : 'Finish'}
              </button>
              <button type="button" disabled={!picked || saving} onClick={() => finish(true, () => setStarter(null))}>
                Add another
              </button>
              <button type="button" disabled={saving} onClick={() => finish(false, onClose)}>
                Start empty
              </button>
              <button type="button" disabled={saving} onClick={() => setStep(3)}>
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function PermRow({
  label,
  state,
  onAsk,
  pane,
  note,
  setup,
}: {
  label: string
  state: PermState | null
  onAsk: () => void
  pane: 'camera' | 'accessibility'
  note?: string
  setup: GestureSetupBridge
}) {
  const v = permView(state)
  return (
    <>
      <div className="gest-field">
        <span>{label}</span>
        <span className="gest-row">
          <span className={`gest-chip gest-perm-${v.tone}`}>{v.chip}</span>
          {v.canAsk && (
            <button type="button" onClick={onAsk}>
              Allow
            </button>
          )}
        </span>
      </div>
      {note && <p className="muted">{note}</p>}
      {v.recovery && (
        <div className="error" role="alert">
          <p>{`${label}: ${RECOVERY_TEXT}`}</p>
          <button type="button" onClick={() => setup.openSettings(pane)}>
            Open System Settings
          </button>
        </div>
      )}
    </>
  )
}

function SwitchRow({ t, on, flip }: { t: { label: string; hint?: string }; on: boolean; flip: () => void }) {
  return (
    <div className="gest-field">
      <span>
        {t.label}
        {t.hint && <span className="muted gest-hint"> — {t.hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={on} aria-label={t.label} className="gest-switch" onClick={flip} />
    </div>
  )
}

function NumRow({
  label,
  unit,
  value,
  range,
  onChange,
}: {
  label: string
  unit: string
  value: number
  range: { min: number; max: number; step: number }
  onChange: (v: string) => void
}) {
  return (
    <div className="gest-field">
      <span>{label}</span>
      <span className="gest-row">
        <input type="number" aria-label={unit} min={range.min} max={range.max} step={range.step} value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="muted">{secondsText(value)}</span>
      </span>
    </div>
  )
}
