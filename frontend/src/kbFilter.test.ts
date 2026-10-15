import { describe, expect, it } from 'vitest'
import { groupKb, kbNoteHref, kbPathFromRoute, kbTags, matchesKb, type KbNote } from './kbFilter'

const n = (path: string, title: string, tags: string[], updated: string): KbNote => ({
  path,
  topic: path.split('/')[1],
  title,
  tags,
  updated,
})

const notes = [
  n('topics/rust/borrow.md', 'Borrow checker', ['lang', 'memory'], '2026-01-02'),
  n('topics/rust/async.md', 'Async runtime', ['lang'], '2026-03-01'),
  n('topics/ops/backup.md', 'Backup plan', ['memory'], '2026-02-01'),
]

describe('kbFilter', () => {
  it('matches every word against title, path and tags, case-insensitively', () => {
    expect(matchesKb(notes[0], 'BORROW rust', null)).toBe(true)
    expect(matchesKb(notes[0], 'borrow ops', null)).toBe(false)
    expect(matchesKb(notes[0], '', 'lang')).toBe(true)
    expect(matchesKb(notes[0], '', 'ops')).toBe(false)
  })

  it('groups by topic A-Z, newest note first, dropping empty topics', () => {
    const g = groupKb(notes, '', null)
    expect(g.map((x) => x.topic)).toEqual(['ops', 'rust'])
    expect(g[1].notes.map((x) => x.title)).toEqual(['Async runtime', 'Borrow checker'])
    expect(groupKb(notes, '', 'memory').map((x) => x.topic)).toEqual(['ops', 'rust'])
    expect(groupKb(notes, 'backup', null).map((x) => x.topic)).toEqual(['ops'])
    expect(groupKb(notes, 'zzz', null)).toEqual([])
  })

  it('counts tags, most used first', () => {
    expect(kbTags(notes)).toEqual([
      { tag: 'lang', count: 2 },
      { tag: 'memory', count: 2 },
    ])
  })

  it('round-trips a note path through the route', () => {
    const href = kbNoteHref('topics/a b/x.md')
    expect(href).toBe('#/kb/topics/a%20b/x.md')
    expect(kbPathFromRoute(href.slice(1))).toBe('topics/a b/x.md')
    expect(kbPathFromRoute('/kb')).toBeNull()
    expect(kbPathFromRoute('/kb/%E0%A4%A')).toBeNull()
  })
})
