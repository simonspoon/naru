import { describe, expect, it } from 'vitest'
import { formatDuration, gateBadge, gateByNode, handledFailures, hasOutputPanel, runPollMs, runSummary, runningRunId, stepClass, stepCounts, stepOutput, stepStatusByNode, triggerLabel } from './workflowRun'
import type { WorkflowGate } from './types/WorkflowGate'
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
  started_at: null,
  log: null,
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

describe('handledFailures', () => {
  it('marks a failed step whose node has a wired failure exit', () => {
    const r = run([step(1, 'failed'), step(2, 'ok'), step(3, 'failed'), step(4, 'ok')])
    const edges = [
      { from_node: 1, branch: 'failure', kind: 'exec' as const },
      { from_node: 3, branch: null, kind: 'exec' as const },
      { from_node: 3, branch: 'failure', kind: 'data' as const },
      { from_node: 4, branch: 'failure', kind: 'exec' as const },
    ]
    expect([...handledFailures(r, edges)]).toEqual([1])
    expect(handledFailures(null, edges).size).toBe(0)
  })
})

describe('runSummary', () => {
  it('counts steps and names the failure', () => {
    const r = run([step(1, 'ok'), step(2, 'failed'), step(3, 'skipped')], { status: 'failed', error: 'node "b" failed' })
    expect(stepCounts(r)).toEqual({ running: 0, ok: 1, skipped: 1, failed: 1 })
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
    expect(triggerLabel({ trigger: 'ambient', trigger_phrase: null, trigger_events: ['idea', 'wake'] })).toBe(
      'ambient · idea, wake',
    )
    expect(triggerLabel({ trigger: 'ambient', trigger_phrase: null, trigger_events: [] })).toBe('ambient')
  })
})

describe('live run', () => {
  it('counts and classes a running step', () => {
    const r = run([step(1, 'ok'), step(2, 'running')], { status: 'running' })
    expect(stepCounts(r).running).toBe(1)
    expect(stepClass('running')).toBe('step-running')
    expect(runSummary(r)).toBe('running · 1 ok, 1 running')
  })

  it('picks the newest running run, or none', () => {
    expect(runningRunId(null)).toBeNull()
    expect(runningRunId([run([], { id: 3 }), run([], { id: 2 })])).toBeNull()
    expect(
      runningRunId([run([], { id: 4, status: 'running' }), run([], { id: 3, status: 'running' })]),
    ).toBe(4)
  })

  it('polls fast only while something runs', () => {
    expect(runPollMs(false, null)).toBe(5000)
    expect(runPollMs(true, null)).toBe(1000)
    expect(runPollMs(false, 7)).toBe(1000)
  })
})

describe('gate helpers (naru task 1993)', () => {
  const gate = (over: Partial<WorkflowGate>): WorkflowGate => ({
    id: 1,
    run_id: 1,
    node_id: 5,
    workflow_id: 1,
    message: '',
    status: 'pending',
    reason: null,
    created_at: '',
    decided_at: null,
    ...over,
  })
  it('keys gates by node, newest first wins', () => {
    const m = gateByNode([gate({ id: 9, node_id: 5 }), gate({ id: 3, node_id: 5 }), gate({ id: 4, node_id: 6 })])
    expect(m.get(5)?.id).toBe(9)
    expect(m.get(6)?.id).toBe(4)
    expect(gateByNode(null).size).toBe(0)
  })
  it('words the badge, naming a timeout', () => {
    expect(gateBadge(gate({}))).toEqual({ text: 'waiting', tone: 'waiting' })
    expect(gateBadge(gate({ status: 'approved' }))).toEqual({ text: 'approved', tone: 'approved' })
    expect(gateBadge(gate({ status: 'rejected' }))).toEqual({ text: 'rejected', tone: 'rejected' })
    expect(gateBadge(gate({ status: 'rejected', reason: 'timed out' }))).toEqual({
      text: 'rejected — timed out',
      tone: 'rejected',
    })
  })
})

describe('output panel', () => {
  it('is offered on cli and script nodes only', () => {
    expect(hasOutputPanel('cli')).toBe(true)
    expect(hasOutputPanel('script')).toBe(true)
    expect(hasOutputPanel('prompt')).toBe(false)
    expect(hasOutputPanel('subworkflow')).toBe(false)
  })

  it('shows the step log, or nothing before the node has a step', () => {
    const live = { ...step(2, 'running'), log: 'one\ntwo\n' }
    expect(stepOutput(run([live]), 2)).toEqual({ status: 'running', text: 'one\ntwo\n' })
    expect(stepOutput(run([live]), 3)).toBeNull()
    expect(stepOutput(null, 2)).toBeNull()
  })

  it('falls back to output and error for a step without a log', () => {
    const old = { ...step(2, 'failed'), output: 'out', error: 'exited 1: bad' }
    expect(stepOutput(run([old]), 2)?.text).toBe('out\nexited 1: bad')
  })
})
