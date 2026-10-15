// Pure logic for the knowledge base page (naru task 1928): filtering the
// metadata list by text and tag, grouping it by topic, and the `#/kb/<path>`
// address of one note. No React, so it is unit-tested (kbFilter.test.ts).

/** One row of `GET /api/kb/notes` (the CLI's `kb list`). */
export interface KbNote {
  path: string
  topic: string
  title: string
  tags: string[]
  updated: string
}

export interface KbGroup {
  topic: string
  /** Notes in this topic that pass the filter. */
  notes: KbNote[]
}

/** True when the note passes the text and tag filters (both optional). */
export function matchesKb(note: KbNote, text: string, tag: string | null): boolean {
  if (tag !== null && !note.tags.includes(tag)) return false
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = `${note.title} ${note.path} ${note.tags.join(' ')}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** Filtered notes grouped by topic: topics A-Z, notes newest first. A topic
 * with no surviving note is omitted. */
export function groupKb(notes: KbNote[], text: string, tag: string | null): KbGroup[] {
  const by = new Map<string, KbNote[]>()
  for (const n of notes) {
    if (!matchesKb(n, text, tag)) continue
    const list = by.get(n.topic)
    if (list) list.push(n)
    else by.set(n.topic, [n])
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([topic, list]) => ({
      topic,
      notes: list.sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title)),
    }))
}

/** Every distinct tag with its note count, most used first then A-Z. */
export function kbTags(notes: KbNote[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** The note path a `#/kb/<path>` route names, or null for `#/kb` / non-kb. */
export function kbPathFromRoute(path: string): string | null {
  const m = /^\/kb\/(.+)$/.exec(path)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}

/** The hash address of a note (the inverse of `kbPathFromRoute`). */
export function kbNoteHref(path: string): string {
  return `#/kb/${path.split('/').map(encodeURIComponent).join('/')}`
}
