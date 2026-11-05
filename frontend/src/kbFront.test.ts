import { describe, expect, it } from 'vitest'
import {
  bubbleBounds,
  bubbleRadius,
  freshness,
  hitRate,
  labelSize,
  MIN_R,
  packBubbles,
  recentNotes,
  topicStats,
  updatedThisWeek,
  type KbNoteInfo,
} from './kbFront'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const note = (path: string, updated: string): KbNoteInfo => ({
  path,
  topic: path.split('/')[1],
  title: path,
  tags: [],
  updated,
  sessions: [],
})

describe('kbFront', () => {
  it('counts topics biggest first with their newest note', () => {
    const s = topicStats(
      [
        note('topics/a/1.md', '2026-11-01T00:00:00Z'),
        note('topics/b/1.md', '2026-01-01'),
        note('topics/a/2.md', '2026-09-01T00:00:00Z'),
      ],
      NOW,
    )
    expect(s.map((t) => [t.topic, t.count, t.freshness])).toEqual([
      ['a', 2, 'week'],
      ['b', 1, 'older'],
    ])
  })

  it('buckets freshness by age in days', () => {
    const ago = (d: number) => NOW - d * 86_400_000
    expect([1, 20, 60, 200].map((d) => freshness(ago(d), NOW))).toEqual([
      'week',
      'month',
      'quarter',
      'older',
    ])
  })

  it('lists recent notes newest first, capped', () => {
    const notes = Array.from({ length: 12 }, (_, i) =>
      note(`topics/a/${i}.md`, `2026-10-${String(i + 1).padStart(2, '0')}`),
    )
    const r = recentNotes(notes)
    expect(r).toHaveLength(10)
    expect(r[0].path).toBe('topics/a/11.md')
    expect(updatedThisWeek(notes, Date.parse('2026-10-12T00:00:00Z'))).toBe(8)
  })

  it('reports the lookup hit rate, null with no lookups', () => {
    const u = { lookups: 10, useful: 2, unused: 3, unchecked: 1, empty: 3, failed: 1, days: 28 }
    expect(hitRate(u)).toEqual({ hits: 6, rate: 0.6 })
    expect(hitRate({ ...u, lookups: 0, useful: 0, unused: 0, unchecked: 0 }).rate).toBeNull()
  })

  it('packs bubbles without overlap, area by count, a floor on small ones', () => {
    const counts = [690, 200, 120, 40, 12, 5, 3, 1, 1, 1]
    const stats = counts.map((count, i) => ({
      topic: `t${i}`,
      count,
      newest: 0,
      freshness: 'older' as const,
    }))
    const b = packBubbles(stats)
    expect(b).toHaveLength(counts.length)
    for (let i = 0; i < b.length; i++)
      for (let j = i + 1; j < b.length; j++)
        expect(Math.hypot(b[i].x - b[j].x, b[i].y - b[j].y)).toBeGreaterThanOrEqual(
          b[i].r + b[j].r - 1e-9,
        )
    expect(bubbleRadius(1, 690)).toBe(MIN_R)
    expect(bubbleRadius(690, 690) / bubbleRadius(173, 690)).toBeCloseTo(Math.sqrt(690 / 173))
    const box = bubbleBounds(b)
    for (const x of b) {
      expect(x.x - x.r).toBeGreaterThanOrEqual(box.x)
      expect(x.y + x.r).toBeLessThanOrEqual(box.y + box.h)
    }
  })

  it('drops a label that would be too small to read', () => {
    expect(labelSize('agents', 150)).not.toBeNull()
    expect(labelSize('a-very-long-topic-name', MIN_R)).toBeNull()
  })
})
