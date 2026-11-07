import { useEffect, useMemo, useRef, useState } from 'react'
import { getLibraryItem, getProject, listLibrary, listProjects, listTasks } from '../api'
import { boardThemeVars } from '../boardTheme'
import {
  buildSrcdoc,
  covers,
  dispatch,
  grant,
  loadGrants,
  newPanelKey,
  parseManifest,
  parseRequest,
  PERMISSIONS,
} from '../panelSdk'
import { cssVar, onThemeChange } from '../theme'
import type { LibraryItem } from '../types/LibraryItem'

// A user-made panel (naru task 2613, docs/custom-panels.md). The body runs in a
// sandboxed iframe; this component owns everything outside it: loading the
// item, the permission prompt (shown before any iframe exists) and the message
// bridge that answers `naru.call` from the grant this browser holds.

const deps = { listProjects, getProject, listTasks }

type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; item: LibraryItem }

function readTheme(): Record<string, string> {
  return boardThemeVars((name) => cssVar(name, ''))
}

export function CustomPanel({ panelKey, onClose }: { panelKey: string; onClose?: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [grants, setGrants] = useState(loadGrants)
  const [themeVars, setThemeVars] = useState(readTheme)
  const frameRef = useRef<HTMLIFrameElement>(null)
  // Per-mount key the SDK sends with every request (see parseRequest).
  const [key] = useState(newPanelKey)

  useEffect(() => {
    let live = true
    const find = async (): Promise<LibraryItem | null> => {
      if (panelKey.startsWith('id:')) return getLibraryItem(Number(panelKey.slice(3)))
      const builtin = panelKey.slice('builtin:'.length)
      const all = await listLibrary()
      // The unforked built-in, else its fork, so a tab outlives a fork.
      return (
        all.find((i) => i.id === null && i.builtin_id === builtin) ??
        all.find((i) => i.builtin_id === builtin) ??
        null
      )
    }
    find().then(
      (item) => {
        if (!live) return
        setLoaded(
          item === null || item.kind !== 'panel'
            ? { state: 'error', message: 'This panel is not in the library any more.' }
            : { state: 'ready', item },
        )
      },
      (e: unknown) => {
        if (live) setLoaded({ state: 'error', message: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => {
      live = false
    }
  }, [panelKey])

  // The theme reaches the panel as `--naru-*` variables in its document; a new
  // theme rebuilds the srcdoc (the frame reloads), but only if a value changed.
  useEffect(
    () =>
      onThemeChange(() =>
        setThemeVars((prev) => {
          const next = readTheme()
          return JSON.stringify(next) === JSON.stringify(prev) ? prev : next
        }),
      ),
    [],
  )

  const item = loaded.state === 'ready' ? loaded.item : null
  const manifest = useMemo(() => (item ? parseManifest(item.body) : null), [item])
  const perms = manifest && !('error' in manifest) ? manifest.permissions : null
  const running = item !== null && perms !== null && covers(grants[panelKey] ?? [], perms)

  const srcdoc = useMemo(
    () => (running && item && perms ? buildSrcdoc(item.body, { permissions: perms, themeVars, key }) : null),
    [running, item, perms, themeVars, key],
  )

  useEffect(() => {
    if (!running) return
    const onMessage = (e: MessageEvent) => {
      // Read at message time: the frame's window changes when the dock
      // reparents it, so it is never cached.
      const win = frameRef.current?.contentWindow
      if (!win || e.source !== win) return
      const req = parseRequest(e.data, key)
      if (req === null) return
      // The grant is re-read on every request, so a revoke is immediate.
      void dispatch(req, loadGrants()[panelKey] ?? [], deps).then((reply) => {
        // A sandboxed frame has an opaque origin, which cannot be targeted.
        frameRef.current?.contentWindow?.postMessage(reply, '*')
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [running, panelKey, key])

  if (loaded.state === 'loading') return <p className="muted dock-empty-note">Loading…</p>
  if (loaded.state === 'error') return <p className="error dock-empty-note">{loaded.message}</p>
  if (manifest && 'error' in manifest) {
    return (
      <div className="custom-panel-prompt">
        <h2>{loaded.item.name}</h2>
        <p className="error">This panel cannot run: {manifest.error}</p>
        {onClose && <button onClick={onClose}>Close</button>}
      </div>
    )
  }
  if (!running || perms === null) {
    return (
      <div className="custom-panel-prompt">
        <h2>{manifest?.title ?? loaded.item.name}</h2>
        <p className="muted">This panel is custom code. It asks to:</p>
        <ul>
          {perms?.map((p) => <li key={p}>{PERMISSIONS[p]}</li>)}
        </ul>
        <div className="custom-panel-actions">
          <button
            onClick={() => {
              if (perms) setGrants(grant(panelKey, perms))
            }}
          >
            Allow and run
          </button>
          {onClose && <button onClick={onClose}>Close</button>}
        </div>
      </div>
    )
  }
  return (
    <iframe
      ref={frameRef}
      className="custom-panel-frame"
      title={manifest?.title ?? loaded.item.name}
      sandbox="allow-scripts"
      srcDoc={srcdoc ?? undefined}
    />
  )
}
