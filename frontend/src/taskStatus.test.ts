import { describe, expect, it } from 'vitest'
import { statusLabel } from './taskStatus'

describe('statusLabel', () => {
  it('shows todo as queued', () => {
    expect(statusLabel('todo')).toBe('queued')
  })
  it('leaves every other status as stored', () => {
    expect(statusLabel('backlog')).toBe('backlog')
    expect(statusLabel('in_progress')).toBe('in_progress')
    expect(statusLabel('done')).toBe('done')
    expect(statusLabel('cancelled')).toBe('cancelled')
  })
})
