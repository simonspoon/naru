import { useState } from 'react'
import { getAmbient, updateAmbient } from '../api'
import { detectNativeHost } from '../nativeHost'
import { useFetch } from '../useFetch'
import { wakeWordsError, wakeWordsToSave } from '../wakeWords'

/**
 * Settings > Voice: the words the ambient listener wakes on (naru task 1769,
 * `docs/config.md`). "Naru" is built in; these are the extras. Saving tells the
 * Naru Mac app, when we are inside it, to refetch the list. Logic lives in
 * `wakeWords.ts`.
 */
export function WakeWordsSection() {
  const { data, error, refetch } = useFetch(() => getAmbient(), 'ambient')
  // null = untouched: show what the server has.
  const [edited, setEdited] = useState<string[] | null>(null)
  const [entry, setEntry] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const loaded = data !== null
  const words = edited ?? data?.wake_words ?? []
  const dirty = edited !== null
  const problem = wakeWordsError(words)

  function change(next: string[]) {
    setEdited(next)
    setSaved(false)
    setSaveError(null)
  }

  function add() {
    const next = wakeWordsToSave([...words, entry])
    if (next.length === wakeWordsToSave(words).length) {
      // Blank or a duplicate: nothing to add.
      setEntry('')
      return
    }
    change(next)
    setEntry('')
  }

  function save() {
    if (!loaded) return
    setSaving(true)
    setSaveError(null)
    updateAmbient(wakeWordsToSave(words)).then(
      () => {
        // Tell the Naru Mac app, when we are inside it, to refetch the list.
        detectNativeHost(window as unknown as Record<string, unknown>)?.post({ type: 'wakeWords' })
        // Keep showing the edited list until the refetch lands, so it does not flicker back.
        void refetch().finally(() => {
          setSaving(false)
          setEdited(null)
          setSaved(true)
        })
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  return (
    <>
      <h2>Wake words</h2>
      <section className="settings-command">
        <p className="muted settings-command-blurb">
          The ambient listener wakes when it hears one of these. Punctuation and hyphens count as
          spaces, a leading Hey/Hi/OK is optional, and sound-alikes are accepted for words of 4 or
          more letters.
        </p>
        {error && <p className="error">{error}</p>}
        <ul>
          <li>
            Naru <span className="muted">built in, always on</span>
          </li>
          {words.map((word) => (
            <li key={word.toLowerCase()}>
              {word}{' '}
              <button
                type="button"
                aria-label={`remove ${word}`}
                onClick={() => change(words.filter((w) => w !== word))}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
        <div className="settings-actions">
          <input
            type="text"
            value={entry}
            placeholder="add a wake word"
            aria-label="new wake word"
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
          />
          <button type="button" disabled={!loaded || entry.trim() === ''} onClick={add}>
            add
          </button>
          <button type="button" disabled={!loaded || !dirty || saving || problem !== null} onClick={save}>
            {saving ? 'saving…' : 'save'}
          </button>
          {dirty && !saving && <span className="muted">unsaved changes</span>}
          {saved && !dirty && <span className="settings-saved">saved</span>}
        </div>
        {problem && <p className="error">{problem}</p>}
        {saveError && <p className="error">{saveError}</p>}
      </section>
    </>
  )
}
