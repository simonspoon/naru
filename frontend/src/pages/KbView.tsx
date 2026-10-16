import { useState } from 'react'
import { askKb, getKbNote } from '../api'
import { Markdown } from '../components/Markdown'
import { Callout } from '../components/templates'
import { kbNoteHref } from '../kbFilter'
import { useFetch } from '../useFetch'

type KbAnswer = Awaited<ReturnType<typeof askKb>>

/** `#/kb` and `#/kb/<note path>` (naru tasks 1928, 1942): one Ask box over
 * `POST /api/kb/ask` showing exactly what `naru kb ask` returns (the answer and
 * its sources, plus the raw JSON), and a source's note body at `#/kb/<path>`. */
export function KbView({ notePath }: { notePath: string | null }) {
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [result, setResult] = useState<KbAnswer | null>(null)
  const [askError, setAskError] = useState<string | null>(null)

  const { data: note, error: noteError } = useFetch(
    () => (notePath ? getKbNote(notePath) : Promise.resolve(null)),
    `kb-note:${notePath ?? ''}`,
  )

  async function ask() {
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setAskError(null)
    setResult(null)
    try {
      setResult(await askKb(q))
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e))
    } finally {
      setAsking(false)
    }
  }

  if (notePath) {
    return (
      <div className="kb-page">
        <h1>Knowledge base</h1>
        <section className="cc-panel kb-panel">
          <a className="kb-back" href="#/kb">
            ← Back to ask
          </a>
          <h2>{notePath}</h2>
          {noteError ? (
            <Callout tone="bad" text={`Could not load this note: ${noteError}`} />
          ) : note && note.path === notePath ? (
            <Markdown text={note.body} />
          ) : (
            <p className="muted">Loading…</p>
          )}
        </section>
      </div>
    )
  }

  return (
    <div className="kb-page">
      <h1>Knowledge base</h1>
      <section className="cc-panel kb-panel">
        <h2>Ask</h2>
        <p className="cc-hint muted">
          The same call as <code>naru kb ask</code>: answers come from your notes only.
        </p>
        <form
          className="kb-ask"
          onSubmit={(e) => {
            e.preventDefault()
            void ask()
          }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask the knowledge base…"
            aria-label="Ask the knowledge base"
            aria-busy={asking}
          />
          <button type="submit" className="kb-ask-btn" disabled={asking || !question.trim()}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </form>
        {asking && (
          <p className="muted kb-result" role="status">
            Asking…
          </p>
        )}
        {askError && <Callout tone="bad" text={askError} />}
        {result && (
          <div className="kb-result">
            {result.answer ? (
              <div className="tpl-callout tpl-tone-info kb-answer" role="status">
                <Markdown text={result.answer} />
              </div>
            ) : (
              <Callout tone="neutral" text="The notes do not answer that." />
            )}
            {result.sources.length > 0 && (
              <>
                <p className="cc-hint muted kb-sources-label">Sources</p>
                <div className="kb-sources">
                  {result.sources.map((s) => (
                    <a key={s.path} className="kb-source" href={kbNoteHref(s.path)} title={s.path}>
                      {s.title ? `${s.title} · ${s.path}` : s.path}
                    </a>
                  ))}
                </div>
              </>
            )}
            <details className="kb-raw">
              <summary>Raw JSON</summary>
              <pre>{JSON.stringify(result, null, 2)}</pre>
            </details>
          </div>
        )}
      </section>
    </div>
  )
}
