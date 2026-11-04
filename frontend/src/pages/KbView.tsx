import { useMemo, useState } from 'react'
import { askKb, getKbDupes, getKbNote, getKbUsage, listKbNotes, mergeKbNotes } from '../api'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { Markdown } from '../components/Markdown'
import { Callout } from '../components/templates'
import { kbNoteHref } from '../kbFilter'
import {
  bubbleBounds,
  FRESHNESS_LABEL,
  hitRate,
  labelSize,
  packBubbles,
  recentNotes,
  topicStats,
  updatedMs,
  updatedThisWeek,
  type Freshness,
  type KbNoteInfo,
} from '../kbFront'
import { useFetch } from '../useFetch'

type KbAnswer = Awaited<ReturnType<typeof askKb>>

/** `#/kb` and `#/kb/<note path>` (naru tasks 1928, 1942, 2552): a stats row,
 * the Ask box over `POST /api/kb/ask` showing exactly what `naru kb ask`
 * returns (the answer and its sources, plus the raw JSON), the topic bubble
 * map, the recent notes and the duplicates to merge; and a note's body at
 * `#/kb/<path>`. */
export function KbView({ notePath }: { notePath: string | null }) {
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [result, setResult] = useState<KbAnswer | null>(null)
  const [askError, setAskError] = useState<string | null>(null)

  const { data: note, error: noteError } = useFetch(
    () => (notePath ? getKbNote(notePath) : Promise.resolve(null)),
    `kb-note:${notePath ?? ''}`,
  )
  // One notes fetch for the front page, so a merge's refetch updates the
  // stats row and the lists together.
  const {
    data: notes,
    error: notesError,
    refetch: refetchNotes,
  } = useFetch(() => (notePath ? Promise.resolve(null) : listKbNotes()), `kb-notes:${notePath ?? ''}`)

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
            ← Back to knowledge base
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
      <KbStats notes={notes} />
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
      <KbFront notes={notes} error={notesError} refetchNotes={refetchNotes} />
    </div>
  )
}

const FRESHNESS: Freshness[] = ['week', 'month', 'quarter', 'older']

/** A note's `updated` as a plain date. */
function day(updated: string): string {
  return updated.slice(0, 10)
}

/** Total notes, notes filed or updated this week, and the automatic
 * lookup's hit rate over `naru kb usage`'s 28 days. */
function KbStats({ notes }: { notes: KbNoteInfo[] | null }) {
  const { data: usage, error: usageError } = useFetch(getKbUsage, 'kb-usage')
  const [now] = useState(() => Date.now())
  const hit = usage ? hitRate(usage) : null
  return (
    <div className="kb-stats">
      <div className="kb-stat">
        <span className="kb-stat-value">{notes ? notes.length : '…'}</span>
        <span className="kb-stat-label">notes</span>
      </div>
      <div className="kb-stat">
        <span className="kb-stat-value">{notes ? updatedThisWeek(notes, now) : '…'}</span>
        <span className="kb-stat-label">added or updated this week</span>
      </div>
      <div className="kb-stat">
        <span className="kb-stat-value">
          {usageError
            ? '—'
            : !hit
              ? '…'
              : hit.rate === null
                ? '—'
                : `${Math.round(hit.rate * 100)}%`}
        </span>
        <span className="kb-stat-label">
          {usageError
            ? 'lookup hit rate unavailable'
            : usage && hit
              ? `lookup hit rate: ${hit.hits} of ${usage.lookups} lookups found notes, ${usage.useful} used (${usage.days} days)`
              : 'lookup hit rate'}
        </span>
      </div>
    </div>
  )
}

/** The topic bubble map with its drill-down, the recent notes and the
 * duplicate clusters. */
