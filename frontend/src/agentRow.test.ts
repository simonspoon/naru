import { describe, expect, it } from 'vitest'
import {
  agentHeadline,
  agentKindOf,
  agentRowActions,
  agentTint,
  formatContextTokens,
  headlineSince,
  naruTimeMs,
  stepTrail,
  isRunPaneId,
  parseRunPaneId,
  responsePreview,
  rowPaneId,
  runPaneId,
} from './agentRow'

describe('formatContextTokens', () => {
  it('shows a sub-1k count exactly', () => {
    expect(formatContextTokens(1)).toBe('1')
    expect(formatContextTokens(999)).toBe('999')
  })

  it('compacts thousands to one decimal', () => {
    expect(formatContextTokens(1000)).toBe('1k')
    expect(formatContextTokens(48_200)).toBe('48.2k')
    expect(formatContextTokens(999_400)).toBe('999.4k')
  })

  it('compacts millions the same way', () => {
    expect(formatContextTokens(1_000_000)).toBe('1M')
    expect(formatContextTokens(1_100_000)).toBe('1.1M')
  })

  it('renders nothing rather than a zero that reads as a measurement', () => {
    expect(formatContextTokens(0)).toBeNull()
    expect(formatContextTokens(-5)).toBeNull()
  })

  it('renders nothing when there is no usage line yet', () => {
    expect(formatContextTokens(null)).toBeNull()
    expect(formatContextTokens(undefined)).toBeNull()
    expect(formatContextTokens(Number.NaN)).toBeNull()
  })
})

describe('responsePreview', () => {
  it('passes a plain one-line response through', () => {
    expect(responsePreview('Ran the tests, all green.')).toBe('Ran the tests, all green.')
  })

  it('collapses newlines and runs of whitespace to single spaces', () => {
    expect(responsePreview('first line\n\nsecond   line\tthird')).toBe('first line second line third')
  })

  it('trims the edges', () => {
    expect(responsePreview('\n  reading the file  \n')).toBe('reading the file')
  })

  it('renders nothing for empty, whitespace-only or absent text', () => {
    expect(responsePreview('')).toBeNull()
    expect(responsePreview('   \n\t ')).toBeNull()
    expect(responsePreview(null)).toBeNull()
    expect(responsePreview(undefined)).toBeNull()
  })
})

describe('agentHeadline (mesa task 1484)', () => {
  const running = { pid: 1, state: 'working' as string | null }

  it('prefers the server-lifted activity over the latest prose while running', () => {
    expect(agentHeadline({ ...running, activity: 'Adding  tests', lastResponse: 'done' })).toBe(
      'Adding tests',
    )
  })

  it('falls back to the latest prose, then to nothing', () => {
    expect(agentHeadline({ ...running, activity: null, lastResponse: 'On it.' })).toBe('On it.')
    expect(agentHeadline({ ...running, activity: '  ', lastResponse: null })).toBeNull()
  })

  it('shows the closing reply, not a stale activity, once the session is done or gone', () => {
    const stale = { activity: 'Adding tests', lastResponse: 'All done.' }
    expect(agentHeadline({ pid: 1, state: 'done', ...stale })).toBe('All done.')
    expect(agentHeadline({ pid: null, state: 'working', ...stale })).toBe('All done.')
  })
})

describe('agentTint', () => {
  it('is active while working and busy', () => {
    expect(agentTint({ state: 'working', status: 'busy' })).toBe('active')
    expect(agentTint({ state: null, status: 'busy' })).toBe('active')
  })

  it('is stale for the idle + working pair', () => {
    expect(agentTint({ state: 'working', status: 'idle' })).toBe('stale')
  })

  it('is null for every other state', () => {
    expect(agentTint({ state: 'done', status: 'idle' })).toBeNull()
    expect(agentTint({ state: 'blocked', status: 'busy' })).toBeNull()
    expect(agentTint({ state: 'failed', status: null })).toBeNull()
    expect(agentTint({ state: null, status: 'idle' })).toBeNull()
  })
})

