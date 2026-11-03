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
  return { id, workflow_id: 1, kind, title, config, x: 0, y: 0, created_at: '', updated_at: '', pins: { in: [], out: [] } }
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

describe('server pins, wire kind and data inputs (naru task 2537)', () => {
  const serverCli = (id: number, title: string): WorkflowNode => ({
    ...node(id, 'cli', { command: 'x' }, title),
    pins: {
      in: [{ name: 'stdin', ty: 'string' }],
      out: [
        { name: 'stdout', ty: 'string' },
        { name: 'stderr', ty: 'string' },
        { name: 'exit_code', ty: 'number' },
      ],
    },
  })
  const edge = (id: number, from: number, to: number, kind: 'exec' | 'data', from_pin: string | null, to_pin: string | null) => ({
    id, workflow_id: 1, from_node: from, to_node: to, branch: null, from_pin, to_pin, kind,
  })

  it('shows the server pins after the declared ones, but defaults stay declared-only', async () => {
    const { pinsOf, pinType, effectivePin } = await import('./workflowTypes')
    const a = serverCli(1, 'A')
    expect(pinsOf(a, types).outputs.map((p) => p.name)).toEqual(['stdout', 'stderr', 'exit_code'])
    expect(pinType(a, 'out', 'exit_code', types)).toBe('number')
    expect(pinType(a, 'out', null, types)).toBe('any')
    expect(effectivePin(a, 'out', null, types)).toBeNull()
    // A declared pin of the same name wins, type included, and is listed once.
    const d = { ...a, config: { command: 'x', pins: { out: [{ name: 'stderr', ty: 'Review' }] } } }
    expect(pinsOf(d, types).outputs).toEqual([
      { name: 'stderr', ty: 'Review' },
      { name: 'stdout', ty: 'string' },
      { name: 'exit_code', ty: 'number' },
    ])
  })

  it('makes pin-to-pin a data wire, flow handles and break/make exec', async () => {
    const { wireKind } = await import('./workflowTypes')
    const a = serverCli(1, 'A')
    const b = serverCli(2, 'B')
    expect(wireKind(a, 'stderr', b, 'stdin')).toBe('data')
    expect(wireKind(a, 'stderr', b, null)).toBe('exec')
    expect(wireKind(a, null, b, 'stdin')).toBe('exec')
    expect(wireKind(a, 'stdout', node(3, 'break', { struct: 'Review' }), 'value')).toBe('exec')
    expect(wireKind(node(4, 'make', { struct: 'Review' }), 'value', b, 'stdin')).toBe('exec')
  })

  it('lists the data wires into a node and what each one fills', async () => {
    const { dataInputs } = await import('./workflowTypes')
    const a = serverCli(1, 'A')
    const b = serverCli(2, 'B')
    const p = node(3, 'prompt', { prompt: 'x' }, 'P')
    const nodes = [a, b, p]
    const edges = [
      edge(10, 1, 2, 'exec', null, null),
      edge(12, 1, 2, 'data', 'stdout', 'stdin'),
      edge(11, 1, 2, 'data', 'stderr', 'stdin'),
      edge(13, 1, 3, 'data', 'stdout', 'model'),
      edge(14, 2, 3, 'data', 'stdout', 'input'),
    ]
    expect(dataInputs(b, edges, nodes)).toEqual([
      { pin: 'stdin', from: 'A', fromPin: 'stderr', feedsInput: true, shadowed: false },
      { pin: 'stdin', from: 'A', fromPin: 'stdout', feedsInput: true, shadowed: true },
    ])
    expect(dataInputs(p, edges, nodes).map((d) => [d.pin, d.feedsInput, d.shadowed])).toEqual([
      ['model', false, false],
      ['input', true, false],
    ])
    expect(dataInputs(a, edges, nodes)).toEqual([])
  })
})