function KbFront({
  notes,
  error,
  refetchNotes,
}: {
  notes: KbNoteInfo[] | null
  error: string | null
  refetchNotes: () => Promise<void>
}) {
  const { data: dupes, error: dupesError, refetch: refetchDupes } = useFetch(getKbDupes, 'kb-dupes')
  const [picked, setTopic] = useState<string | null>(null)
  const [now] = useState(() => Date.now())
  const stats = useMemo(() => (notes ? topicStats(notes, now) : []), [notes, now])
  // A merge can empty the picked topic; it then reads as no pick.
  const topic = stats.some((s) => s.topic === picked) ? picked : null
  const bubbles = useMemo(() => packBubbles(stats), [stats])
  const box = bubbleBounds(bubbles)
  const topicNotes = useMemo(
    () =>
      notes && topic
        ? notes
            .filter((n) => n.topic === topic)
            .sort((a, b) => updatedMs(b.updated) - updatedMs(a.updated))
        : [],
    [notes, topic],
  )

  const notesError = error ? (
    <Callout tone="bad" text={`Could not load the notes: ${error}`} />
  ) : null

  return (
    <>
      <section className="cc-panel kb-panel">
        <h2>Topics</h2>
        <p className="cc-hint muted">
          Bubble size is the number of notes; colour is how recently the topic was updated. Pick
          one to see its notes.
        </p>
        {notesError ?? (!notes ? (
          <p className="muted">Loading…</p>
        ) : notes.length === 0 ? (
          <Callout tone="neutral" text="The knowledge base is empty." />
        ) : (
          <>
            <div className="kb-legend">
              {FRESHNESS.map((f) => (
                <span key={f} className="kb-legend-item">
                  <span className={`kb-swatch kb-fresh-${f}`} aria-hidden="true" />
                  {FRESHNESS_LABEL[f]}
                </span>
              ))}
            </div>
            <svg
              className="kb-map"
              viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
              role="group"
              aria-label="Topic bubble map"
            >
              {bubbles.map((b) => {
                const size = labelSize(b.topic, b.r)
                return (
                  <g
                    key={b.topic}
                    className={`kb-bubble kb-fresh-${b.freshness}${b.topic === topic ? ' selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={b.topic === topic}
                    aria-label={`${b.topic}: ${b.count} notes, ${FRESHNESS_LABEL[b.freshness].toLowerCase()}`}
                    onClick={() => setTopic(b.topic === topic ? null : b.topic)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setTopic(b.topic === topic ? null : b.topic)
                      }
                    }}
                  >
                    <title>{`${b.topic}: ${b.count} notes`}</title>
                    <circle cx={b.x} cy={b.y} r={b.r} />
                    {size !== null && (
                      <>
                        <text x={b.x} y={b.y} fontSize={size} className="kb-bubble-name">
                          {b.topic}
                        </text>
                        <text x={b.x} y={b.y + size * 1.15} fontSize={size * 0.8} className="kb-bubble-count">
                          {b.count}
                        </text>
                      </>
                    )}
                  </g>
                )
              })}
            </svg>
            <div className="kb-topic-chips">
              {stats.map((s) => (
                <button
                  key={s.topic}
                  type="button"
                  className={`kb-topic-chip${s.topic === topic ? ' active' : ''}`}
                  aria-pressed={s.topic === topic}
                  onClick={() => setTopic(s.topic === topic ? null : s.topic)}
                >
                  <span className={`kb-swatch kb-fresh-${s.freshness}`} aria-hidden="true" />
                  {s.topic} <span className="muted">{s.count}</span>
                </button>
              ))}
            </div>
            {topic && (
              <div className="kb-topic-notes">
                <div className="kb-topic-head">
                  <h3>
                    {topic} · {topicNotes.length} notes
                  </h3>
                  <button type="button" onClick={() => setTopic(null)}>
                    Close
                  </button>
                </div>
                <NoteList notes={topicNotes} />
              </div>
            )}
          </>
        ))}
      </section>
      <div className="kb-columns">
        <section className="cc-panel kb-panel">
          <h2>Recent notes</h2>
          {notesError ??
            (!notes ? (
              <p className="muted">Loading…</p>
            ) : notes.length === 0 ? (
              <p className="muted">No notes yet.</p>
            ) : (
              <NoteList notes={recentNotes(notes)} showTopic />
            ))}
        </section>
        <section className="cc-panel kb-panel">
          <h2>Duplicates to merge</h2>
          <p className="cc-hint muted">
            Near-duplicate notes, as <code>naru kb dupes</code> finds them. Merging keeps the chosen
            note, folds in the lines it lacks and deletes the others.
          </p>
          {dupesError ? (
            <Callout tone="bad" text={`Could not look for duplicates: ${dupesError}`} />
          ) : !dupes ? (
            <p className="muted">Loading…</p>
          ) : dupes.length === 0 ? (
            <p className="muted">No near-duplicates.</p>
          ) : (
            <div className="kb-dupes">
              {dupes.map((c) => (
                <DupeCluster
                  key={c.notes
                    .map((n) => n.path)
                    .sort()
                    .join('|')}
                  score={c.score}
                  notes={c.notes}
                  onMerged={() => Promise.all([refetchDupes(), refetchNotes()])}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function NoteList({ notes, showTopic }: { notes: KbNoteInfo[]; showTopic?: boolean }) {
  return (
    <ul className="kb-note-list">
      {notes.map((n) => (
        <li key={n.path}>
          <a className="kb-note-title" href={kbNoteHref(n.path)} title={n.path}>
            {n.title || n.path}
          </a>
          <span className="kb-note-meta">
            {showTopic && <span className="kb-note-topic">{n.topic}</span>}
            {n.tags.map((t) => (
              <span key={t} className="kb-tag">
                {t}
              </span>
            ))}
            <span className="muted">{day(n.updated)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** One cluster: its notes, a choice of which to keep, and a merge that only
 * runs after a confirm (the same merge as `naru kb merge`). */
function DupeCluster({
  score,
  notes,
  onMerged,
}: {
  score: number
  notes: { path: string; title: string }[]
  onMerged: () => Promise<unknown>
}) {
  const [keep, setKeep] = useState(notes[0].path)
  const drops = notes.filter((n) => n.path !== keep).map((n) => n.path)
  const keepTitle = notes.find((n) => n.path === keep)?.title || keep
  const name = `kb-keep-${notes[0].path}`
  return (
    <div className="kb-dupe">
      <p className="cc-hint muted kb-dupe-score">
        {notes.length} notes, similarity {score.toFixed(2)}
      </p>
      <ul className="kb-dupe-notes">
        {notes.map((n) => (
          <li key={n.path}>
            <label>
              <input
                type="radio"
                name={name}
                checked={n.path === keep}
                onChange={() => setKeep(n.path)}
                aria-label={`Keep ${n.title || n.path}`}
              />
              <span className="kb-dupe-keep">{n.path === keep ? 'keep' : ''}</span>
            </label>
            <a className="kb-note-title" href={kbNoteHref(n.path)} title={n.path}>
              {n.title || n.path}
            </a>
          </li>
        ))}
      </ul>
      <ConfirmDelete
        label="Merge"
        message={`Keep “${keepTitle}” and delete ${drops.length} note${drops.length === 1 ? '' : 's'}?`}
        onDelete={() => mergeKbNotes(keep, drops).then(onMerged)}
      />
    </div>
  )
}