describe('agent row kinds', () => {
  const bg = { id: 'ab12', kind: 'background', runId: null, status: 'busy' }
  const inter = { id: null, kind: 'interactive', runId: null, status: 'busy' }
  const run = { id: null, kind: 'runner', runId: 'r1', status: 'busy' }

  it('classifies the three kinds', () => {
    expect(agentKindOf(bg)).toBe('background')
    expect(agentKindOf(inter)).toBe('interactive')
    expect(agentKindOf(run)).toBe('runner')
    expect(agentKindOf({ ...run, runId: null })).toBe('interactive')
  })

  it('background rows attach and stop through claude', () => {
    expect(agentRowActions(bg)).toEqual({
      attachable: true,
      openable: true,
      stop: { route: 'agent', id: 'ab12' },
      note: null,
    })
  })

  it('interactive rows get only the external-terminal note', () => {
    expect(agentRowActions(inter)).toEqual({
      attachable: false,
      openable: false,
      stop: null,
      note: 'external terminal — not attachable',
    })
  })

  it('runner rows stop through the run route, never attach, no note', () => {
    expect(agentRowActions(run)).toEqual({
      attachable: false,
      openable: true,
      stop: { route: 'run', id: 'r1' },
      note: null,
    })
  })

  it('an idle live run keeps its stop; a terminal run (no status) has none', () => {
    expect(agentRowActions({ ...run, status: 'idle' }).stop).toEqual({ route: 'run', id: 'r1' })
    expect(agentRowActions({ ...run, status: null }).stop).toBeNull()
  })
})

describe('run pane ids', () => {
  const run = { id: null, kind: 'runner', runId: 'r1' } as const
  it('prefix the run id so it never collides with a job id', () => {
    expect(runPaneId('r1')).toBe('run:r1')
    expect(isRunPaneId('run:r1')).toBe(true)
    expect(isRunPaneId('child:a:sub:b')).toBe(false)
    expect(isRunPaneId('abc123')).toBe(false)
    expect(parseRunPaneId('run:r1')).toBe('r1')
    expect(parseRunPaneId('run:')).toBeNull()
    expect(parseRunPaneId('abc123')).toBeNull()
  })
  it('rowPaneId picks the pane a row opens', () => {
    expect(rowPaneId(run)).toBe('run:r1')
    expect(rowPaneId({ id: 'j1', kind: 'background', runId: null })).toBe('j1')
    expect(rowPaneId({ id: null, kind: 'interactive', runId: null })).toBeNull()
  })
})

describe('headlineSince', () => {
  const running = { pid: 42, state: 'working' } as const
  const at = '2026-10-12 08:00:00'
  const ms = Date.UTC(2026, 9, 12, 8, 0, 0)

  it('returns the step start while the headline is the activity', () => {
    expect(headlineSince({ ...running, activity: 'Running tests', activitySince: at })).toBe(ms)
  })

  it('is null for a done agent, no activity, or no timestamp', () => {
    expect(headlineSince({ pid: 42, state: 'done', activity: 'x', activitySince: at })).toBeNull()
    expect(headlineSince({ ...running, activity: null, activitySince: at })).toBeNull()
    expect(headlineSince({ ...running, activity: '  ', activitySince: at })).toBeNull()
    expect(headlineSince({ ...running, activity: 'x', activitySince: null })).toBeNull()
  })

  it('parses Naru timestamps as UTC', () => {
    expect(naruTimeMs(at)).toBe(ms)
    expect(naruTimeMs('garbage')).toBeNull()
    expect(naruTimeMs(null)).toBeNull()
  })
})

describe('stepTrail', () => {
  it('lists newest first with whitespace collapsed and empties dropped', () => {
    const trail = stepTrail({
      recentSteps: [
        { text: 'first', at: '2026-10-12 08:00:00' },
        { text: '  ', at: null },
        { text: 'second\n  step', at: null },
      ],
    })
    expect(trail).toEqual([
      { text: 'second step', atMs: null },
      { text: 'first', atMs: Date.UTC(2026, 9, 12, 8, 0, 0) },
    ])
  })

  it('is empty for no steps', () => {
    expect(stepTrail({ recentSteps: [] })).toEqual([])
  })
})
