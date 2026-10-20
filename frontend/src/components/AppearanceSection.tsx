import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  createMarkSkin,
  createTheme,
  deleteMarkSkin,
  getAppearance,
  getMarkSkin,
  listMarkSkins,
  listThemes,
  updateAppearance,
  updateMarkSkin,
} from '../api'
import { currentMarkSkin, MARK_SKIN_IDS, MARK_SKIN_LABELS, setMarkSkin, subscribeMarkSkin } from '../markSkin'
import { exportFilename, importName } from '../markSkinCustom'
import type { SkinLoadState } from '../markSkinCustom'
import type { MarkSkinSummary } from '../types/MarkSkinSummary'
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
  // Custom skins (naru task 2122): stored server-side, listed after the
  // built-ins; each preview reports whether it loaded or fell back.
  const customSkins = useFetch(() => listMarkSkins(), 'mark-skins')
  const [skinLoad, setSkinLoad] = useState<Record<string, SkinLoadState>>({})
  const [importing, setImporting] = useState(false)
  const skinFile = useRef<HTMLInputElement>(null)

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

  async function importSkin(file: File | undefined) {
    if (!file) return
    setSkinError(null)
    setImporting(true)
    try {
      await createMarkSkin({ name: importName(file.name), body: await file.text() })
      await customSkins.refetch()
    } catch (e) {
      setSkinError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  async function exportSkin(s: MarkSkinSummary) {
    setSkinError(null)
    try {
      const { body } = await getMarkSkin(s.id)
      const url = URL.createObjectURL(new Blob([body], { type: 'text/html' }))
      const a = document.createElement('a')
      a.href = url
      a.download = exportFilename(s.name)
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setSkinError(e instanceof Error ? e.message : String(e))
    }
  }

  async function deleteSkin(s: MarkSkinSummary) {
    setSkinError(null)
    try {
      await deleteMarkSkin(s.id)
      // The server cleared the saved choice if it was this skin.
      if (currentMarkSkin() === s.id) setMarkSkin('waveform')
      await customSkins.refetch()
    } catch (e) {
      setSkinError(e instanceof Error ? e.message : String(e))
    }
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
            )).concat(
              (customSkins.data ?? []).map((s) => (
                <div key={s.id} className="theme-option-wrap">
                  <label className={`theme-option${s.id === skin ? ' selected' : ''}`}>
                    <input
                      type="radio"
                      name="mark-skin"
                      value={s.id}
                      checked={s.id === skin}
                      onChange={() => pickSkin(s.id)}
                    />
                    <span className="mark-skin-preview" aria-hidden="true">
                      <NaruMark
                        state={state}
                        level={level}
                        speechRms={noRms}
                        decorative
                        brandIdle
                        skin={s.id}
                        onSkinState={(load) => setSkinLoad((m) => (m[s.id] === load ? m : { ...m, [s.id]: load }))}
                      />
                    </span>
                    <span className="settings-command-title mark-skin-name" title={s.name}>
                      {s.name}
                    </span>
                    {skinLoad[s.id] === 'fallback' && (
                      <span className="mark-skin-failed">failed to load · showing waveform</span>
                    )}
                  </label>
                  <div className="mark-skin-actions">
                    <button
                      type="button"
                      className="theme-duplicate"
                      aria-label={`Export ${s.name}`}
                      onClick={() => void exportSkin(s)}
                    >
                      Export
                    </button>
                    <button
                      type="button"
                      className="theme-duplicate danger"
                      aria-label={`Delete ${s.name}`}
                      onClick={() => void deleteSkin(s)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )),
            )
          }
        </MarkPreviews>
      </div>
      <div className="mark-skin-import">
        <button type="button" disabled={importing} onClick={() => skinFile.current?.click()}>
          {importing ? 'Importing…' : 'Import skin…'}
        </button>
        <input
          ref={skinFile}
          type="file"
          accept=".html,text/html"
          hidden
          aria-label="Mark skin file"
          onChange={(e) => {
            void importSkin(e.target.files?.[0])
            // Reset so the same file can be picked again.
            e.target.value = ''
          }}
        />
        <p className="muted mark-skin-hint">
          A single self-contained HTML file, up to 64 KiB. See <code>docs/mark-skins.md</code>.
        </p>
      </div>
      {customSkins.error && <p className="error">{customSkins.error}</p>}
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
