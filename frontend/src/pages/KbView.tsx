import { useMemo, useState } from 'react'
import { askKb, getKbNote, listKbNotes } from '../api'
import { Markdown } from '../components/Markdown'
import { Callout, ListDetail } from '../components/templates'
import { groupKb, kbNoteHref, kbTags } from '../kbFilter'
import { useFetch } from '../useFetch'

/** `#/kb` and `#/kb/<note path>` (naru task 1928): the knowledge base's notes
 * grouped by topic, a note's markdown, text/tag filters (client-side over the
 * metadata list, bodies fetched on demand) and an ask box with linked sources. */
export function KbView({ notePath }: { notePath: string | null }) {
  const { data: notes, error } = useFetch(() => listKbNotes(), 'kb-notes')
  const [text, setText] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<Awaited<ReturnType<typeof askKb>> | null>(null)
  const [askError, setAskError] = useState<string | null>(null)

  const groups = useMemo(() => groupKb(notes ?? [], text, tag), [notes, text, tag])
  const tags = useMemo(() => kbTags(notes ?? []), [notes])
  const shown = groups.reduce((n, g) => n + g.notes.length, 0)

  const { data: note, error: noteError } = useFetch(
    () => (notePath ? getKbNote(notePath) : Promise.resolve(null)),
    `kb-note:${notePath ?? ''}`,
  )

  const detailFor =
    notePath && note && note.path === notePath ? { [notePath]: { body: note.body } } : {}
  const emptyDetail = !notePath
    ? 'Pick a note.'
    : noteError
      ? `Could not load this note: ${noteError}`
      : 'Loading…'

  async function ask() {
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setAskError(null)
    setAnswer(null)
    try {
      setAnswer(await askKb(q))
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e))
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="kb-page">
      <h1>Knowledge base</h1>
      <section className="cc-panel kb-panel">
        <h2>Ask</h2>
        <p className="cc-hint muted">Answers come from your notes only.</p>
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
        {askError && <Callout tone="bad" text={askError} />}
        {answer &&
          (answer.answer ? (
            <div className="tpl-callout tpl-tone-info kb-answer" role="status">
              <Markdown text={answer.answer} />
              {answer.sources.length > 0 && (
                <>
                  <p className="cc-hint muted kb-sources-label">Sources</p>
                  <div className="kb-sources">
                    {answer.sources.map((s) => (
                      <a key={s.path} className="kb-source" href={kbNoteHref(s.path)} title={s.path}>
                        {s.title || s.path}
                      </a>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <Callout tone="neutral" text="The notes do not answer that." />
          ))}
      </section>
      <section className="cc-panel kb-panel">
        <h2>Notes</h2>
        <div className="kb-toolbar">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter notes by title, topic or tag…"
            aria-label="Filter notes"
          />
          {notes && notes.length > 0 && (
            <span className="tpl-meta">
              {shown} of {notes.length} notes
            </span>
          )}
        </div>
        {tags.length > 0 && (
          <div className="kb-tags">
            {tags.map((t) => (
              <button
                key={t.tag}
                type="button"
                className={`kb-tag${tag === t.tag ? ' active' : ''}`}
                aria-pressed={tag === t.tag}
                onClick={() => setTag(tag === t.tag ? null : t.tag)}
              >
                {t.tag} <span className="kb-tag-count">{t.count}</span>
              </button>
            ))}
          </div>
        )}
        {error ? (
          <Callout tone="bad" text={error} />
        ) : !notes ? (
          <p className="muted">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="muted">
            No notes yet. Add one with <code>naru kb add</code>.
          </p>
        ) : (
          <ListDetail
            items={groups.flatMap((g) =>
              g.notes.map((n) => ({ id: n.path, title: n.title, group: g.topic, meta: n.tags })),
            )}
            details={detailFor}
            selectedId={notePath ?? undefined}
            emptyList="No notes match."
            emptyDetail={emptyDetail}
            onSelect={(path) => {
              window.location.hash = kbNoteHref(path)
            }}
          />
        )}
      </section>
    </div>
  )
}
