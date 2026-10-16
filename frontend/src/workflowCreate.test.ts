import { describe, expect, it } from 'vitest'
import { createdWorkflowHref, globalWorkflowBody, validWorkflowName } from './workflowCreate'

describe('validWorkflowName', () => {
  it('trims', () => expect(validWorkflowName('  Nightly  ')).toBe('Nightly'))
  it('rejects empty and whitespace', () => {
    expect(validWorkflowName('')).toBeNull()
    expect(validWorkflowName('   ')).toBeNull()
  })
})

describe('globalWorkflowBody', () => {
  it('carries the trimmed name and no project_id', () => {
    const body = globalWorkflowBody(' Daily ')
    expect(body).toEqual({ name: 'Daily' })
    expect('project_id' in body).toBe(false)
  })
})

describe('createdWorkflowHref', () => {
  it('opens the global builder', () => expect(createdWorkflowHref(7)).toBe('#/workflows/7'))
})
