import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createTheme, getAppearance, listThemes, updateAppearance, updateMarkSkin } from '../api'
import { currentMarkSkin, MARK_SKIN_IDS, MARK_SKIN_LABELS, setMarkSkin, subscribeMarkSkin } from '../markSkin'
import { previewMicRms, previewState } from '../markSkinFrames'
import { applyTheme, isCustomId, parseSetting, themeSwatch } from '../theme'
import type { ThemeSetting } from '../theme'
import type { Theme } from '../types/Theme'
import { useFetch } from '../useFetch'
import { NaruMark } from './NaruMark'
import { ThemeEditor } from './ThemeEditor'

/**
 * Appearance: the web UI's colour theme (naru tasks 1784, 1847). Unlike its
 * siblings there is no draft and no save button — a pick applies at once (live
 * preview) and is saved through `PUT /api/config/appearance`; a refused save
 * puts the previous theme back and says why. A custom theme gets an editor
 * (`ThemeEditor`); built-ins are read-only and can be duplicated.
 */
export function AppearanceSection() {
  const { data, error } = useFetch(() => getAppearance(), 'appearance')
  const themes = useFetch(() => listThemes(), 'themes')
  const [picked, setPicked] = useState<ThemeSetting | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Only the newest pick may revert on failure (out-of-order rejections).
  const latest = useRef(0)
  // The mark skin (naru task 2121): the selection is the live current skin
  // itself, so a pick, a revert and a CLI change behind the page all show.
  const skin = useSyncExternalStore(subscribeMarkSkin, currentMarkSkin)
  const [skinError, setSkinError] = useState<string | null>(null)
  const latestSkin = useRef(0)

  const failure = error ?? themes.error
  if (failure) {
    return (
      <>
        <h2>Theme</h2>
        <p className="error">{failure}</p>
      </>
    )
  }
  if (!data || !themes.data) {
    return (
      <>
        <h2>Theme</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const list = themes.data
  const byId = (id: string): Theme | undefined => list.find((t) => t.id === id)
  let current = picked ?? parseSetting(data.theme)
  // A dangling custom id (deleted behind our back) reads as system.
  if (isCustomId(current) && !byId(current)) current = 'system'

  function show(setting: ThemeSetting) {
    applyTheme(setting, isCustomId(setting) ? (byId(setting) ?? null) : undefined)
  }

  function pick(next: ThemeSetting, nextTheme?: Theme) {
    if (next === current) return
    const previous = current
    const id = ++latest.current
    setPicked(next)
    setSaveError(null)
    if (nextTheme) applyTheme(next, nextTheme)
    else show(next)
    updateAppearance(next === 'system' ? null : next).catch((e: unknown) => {
      if (id !== latest.current) return
      setPicked(previous)
      show(previous)
      setSaveError(e instanceof Error ? e.message : String(e))
    })
  }

  async function duplicate(from: Theme) {
    setSaveError(null)
    try {
      const copy = await createTheme({ from: from.id })
      await themes.refetch()
      pick(parseSetting(copy.id), copy)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    }
  }

  function pickSkin(next: string) {
    if (next === skin) return
    const previous = skin
    const id = ++latestSkin.current
    setSkinError(null)
    setMarkSkin(next)
    updateMarkSkin(next).catch((e: unknown) => {
      if (id !== latestSkin.current) return
      setMarkSkin(previous)
      setSkinError(e instanceof Error ? e.message : String(e))
    })
  }

  const active = isCustomId(current) ? byId(current) : undefined
  const builtinActive = list.find((t) => t.id === current && t.builtin)

  return (
    <>
      <h2>Theme</h2>
      <p className="muted">
        Applies immediately and is remembered in <code>~/.mesa/config.json</code>.{' '}
        <em>System</em> follows the operating system's light or dark setting.
      </p>
      <div className="theme-picker" role="radiogroup" aria-label="Colour theme">
        <label className={`theme-option${current === 'system' ? ' selected' : ''}`}>
          <input
            type="radio"
            name="theme"
            value="system"
            checked={current === 'system'}
            onChange={() => pick('system')}
          />
          <span className="theme-swatch" aria-hidden="true">
            {[byId('dark'), byId('light')].map((t, i) => (
              <span key={i} style={{ background: t?.slots.bg, width: '50%' }} />
            ))}
          </span>
          <span className="settings-command-title">System</span>
        </label>
        {list.map((t) => (
          <div key={t.id} className="theme-option-wrap">
            <label className={`theme-option${t.id === current ? ' selected' : ''}`}>
              <input
                type="radio"
                name="theme"
                value={t.id}
                checked={t.id === current}
                onChange={() => pick(parseSetting(t.id), t)}
              />
              <span className="theme-swatch" aria-hidden="true">
                {themeSwatch(t).map((c, i) => (
                  <span key={i} style={{ background: c }} />
                ))}
              </span>
              <span className="settings-command-title">{t.name}</span>
            </label>
            <button type="button" className="theme-duplicate" onClick={() => void duplicate(t)}>
              Duplicate
            </button>
          </div>
        ))}
      </div>
      {saveError && <p className="error">{saveError}</p>}
      {builtinActive && <p className="muted">Built-in — duplicate to edit.</p>}
      {active && (
        <ThemeEditor
          key={active.id}
          theme={active}
          onSaved={() => void themes.refetch()}
          onDeleted={() => {
            // The server cleared the saved setting if this was the active one.
            setPicked('system')
            applyTheme('system')
            void themes.refetch()
          }}
        />
      )}
      <h2>Mark</h2>
      <p className="muted">The live mark in the nav and conversation panel. Applies immediately.</p>
      <div className="theme-picker mark-skin-picker" role="radiogroup" aria-label="Live mark">
        <MarkPreviews>
          {(state, level) =>
            MARK_SKIN_IDS.map((id) => (
              <label key={id} className={`theme-option${id === skin ? ' selected' : ''}`}>
                <input type="radio" name="mark-skin" value={id} checked={id === skin} onChange={() => pickSkin(id)} />
                <span className="mark-skin-preview" aria-hidden="true">
                  <NaruMark state={state} level={level} speechRms={noRms} decorative brandIdle skin={id} />
                </span>
                <span className="settings-command-title">{MARK_SKIN_LABELS[id]}</span>
              </label>
            ))
          }
        </MarkPreviews>
      </div>
      {skinError && <p className="error">{skinError}</p>}
    </>
  )
}

/** Speaking previews have no playback to tap: the mark simulates the voice. */
const noRms = (): number | null => null

/**
 * The previews' one shared clock: every preview cycles idle, hearing,
 * speaking, thinking and paused in step (`markSkinFrames.ts::previewState`),
 * with a made-up microphone level while hearing. Kept in its own component so
 * its ticks re-render only the previews.
 */
function MarkPreviews({
  children,
}: {
  children: (state: ReturnType<typeof previewState>, level: number) => React.ReactNode
}) {
  const [t, setT] = useState(0)
  useEffect(() => {
    const start = performance.now()
    const timer = window.setInterval(() => setT((performance.now() - start) / 1000), 120)
    return () => window.clearInterval(timer)
  }, [])
  return <>{children(previewState(t), previewMicRms(t))}</>
}
