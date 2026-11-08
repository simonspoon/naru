import { useEffect, useRef, useState } from 'react'
import { checkWake, getAmbient, transcribeAudio, updateAmbient } from '../api'
import { downsample, encodeWav, TARGET_SAMPLE_RATE, toBase64, toPcm16 } from '../liveAudio'
import { detectNativeHost } from '../nativeHost'
import { useFetch } from '../useFetch'
import {
  makePrimary,
  toggleWake,
  wakeOn,
  wakeVerdictText,
  wakeWordsError,
  wakeWordsToSave,
} from '../wakeWords'

/** How long "Test my wake word" listens before it stops by itself. */
const TEST_RECORD_MS = 4000

/**
 * One utterance from the mic as 16 kHz mono WAV, base64. MediaRecorder rather than a worklet
 * (headless Chrome has none); the browser decodes what it recorded.
 */
async function decodeRecording(blob: Blob): Promise<string> {
  const ctx = new AudioContext()
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer())
    const mono = downsample(audio.getChannelData(0), audio.sampleRate, TARGET_SAMPLE_RATE)
    return toBase64(encodeWav(toPcm16(mono), Math.min(audio.sampleRate, TARGET_SAMPLE_RATE)))
  } finally {
    void ctx.close()
  }
}

/**
 * Settings > Voice: the words the ambient listener wakes on (naru tasks 1769,
 * 2622, `docs/config.md`) — the whole list naru-audio reads; "Naru" is just the
 * default entry. The first entry is primary, the assistant's name. Saving also
 * tells the Naru Mac app, when we are inside it, to refetch the list. Logic
 * lives in `wakeWords.ts`.
 */
export function WakeWordsSection() {
  const { data, error, refetch } = useFetch(() => getAmbient(), 'ambient')
  // null = untouched: show what the server has.
  const [edited, setEdited] = useState<string[] | null>(null)
  const [entry, setEntry] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // The list the "Wake on voice" switch took away, so switching back on restores it.
  const [remembered, setRemembered] = useState<string[]>([])
  const [test, setTest] = useState<'idle' | 'recording' | 'working'>('idle')
  const [testResult, setTestResult] = useState<{ heard: string; verdict: string } | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const stopTimer = useRef<number | undefined>(undefined)
  // Set while getUserMedia is pending, so a second click cannot open a second stream.
  const starting = useRef(false)
  const mounted = useRef(true)

  const loaded = data !== null
  const words = edited ?? data?.wake_words ?? []
  const dirty = edited !== null
  const problem = wakeWordsError(words)
  // The test checks the list on screen when it finishes, not the one when it started.
  const wordsRef = useRef(words)
  wordsRef.current = words

  function change(next: string[]) {
    setEdited(next)
    setSaved(false)
    setSaveError(null)
  }

  function setWake(on: boolean) {
    const next = toggleWake(words, remembered, on)
    setRemembered(next.remembered)
    change(next.words)
  }

  // Leaving the page mid-recording releases the mic.
  useEffect(
    () => () => {
      mounted.current = false
      window.clearTimeout(stopTimer.current)
      const r = recorder.current
      if (r && r.state !== 'inactive') {
        r.onstop = null
        r.stop()
      }
      r?.stream.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  async function finishTest(blob: Blob) {
    setTest('working')
    try {
      const { text } = await transcribeAudio(await decodeRecording(blob))
      if (text.trim() === '') {
        setTestResult({ heard: '', verdict: 'no (nothing heard)' })
      } else {
        const v = await checkWake(text, wakeWordsToSave(wordsRef.current))
        setTestResult({ heard: text, verdict: wakeVerdictText(v) })
      }
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e))
    } finally {
      setTest('idle')
    }
  }

  async function toggleTest() {
    if (test === 'recording') {
      recorder.current?.stop()
      return
    }
    if (starting.current || test !== 'idle') return
    starting.current = true
    setTestResult(null)
    setTestError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => chunks.push(e.data)
      rec.onstop = () => {
        window.clearTimeout(stopTimer.current)
        stream.getTracks().forEach((t) => t.stop())
        void finishTest(new Blob(chunks, { type: rec.mimeType }))
      }
      recorder.current = rec
      rec.start()
      setTest('recording')
      stopTimer.current = window.setTimeout(() => {
        if (rec.state !== 'inactive') rec.stop()
      }, TEST_RECORD_MS)
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e))
    } finally {
      starting.current = false
    }
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
          The ambient listener wakes when it hears one of these. The first is primary: the name the
          assistant answers to and calls itself. Naru is just the default entry; remove it to wake on
          something else. Hyphens count as spaces, a leading Hey/Hi/OK is optional,
          and sound-alikes are accepted for words of 4 or more letters.
        </p>
        {error && <p className="error">{error}</p>}
        <label>
          <input
            type="checkbox"
            checked={wakeOn(words)}
            disabled={!loaded}
            onChange={(e) => setWake(e.target.checked)}
          />{' '}
          Wake on voice
        </label>
        <ul>
          {words.map((word, i) => (
            <li key={word.toLowerCase()}>
              {word}{' '}
              {i === 0 ? (
                <span className="muted">primary, the assistant&apos;s name</span>
              ) : (
                <button type="button" aria-label={`make ${word} primary`} onClick={() => change(makePrimary(words, word))}>
                  make primary
                </button>
              )}{' '}
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
        <div className="settings-actions">
          <button type="button" disabled={!loaded || test === 'working'} onClick={() => void toggleTest()}>
            {test === 'recording' ? 'stop' : test === 'working' ? 'checking…' : 'Test my wake word'}
          </button>
          {test === 'recording' && <span className="muted">listening…</span>}
        </div>
        {testResult && (
          <p>
            {testResult.heard !== '' && <>Heard: &quot;{testResult.heard}&quot;. </>}
            Would wake: {testResult.verdict}
          </p>
        )}
        {testError && <p className="error">{testError}</p>}
        {problem && <p className="error">{problem}</p>}
        {saveError && <p className="error">{saveError}</p>}
      </section>
    </>
  )
}
