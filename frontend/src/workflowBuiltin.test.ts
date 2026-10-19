import { describe, expect, it } from 'vitest'
import { BUILTIN_TITLE, duplicateLabel, isBuiltin, readOnlyTitle } from './workflowBuiltin'

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
})
