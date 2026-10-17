import { describe, expect, it } from 'vitest'
import type { WorkflowNode } from './types/WorkflowNode'
import type { WorkflowType } from './types/WorkflowType'
import {
  pinColorVar,
  pinType,
  pinsConfig,
  pinsOf,
  refusalReason,
  shapePlan,
  typeUsages,
  typesMatch,
  validateTypeDraft,
} from './workflowTypes'

const review: WorkflowType = {
  name: 'Review',
  fields: [
    { name: 'score', ty: 'number' },
    { name: 'ok', ty: 'bool' },
  ],
}
const types = [review]

function node(id: number, kind: WorkflowNode['kind'], config: Record<string, unknown>, title = `n${id}`): WorkflowNode {
  return { id, workflow_id: 1, kind, title, config, x: 0, y: 0, created_at: '', updated_at: '' }
}

describe('typesMatch', () => {
  it('any matches everything, otherwise equal', () => {
    expect(typesMatch('any', 'number')).toBe(true)
    expect(typesMatch('Review', 'any')).toBe(true)
    expect(typesMatch('Review', 'Review')).toBe(true)
    expect(typesMatch('number', 'Review')).toBe(false)
    expect(typesMatch('list<string>', 'string')).toBe(false)
  })
})

describe('pinColorVar', () => {
  it('colours primitives, follows a list to its element, and is stable for a struct', () => {
    expect(pinColorVar('string')).toBe('--cyan')
    expect(pinColorVar('number')).toBe('--amber')
    expect(pinColorVar('bool')).toBe('--red')
    expect(pinColorVar('list<number>')).toBe('--amber')
    expect(pinColorVar('Review')).toBe(pinColorVar('Review'))
    expect(pinColorVar('Review')).toMatch(/^--/)
  })
})

describe('pinsOf / pinType', () => {
  it('derives a break and a make from their struct, and reads declared pins elsewhere', () => {
    const b = node(1, 'break', { struct: 'Review' })
    expect(pinsOf(b, types).inputs).toEqual([{ name: 'value', ty: 'Review' }])
    expect(pinsOf(b, types).outputs.map((p) => p.name)).toEqual(['score', 'ok'])
    const m = node(2, 'make', { struct: 'Review' })
    expect(pinsOf(m, types).outputs).toEqual([{ name: 'value', ty: 'Review' }])
    const c = node(3, 'cli', { command: 'x', pins: { out: [{ name: 'result', ty: 'Review' }] } })
    expect(pinType(c, 'out', null, types)).toBe('Review')
    expect(pinType(c, 'in', null, types)).toBe('any')
    expect(pinType(c, 'out', 'nope', types)).toBeNull()
  })
})

describe('refusalReason', () => {
  const num = node(1, 'cli', { command: 'x', pins: { out: [{ name: 'result', ty: 'number' }] } })
  const rev = node(2, 'cli', { command: 'x', pins: { in: [{ name: 'input', ty: 'Review' }] } })
  const plain = node(3, 'cli', { command: 'x' })
  it('names both types on a mismatch', () => {
    const why = refusalReason(num, null, rev, null, types)
    expect(why).toContain('number')
    expect(why).toContain('Review')
  })
  it('lets any and equal types through', () => {
    expect(refusalReason(num, null, plain, null, types)).toBeNull()
    const brk = node(4, 'break', { struct: 'Review' })
    expect(refusalReason(brk, 'score', num, null, types)).toBeNull()
    expect(refusalReason(brk, 'ok', rev, null, types)).toContain('bool')
  })
})

describe('shapePlan', () => {
  it('offers Break on a struct output and Make on a struct input only', () => {
    expect(shapePlan('out', 'Review', types)?.kind).toBe('break')
    expect(shapePlan('in', 'Review', types)?.title).toBe('Make Review')
    expect(shapePlan('out', 'number', types)).toBeNull()
    expect(shapePlan('out', 'list<Review>', types)).toBeNull()
  })
})

describe('validateTypeDraft', () => {
  it('rejects duplicates, reserved names, unknown types and self-containment', () => {
    expect(validateTypeDraft(types)).toBeNull()
    expect(validateTypeDraft([review, { ...review, name: 'review' }])).toContain('twice')
    expect(validateTypeDraft([{ name: 'string', fields: [] }])).toContain('valid type name')
    expect(validateTypeDraft([{ name: 'A', fields: [{ name: 'x', ty: 'Nope' }] }])).toContain('unknown')
    expect(validateTypeDraft([{ name: 'A', fields: [{ name: 'x', ty: 'list<A>' }] }])).toContain('itself')
  })
})

describe('typeUsages / pinsConfig', () => {
  it('lists what blocks deleting a type', () => {
    const c = node(3, 'cli', { command: 'x', pins: { out: [{ name: 'result', ty: 'Review' }] } }, 'Src')
    expect(typeUsages('Review', [c, node(4, 'break', { struct: 'Review' }, 'Brk')], types)).toEqual([
      'Src · result',
      'Brk',
    ])
    expect(typeUsages('Review', [], types)).toEqual([])
  })
  it('drops empty sides and trims names', () => {
    expect(pinsConfig({ inputs: [], outputs: [] })).toBeUndefined()
    expect(pinsConfig({ inputs: [], outputs: [{ name: ' r ', ty: 'string' }] })).toEqual({
      out: [{ name: 'r', ty: 'string' }],
    })
  })
})

describe('handles and default pins', () => {
  it('round-trips a typed handle id and names the default pin', async () => {
    const { effectivePin, pinHandleId, pinOfHandle } = await import('./workflowTypes')
    expect(pinOfHandle('out', pinHandleId('out', 'score'))).toBe('score')
    expect(pinOfHandle('in', pinHandleId('out', 'score'))).toBeNull()
    expect(pinOfHandle('out', 'true')).toBeNull()
    const c = node(3, 'cli', { command: 'x', pins: { out: [{ name: 'result', ty: 'Review' }] } })
    expect(effectivePin(c, 'out', null, types)).toBe('result')
    expect(effectivePin(c, 'in', null, types)).toBeNull()
    expect(effectivePin(node(4, 'break', { struct: 'Review' }), 'in', null, types)).toBe('value')
  })
})
