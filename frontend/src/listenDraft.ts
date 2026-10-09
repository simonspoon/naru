import { engineChange, engineChoices } from './audioDraft'
import type { ConfigListen } from './types/ConfigListen'

/**
 * Pure draft logic for the Settings page's listen editor (mesa task 955),
 * hoisted out of the component so it is unit-testable (see CLAUDE.md: the
 * frontend tests cover the pure modules, never a rendered tree).
 *
 * The input-side mirror of [`speechDraft`](./speechDraft.ts), for the one
 * value this section edits — the model `live transcribe` runs the external
 * `auris` binary with:
 *
 * - **Blank means "the binary's own default"**, not "silence". A blank box
 *   is PUT as `null`, which removes the key so mesa passes no `-m` at all.
 * - **The model is edited as text**, even when the box is a `<select>`: an
 *   installed binary mesa could not ask has no list to pick from, and the
 *   value already in the file has to survive that.
 * - **The engine** (`listen.engine`, mesa task 1391) is picked from a fixed
 *   list and drafted as the engine in force; picking the built-in sends
 *   `null` (`audioDraft.ts::engineChange`).
 */

/** The section's boxes as typed. */
export type ListenDraft = { model: string; engine: string; vocabulary: string }

/** The engines `PUT /api/config/listen` accepts, built-in first. */
export const LISTEN_ENGINES = ['server', 'browser']

/**
 * The editable values as loaded: an unconfigured model is blank, and the
 * engine is the one in force.
 */
export function draftFrom(listen: ConfigListen): ListenDraft {
  const engine = (listen.engine ?? '').trim()
  return {
    model: listen.model ?? '',
    engine: engine === '' ? listen.engine_default : engine,
    vocabulary: listen.vocabulary ?? '',
  }
}

/** The engines to offer, keeping a hand-edited unknown one visible. */
export function engineOptions(listen: ConfigListen): string[] {
  return engineChoices(listen.engine, LISTEN_ENGINES)
}

/** What the engine select means for a save: see `audioDraft.ts::engineChange`. */
function engineOf(listen: ConfigListen, draft: ListenDraft): string | null | undefined {
  return engineChange(listen.engine, listen.engine_default, draft.engine)
}

/**
 * Whether the picker can be a list: only when the binary answered
 * `--list-models` with something. Empty means mesa could not ask, and the box
 * has to accept a typed name instead — never that there are no models.
 */
export function canPick(listen: ConfigListen): boolean {
  return listen.models.length > 0
}

/**
 * The options to offer, in the binary's own order, with the configured model
 * included even when the binary no longer lists it — otherwise selecting the
 * list would silently rewrite a value the user never touched.
 */
export function options(listen: ConfigListen): string[] {
  const configured = (listen.model ?? '').trim()
  if (configured === '' || listen.models.includes(configured)) return listen.models
  return [...listen.models, configured]
}

/**
 * The complaint about the model box, or `null` if it is fine. Blank is *not*
 * an error — it is the legitimate "use the binary's default", the reset.
 *
 * Mirrors the server's shape rule (`core::listen::is_model_name`) so a name
 * that could be read as an option is refused before the round trip. One
 * character wider than the voice rule — a dot is allowed, since a real model
 * name looks like `parakeet-tdt-0.6b-v2-int8`. Membership in the offered list
 * is deliberately **not** checked here: the server owns that, and it skips it
 * too when it has no list.
 */
export function valueError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) {
    return 'letters, digits, underscores, dots and dashes only'
  }
  if (trimmed.length > 64) return 'longer than 64 characters'
  return null
}

