import { describe, expect, it } from 'vitest'
import { TASK_NOTE_MAX, noteToSubmit, sessionLabel } from './taskNotes'

describe('noteToSubmit', () => {
  it('rejects blank drafts', () => {
    expect(noteToSubmit('')).toBeNull()
    expect(noteToSubmit('  \n ')).toBeNull()
  })
  it('keeps the draft verbatim', () => {
    expect(noteToSubmit(' a\nb ')).toBe(' a\nb ')
  })
  it('counts bytes, not characters', () => {
    expect(noteToSubmit('x'.repeat(TASK_NOTE_MAX))).not.toBeNull()
    expect(noteToSubmit('x'.repeat(TASK_NOTE_MAX + 1))).toBeNull()
    expect(noteToSubmit('é'.repeat(TASK_NOTE_MAX / 2 + 1))).toBeNull()
  })
})

describe('sessionLabel', () => {
  it('is null without a session', () => {
    expect(sessionLabel(null)).toBeNull()
    expect(sessionLabel(' ')).toBeNull()
  })
  it('shortens long ids', () => {
    expect(sessionLabel('0123456789abcdef')).toBe('01234567')
    expect(sessionLabel('abc')).toBe('abc')
  })
})
