import { describe, expect, it } from 'vitest'
import {
  SKILL_FILE,
  addFile,
  changedFiles,
  fileList,
  filesDiffer,
  filesPayload,
  pathError,
  removeFile,
  selectionAfter,
  setFileText,
  textOf,
} from './librarySkillFiles'

describe('librarySkillFiles', () => {
  it('lists SKILL.md first, then siblings in path order', () => {
    expect(fileList({ 'waiting.md': '', 'deep/a.md': '', 'briefs.md': '' })).toEqual([
      SKILL_FILE,
      'briefs.md',
      'deep/a.md',
      'waiting.md',
    ])
    expect(fileList({})).toEqual([SKILL_FILE])
  })

  it('mirrors the server path rules', () => {
    const have = { 'a.md': 'x' }
    expect(pathError('b.md', have)).toBeNull()
    expect(pathError('deep/b.md', have)).toBeNull()
    expect(pathError('', have)).not.toBeNull()
    expect(pathError('/abs.md', have)).not.toBeNull()
    expect(pathError('../x.md', have)).not.toBeNull()
    expect(pathError('a//b.md', have)).not.toBeNull()
    expect(pathError('.hidden', have)).not.toBeNull()
    expect(pathError('a\\b.md', have)).not.toBeNull()
    expect(pathError('skill.md', have)).not.toBeNull()
    expect(pathError('a.md', have)).toMatch(/already exists/)
    expect(pathError('x'.repeat(201), have)).not.toBeNull()
    expect(pathError('1/2/3/4/5/6/7/8/9/10.md', have)).not.toBeNull()
    expect(pathError('1/2/3/4/5/6/7/8/9.md', have)).toBeNull()
  })

  it('caps the file count', () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}.md`, '']))
    expect(pathError('one-more.md', many)).not.toBeNull()
  })

  it('adds, edits and removes without mutating', () => {
    const base = { 'a.md': 'A' }
    const added = addFile(base, 'b.md')
    expect(added).toEqual({ 'a.md': 'A', 'b.md': '' })
    expect(base).toEqual({ 'a.md': 'A' })
    expect(setFileText(added, 'b.md', 'B')['b.md']).toBe('B')
    expect(removeFile(added, 'a.md')).toEqual({ 'b.md': '' })
    expect(removeFile(base, SKILL_FILE)).toEqual(base)
  })

  it('reads SKILL.md from the body', () => {
    expect(textOf(SKILL_FILE, 'body', { 'a.md': 'A' })).toBe('body')
    expect(textOf('a.md', 'body', { 'a.md': 'A' })).toBe('A')
    expect(textOf('gone.md', 'body', {})).toBe('')
  })

  it('detects a difference by keys or text, not key order', () => {
    expect(filesDiffer({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(false)
    expect(filesDiffer({ a: '1' }, { a: '2' })).toBe(true)
    expect(filesDiffer({ a: '1' }, {})).toBe(true)
    expect(filesDiffer({ a: '1' }, { b: '1' })).toBe(true)
  })

  it('names the changed files', () => {
    expect(changedFiles('b', { 'a.md': 'A' }, 'b', { 'a.md': 'A' })).toEqual([])
    expect(changedFiles('b', { 'a.md': 'A' }, 'b2', { 'a.md': 'A2', 'n.md': '' })).toEqual([
      SKILL_FILE,
      'a.md',
      'n.md',
    ])
  })

  it('sends files for a skill only', () => {
    expect(filesPayload('skill', { 'a.md': 'A' })).toEqual({ 'a.md': 'A' })
    expect(filesPayload('skill', {})).toEqual({})
    expect(filesPayload('agent', {})).toBeUndefined()
  })

  it('falls back to SKILL.md when the selected file is gone', () => {
    expect(selectionAfter('a.md', { 'a.md': '' })).toBe('a.md')
    expect(selectionAfter('a.md', {})).toBe(SKILL_FILE)
    expect(selectionAfter(SKILL_FILE, {})).toBe(SKILL_FILE)
  })
})