/** What the box means: a model, or `null` for "the binary's default". */
function valueOf(draft: ListenDraft): string | null {
  const trimmed = (draft.model ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** True when either value differs from what the server last reported. */
export function isDirty(listen: ConfigListen, draft: ListenDraft): boolean {
  return (
    valueOf(draft) !== (listen.model ?? null) ||
    engineOf(listen, draft) !== undefined ||
    vocabularyOf(draft) !== (listen.vocabulary ?? null)
  )
}

/**
 * True when nothing the save would send is rejected by the server. The model
 * is judged only when the draft changes it: the server validates just the
 * keys it is sent, so a bad name already in the file (hand-edited) must not
 * hold back an engine-only save.
 */
export function isSavable(listen: ConfigListen, draft: ListenDraft): boolean {
  return (
    (valueOf(draft) === (listen.model ?? null) || valueError(draft.model ?? '') === null) &&
    (vocabularyOf(draft) === (listen.vocabulary ?? null) ||
      vocabularyError(draft.vocabulary) === null)
  )
}

/**
 * The subset to PUT: each key only when it actually changed, so the API's
 * "only the keys present are touched" rule keeps two editors from clobbering
 * each other. A box cleared to blank sends `null` — the server's "remove this
 * key", which is the reset to the binary's own model; the engine's built-in
 * likewise sends `null`.
 */
export function changedListen(
  listen: ConfigListen,
  draft: ListenDraft,
): Record<string, string | null> {
  if (!isDirty(listen, draft) || !isSavable(listen, draft)) return {}
  const changed: Record<string, string | null> = {}
  if (valueOf(draft) !== (listen.model ?? null)) changed.model = valueOf(draft)
  const engine = engineOf(listen, draft)
  if (engine !== undefined) changed.engine = engine
  if (vocabularyOf(draft) !== (listen.vocabulary ?? null)) changed.vocabulary = vocabularyOf(draft)
  return changed
}

/** What the vocabulary box means: its text, or `null` for "none". */
function vocabularyOf(draft: ListenDraft): string | null {
  const trimmed = (draft.vocabulary ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** The most terms naru-audio keeps; the server refuses more at save. */
export const VOCABULARY_MAX_TERMS = 128
const VOCABULARY_MAX_TERM_BYTES = 64
const VOCABULARY_MAX_BOOST = 8

/**
 * The complaint about the vocabulary box, or `null` if it is fine — a mirror
 * of `config::validate_vocabulary` (naru task 1754), which owns the rule and
 * answers a 422 naming the line. One `term[ :boost]` per line, `#` starts a
 * comment, blank lines are skipped, a boost is above 0 and at most 8, a term
 * has no `/` or control character and is at most 64 bytes, and there are at
 * most 128 terms.
 */
export function vocabularyError(text: string): string | null {
  let terms = 0
  const lines = (text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const fail = (why: string) => `line ${i + 1}: ${why}`
    const tokens = lines[i]
      .split('#')[0]
      .split(/\s+/)
      .filter((t) => t !== '')
    if (tokens.length === 0) continue
    let boost: string | null = null
    if (tokens.length > 1 && tokens[tokens.length - 1].startsWith(':')) {
      boost = tokens.pop()!.slice(1)
    }
    for (const token of tokens) {
      if (token.startsWith(':')) return fail('a stray ":" where the term should be')
      if (token.includes(':')) {
        return fail(`"${token}" has a ":" inside a word; write the boost as " :BOOST" after a space`)
      }
    }
    if (boost !== null) {
      // f32, like the daemon: 1e-50 underflows to 0 there.
      const value = boost === '' ? NaN : Math.fround(Number(boost))
      if (Number.isNaN(value)) return fail(`the boost "${boost}" is not a number`)
      if (value <= 0 || value > VOCABULARY_MAX_BOOST) {
        return fail(`the boost "${boost}" must be above 0 and at most ${VOCABULARY_MAX_BOOST}`)
      }
    }
    const term = tokens.join(' ')
    if (term.includes('/')) return fail('a term cannot contain "/"')
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f]/.test(term)) {
      return fail('a term cannot contain a control character')
    }
    const bytes = new TextEncoder().encode(term).length
    if (bytes > VOCABULARY_MAX_TERM_BYTES) {
      return fail(`the term is ${bytes} bytes; at most ${VOCABULARY_MAX_TERM_BYTES}`)
    }
    terms++
  }
  if (terms > VOCABULARY_MAX_TERMS) {
    return `${terms} terms; at most ${VOCABULARY_MAX_TERMS}`
  }
  return null
}

/**
 * The line under the vocabulary box saying whether it is used, or `null` when
 * nothing needs saying. `engine` is the server's engine in force
 * (`audioDraft.savedEngine`), `null` while that is still loading. The model
 * judged is the configured one, else the daemon's default; when neither is
 * known the page claims nothing.
 */
export function vocabularyNote(listen: ConfigListen, engine: string | null): string | null {
  if (engine === null) return null
  if (engine !== 'naru-audio') return 'Vocabulary is used only with the Naru Audio engine.'
  const model = (listen.model ?? '').trim() || listen.default_model
  if (!model) return null
  if (listen.hotword_models.includes(model)) return null
  const alternative =
    listen.hotword_models.length > 0 ? `; a model such as ${listen.hotword_models[0]} uses it` : ''
  return `${model} ignores the vocabulary${alternative}.`
}
