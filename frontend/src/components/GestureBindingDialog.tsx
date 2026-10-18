import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  GESTURES,
  actionText,
  conflictWarning,
  draftError,
  gestureLabel,
  newBinding,
  type GestureBinding,
  type GestureBridge,
} from '../gestureBindings'
import { ActionPicker } from './ActionPicker'

const PAGES: [string, string][] = [
  ['any', 'Anywhere'],
  ['live', 'Live'],
  ['tasks', 'Tasks'],
]

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="gest-switch" onClick={() => onChange(!on)} />
  )
}

/** Add/edit one binding. Escape closes the picker first, then the dialog. */
export function GestureBindingDialog({
  initial,
  others,
  bridge,
  onSave,
  onClose,
}: {
  initial: GestureBinding | null
  others: GestureBinding[]
  bridge: GestureBridge
  onSave: (b: GestureBinding) => Promise<void>
  onClose: () => void
}) {
  const [d, setD] = useState<GestureBinding>(() => initial ?? newBinding())
  const [picking, setPicking] = useState(false)
  const [changing, setChanging] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (p: Partial<GestureBinding>) => setD((x) => ({ ...x, ...p }))

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (picking) setPicking(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking, onClose])

  useEffect(() => {
    if (testing === null) return
    return bridge.onSeen((s) => {
      if (s && s.gesture === d.gesture) setTesting(`Seen: ${gestureLabel(s.gesture)}`)
    })
  }, [testing === null, bridge, d.gesture]) // eslint-disable-line react-hooks/exhaustive-deps

  const problem = draftError(d)
  const warning = conflictWarning(d, others)

  function save() {
    setSaving(true)
    setError(null)
    onSave(d).then(
      () => onClose(),
      (e: unknown) => {
        setSaving(false)
        setError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  return createPortal(
    <div className="create-task-backdrop" onClick={onClose}>
      <div
        className="create-task-modal gest-dialog"
        role="dialog"
        aria-label={initial ? 'Edit binding' : 'New binding'}
        onClick={(e) => e.stopPropagation()}
      >
        {picking ? (
          <ActionPicker
            action={d.action}
            behavior={d.behavior}
            onPick={(action, behavior) => set({ action, behavior })}
            onDone={() => setPicking(false)}
          />
        ) : (
          <>
            <h3>{initial ? 'Edit binding' : 'New binding'}</h3>
            <p className="gest-label">When I do this gesture</p>
            <div className="gest-field">
              <span>{gestureLabel(d.gesture)}</span>
              <span>
                <button type="button" onClick={() => setChanging((v) => !v)}>
                  Change
                </button>{' '}
                <button type="button" onClick={() => setTesting(testing === null ? 'Waiting for the gesture…' : null)}>
                  {testing === null ? 'Test' : 'Stop'}
                </button>
              </span>
            </div>
            {changing && (
              <div className="gest-chips" role="group" aria-label="gesture">
                {GESTURES.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={g.id === d.gesture ? 'active' : ''}
                    aria-pressed={g.id === d.gesture}
                    onClick={() => {
                      set({ gesture: g.id })
                      setChanging(false)
                    }}
                  >
                    {gestureLabel(g.id)}
                  </button>
                ))}
              </div>
            )}
            {testing !== null && (
              <p className="muted" aria-live="polite">
                {testing}
              </p>
            )}

            <p className="gest-label">Run this action</p>
            <div className="gest-field">
              <span>{d.action ? actionText(d) : <span className="muted">none chosen</span>}</span>
              <button type="button" onClick={() => setPicking(true)}>
                Choose
              </button>
            </div>

            <p className="gest-label">Only when</p>
            <div className="gest-box">
              <div className="gest-row">
                <span>Page</span>
                <span className="gest-chips" role="group" aria-label="page">
                  {PAGES.map(([id, label]) => (
                    <button key={id} type="button" className={d.page === id ? 'active' : ''} aria-pressed={d.page === id} onClick={() => set({ page: id })}>
                      {label}
                    </button>
                  ))}
                </span>
              </div>
              <div className="gest-row">
                <span>Mic is live</span>
                <Switch on={d.micLive} label="Mic is live" onChange={(v) => set({ micLive: v })} />
              </div>
              <div className="gest-row">
                <span>Naru app is focused</span>
                <Switch on={d.naruFocused} label="Naru app is focused" onChange={(v) => set({ naruFocused: v })} />
              </div>
            </div>

            <p className="gest-label">Safety</p>
            <div className="gest-box">
              <div className="gest-row">
                <label htmlFor="gest-cooldown">Cooldown</label>
                <span>
                  <input
                    id="gest-cooldown"
                    type="number"
                    min={0}
                    step={0.5}
                    value={Number.isNaN(d.cooldownS) ? '' : d.cooldownS}
                    onChange={(e) => set({ cooldownS: e.target.value === '' ? NaN : Number(e.target.value) })}
                  />{' '}
                  s
                </span>
              </div>
              <div className="gest-row">
                <span>Ask before firing</span>
                <Switch on={d.ask} label="Ask before firing" onChange={(v) => set({ ask: v })} />
              </div>
            </div>

            {warning && <p className="gest-warn">⚠ {warning}</p>}
            {problem && d.action !== '' && <p className="error">{problem}</p>}
            {error && <p className="error">{error}</p>}
            <div className="settings-actions">
              <button type="button" className="gest-primary" disabled={problem !== null || saving} onClick={save}>
                {saving ? 'saving…' : 'Save binding'}
              </button>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
