// Pure view logic for a task's append-only notes (naru task 1724). Kept out of
// TaskPanel.tsx per CLAUDE.md's frontend invariant.

/** Mirrors `Store::TASK_NOTE_MAX` (bytes) in src/core/store.rs. */
export const TASK_NOTE_MAX = 8192

/**
 * What the add-note form may submit: the draft as typed (inner whitespace and
 * line breaks are the author's), or `null` when it is blank or longer than the
 * server accepts — the form disables its button on `null`.
 */
export function noteToSubmit(draft: string): string | null {
  if (draft.trim() === '') return null
  if (new TextEncoder().encode(draft).length > TASK_NOTE_MAX) return null
  return draft
}

/** A session id shortened for the meta line; `null` (the web UI) is no label. */
export function sessionLabel(session: string | null): string | null {
  if (session === null || session.trim() === '') return null
  return session.length > 8 ? session.slice(0, 8) : session
}
