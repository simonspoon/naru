import { useRef, useState } from 'react'
import { getAppearance, updateAppearance } from '../api'
import { applyTheme, parseSetting, THEMES } from '../theme'
import type { ThemeSetting } from '../theme'
import { useFetch } from '../useFetch'

/**
 * Appearance: the web UI's colour theme (naru task 1784). Unlike its siblings
 * there is no draft and no save button — a pick applies at once (live preview)
 * and is saved through `PUT /api/config/appearance`; a refused save puts the
 * previous theme back and says why.
 */
export function AppearanceSection() {
  const { data, error } = useFetch(() => getAppearance(), 'appearance')
  const [picked, setPicked] = useState<ThemeSetting | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Only the newest pick may revert on failure (out-of-order rejections).
  const latest = useRef(0)

  if (error) {
    return (
      <>
        <h2>Theme</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!data) {
    return (
      <>
        <h2>Theme</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const current = picked ?? parseSetting(data.theme)

  function pick(next: ThemeSetting) {
    if (next === current) return
    const previous = current
    const id = ++latest.current
    setPicked(next)
    setSaveError(null)
    applyTheme(next)
    updateAppearance(next === 'system' ? null : next).catch((e: unknown) => {
      if (id !== latest.current) return
      setPicked(previous)
      applyTheme(previous)
      setSaveError(e instanceof Error ? e.message : String(e))
    })
  }

  const options: { id: ThemeSetting; label: string; swatch: readonly string[] | null }[] = [
    { id: 'system', label: 'System', swatch: null },
    ...THEMES,
  ]

  return (
    <>
      <h2>Theme</h2>
      <p className="muted">
        Applies immediately and is remembered in <code>~/.mesa/config.json</code>.{' '}
        <em>System</em> follows the operating system's light or dark setting.
      </p>
      <div className="theme-picker" role="radiogroup" aria-label="Colour theme">
        {options.map((o) => (
          <label key={o.id} className={`theme-option${o.id === current ? ' selected' : ''}`}>
            <input
              type="radio"
              name="theme"
              value={o.id}
              checked={o.id === current}
              onChange={() => pick(o.id)}
            />
            <span className="theme-swatch" aria-hidden="true">
              {(o.swatch ?? [THEMES[0].swatch[0], THEMES[1].swatch[0]]).map((c, i) => (
                <span
                  key={i}
                  style={
                    o.swatch
                      ? { background: c }
                      : { background: c, width: '50%' }
                  }
                />
              ))}
            </span>
            <span className="settings-command-title">{o.label}</span>
          </label>
        ))}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}
