// Pure logic for the knowledge base front page (naru task 2552): the topic
// bubble map's sizes, colours and layout, the stats row and the recent-notes
// list, all derived from `naru kb list` / `naru kb usage` output. No React,
// so it is unit-tested (kbFront.test.ts).

/** One note's metadata, as `naru kb list` / `GET /api/kb/notes` prints it. */
export interface KbNoteInfo {
  path: string
  topic: string
  title: string
  tags: string[]
  updated: string
}

/** How recently a topic's newest note was updated. */
export type Freshness = 'week' | 'month' | 'quarter' | 'older'

export const FRESHNESS_LABEL: Record<Freshness, string> = {
  week: 'Updated this week',
  month: 'This month',
  quarter: 'Last 3 months',
  older: 'Older',
}

const DAY_MS = 86_400_000

/** A note's `updated` as epoch ms (0 when it does not parse). */
export function updatedMs(updated: string): number {
  const t = Date.parse(updated)
  return Number.isFinite(t) ? t : 0
}

export function freshness(newestMs: number, nowMs: number): Freshness {
  const days = (nowMs - newestMs) / DAY_MS
  if (days <= 7) return 'week'
  if (days <= 30) return 'month'
  if (days <= 90) return 'quarter'
  return 'older'
}

export interface TopicStat {
  topic: string
  count: number
  /** epoch ms of the topic's most recently updated note. */
  newest: number
  freshness: Freshness
}

/** One entry per topic, biggest first (ties by name). */
export function topicStats(notes: KbNoteInfo[], nowMs: number): TopicStat[] {
  const by = new Map<string, { count: number; newest: number }>()
  for (const n of notes) {
    const s = by.get(n.topic) ?? { count: 0, newest: 0 }
    s.count += 1
    s.newest = Math.max(s.newest, updatedMs(n.updated))
    by.set(n.topic, s)
  }
  return [...by.entries()]
    .map(([topic, s]) => ({ topic, ...s, freshness: freshness(s.newest, nowMs) }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
}

/** Notes newest first (ties by path), at most `limit`. */
export function recentNotes(notes: KbNoteInfo[], limit = 10): KbNoteInfo[] {
  return [...notes]
    .sort((a, b) => updatedMs(b.updated) - updatedMs(a.updated) || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/** Notes filed or updated in the last 7 days. */
export function updatedThisWeek(notes: KbNoteInfo[], nowMs: number): number {
  return notes.filter((n) => nowMs - updatedMs(n.updated) <= 7 * DAY_MS).length
}

/** The counts `naru kb usage` prints (the ones the page reads). */
export interface KbUsage {
  lookups: number
  useful: number
  unused: number
  unchecked: number
  empty: number
  failed: number
  days: number
}

/** The automatic lookup's hit rate: the share of lookups that found notes
 * and injected them (useful + unused + unchecked). Null with no lookups. */
export function hitRate(u: KbUsage): { hits: number; rate: number | null } {
  const hits = u.useful + u.unused + u.unchecked
  return { hits, rate: u.lookups > 0 ? hits / u.lookups : null }
}

export interface Bubble extends TopicStat {
  x: number
  y: number
  r: number
}

/** Map-unit radius of the biggest bubble; area is proportional to the note
 * count, but no bubble goes below MIN_R so a small topic stays clickable. */
export const MAX_R = 150
export const MIN_R = 26
const GAP = 4

/** The bubble radius for a topic of `count` notes when the biggest has `max`. */
export function bubbleRadius(count: number, max: number): number {
  return Math.max(MIN_R, MAX_R * Math.sqrt(count / Math.max(1, max)))
}

/** Packs the topics as non-overlapping circles, biggest at the centre and
 * each next one at the first free spot on an outward spiral. Deterministic. */
export function packBubbles(stats: TopicStat[]): Bubble[] {
  const max = stats.reduce((m, s) => Math.max(m, s.count), 0)
  const placed: Bubble[] = []
  for (const s of stats) {
    const r = bubbleRadius(s.count, max)
    let x = 0
    let y = 0
    if (placed.length > 0) {
      // Archimedean spiral; the step is small against MIN_R so no gap a
      // bubble fits in is skipped by much.
      for (let t = 0; ; t += 0.05) {
        const d = 3 * t
        x = d * Math.cos(t)
        y = d * Math.sin(t)
        if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + GAP)) break
      }
    }
    placed.push({ ...s, x, y, r })
  }
  return placed
}

/** The viewBox that holds every bubble, with `pad` map units around them. */
export function bubbleBounds(bubbles: Bubble[], pad = 8): {
  x: number
  y: number
  w: number
  h: number
} {
  if (bubbles.length === 0) return { x: 0, y: 0, w: 1, h: 1 }
  const minX = Math.min(...bubbles.map((b) => b.x - b.r)) - pad
  const maxX = Math.max(...bubbles.map((b) => b.x + b.r)) + pad
  const minY = Math.min(...bubbles.map((b) => b.y - b.r)) - pad
  const maxY = Math.max(...bubbles.map((b) => b.y + b.r)) + pad
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** The label font size (map units) that fits `topic` and its count inside a
 * bubble of radius `r`, or null when it would be too small to read. */
export function labelSize(topic: string, r: number): number | null {
  // Text is roughly 0.6em wide per character; the label row gets ~1.6r.
  const size = Math.min(r / 2.4, (1.6 * r) / (0.6 * Math.max(4, topic.length)))
  return size >= 9 ? size : null
}
