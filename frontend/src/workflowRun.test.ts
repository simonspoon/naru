import { describe, expect, it } from 'vitest'
import { formatDuration, runSummary, stepClass, stepCounts, stepStatusByNode, triggerLabel } from './workflowRun'
import type { WorkflowRun } from './types/WorkflowRun'
import type { WorkflowStep } from './types/WorkflowStep'

const step = (node_id: number, status: WorkflowStep['status']): WorkflowStep => ({
  node_id,
  title: `n${node_id}`,
  kind: 'cli',
  status,
  output: '',
  error: null,
  duration_ms: 5,
})

const run = (steps: WorkflowStep[], over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1,
  workflow_id: 1,
  trigger: 'manual',
  input: '',
  status: 'succeeded',
  steps,
  error: null,
  started_at: '',
  finished_at: null,
  ...over,
})

describe('stepStatusByNode', () => {
  it('maps each recorded step to its node and is empty before a run', () => {
    const m = stepStatusByNode(run([step(1, 'ok'), step(2, 'skipped'), step(3, 'failed')]))
    expect(m.get(1)).toBe('ok')
    expect(m.get(2)).toBe('skipped')
    expect(m.get(3)).toBe('failed')
    expect(m.get(4)).toBeUndefined()
    expect(stepStatusByNode(null).size).toBe(0)
  })
})

describe('stepClass', () => {
  it('paints nothing before a run', () => {
    expect(stepClass(undefined)).toBe('')
    expect(stepClass('failed')).toBe('step-failed')
  })
})

describe('runSummary', () => {
  it('counts steps and names the failure', () => {
    const r = run([step(1, 'ok'), step(2, 'failed'), step(3, 'skipped')], { status: 'failed', error: 'node "b" failed' })
    expect(stepCounts(r)).toEqual({ ok: 1, skipped: 1, failed: 1 })
    expect(runSummary(r)).toBe('failed · 1 ok, 1 skipped, 1 failed — node "b" failed')
    expect(runSummary(run([step(1, 'ok')]))).toBe('succeeded · 1 ok')
  })
})

describe('formatDuration', () => {
  it('switches to seconds at one second', () => {
    expect(formatDuration(420)).toBe('420 ms')
    expect(formatDuration(1234)).toBe('1.2 s')
  })
})

describe('triggerLabel', () => {
  it('says what starts it', () => {
    expect(triggerLabel({ trigger: null, trigger_phrase: null })).toBe('no trigger')
    expect(triggerLabel({ trigger: 'time', trigger_phrase: null })).toBe('time')
    expect(triggerLabel({ trigger: 'voice', trigger_phrase: 'capture' })).toBe('voice · “capture”')
  })
})
