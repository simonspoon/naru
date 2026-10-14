import { describe, expect, it } from 'vitest'
import { agentModel, modelChoices, modelFromSelect, modelPill, modelSelectValue } from './libraryModel'

const doc = (fm: string) => `---\n${fm}\n---\nbody\n`

describe('agentModel', () => {
  it('reads a bare value', () => {
    expect(agentModel(doc('name: a\nmodel: opus\ntools: Read'))).toBe('opus')
  })
  it('strips quotes and trailing comments', () => {
    expect(agentModel(doc('model: "sonnet"'))).toBe('sonnet')
    expect(agentModel(doc("model: 'haiku' # cheap"))).toBe('haiku')
    expect(agentModel(doc('model: fable # note'))).toBe('fable')
  })
  it('is null without frontmatter, key or value', () => {
    expect(agentModel('model: opus\nno fence')).toBeNull()
    expect(agentModel(doc('name: a'))).toBeNull()
    expect(agentModel(doc('model:'))).toBeNull()
    expect(agentModel('---\nname: a\n---\nmodel: opus\n')).toBeNull()
  })
  it('ignores indented or lookalike keys', () => {
    expect(agentModel(doc('  model: opus'))).toBeNull()
    expect(agentModel(doc('models: opus'))).toBeNull()
  })
  it('handles CRLF', () => {
    expect(agentModel('---\r\nmodel: opus\r\n---\r\nx')).toBe('opus')
  })
})

describe('modelPill', () => {
  it('none when unset', () => {
    expect(modelPill('plain')).toEqual({ label: 'none', family: 'none' })
  })
  it('classifies families', () => {
    expect(modelPill(doc('model: opus')).family).toBe('opus')
    expect(modelPill(doc('model: Sonnet')).family).toBe('sonnet')
    expect(modelPill(doc('model: haiku')).family).toBe('haiku')
    expect(modelPill(doc('model: fable')).family).toBe('fable')
  })
  it('maps a full id to its family, keeping the raw label', () => {
    expect(modelPill(doc('model: claude-opus-4-1'))).toEqual({
      label: 'claude-opus-4-1',
      family: 'opus',
    })
  })
  it('other for inherit and unknown values', () => {
    expect(modelPill(doc('model: inherit'))).toEqual({ label: 'inherit', family: 'other' })
  })
})

describe('model dropdown helpers', () => {
  it('lists the families, plus a current value outside them', () => {
    expect(modelChoices(doc('model: opus'))).toEqual(['opus', 'sonnet', 'haiku', 'fable'])
    expect(modelChoices(doc('name: a'))).toEqual(['opus', 'sonnet', 'haiku', 'fable'])
    expect(modelChoices(doc('model: claude-opus-4-1'))).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'fable',
      'claude-opus-4-1',
    ])
  })
  it('selects the current model, or inherit when there is none', () => {
    expect(modelSelectValue(doc('model: "haiku"'))).toBe('haiku')
    expect(modelSelectValue(doc('name: a'))).toBe('')
  })
  it('sends inherit as null', () => {
    expect(modelFromSelect('')).toBeNull()
    expect(modelFromSelect('sonnet')).toBe('sonnet')
  })
})
