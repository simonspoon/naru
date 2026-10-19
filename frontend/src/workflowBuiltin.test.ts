import { describe, expect, it } from 'vitest'
import {
  BUILTIN_TITLE,
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
    expect(installLine(v('Task loop', true))).toBe('Task loop — on')
  })
})
