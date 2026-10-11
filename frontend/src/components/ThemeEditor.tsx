import { useEffect, useRef, useState } from 'react'
import { deleteTheme, previewTheme, updateTheme } from '../api'
import { applyTheme, normalizeHex, SLOT_ROWS, warningText } from '../theme'
import type { ContrastWarning } from '../types/ContrastWarning'
import type { Theme } from '../types/Theme'
import type { ThemeSlots } from '../types/ThemeSlots'

const PREVIEW_MS = 150
const SAVE_MS = 400

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Editor for the active custom theme (naru task 1847): nine colour rows, rename
 * and delete. Colours are never derived here — each change is sent to
 * `POST /api/themes/preview` (debounced) and the returned vars are applied live;
 * the slot is then persisted with `PATCH /api/themes/{id}` (debounced). Mount it
 * with `key={theme.id}` so its draft resets per theme.
 */
export function ThemeEditor({
  theme,
  onSaved,
  onDeleted,
}: {
  theme: Theme
  onSaved: (t: Theme) => void
  onDeleted: (t: Theme) => void
}) {
  const [slots, setSlots] = useState<ThemeSlots>(theme.slots)
  const [texts, setTexts] = useState<Partial<Record<keyof ThemeSlots, string>>>({})
  const [warnings, setWarnings] = useState<ContrastWarning[]>(theme.warnings)
  const [name, setName] = useState(theme.name)
  const [error, setError] = useState<string | null>(null)

  const slotsRef = useRef(slots)
  const pending = useRef<Partial<ThemeSlots>>({})
  const previewTimer = useRef<number | undefined>(undefined)
  const saveTimer = useRef<number | undefined>(undefined)
  const previewSeq = useRef(0)
  const themeRef = useRef(theme)
  const onSavedRef = useRef(onSaved)
  useEffect(() => {
    themeRef.current = theme
    onSavedRef.current = onSaved
  })

  function flush() {
    window.clearTimeout(saveTimer.current)
    const patch = pending.current
    if (Object.keys(patch).length === 0) return
    pending.current = {}
    updateTheme(themeRef.current.id, { slots: patch }).then(
      (t) => onSavedRef.current(t),
      (e: unknown) => setError(msg(e)),
    )
  }
  // Save what is still pending when the editor goes away.
  useEffect(
    () => () => {
      window.clearTimeout(previewTimer.current)
      flush()
    },
    [],
  )

  function setSlot(key: keyof ThemeSlots, value: string) {
    const next = { ...slotsRef.current, [key]: value }
    slotsRef.current = next
    setSlots(next)
    setError(null)
    pending.current = { ...pending.current, [key]: value }
    window.clearTimeout(previewTimer.current)
    previewTimer.current = window.setTimeout(() => {
      const seq = ++previewSeq.current
      previewTheme(slotsRef.current).then(
        (p) => {
          if (seq !== previewSeq.current) return
          setWarnings(p.warnings)
          applyTheme(themeRef.current.id, { ...themeRef.current, slots: slotsRef.current, vars: p.vars, scheme: p.scheme })
        },
        (e: unknown) => {
          if (seq === previewSeq.current) setError(msg(e))
        },
      )
    }, PREVIEW_MS)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, SAVE_MS)
  }

  function onText(key: keyof ThemeSlots, text: string) {
    setTexts((t) => ({ ...t, [key]: text }))
    const hex = normalizeHex(text)
    if (hex && hex !== slotsRef.current[key]) setSlot(key, hex)
  }

  function rename() {
    const next = name.trim()
    if (next === theme.name) return
    setError(null)
    updateTheme(theme.id, { name: next }).then(
      (t) => {
        setName(t.name)
        onSaved(t)
      },
      (e: unknown) => setError(msg(e)),
    )
  }

  function remove() {
    window.clearTimeout(previewTimer.current)
    window.clearTimeout(saveTimer.current)
    pending.current = {}
    deleteTheme(theme.id).then(
      (t) => onDeleted(t),
      (e: unknown) => setError(msg(e)),
    )
  }

  return (
    <div className="theme-editor">
      <div className="theme-editor-name">
        <input
          type="text"
          aria-label="Theme name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <button type="button" className="danger" onClick={remove}>
          Delete
        </button>
      </div>
      <div className="theme-editor-rows">
        {SLOT_ROWS.map((r) => {
          const text = texts[r.key] ?? slots[r.key]
          return (
            <div key={r.key} className="theme-editor-row">
              <span>{r.label}</span>
              <input
                type="color"
                aria-label={`${r.label} colour`}
                value={slots[r.key]}
                onChange={(e) => {
                  setTexts((t) => ({ ...t, [r.key]: e.target.value }))
                  setSlot(r.key, e.target.value)
                }}
              />
              <input
                type="text"
                aria-label={`${r.label} hex`}
                value={text}
                maxLength={7}
                spellCheck={false}
                aria-invalid={normalizeHex(text) === null}
                onChange={(e) => onText(r.key, e.target.value)}
                onBlur={() => setTexts((t) => ({ ...t, [r.key]: slots[r.key] }))}
              />
            </div>
          )
        })}
      </div>
      {warnings.length > 0 && (
        <ul className="theme-editor-warnings">
          {warnings.map((w) => (
            <li key={w.pair}>{warningText(w)}</li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
