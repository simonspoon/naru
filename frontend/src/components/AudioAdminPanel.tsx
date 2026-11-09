import { useCallback, useEffect, useRef, useState } from 'react'
import { testAudio } from '../api'
import { audioAdminView, type AudioAdminView } from '../audioAdmin'

// The Audio dock panel (naru task 2676, docs/dock.md): naru-audio's own admin
// page in an iframe — voice clones, samples and models live there, never in
// Naru. Nothing loads until the panel is first shown; after that the frame
// stays, so a tab switch does not reload it.
export function AudioAdminPanel({ active }: { active: boolean }) {
  const [view, setView] = useState<AudioAdminView | { kind: 'loading' } | null>(null)

  const started = useRef(false)

  const probe = useCallback(() => {
    testAudio(null).then(
      (result) => setView(audioAdminView(result, window.location.hostname)),
      (e: unknown) => setView({ kind: 'down', message: e instanceof Error ? e.message : String(e) }),
    )
  }, [])

  useEffect(() => {
    if (!active || started.current) return
    started.current = true
    probe()
  }, [active, probe])

  const retry = () => {
    setView({ kind: 'loading' })
    probe()
  }

  if (view === null || view.kind === 'loading') return <p className="muted dock-empty-note">Loading…</p>
  if (view.kind === 'down') {
    return (
      <div className="custom-panel-prompt">
        <h2>naru-audio is not available</h2>
        <p className="muted">{view.message}</p>
        <div className="custom-panel-actions">
          <button type="button" onClick={retry}>
            Retry
          </button>
        </div>
      </div>
    )
  }
  return <iframe className="audio-admin-frame" title="naru-audio admin" src={view.src} />
}
