import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { libraryBridge, type GestureBridge, type MatchEvent, type PathEvent } from '../gestureBindings'
import {
  DEFAULT_THRESHOLD,
  TAKES,
  addTry,
  allCaptured,
  combinedScore,
  averageTake,
  consistency,
  consistencyWord,
  gestureError,
  holdText,
  lookalike,
  lookalikeText,
  motionOverlaps,
  nextTake,
  overlapsWith,
  partsError,
  takeStatus,
  tryText,
  type Gesture,
  type Hand,
  type Try,
} from '../gestureLibrary'

const STEPS = ['Pose', 'Motion', 'Name and test']
const NO_CAMERA = 'Recording needs the camera in the Naru app'

/** Pose recording (naru task 1973), then motion recording (task 1974: 3 takes
 *  of drawing a path), then name it and try it. Step 2 can be skipped for a
 *  pose-only gesture. */
export function GestureRecordWizard({
  initial,
  all,
  bridge,
  onSave,
  onClose,
}: {
  initial: Gesture | null
  all: Gesture[]
  bridge: GestureBridge
  onSave: (g: Gesture) => Promise<void>
  onClose: () => void
}) {
  const lib = libraryBridge(bridge)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [takes, setTakes] = useState<(number[] | null)[]>(() => Array(TAKES).fill(null))
  const [mTakes, setMTakes] = useState<(number[] | null)[]>(() => Array(TAKES).fill(null))
  const [trail, setTrail] = useState<[number, number][]>([])
  const [shortTake, setShortTake] = useState(false)
  const [usePose, setUsePose] = useState(true)
  const [useMotion, setUseMotion] = useState(true)
  const [mLive, setMLive] = useState<MatchEvent | null>(null)
  const [progress, setProgress] = useState(0)
  const [lost, setLost] = useState(false)
  const [name, setName] = useState(initial?.name ?? '')
  const [holdS, setHoldS] = useState(initial?.holdS ?? 0.5)
  const [hand, setHand] = useState<Hand>(initial?.hand ?? 'either')
  const [threshold, setThreshold] = useState(initial?.threshold ?? DEFAULT_THRESHOLD)
  const [live, setLive] = useState<MatchEvent | null>(null)
  const [tries, setTries] = useState<Try[]>([])
  const [last, setLast] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(lib.recordTake ? null : NO_CAMERA)
  const [newId] = useState(() => `rec-${Date.now()}`)
  const title = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    title.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The next empty take records by itself while step 1 is showing.
  const want = step === 1 && lib.recordTake ? nextTake(takes) : null
  useEffect(() => {
    if (want === null || !lib.recordTake) return
    const stop = lib.recordTake((e) => {
      if (e.phase === 'holding') setProgress(e.progress)
      else if (e.phase === 'captured') {
        setTakes((t) => t.map((x, i) => (i === want ? e.sample : x)))
      } else {
        setLost(true)
        setProgress(0)
      }
    })
    return () => {
      stop()
      setProgress(0)
      setLost(false)
    }
  }, [want]) // eslint-disable-line react-hooks/exhaustive-deps

  // Likewise the next empty path take while step 2 is showing.
  const mWant = step === 2 && lib.recordPath ? nextTake(mTakes) : null
  useEffect(() => {
    if (mWant === null || !lib.recordPath) return
    const stop = lib.recordPath((e: PathEvent) => {
      if (e.phase === 'tracing') {
        setShortTake(false)
        setTrail(e.points)
      } else if (e.phase === 'captured') {
        setMTakes((t) => t.map((x, i) => (i === mWant ? e.sample : x)))
      } else setShortTake(true)
    })
    return () => {
      stop()
      setTrail([])
    }
  }, [mWant]) // eslint-disable-line react-hooks/exhaustive-deps

  const active = want
  const mSamples = mTakes.filter((t): t is number[] => !!t)
  const mAvg = allCaptured(mTakes) ? averageTake(mSamples) : null
  const samples = takes.filter((t): t is number[] => !!t)
  const avg = allCaptured(takes) ? averageTake(samples) : null
  const others = all.filter((g) => g.id !== initial?.id)

  useEffect(() => {
    if (step !== 3 || !avg || !lib.matchPose) return
    return lib.matchPose(avg, setLive)
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step !== 3 || !mAvg || !lib.matchMotion) return
    return lib.matchMotion(mAvg, setMLive)
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  const hasPose = !!avg
  const hasMotion = !!mAvg
  const pct = step === 2 ? consistency(mTakes) : consistency(takes)
  const word = consistencyWord(pct)
  const poseOverlaps = usePose ? (live?.overlaps ?? (avg ? overlapsWith(avg, others) : [])) : []
  const motionLooks = useMotion ? (mLive?.overlaps ?? (mAvg ? motionOverlaps(mAvg, others) : [])) : []
  const look = lookalike([...poseOverlaps, ...motionLooks])
  const score = combinedScore(usePose ? (live?.score ?? null) : null, useMotion ? (mLive?.score ?? null) : null)
  const draft: Gesture = {
    id: initial?.id ?? newId,
    name: name.trim(),
    pose: 'custom',
    motion: useMotion ? 'custom' : 'still',
    holdS,
    hand,
    builtin: false,
    takes: usePose ? samples : [],
    motionTakes: useMotion ? mSamples : undefined,
    threshold,
  }
  const problem = partsError(usePose, useMotion, hasPose, hasMotion) ?? gestureError(draft, all)

  function tryIt() {
    if (score === null) return
    setLast(score)
    setTries((t) => addTry(t, score, threshold))
  }

  function save() {
    setSaving(true)
    setError(null)
    onSave(draft).then(
      () => onClose(),
      (e: unknown) => {
        setSaving(false)
        setError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  function redo(i: number) {
    setTakes((t) => t.map((x, j) => (j === i ? null : x)))
  }

  function redoMotion(i: number) {
    setMTakes((t) => t.map((x, j) => (j === i ? null : x)))
    setShortTake(false)
  }

  function rerecord() {
    setTakes(Array(TAKES).fill(null))
    setMTakes(Array(TAKES).fill(null))
    setUsePose(true)
    setUseMotion(true)
    setLive(null)
    setMLive(null)
    setLast(null)
    setStep(1)
  }

  return createPortal(
    <div className="create-task-backdrop" onClick={onClose}>
      <div
        className="create-task-modal gest-dialog gest-wiz"
        role="dialog"
        aria-label="Record a gesture"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 ref={title} tabIndex={-1}>
          Record a gesture
        </h3>
        <p className="muted">
          {step === 2 ? 'Do it three times. Naru learns the variation.' : 'Hold the pose still. Each take ends by itself after a second.'}
        </p>
        <ol className="gest-steps">
          {STEPS.map((s, i) => {
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
        {step === 2 && !lib.recordPath && <p className="error">{NO_CAMERA}</p>}

        {step === 1 && (
          <>
            <div className="gest-camera gest-wiz-cam">
              <span className="gest-wiz-badge">
                {active !== null ? `● HOLD take ${active + 1} of ${TAKES}` : allCaptured(takes) ? 'All takes captured' : 'Waiting'}
              </span>
              {active !== null && (
                <div className="gest-bar" aria-hidden="true">
                  <i style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              <span className="muted" aria-live="polite">
                {lost ? 'Lost the hand, hold again' : active !== null ? `Hold… ${progress.toFixed(1)}s` : ''}
              </span>
            </div>
            <h4>Takes</h4>
            <ul className="gest-takes" aria-live="polite">
              {takes.map((_, i) => {
                const st = takeStatus(i, takes, active)
                return (
                  <li key={i}>
                    <span>Take {i + 1}</span>
                    <span className={`gest-chip ${st}`}>{st}</span>
                    <button type="button" disabled={st === 'waiting'} onClick={() => redo(i)}>
                      Redo
                    </button>
                  </li>
                )
              })}
            </ul>
            <h4>Consistency</h4>
            <div className="gest-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0} aria-label="Consistency across takes">
              <i className={word} style={{ width: `${pct ?? 0}%` }} />
            </div>
            <p className="muted">{pct === null ? 'Capture two takes to compare' : `${pct}% ${word}`}</p>
            <div className="gest-lib-foot">
              <button type="button" className="gest-primary" disabled={!allCaptured(takes)} onClick={() => setStep(2)}>
                Next
              </button>
              <button
                type="button"
                disabled={!allCaptured(takes)}
                onClick={() => {
                  setUseMotion(false)
                  setStep(3)
                }}
              >
                Skip motion
              </button>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="gest-camera gest-wiz-cam">
              <svg className="gest-trail" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                <polyline points={trail.map(([x, y]) => `${x},${y}`).join(' ')} />
              </svg>
              <span className="gest-wiz-badge" aria-live="polite">
                {mWant !== null ? `● REC take ${mWant + 1} of ${TAKES}` : allCaptured(mTakes) ? 'All takes captured' : 'Waiting'}
              </span>
              <span className="muted" aria-live="polite">
                {shortTake ? 'Didn’t catch a path, try again' : mWant !== null ? 'Draw the path, then press Stop take' : ''}
              </span>
            </div>
            <div className="gest-lib-foot">
              <button type="button" disabled={mWant === null || !lib.endPath} onClick={() => lib.endPath?.()}>
                ■ Stop take
              </button>
              <button
                type="button"
                disabled={mSamples.length === 0}
                onClick={() => redoMotion(mWant !== null ? Math.max(0, mWant - 1) : TAKES - 1)}
              >
                Redo
              </button>
            </div>
            <h4>Takes</h4>
            <ul className="gest-takes" aria-live="polite">
              {mTakes.map((_, i) => {
                const st = takeStatus(i, mTakes, mWant, 'recording')
                return (
                  <li key={i}>
                    <span>Take {i + 1}</span>
                    <span className={`gest-chip ${st}`}>{st}</span>
                    <button type="button" disabled={st === 'waiting'} onClick={() => redoMotion(i)}>
                      Redo
                    </button>
                  </li>
                )
              })}
            </ul>
            <h4>Consistency</h4>
            <div className="gest-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0} aria-label="Consistency across takes">
              <i className={word} style={{ width: `${pct ?? 0}%` }} />
            </div>
            <p className="muted">{pct === null ? 'Capture two takes to compare' : `${pct}% ${word}`}</p>
            <div className="gest-lib-foot">
              <button type="button" className="gest-primary" disabled={!allCaptured(mTakes)} onClick={() => setStep(3)}>
                Next
              </button>
              <button type="button" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h4>Try it before you save it</h4>
            <p className="gest-try" aria-live="polite">
              {last === null ? 'Do the gesture, then press Try it' : tryText(name.trim() || 'Your gesture', last, threshold)}
            </p>
            <button type="button" disabled={score === null} onClick={tryIt}>
              Try it{score !== null ? ` (${score}%)` : ''}
            </button>
            <label className="gest-field gest-slider">
              Match strictness
              <span className="muted">loose</span>
              <input
                type="range"
                min={30}
                max={100}
                value={threshold}
                aria-label="Match strictness"
                onChange={(e) => setThreshold(e.target.valueAsNumber)}
              />
              <span className="muted">strict</span>
              <output>threshold {threshold}%</output>
            </label>
            <h4>Last 5 tries</h4>
            <ul className="gest-tries">
              {tries.length === 0 && <li className="muted">No tries yet</li>}
              {tries.map((t, i) => (
                <li key={i} className={`gest-chip ${t.ok ? 'captured' : 'waiting'}`}>
                  {t.score}% {t.ok ? '✓' : '✕'}
                </li>
              ))}
            </ul>
            {look && <p className="gest-warn">⚠ {lookalikeText(look)}</p>}
            <h4>Details</h4>
            <label className="gest-field">
              Name
              <input value={name} placeholder="Figure eight" onChange={(e) => setName(e.target.value)} aria-label="Name" />
            </label>
            <div className="gest-field" role="group" aria-label="Made of">
              Made of
              <span className="gest-checks">
                <label>
                  <input type="checkbox" checked={usePose} disabled={!hasPose} onChange={(e) => setUsePose(e.target.checked)} />
                  Pose (one finger)
                </label>
                <label>
                  <input type="checkbox" checked={useMotion} disabled={!hasMotion} onChange={(e) => setUseMotion(e.target.checked)} />
                  Motion (path)
                </label>
              </span>
            </div>
            {usePose && (
              <label className="gest-field">
                Hold time (s)
                <input type="number" min={0} step={0.1} value={holdS} onChange={(e) => setHoldS(e.target.valueAsNumber)} />
                <span className="muted">{Number.isFinite(holdS) ? holdText(holdS) : ''}</span>
              </label>
            )}
            <div className="gest-field" role="group" aria-label="Hand">
              Hand
              <span className="gest-seg">
                {(['left', 'right', 'either'] as Hand[]).map((h) => (
                  <button key={h} type="button" className={hand === h ? 'active' : ''} aria-pressed={hand === h} onClick={() => setHand(h)}>
                    {h[0].toUpperCase() + h.slice(1)}
                  </button>
                ))}
              </span>
            </div>
            {problem && (name !== '' || partsError(usePose, useMotion, hasPose, hasMotion)) && <p className="gest-warn">{problem}</p>}
            <div className="gest-lib-foot">
              <button type="button" className="gest-primary" disabled={problem !== null || saving} onClick={save}>
                {saving ? 'Saving…' : 'Save to library'}
              </button>
              <button type="button" onClick={rerecord}>
                Re-record
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
