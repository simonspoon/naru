import { describe, expect, it } from 'vitest'
import {
  NODE_KINDS,
  branchForHandle,
  decodeKindDrag,
  buildConfig,
  defaultConfig,
  draftFromConfig,
  hasInput,
  hasOutput,
  missingValueRows,
  summarize,
} from './workflowConfig'
import type { WorkflowNodeKind } from './types/WorkflowNodeKind'

const kinds = NODE_KINDS.map((k) => k.kind)

describe('defaultConfig', () => {
  it('survives its own round trip through the editor for every kind', () => {
    for (const kind of kinds) {
      const config = defaultConfig(kind)
      const built = buildConfig(kind, draftFromConfig(kind, config))
      expect(built.error, kind).toBeNull()
      expect(built.config, kind).toEqual(config)
    }
  })
  it('uses the given script, else a placeholder', () => {
    expect(defaultConfig('script', 'notes')).toEqual({ script: 'notes', values: {} })
    expect(defaultConfig('script')).toEqual({ script: 'unset', values: {} })
  })
})

describe('summarize', () => {
  it('reads like the mockup', () => {
    expect(summarize('prompt', { model: 'haiku', thinking: false, prompt: 'x' })).toBe('Haiku · prompt')
    expect(summarize('prompt', { model: 'local:llama3', thinking: true, prompt: 'x' })).toBe('local:llama3 · thinking · prompt')
    expect(summarize('branch', { op: 'score_above', value: 0.8 })).toBe('score > 0.8')
    expect(summarize('trigger', { mode: 'manual' })).toBe('manual')
    expect(summarize('trigger', { mode: 'time', every_minutes: 10 })).toBe('every 10 min')
    expect(summarize('trigger', { mode: 'voice', phrase: 'capture a thought' })).toBe('voice · “capture a thought”')
    expect(summarize('output', { target: 'log', log: 'ambient' })).toBe('log · ambient')
    expect(summarize('output', { target: 'inbox', task_id: 7, kind: 'task-summary' })).toBe('inbox · task 7')
  })
  it('clips a long command to one line', () => {
    const line = summarize('cli', { command: `echo ${'a'.repeat(100)}\nsecond line` })
    expect(line.length).toBeLessThanOrEqual(34)
    expect(line.endsWith('…')).toBe(true)
    expect(line).not.toContain('\n')
  })
  it('does not throw on a malformed config', () => {
    for (const kind of kinds) expect(() => summarize(kind, {})).not.toThrow()
  })
})

