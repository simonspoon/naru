import { useEffect, useRef, useState } from 'react'
import { libraryBridge, type GestureBinding, type GestureBridge } from '../gestureBindings'
import {
  BUILTIN_GESTURES,
  HOLD_MAX_S,
  MOTIONS,
  POSES,
  canDelete,
  duplicateOf,
  gestureError,
  holdText,
  poseMotionText,
  usedBy,
  type Gesture,
  type Hand,
} from '../gestureLibrary'
import { GestureRecordWizard } from './GestureRecordWizard'

const HANDS: [Hand, string][] = [
  ['left', 'Left'],
  ['right', 'Right'],
  ['either', 'Either'],
]

/** Settings > Gestures > Library (naru task 1973): the gesture table, its
 *  editor and the pose recording wizard. Persists through the host's library
 *  calls when it has them, else keeps the list for this page only. */
export function GestureLibrary({
  bridge,
  bindings,
  newTick,
}: {
  bridge: GestureBridge
  bindings: GestureBinding[]
  newTick: number
}) {
  const lib = libraryBridge(bridge)
  const [list, setList] = useState<Gesture[] | null>(lib.loadLibrary ? null : BUILTIN_GESTURES)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [draft, setDraft] = useState<Gesture | null>(null)
  const [wizard, setWizard] = useState<{ initial: Gesture | null } | null>(null)
  const trigger = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!lib.loadLibrary) return
    let live = true
    lib.loadLibrary().then(
      (l) => live && setList(l),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      live = false
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [seenTick, setSeenTick] = useState(newTick)
  if (newTick !== seenTick) {
    setSeenTick(newTick)
    setWizard({ initial: null })
  }

  function persist(next: Gesture[]): Promise<void> {
    const done = () => setList(next)
    return lib.saveLibrary ? lib.saveLibrary(next).then(done) : Promise.resolve(done())
  }

  function run(p: Promise<void>) {
    setError(null)
    p.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  function select(g: Gesture) {
    setSel(g.id)
    setDraft(g)
  }

  const all = list ?? []
  const problem = draft ? gestureError(draft, all) : null
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(all.find((g) => g.id === draft.id))
  const set = (p: Partial<Gesture>) => setDraft((d) => (d ? { ...d, ...p } : d))

  function remove() {
    if (!draft || !canDelete(draft)) return
    run(
      persist(all.filter((g) => g.id !== draft.id)).then(() => {
        setSel(null)
        setDraft(null)
      }),
    )
  }

  function duplicate() {
    if (!draft) return
    const copy = duplicateOf(draft, all)
    run(persist([...all, copy]).then(() => select(copy)))
  }

  function saved(g: Gesture): Promise<void> {
    const next = all.some((x) => x.id === g.id) ? all.map((x) => (x.id === g.id ? g : x)) : [...all, g]
    return persist(next).then(() => select(g))
  }

  return (
    <>
      {error && <p className="error">{error}</p>}
      <div className="gest-grid">
        <section className="cc-panel">
          {list === null && !error && <p className="muted">Loading gestures…</p>}
          {list !== null && all.length === 0 && <p className="muted">No gestures yet</p>}
          {all.length > 0 && (
            <div className="cc-table-wrap">
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Pose + motion</th>
                    <th className="gest-num">Hold</th>
                    <th>Used by</th>
                    <th>Kind</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((g) => {
                    const used = usedBy(g, bindings)
                    return (
                      <tr key={g.id} className={sel === g.id ? 'gest-lib-sel' : ''}>
                        <td>
                          <button type="button" className="gest-link" aria-current={sel === g.id} onClick={() => select(g)}>
                            {g.name}
                          </button>
                        </td>
                        <td>{g.takes?.length ? 'recorded custom pose' : poseMotionText(g)}</td>
                        <td className="gest-num">{holdText(g.holdS)}</td>
                        <td className={used ? '' : 'muted'}>{used ?? 'unused'}</td>
                        <td>
                          <span className="gest-chip">{g.builtin ? 'built in' : 'recorded'}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="cc-panel gest-side">
          {!draft && <p className="muted">Select a gesture to edit it</p>}
          {draft && (
            <>
              <h3>{draft.name || 'Gesture'}</h3>
              <label className="gest-field">
                Pose
                <select value={draft.pose} disabled={draft.builtin} onChange={(e) => set({ pose: e.target.value })}>
                  {POSES.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="gest-field">
                Motion
                <select value={draft.motion} disabled={draft.builtin} onChange={(e) => set({ motion: e.target.value })}>
                  {MOTIONS.map(([id, label]) => (
                    <option key={id} value={id} disabled={id !== 'still' && id !== draft.motion}>
                      {label}
                      {id !== 'still' && id !== draft.motion ? ' (task 1974)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="gest-field">
                Hold time (s)
                <input
                  type="number"
                  min={0}
                  max={HOLD_MAX_S}
                  step={0.1}
                  value={draft.holdS}
                  disabled={draft.builtin}
                  onChange={(e) => set({ holdS: e.target.valueAsNumber })}
                />
              </label>
              <div className="gest-field" role="group" aria-label="Hand">
                Hand
                <span className="gest-seg">
                  {HANDS.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={draft.hand === id ? 'active' : ''}
                      aria-pressed={draft.hand === id}
                      disabled={draft.builtin}
                      onClick={() => set({ hand: id })}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              </div>
              {draft.builtin && <p className="muted">Built-in gestures are read-only. Duplicate one to change it.</p>}
              {problem && dirty && <p className="gest-warn">{problem}</p>}
              <button
                type="button"
                className="gest-lib-record"
                onClick={(e) => {
                  trigger.current = e.currentTarget
                  setWizard({ initial: draft.builtin ? null : draft })
                }}
              >
                ● Record a custom pose with the camera
              </button>
              <div className="gest-lib-foot">
                <button
                  type="button"
                  className="gest-primary"
                  disabled={!dirty || problem !== null || draft.builtin}
                  onClick={() => run(saved(draft))}
                >
                  Save
                </button>
                <button type="button" onClick={duplicate}>
                  Duplicate
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={!canDelete(draft)}
                  title={canDelete(draft) ? undefined : "Built-in gestures can't be deleted"}
                  onClick={remove}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      {wizard && (
        <GestureRecordWizard
          initial={wizard.initial}
          all={all}
          bridge={bridge}
          onSave={saved}
          onClose={() => {
            setWizard(null)
            trigger.current?.focus()
          }}
        />
      )}
    </>
  )
}
