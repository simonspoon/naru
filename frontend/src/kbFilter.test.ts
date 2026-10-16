import { describe, expect, it } from 'vitest'
import { kbNoteHref, kbPathFromRoute } from './kbFilter'

describe('kbFilter', () => {
  it('round-trips a note path through the route', () => {
    const href = kbNoteHref('topics/a b/x.md')
    expect(href).toBe('#/kb/topics/a%20b/x.md')
    expect(kbPathFromRoute(href.slice(1))).toBe('topics/a b/x.md')
    expect(kbPathFromRoute('/kb')).toBeNull()
    expect(kbPathFromRoute('/kb/%E0%A4%A')).toBeNull()
  })
})
