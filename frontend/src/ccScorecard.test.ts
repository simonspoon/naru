import { describe, expect, it } from 'vitest'
import {
  changeDate,
  fmtModelChange,
  fmtRunCost,
  fmtTaskOutcome,
  fmtTurns,
  fmtWall,
  scorecardQuery,
  scorecardRowKey,
  sortedChanges,
} from './ccScorecard'
import type { CcModelChange } from './types/CcModelChange'
import type { CcScorecardRow } from './types/CcScorecardRow'

const change = (p: Partial<CcModelChange>): CcModelChange => ({
  agent: 'implementer',
  at: '2026-09-22 10:00:00',
  from_model: null,
  to_model: 'opus',
  from_effort: null,
  to_effort: null,
  ...p,
})

describe('fmtWall', () => {
  it('picks the coarsest unit that reads', () => {
    expect(fmtWall(0.4)).toBe('0s')
    expect(fmtWall(45)).toBe('45s')
    expect(fmtWall(185)).toBe('3m 05s')
    expect(fmtWall(3720)).toBe('1h 02m')
    expect(fmtWall(-5)).toBe('0s')
  })
})

describe('fmtRunCost / fmtTurns', () => {
  it('shows sub-cent runs as less than a cent, not zero', () => {
    expect(fmtRunCost(0)).toBe('$0.00')
    expect(fmtRunCost(0.004)).toBe('<$0.01')
    expect(fmtRunCost(1.234)).toBe('$1.23')
  })
  it('drops a trailing .0 on turns', () => {
    expect(fmtTurns(4)).toBe('4')
    expect(fmtTurns(4.25)).toBe('4.3')
  })
})

describe('scorecardQuery', () => {
  it('omits blank bounds', () => {
    expect(scorecardQuery('', '')).toBe('')
    expect(scorecardQuery('2026-09-22', '')).toBe('?since=2026-09-22')
    expect(scorecardQuery('2026-09-22', '2026-10-01')).toBe('?since=2026-09-22&until=2026-10-01')
  })
})

describe('scorecardRowKey', () => {
  it('distinguishes the same agent on two models', () => {
    const r = (model: string) => ({ agent: 'a', model }) as CcScorecardRow
    expect(scorecardRowKey(r('x'))).not.toBe(scorecardRowKey(r('y')))
  })
})

describe('fmtTaskOutcome', () => {
  const r = (task_runs: number, task_done: number, task_requeued: number) =>
    ({ task_runs, task_done, task_requeued }) as CcScorecardRow
  it('shows done over n and the requeue count, a dash with no linked run', () => {
    expect(fmtTaskOutcome(r(4, 3, 1))).toBe('done 3/4 · requeued 1')
    expect(fmtTaskOutcome(r(1, 0, 0))).toBe('done 0/1 · requeued 0')
    expect(fmtTaskOutcome(r(0, 0, 0))).toBe('—')
  })
})

describe('model changes', () => {
  it('reads a first version as a set and a change as from → to with effort', () => {
    expect(fmtModelChange(change({}))).toBe('set to opus')
    expect(
      fmtModelChange(
        change({ from_model: 'claude-opus-4-8', to_model: 'claude-sonnet-4-6', to_effort: 'high' }),
      ),
    ).toBe('opus-4-8 → sonnet-4-6 (high)')
    expect(fmtModelChange(change({ from_model: 'sonnet', from_effort: 'high', to_model: 'sonnet', to_effort: 'low' }))).toBe(
      'sonnet (high) → sonnet (low)',
    )
  })
  it('sorts newest first and keeps the date part', () => {
    const a = change({ at: '2026-09-01 08:00:00' })
    const b = change({ at: '2026-09-22 10:00:00' })
    expect(sortedChanges([a, b])).toEqual([b, a])
    expect(changeDate(b)).toBe('2026-09-22')
  })
})
