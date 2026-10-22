import { describe, expect, it } from 'vitest'
import type { WorkflowSnapshot } from './types/WorkflowSnapshot'
import {
  BUILTIN_TITLE,
  builtinRepoints,
  builtinUpdateBadge,
  builtinUpdateDiff,
  builtinUpdateHead,
  builtinUpdateNote,
  duplicateLabel,
  installHeadline,
  installLine,
  isBuiltin,
  readOnlyTitle,
} from './workflowBuiltin'

describe('workflowBuiltin', () => {
  it('reads the built-in flag', () => {
    expect(isBuiltin({ builtin: true })).toBe(true)
    expect(isBuiltin({ builtin: false })).toBe(false)
  })
  it('relabels duplicate only on a built-in', () => {
    expect(duplicateLabel({ builtin: true })).toBe('Duplicate to customise')
    expect(duplicateLabel({ builtin: false })).toBe('duplicate')
  })
  it('gives a tooltip only when read-only', () => {
    expect(readOnlyTitle(true)).toBe(BUILTIN_TITLE)
    expect(readOnlyTitle(false)).toBeUndefined()
  })
  it('words the install result honestly', () => {
    const v = (name: string, enabled: boolean) => ({ workflow: { name, enabled } }) as never
    expect(installHeadline({ created: [] })).toBe('All built-ins already installed.')
    expect(installHeadline({ created: [v('KB: ongoing capture', false)] })).toBe(
      'Installed or updated 1 built-in workflow.',
    )
    expect(installHeadline({ created: [v('a', false), v('b', true)] })).toBe(
      'Installed or updated 2 built-in workflows.',
    )
    expect(installLine(v('KB: ongoing capture', false))).toBe('KB: ongoing capture — off')
    expect(installLine(v('KB: mine past sessions', true))).toBe('KB: mine past sessions — on')
  })
})

const snap = (nodes: WorkflowSnapshot['nodes']): WorkflowSnapshot => ({
  name: 'w',
  description: null,
  enabled: true,
  types: [],
  nodes,
  edges: [],
})
const node = (id: number, kind: string, title: string, config: unknown = {}) =>
  ({ id, kind, title, config, x: 0, y: 0 }) as WorkflowSnapshot['nodes'][number]

describe('builtin update (naru task 2052)', () => {
  it('badges only a flagged copy', () => {
    expect(builtinUpdateBadge({ builtin_updated: false, name: 'A' })).toBeNull()
    const b = builtinUpdateBadge({ builtin_updated: true, name: 'A' })
    expect(b?.text).toBe('update available')
    expect(b?.label).toBe('Update available for A, review')
  })
  it('diffs the copy (-) against the built-in (+)', () => {
    const d = builtinUpdateDiff(snap([node(1, 'cli', 'Old')]), snap([node(2, 'cli', 'New')]))
    expect(d.some((l) => l.kind === 'mesa-only' && l.text.includes('Old'))).toBe(true)
    expect(d.some((l) => l.kind === 'disk-only' && l.text.includes('New'))).toBe(true)
  })
  it('says when the base is unknown', () => {
    expect(builtinUpdateHead({ base_rev: null, builtin_rev: 3 })).toMatch(/Base unknown/)
    expect(builtinUpdateHead({ base_rev: 1, builtin_rev: 3 })).toMatch(/revision 1.*now at 3/)
  })
  it('lists a subworkflow node the built-in would re-point', () => {
    const mine = snap([node(1, 'subworkflow', 'Child', { workflow: 'Loop (custom)' })])
    const theirs = snap([node(9, 'subworkflow', 'Child', { workflow: 'Loop' })])
    expect(builtinRepoints(mine, theirs)).toEqual([{ title: 'Child', from: 'Loop (custom)', to: 'Loop' }])
    expect(builtinRepoints(theirs, theirs)).toEqual([])
  })
  it('words the note after an answer', () => {
    expect(builtinUpdateNote('keep', 4)).toBe('Kept your version.')
    expect(builtinUpdateNote('take', 4)).toMatch(/revision 4.*History/)
  })
})