describe('buildConfig', () => {
  const draft = (kind: WorkflowNodeKind, over: Record<string, unknown>) => ({
    ...draftFromConfig(kind, {}),
    ...over,
  })

  it('requires every_minutes for a time trigger only', () => {
    expect(buildConfig('trigger', draft('trigger', { mode: 'time' })).error).toMatch(/every minutes/)
    expect(buildConfig('trigger', draft('trigger', { mode: 'time', every_minutes: '0' })).error).not.toBeNull()
    expect(buildConfig('trigger', draft('trigger', { mode: 'time', every_minutes: '10081' })).error).not.toBeNull()
    expect(buildConfig('trigger', draft('trigger', { mode: 'time', every_minutes: '10' })).config).toEqual({
      mode: 'time',
      every_minutes: 10,
    })
    // a stale value left in the field is not sent for a manual trigger
    expect(buildConfig('trigger', draft('trigger', { mode: 'manual', every_minutes: '10' })).config).toEqual({ mode: 'manual' })
  })

  it('checks the prompt model, text and timeout', () => {
    const base = { prompt: 'hi' }
    expect(buildConfig('prompt', draft('prompt', { ...base, model: 'gpt' })).error).toMatch(/model/)
    expect(buildConfig('prompt', draft('prompt', { ...base, model: 'local:' })).error).toMatch(/model/)
    expect(buildConfig('prompt', draft('prompt', { prompt: '  ' })).error).toMatch(/empty/)
    expect(buildConfig('prompt', draft('prompt', { ...base, timeout_secs: '3601' })).error).toMatch(/timeout/)
    expect(buildConfig('prompt', draft('prompt', { ...base, model: 'local:llama3.2', thinking: true, timeout_secs: '30' })).config).toEqual({
      model: 'local:llama3.2',
      thinking: true,
      prompt: 'hi',
      timeout_secs: 30,
    })
  })

  it('keeps a cli command verbatim', () => {
    expect(buildConfig('cli', draft('cli', { command: 'echo $(date)  ' })).config).toEqual({ command: 'echo $(date)  ' })
    expect(buildConfig('cli', draft('cli', { command: '' })).error).not.toBeNull()
  })

  it('drops blank script value rows', () => {
    const r = buildConfig('script', draft('script', { script: ' notes ', values: [['text', '{input}'], ['', 'x']] }))
    expect(r.config).toEqual({ script: 'notes', values: { text: '{input}' } })
    expect(buildConfig('script', draft('script', { script: '' })).error).toMatch(/script/)
  })

  it('stores a score threshold as a number and refuses a non-number', () => {
    expect(buildConfig('branch', draft('branch', { op: 'score_above', value: '0.8' })).config).toEqual({ op: 'score_above', value: 0.8 })
    expect(buildConfig('branch', draft('branch', { op: 'score_below', value: 'high' })).error).toMatch(/numeric/)
    expect(buildConfig('branch', draft('branch', { op: 'equals', value: ' ok' })).config).toEqual({ op: 'equals', value: ' ok' })
    expect(buildConfig('branch', draft('branch', { op: 'regex', value: '' })).error).not.toBeNull()
  })

  it('sends only the keys of the chosen output target', () => {
    const stale = { log: 'old', project: 'p', task_id: '3', kind: 'task-summary', title: 't' }
    expect(buildConfig('output', draft('output', { ...stale, target: 'log' })).config).toEqual({ target: 'log', log: 'old' })
    expect(buildConfig('output', draft('output', { ...stale, target: 'task' })).config).toEqual({ target: 'task', project: 'p' })
    expect(buildConfig('output', draft('output', { ...stale, target: 'inbox' })).config).toEqual({
      target: 'inbox',
      task_id: 3,
      kind: 'task-summary',
    })
    expect(buildConfig('output', draft('output', { ...stale, target: 'board' })).config).toEqual({ target: 'board', title: 't' })
    expect(buildConfig('output', draft('output', { target: 'board', title: '' })).config).toEqual({ target: 'board' })
    expect(buildConfig('output', draft('output', { target: 'inbox', task_id: '' })).error).toMatch(/task id/)
    expect(buildConfig('output', draft('output', { target: 'task', project: '' })).error).toMatch(/project/)
    expect(buildConfig('output', draft('output', { target: 'log', log: '  ' })).config).toEqual({ target: 'log', log: 'default' })
  })
})

describe('graph rules', () => {
  it('only a branch edge carries a branch, defaulting to true', () => {
    expect(branchForHandle('cli', 'false')).toBeUndefined()
    expect(branchForHandle('branch', 'false')).toBe('false')
    expect(branchForHandle('branch', 'true')).toBe('true')
    expect(branchForHandle('branch', null)).toBe('true')
  })
  it('a trigger takes no input and an output offers no output', () => {
    expect(hasInput('trigger')).toBe(false)
    expect(hasInput('cli')).toBe(true)
    expect(hasOutput('output')).toBe(false)
    expect(hasOutput('branch')).toBe(true)
  })
})

describe('missingValueRows', () => {
  it('offers a row for each declared argument not yet given a value', () => {
    expect(missingValueRows(['a', 'b'], [['a', '1']])).toEqual([['b', '']])
  })
})

describe('decodeKindDrag', () => {
  it('accepts exactly the six kinds', () => {
    for (const kind of kinds) expect(decodeKindDrag(kind)).toBe(kind)
    expect(decodeKindDrag('')).toBeNull()
    expect(decodeKindDrag('diagram')).toBeNull()
    expect(decodeKindDrag('/etc/passwd')).toBeNull()
  })
})
