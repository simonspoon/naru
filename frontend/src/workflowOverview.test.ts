import { describe, expect, it } from 'vitest'
import {
  isScheduled,
  stateLabel,
  toggleLabel,
  lastFailureLabel,
  lastRunLabel,
  nextRunLabel,
  projectLabel,
  workflowHref,
} from './workflowOverview'
import type { Project } from './types/Project'
import type { Workflow } from './types/Workflow'

const NOW = Date.parse('2026-01-01T12:00:00Z')

function wf(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 7,
    project_id: 3,
    name: 'w',
    description: null,
    trigger: 'manual',
    trigger_phrase: null,
    trigger_events: [],
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    last_run_at: null,
    last_run_status: null,
    last_failure_at: null,
    next_run_at: null,
    enabled: true,
    ...over,
  }
}

describe('workflowOverview', () => {
  it('says on/off from the enabled flag and names the toggle action', () => {
    expect(stateLabel(wf())).toBe('on')
    expect(stateLabel(wf({ enabled: false }))).toBe('off')
    expect(toggleLabel(wf())).toBe('turn off')
    expect(toggleLabel(wf({ enabled: false }))).toBe('turn on')
    expect(nextRunLabel(wf({ trigger: 'time', enabled: false }), NOW)).toBe('—')
  })

  it('is scheduled only for an enabled time trigger', () => {
    expect(isScheduled(wf({ trigger: 'time' }))).toBe(true)
    expect(isScheduled(wf({ trigger: 'time', enabled: false }))).toBe(false)
    expect(isScheduled(wf({ trigger: 'voice' }))).toBe(false)
    expect(isScheduled(wf({ trigger: null }))).toBe(false)
  })

  it('names the project, or a dash for a global one', () => {
    const projects = [{ id: 3, name: 'Alpha' } as Project]
    expect(projectLabel(wf(), projects)).toBe('Alpha')
    expect(projectLabel(wf({ project_id: null }), projects)).toBe('—')
    expect(projectLabel(wf({ project_id: 9 }), projects)).toBe('project 9')
  })

  it('labels the last run and failure', () => {
    expect(lastRunLabel(wf(), NOW)).toBe('never')
    expect(
      lastRunLabel(wf({ last_run_at: '2026-01-01 11:55:00', last_run_status: 'failed' }), NOW),
    ).toBe('failed 5m ago')
    expect(lastFailureLabel(wf(), NOW)).toBe('—')
    expect(lastFailureLabel(wf({ last_failure_at: '2026-01-01 09:00:00' }), NOW)).toBe('3h ago')
  })

  it('derives the next run for a time workflow only', () => {
    expect(nextRunLabel(wf({ next_run_at: '2026-01-01 13:00:00' }), NOW)).toBe('—')
    const t = { trigger: 'time' as const }
    expect(nextRunLabel(wf(t), NOW)).toBe('due')
    expect(nextRunLabel(wf({ ...t, next_run_at: '2026-01-01 11:00:00' }), NOW)).toBe('due')
    expect(nextRunLabel(wf({ ...t, next_run_at: '2026-01-01 12:05:00' }), NOW)).toBe('in 5m')
    expect(nextRunLabel(wf({ ...t, next_run_at: '2026-01-01 15:00:00' }), NOW)).toBe('in 3h')
  })

  it('links to the owning project only', () => {
    expect(workflowHref(wf())).toBe('#/projects/3/workflows/7')
    expect(workflowHref(wf({ project_id: null }))).toBeNull()
  })
})
