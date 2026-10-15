import { useMemo, useState } from 'react'
import { askKb, getKbNote, listKbNotes } from '../api'
import { Markdown } from '../components/Markdown'
import { ListDetail } from '../components/templates'
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
      ? noteError
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
        />
        <button type="submit" disabled={asking || !question.trim()}>
          {asking ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {askError && <p className="error">{askError}</p>}
      {answer && (
        <div className="kb-answer">
          {answer.answer ? (
            <>
              <Markdown text={answer.answer} />
              <ul>
                {answer.sources.map((s) => (
                  <li key={s.path}>
                    <a href={kbNoteHref(s.path)}>{s.title || s.path}</a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">The notes do not answer that.</p>
          )}
        </div>
      )}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Filter notes by title, topic or tag…"
        aria-label="Filter notes"
      />
      {tags.length > 0 && (
        <div className="kb-tags">
          {tags.map((t) => (
            <button
              key={t.tag}
              type="button"
              className={`kb-tag${tag === t.tag ? ' active' : ''}`}
              onClick={() => setTag(tag === t.tag ? null : t.tag)}
            >
              {t.tag} {t.count}
            </button>
          ))}
        </div>
      )}
      {error ? (
        <p className="error">{error}</p>
      ) : !notes ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="muted">
            {shown} of {notes.length} notes
          </p>
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
        </>
      )}
    </div>
  )
}
