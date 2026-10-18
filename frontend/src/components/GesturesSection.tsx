import { useEffect, useRef, useState } from 'react'
import {
  actionText,
  gestureBridge,
  gestureLabel,
  seenText,
  whenText,
  type GestureBinding,
  type GestureSeen,
  type GestureState,
} from '../gestureBindings'
import { setupBridge, shouldAutoOpen, type SetupState } from '../gestureWizard'
import { GestureSetupWizard } from './GestureSetupWizard'
import { GestureBindingDialog } from './GestureBindingDialog'
import { GestureLibrary } from './GestureLibrary'

/** Settings > Gestures (naru task 1972): the Mac app's camera gestures bound
 *  to actions. Only mounted inside the app; data comes through the host's
 *  gesture bridge (`gestureBindings.ts`). */
export function GesturesSection() {
  const bridge = gestureBridge(window as unknown as Record<string, unknown>)
  const [state, setState] = useState<GestureState | null>(null)
  const [error, setError] = useState<string | null>(bridge ? null : 'Could not reach the Naru app')
  const [seen, setSeen] = useState<GestureSeen | null>(null)
  const [dialog, setDialog] = useState<{ initial: GestureBinding | null } | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const [tab, setTab] = useState<'bindings' | 'library'>('bindings')
  const [newTick, setNewTick] = useState(0)
  const setup = bridge ? setupBridge(bridge) : null
  const [setupState, setSetupState] = useState<SetupState | null>(null)
  const [wizard, setWizard] = useState(false)

  useEffect(() => {
    if (!bridge) return
    let live = true
    bridge.load().then(
      (s) => live && setState(s),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    setup?.loadSetup().then(
      (v) => live && setSetupState(v),
      () => undefined, // no stored setup: the wizard stays out of the way
    )
    const stop = bridge.onSeen((s) => live && setSeen(s))
    return () => {
      live = false
      stop()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function persist(next: GestureBinding[]): Promise<void> {
    if (!bridge || !state) return Promise.reject(new Error('Could not reach the Naru app'))
    return bridge.save(next).then(() => setState((s) => (s ? { ...s, bindings: next } : s)))
  }

  function toggle(b: GestureBinding) {
    if (!state) return
    persist(state.bindings.map((x) => (x.id === b.id ? { ...x, enabled: !x.enabled } : x))).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    )
  }

  function save(b: GestureBinding): Promise<void> {
    const list = state?.bindings ?? []
    return persist(list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? b : x)) : [...list, b])
  }

  function setOn(on: boolean) {
    if (!bridge || !state) return
    bridge.setOn(on).then(
      () => {
        if (setup && setupState && shouldAutoOpen(state.on, on, setupState.done)) setWizard(true)
        setState((s) => (s ? { ...s, on } : s))
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    )
  }

  function open(initial: GestureBinding | null, el: HTMLElement) {
    trigger.current = el
    setDialog({ initial })
  }

  const bindings = state?.bindings ?? []
  const conflictOf = (id: string) => state?.conflicts.find((c) => c.binding === id)

  return (
    <>
      <div className="gest-head">
        <h2>Gestures</h2>
        <label className="gest-master">
          Gestures on
          <button
            type="button"
            role="switch"
            aria-checked={state?.on ?? false}
            aria-label="Gestures on"
            className="gest-switch"
            disabled={!state}
            onClick={() => setOn(!state?.on)}
          />
        </label>
        {setup && setupState && (
          <button type="button" disabled={!state} onClick={() => setWizard(true)}>
            Run setup again
          </button>
        )}
        {tab === 'bindings' ? (
          <button type="button" className="gest-primary" disabled={!state} onClick={(e) => open(null, e.currentTarget)}>
            + Add binding
          </button>
        ) : (
          <button type="button" className="gest-primary" disabled={!state} onClick={() => setNewTick((n) => n + 1)}>
            + New gesture
          </button>
        )}
      </div>
      <div className="gest-tabs gest-seg" role="tablist" aria-label="Gestures view">
        {(['bindings', 'library'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'bindings' ? 'Bindings' : 'Library'}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {tab === 'library' && state && bridge && <GestureLibrary bridge={bridge} bindings={bindings} newTick={newTick} />}
      <div className="gest-grid" hidden={tab !== 'bindings'}>
        <section className="cc-panel">
          {state === null && !error && <p className="muted">Loading bindings…</p>}
          {state !== null && bindings.length === 0 && <p className="muted">No gesture bindings yet</p>}
          {bindings.length > 0 && (
            <div className={`cc-table-wrap${state?.on ? '' : ' gest-dim'}`}>
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>Gesture</th>
                    <th>Action</th>
                    <th>When</th>
                    <th>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {bindings.map((b) => {
                    const c = conflictOf(b.id)
                    return [
                      <tr key={b.id} className={b.enabled ? '' : 'muted'}>
                        <td>
                          <button type="button" className="gest-link" onClick={(e) => open(b, e.currentTarget)}>
                            {gestureLabel(b.gesture)}
                          </button>
                        </td>
                        <td>{actionText(b)}</td>
                        <td>{whenText(b)}</td>
                        <td>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={b.enabled}
                            aria-label={`${gestureLabel(b.gesture)} → ${actionText(b)}, ${b.enabled ? 'enabled' : 'disabled'}`}
                            className="gest-switch"
                            onClick={() => toggle(b)}
                          />
                        </td>
                      </tr>,
                      c && (
                        <tr key={`${b.id}-c`}>
                          <td colSpan={4} className="gest-warn">
                            ⚠ {c.message}
                          </td>
                        </tr>
                      ),
                    ]
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="cc-panel gest-side">
          <div className="gest-camera muted">Camera preview</div>
          <p className="gest-seen" aria-live="polite">
            <strong>Live test</strong> · {seenText(state?.on ?? false, seen, bindings)}
          </p>
        </section>
      </div>
      {wizard && state && setup && (
        <GestureSetupWizard
          setup={setup}
          initialSafety={setupState?.safety ?? null}
          seen={seen}
          onSaveBindings={(add) => persist([...state.bindings, ...add])}
          onClose={() => {
            setWizard(false)
            setup.loadSetup().then(setSetupState, () => undefined)
          }}
        />
      )}
      {dialog && state && bridge && (
        <GestureBindingDialog
          initial={dialog.initial}
          others={bindings}
          bridge={bridge}
          onSave={save}
          onClose={() => {
            setDialog(null)
            trigger.current?.focus()
          }}
        />
      )}
    </>
  )
}
