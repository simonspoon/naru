import { beforeEach, describe, expect, it } from 'vitest'
import {
  NODE_KINDS,
  PALETTE_COLLAPSED_KEY,
  PALETTE_GROUPS,
  loadPaletteCollapsed,
  savePaletteCollapsed,
  branchForHandle,
  edgeLabelClass,
  edgeNeedsBranch,
  sourceHandles,
  decodeKindDrag,
  buildConfig,
  defaultConfig,
  draftFromConfig,
  hasInput,
  inspectorKey,
  hasOutput,
  missingValueRows,
  summarize,
  webhookSample,
} from './workflowConfig'
import type { WorkflowNodeKind } from './types/WorkflowNodeKind'

const kinds = NODE_KINDS.map((k) => k.kind)

describe('defaultConfig', () => {
  it('survives its own round trip through the editor for every kind', () => {
    for (const kind of kinds) {
      // A sub-workflow has no sensible default child: it must be picked.
      if (kind === 'subworkflow') continue
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
    expect(summarize('decide', { question: 'q', options: ['a', 'b'], threshold: 0.7 })).toBe('a | b · ≥ 0.7')
    expect(summarize('trigger', { mode: 'manual' })).toBe('manual')
    expect(summarize('trigger', { mode: 'time', every_minutes: 10 })).toBe('every 10 min')
    expect(summarize('trigger', { mode: 'ambient', events: ['idea', 'wake'] })).toBe('ambient · idea, wake')
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

  it('requires at least one known event for an ambient trigger', () => {
    const d = (over: object) => draft('trigger', { mode: 'ambient', ...over })
    expect(buildConfig('trigger', d({})).error).toMatch(/at least one event/)
    expect(buildConfig('trigger', d({ events: ['nope'] })).error).toMatch(/events must be/)
    expect(buildConfig('trigger', d({ events: ['wake', 'idea'] })).config).toEqual({
      mode: 'ambient',
      events: ['idea', 'wake'],
    })
    // stale events left in the draft are not sent for another mode
    expect(buildConfig('trigger', draft('trigger', { mode: 'manual', events: ['idea'] })).config).toEqual({ mode: 'manual' })
  })

  it('builds a schedule from an interval or a UTC cron, never both', () => {
    const b = (over: Record<string, string>) => buildConfig('schedule', draft('schedule', over))
    expect(b({ every_minutes: '15' }).config).toEqual({ every_minutes: 15 })
    expect(b({ every_minutes: '0' }).error).toMatch(/1 to 10080/)
    expect(b({ every_minutes: '10081' }).error).not.toBeNull()
    expect(b({ every_minutes: '10080' }).error).toBeNull()
    expect(b({ every_minutes: '' }).error).not.toBeNull()
    // a cron wins over a stale interval, whitespace normalised
    expect(b({ cron: ' */5   * * * * ', every_minutes: '9' }).config).toEqual({ cron: '*/5 * * * *' })
    expect(b({ cron: '* * * *' }).error).toMatch(/5 fields/)
    expect(b({ cron: '60 * * * *' }).error).toMatch(/out of range/)
    expect(b({ cron: '*/0 * * * *' }).error).toMatch(/step/)
    expect(b({ cron: '5-1 * * * *' }).error).toMatch(/backwards/)
    expect(b({ cron: 'x * * * *' }).error).toMatch(/number/)
    expect(b({ cron: '0 9-17 * * 1-5,7' }).error).toBeNull()
    expect(summarize('schedule', { every_minutes: 15 })).toBe('every 15 min')
    expect(summarize('schedule', { cron: '*/5 * * * *' })).toBe('cron */5 * * * * UTC')
    expect(hasInput('schedule')).toBe(false)
  })

  it('builds a webhook from its body type and treats it as a trigger', () => {
    const b = (over: Record<string, string>) => buildConfig('webhook', draft('webhook', over))
    expect(b({}).config).toEqual({})
    expect(b({ json_type: 'any' }).config).toEqual({})
    expect(b({ json_type: 'number' }).config).toEqual({ type: 'number' })
    expect(summarize('webhook', { type: 'number' })).toBe('POST → number')
    expect(summarize('webhook', {})).toBe('POST → any')
    expect(hasInput('webhook')).toBe(false)
    expect(webhookSample('number')).toBe('1')
    expect(webhookSample('list<string>')).toBe('[]')
    expect(webhookSample('Point')).toBe('{}')
  })

  it('builds a task-event, refuses a status on created, and treats it as a trigger', () => {
    const b = (over: Record<string, string>) => buildConfig('task-event', draft('task-event', over))
    expect(b({}).config).toEqual({ event: 'created' })
    expect(b({ te_event: 'status', te_status: 'done', project: ' naru ' }).config).toEqual({
      event: 'status',
      status: 'done',
      project: 'naru',
    })
    expect(b({ te_event: 'created', te_status: 'done' }).error).toMatch(/status needs event/)
    expect(summarize('task-event', { event: 'created' })).toBe('created · any project')
    expect(summarize('task-event', { event: 'status', status: 'done', project: 'naru' })).toBe('status → done · naru')
    expect(summarize('task-event', { event: 'any' })).toBe('any change · any project')
    expect(hasInput('task-event')).toBe(false)
  })

  it('builds a file-watch, refuses an empty path, and treats it as a trigger', () => {
    const b = (over: Record<string, string>) => buildConfig('file-watch', draft('file-watch', over))
    expect(b({}).error).toMatch(/path required/)
    expect(b({ fw_path: ' /tmp/x ', fw_event: 'modified' }).config).toEqual({ path: '/tmp/x', event: 'modified' })
    expect(b({ fw_path: '/tmp/x', fw_event: 'bogus' }).config).toEqual({ path: '/tmp/x', event: 'any' })
    expect(summarize('file-watch', { path: '', event: 'any' })).toBe('any · no path')
    expect(summarize('file-watch', { path: '/tmp/x', event: 'modified' })).toBe('modified · /tmp/x')
    expect(hasInput('file-watch')).toBe(false)
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

  it('builds an agent node and checks its fields', () => {
    const d = (over: Record<string, unknown>) => ({
      ...draftFromConfig('agent', { agent: 'reviewer', prompt: 'go' }),
      ...over,
    })
    expect(buildConfig('agent', d({})).config).toEqual({ agent: 'reviewer', prompt: 'go' })
    expect(buildConfig('agent', d({ agent: ' ' })).error).toMatch(/agent/)
    expect(buildConfig('agent', d({ prompt: ' ' })).error).toMatch(/empty/)
    expect(buildConfig('agent', d({ model: 'gpt' })).error).toMatch(/model/)
    expect(buildConfig('agent', d({ timeout_secs: '0' })).error).toMatch(/timeout/)
    expect(buildConfig('agent', d({ model: 'opus', result_type: 'Review', retry: false })).config).toEqual({
      agent: 'reviewer',
      prompt: 'go',
      model: 'opus',
      result_type: 'Review',
      retry: false,
    })
    expect(summarize('agent', { agent: 'reviewer', model: 'sonnet' })).toBe('reviewer · sonnet')
    expect(summarize('agent', { agent: 'reviewer' })).toBe('reviewer · default')
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

  it("checks a decide node's question, options and threshold", () => {
    const d = (over: Record<string, unknown>) =>
      buildConfig('decide', draft('decide', { question: 'q', options: ['a', 'b'], ...over }))
    expect(d({}).config).toEqual({ question: 'q', options: ['a', 'b'], threshold: 0.5 })
    expect(d({ options: [' a ', '', 'b'], threshold: '0.8' }).config).toEqual({ question: 'q', options: ['a', 'b'], threshold: 0.8 })
    expect(d({ question: ' ' }).error).toMatch(/question/)
    expect(d({ options: ['a'] }).error).toMatch(/two options/)
    expect(d({ options: ['a', 'a'] }).error).toMatch(/distinct/)
    expect(d({ options: ['a', 'fallback'] }).error).toMatch(/fallback/)
    expect(d({ threshold: '1.5' }).error).toMatch(/threshold/)
    expect(d({ threshold: 'x' }).error).toMatch(/threshold/)
    expect(d({ threshold: '0' }).config).toMatchObject({ threshold: 0 })
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
  it('a decide edge carries its handle, defaulting to fallback', () => {
    expect(branchForHandle('decide', 'ship')).toBe('ship')
    expect(branchForHandle('decide', 'fallback')).toBe('fallback')
    expect(branchForHandle('decide', null)).toBe('fallback')
    expect(branchForHandle('decide', '')).toBe('fallback')
  })
  it("lists a decide node's handles as its options plus fallback", () => {
    expect(sourceHandles('decide', { options: ['a', 'b'] })).toEqual(['a', 'b', 'fallback'])
    expect(sourceHandles('decide', {})).toEqual(['fallback'])
    expect(sourceHandles('branch', {})).toEqual(['true', 'false'])
    expect(sourceHandles('cli', {})).toEqual([])
  })
  it('classes only the two branch verdicts', () => {
    expect(edgeLabelClass('true')).toBe('wf-edge-true')
    expect(edgeLabelClass('false')).toBe('wf-edge-false')
    expect(edgeLabelClass('a b"c')).toBe('')
    expect(edgeLabelClass(null)).toBe('')
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
  it('accepts exactly the seven kinds', () => {
    for (const kind of kinds) expect(decodeKindDrag(kind)).toBe(kind)
    expect(decodeKindDrag('')).toBeNull()
    expect(decodeKindDrag('diagram')).toBeNull()
    expect(decodeKindDrag('/etc/passwd')).toBeNull()
  })
})

describe('inspectorKey', () => {
  const node = { id: 3, title: 'Gate', config: { op: 'contains', value: 'x' } }
  it('ignores position and timestamps, follows title and config', () => {
    expect(inspectorKey({ ...node, x: 1, y: 2, updated_at: 'a' } as typeof node)).toBe(
      inspectorKey({ ...node, x: 9, y: 9, updated_at: 'b' } as typeof node),
    )
    expect(inspectorKey({ ...node, title: 'Other' })).not.toBe(inspectorKey(node))
    expect(inspectorKey({ ...node, config: { op: 'equals', value: 'x' } })).not.toBe(inspectorKey(node))
    expect(inspectorKey({ ...node, id: 4 })).not.toBe(inspectorKey(node))
  })
})

describe('parse-json node (naru task 1985)', () => {
  it('is in the palette and takes input and gives output', () => {
    expect(kinds).toContain('parse-json')
    expect(hasInput('parse-json')).toBe(true)
    expect(hasOutput('parse-json')).toBe(true)
  })
  it('saves a type only when it is not any', () => {
    const draft = (over: Record<string, unknown>) => ({ ...draftFromConfig('parse-json', {}), ...over })
    expect(buildConfig('parse-json', draft({})).config).toEqual({})
    expect(buildConfig('parse-json', draft({ json_type: 'number' })).config).toEqual({ type: 'number' })
    expect(draftFromConfig('parse-json', { type: 'list<P>' }).json_type).toBe('list<P>')
  })
  it('summarizes with the output type', () => {
    expect(summarize('parse-json', { type: 'number' })).toBe('JSON → number')
    expect(summarize('parse-json', {})).toBe('JSON → any')
  })
})

describe('variable node (naru task 1986)', () => {
  it('is in the palette with in and out pins', () => {
    expect(kinds).toContain('variable')
    expect(hasInput('variable')).toBe(true)
    expect(hasOutput('variable')).toBe(true)
  })
  it('needs a name and saves the type only when not any', () => {
    const draft = (over: Record<string, unknown>) => ({ ...draftFromConfig('variable', {}), ...over })
    expect(buildConfig('variable', draft({})).error).toBe('name required')
    expect(buildConfig('variable', draft({ var_name: ' x ' })).config).toEqual({ op: 'set', name: 'x' })
    expect(buildConfig('variable', draft({ var_name: 'x', var_op: 'get', json_type: 'number' })).config).toEqual({
      op: 'get',
      name: 'x',
      type: 'number',
    })
    expect(draftFromConfig('variable', { op: 'get', name: 'n' }).var_op).toBe('get')
  })
  it('summarizes with op and name', () => {
    expect(summarize('variable', { op: 'get', name: 'x' })).toBe('get x')
    expect(summarize('variable', { op: 'set', name: '' })).toBe('set ?')
  })
})

describe('mapfilter node (naru task 1987)', () => {
  const draft = (over: Record<string, unknown>) => ({ ...draftFromConfig('mapfilter', {}), ...over })
  it('is in the palette with list pins and an amber card', () => {
    expect(kinds).toContain('mapfilter')
    expect(hasInput('mapfilter')).toBe(true)
    expect(hasOutput('mapfilter')).toBe(true)
  })
  it('validates the expression per mode', () => {
    expect(buildConfig('mapfilter', draft({ mf_expr: ' ' })).error).toBe('expression required')
    expect(buildConfig('mapfilter', draft({ mf_expr: 'Task: {item}' })).config).toEqual({ mode: 'map', expr: 'Task: {item}' })
    expect(buildConfig('mapfilter', draft({ mf_mode: 'filter', mf_expr: 'contains:a' })).config).toEqual({ mode: 'filter', expr: 'contains:a' })
    expect(buildConfig('mapfilter', draft({ mf_mode: 'filter', mf_expr: 'nonempty' })).error).toBeNull()
    expect(buildConfig('mapfilter', draft({ mf_mode: 'filter', mf_expr: 'regex:(' })).error).toBe('invalid regex')
    expect(buildConfig('mapfilter', draft({ mf_mode: 'filter', mf_expr: 'wat' })).error).toMatch(/unknown predicate/)
  })
  it('summarizes with mode and expression', () => {
    expect(summarize('mapfilter', { mode: 'filter', expr: 'contains:foo' })).toBe('filter · contains:foo')
    expect(summarize('mapfilter', defaultConfig('mapfilter'))).toBe('map · {item}')
  })
})

describe('foreach node (naru task 1988)', () => {
  const draft = (over: Record<string, unknown>) => ({ ...draftFromConfig('foreach', {}), ...over })
  it('is in the palette with pins', () => {
    expect(kinds).toContain('foreach')
    expect(hasInput('foreach')).toBe(true)
    expect(hasOutput('foreach')).toBe(true)
  })
  it('builds a config', () => {
    expect(buildConfig('foreach', draft({ fe_body: ' ' })).error).toBe('body required')
    expect(buildConfig('foreach', draft({ fe_body: 'echo $1' })).config).toEqual({ body: 'echo $1' })
    expect(buildConfig('foreach', draft({ fe_body: 'x', timeout_secs: '5' })).config).toEqual({ body: 'x', timeout_secs: 5 })
    expect(buildConfig('foreach', draft({ fe_body: 'x', timeout_secs: '0' })).error).toMatch(/timeout/)
    expect(buildConfig('foreach', defaultConfig('foreach') && draftFromConfig('foreach', defaultConfig('foreach'))).error).toBeNull()
  })
  it('summarizes the first body line', () => {
    expect(summarize('foreach', { body: '\n echo hi\nmore' })).toBe('for each · echo hi')
  })
})

describe('parallel / join nodes (naru task 1989)', () => {
  it('are in the palette with an empty config', () => {
    for (const k of ['parallel', 'join'] as const) {
      expect(kinds).toContain(k)
      expect(hasInput(k)).toBe(true)
      expect(hasOutput(k)).toBe(true)
      expect(defaultConfig(k)).toEqual({})
      expect(buildConfig(k, draftFromConfig(k, {})).config).toEqual({})
    }
  })
  it('summarize', () => {
    expect(summarize('parallel', {})).toBe('fan out')
    expect(summarize('join', {})).toBe('wait for all')
  })
})

describe('switch node (naru task 1990)', () => {
  const cases = [
    { match: 'red', label: 'r' },
    { match: 'blue', label: '' },
  ]
  const sw = (over: Record<string, unknown>) =>
    buildConfig('switch', { ...draftFromConfig('switch', { op: 'contains', cases }), ...over })

  it('is in the palette and its edges need a label', () => {
    expect(kinds).toContain('switch')
    expect(edgeNeedsBranch('switch')).toBe(true)
    expect(hasInput('switch')).toBe(true)
    expect(hasOutput('switch')).toBe(true)
  })
  it('draws one handle per case label (match when unlabelled) plus default last', () => {
    expect(sourceHandles('switch', { op: 'contains', cases })).toEqual(['r', 'blue', 'default'])
    expect(sourceHandles('switch', {})).toEqual(['default'])
  })
  it('an edge carries its handle, defaulting to default', () => {
    expect(branchForHandle('switch', 'r')).toBe('r')
    expect(branchForHandle('switch', 'default')).toBe('default')
    expect(branchForHandle('switch', null)).toBe('default')
    expect(branchForHandle('switch', '')).toBe('default')
  })
  it('builds a config with labels defaulting to the match', () => {
    expect(sw({}).config).toEqual({
      op: 'contains',
      cases: [
        { match: 'red', label: 'r' },
        { match: 'blue', label: 'blue' },
      ],
    })
  })
  it('refuses a bad operator, too few cases, bad labels and a bad regex', () => {
    expect(sw({ op: 'score_above' }).error).toMatch(/operator/)
    expect(sw({ cases: [{ match: 'a', label: '' }] }).error).toMatch(/two cases/)
    expect(sw({ cases: [{ match: ' ', label: '' }, { match: 'b', label: '' }] }).error).toMatch(/match/)
    expect(sw({ cases: [{ match: 'a', label: 'x' }, { match: 'b', label: 'x' }] }).error).toMatch(/distinct/)
    expect(sw({ cases: [{ match: 'a', label: '' }, { match: 'b', label: 'default' }] }).error).toMatch(/default/)
    expect(sw({ op: 'regex', cases: [{ match: 'a', label: '' }, { match: '(', label: '' }] }).error).toMatch(/regular expression/)
  })
})

describe('delay node (naru task 1992)', () => {
  const draft = (over: Record<string, unknown>) => ({
    ...draftFromConfig('delay', defaultConfig('delay')),
    ...over,
  })
  it('is in the palette with pins and a summary', () => {
    expect(kinds).toContain('delay')
    expect(hasInput('delay')).toBe(true)
    expect(hasOutput('delay')).toBe(true)
    expect(summarize('delay', defaultConfig('delay'))).toBe('wait 5s')
    expect(summarize('delay', { until: '14:30' })).toBe('until 14:30')
    expect(summarize('delay', {})).toBe('unset')
  })
  it('writes exactly one key', () => {
    expect(buildConfig('delay', draft({})).config).toEqual({ seconds: 5 })
    expect(buildConfig('delay', draft({ dl_mode: 'until', dl_until: '14:30' })).config).toEqual({ until: '14:30' })
    expect(buildConfig('delay', draft({ dl_mode: 'until', dl_until: '2026-10-17T14:30:00Z' })).config).toEqual({
      until: '2026-10-17T14:30:00Z',
    })
  })
  it('refuses out-of-range seconds and bad until', () => {
    expect(buildConfig('delay', draft({ dl_seconds: '5000' })).error).toMatch(/seconds/)
    expect(buildConfig('delay', draft({ dl_seconds: '-1' })).error).toMatch(/seconds/)
    expect(buildConfig('delay', draft({ dl_seconds: '' })).error).toMatch(/seconds/)
    expect(buildConfig('delay', draft({ dl_mode: 'until', dl_until: '25:00' })).error).toMatch(/until/)
  })
})

describe('retry node (naru task 1991)', () => {
  const draft = (over: Record<string, unknown>) => ({
    ...draftFromConfig('retry', defaultConfig('retry')),
    rt_wrap_config: '{"command":"true"}',
    ...over,
  })
  it('is in the palette with pins and an amber summary', () => {
    expect(kinds).toContain('retry')
    expect(hasInput('retry')).toBe(true)
    expect(hasOutput('retry')).toBe(true)
    expect(summarize('retry', defaultConfig('retry'))).toBe('retry ×3 · 1000ms ×2 · 60s timeout · cli')
  })
  it('builds the wrap config and the defaults round-trip', () => {
    expect(buildConfig('retry', draft({})).config).toEqual({
      wrap: { kind: 'cli', config: { command: 'true' } },
      attempts: 3,
      backoff_ms: 1000,
      backoff_factor: 2,
      timeout_secs: 60,
    })
  })
  it('refuses bad numbers, bad JSON and control kinds', () => {
    expect(buildConfig('retry', draft({ rt_attempts: '0' })).error).toMatch(/attempts/)
    expect(buildConfig('retry', draft({ rt_attempts: '11' })).error).toMatch(/attempts/)
    expect(buildConfig('retry', draft({ timeout_secs: '3601' })).error).toMatch(/timeout/)
    expect(buildConfig('retry', draft({ rt_wrap_config: '{' })).error).toMatch(/JSON/)
    expect(buildConfig('retry', draft({ rt_wrap_kind: 'branch' })).error).toMatch(/cannot wrap/)
  })
})

describe('gate node (naru task 1993)', () => {
  const draft = (over: Record<string, unknown>) => ({
    ...draftFromConfig('gate', defaultConfig('gate')),
    ...over,
  })
  it('is in the palette, takes an input and offers approved / rejected handles', () => {
    expect(kinds).toContain('gate')
    expect(hasInput('gate')).toBe(true)
    expect(sourceHandles('gate', {})).toEqual(['approved', 'rejected'])
    expect(edgeNeedsBranch('gate')).toBe(true)
    expect(branchForHandle('gate', 'rejected')).toBe('rejected')
    expect(branchForHandle('gate', 'approved')).toBe('approved')
    expect(branchForHandle('gate', null)).toBe('approved')
    expect(summarize('gate', { message: 'Ship it?', timeout_secs: 60 })).toBe('Ship it? · 60s')
    expect(summarize('gate', defaultConfig('gate'))).toBe('approval · 3600s')
  })
  it('writes the timeout and a trimmed message', () => {
    expect(buildConfig('gate', draft({})).config).toEqual({ timeout_secs: 3600 })
    expect(buildConfig('gate', draft({ gate_message: ' Ship? ', gt_timeout: '30' })).config).toEqual({
      timeout_secs: 30,
      message: 'Ship?',
    })
  })
  it('refuses a timeout outside 1..86400', () => {
    for (const t of ['0', '90000', '', '-1', 'x']) {
      expect(buildConfig('gate', draft({ gt_timeout: t })).error, t).toMatch(/timeout/)
    }
    expect(buildConfig('gate', draft({ gt_timeout: '86400' })).error).toBeNull()
  })
})

describe('subworkflow node (naru task 1994)', () => {
  it('is in the palette, has an input, no branch handles, and summarises its child', () => {
    expect(kinds).toContain('subworkflow')
    expect(hasInput('subworkflow')).toBe(true)
    expect(edgeNeedsBranch('subworkflow')).toBe(false)
    expect(sourceHandles('subworkflow', {})).toEqual([])
    expect(summarize('subworkflow', { workflow: 'Child' })).toBe('Child')
    expect(summarize('subworkflow', defaultConfig('subworkflow'))).toBe('pick a workflow')
  })
  it('builds its config from the picked workflow and refuses an empty pick', () => {
    const draft = draftFromConfig('subworkflow', { workflow: ' Child ' })
    expect(draft.sw_workflow).toBe(' Child ')
    expect(buildConfig('subworkflow', draft)).toEqual({ config: { workflow: 'Child' }, error: null })
    const empty = draftFromConfig('subworkflow', defaultConfig('subworkflow'))
    expect(buildConfig('subworkflow', empty).error).toMatch(/pick a workflow/)
  })
})

describe('task node (naru task 1996)', () => {
  const d = (over: Record<string, string>) => ({ ...draftFromConfig('task', defaultConfig('task')), ...over })
  it('is in the palette with an input and summarises its action', () => {
    expect(NODE_KINDS.find((p) => p.kind === 'task')?.label).toBe('Naru task')
    expect(hasInput('task')).toBe(true)
    expect(edgeNeedsBranch('task')).toBe(false)
    expect(summarize('task', { action: 'create', project: 'Web' })).toBe('create · Web')
    expect(summarize('task', { action: 'read', task: '7' })).toBe('read · #7')
  })
  it('keeps only the fields its action takes and round-trips', () => {
    const built = buildConfig('task', d({ tk_project: 'Web', tk_description: 'do {input}', tk_status: 'todo', tk_task: '9' }))
    expect(built).toEqual({ config: { action: 'create', project: 'Web', description: 'do {input}', status: 'todo' }, error: null })
    const read = buildConfig('task', d({ tk_action: 'read', tk_task: ' 9 ', tk_description: 'x' }))
    expect(read.config).toEqual({ action: 'read', task: '9' })
    expect(draftFromConfig('task', read.config!).tk_task).toBe('9')
  })
  it('refuses missing or malformed required fields', () => {
    expect(buildConfig('task', d({ tk_project: '' })).error).toMatch(/project/)
    expect(buildConfig('task', d({ tk_action: 'read' })).error).toMatch(/task id/)
    expect(buildConfig('task', d({ tk_action: 'read', tk_task: 'abc' })).error).toMatch(/whole number/)
    expect(buildConfig('task', d({ tk_action: 'read', tk_task: '{input}' })).error).toBeNull()
    expect(buildConfig('task', d({ tk_action: 'update', tk_task: '3' })).error).toMatch(/at least one/)
    expect(buildConfig('task', d({ tk_action: 'update', tk_task: '3', tk_result: 'ok' })).error).toBeNull()
  })
})

describe('http node (naru task 1997)', () => {
  const d = (over: Record<string, string>) => ({ ...draftFromConfig('http', defaultConfig('http')), ...over })
  it('is in the palette and summarises method and host', () => {
    expect(NODE_KINDS.find((p) => p.kind === 'http')?.label).toBe('HTTP request')
    expect(hasInput('http')).toBe(true)
    expect(edgeNeedsBranch('http')).toBe(false)
    expect(summarize('http', { method: 'POST', url: 'http://h:1/a' })).toBe('POST h:1/a')
    expect(summarize('http', {})).toBe('GET unset')
  })
  it('builds a config and round-trips headers', () => {
    const built = buildConfig('http', d({ ht_url: ' http://h/x ', ht_headers: 'A: 1\nB:  two: 2\n\n', ht_timeout: '5' }))
    expect(built).toEqual({ config: { method: 'GET', url: 'http://h/x', headers: { A: '1', B: 'two: 2' }, timeout_secs: 5 }, error: null })
    expect(draftFromConfig('http', built.config!).ht_headers).toBe('A: 1\nB: two: 2')
  })
  it('keeps a body only for methods that carry one', () => {
    expect(buildConfig('http', d({ ht_method: 'POST', ht_url: 'http://h', ht_body: 'x' })).config).toEqual({ method: 'POST', url: 'http://h', body: 'x' })
    expect(buildConfig('http', d({ ht_url: 'http://h', ht_body: 'x' })).config).toEqual({ method: 'GET', url: 'http://h' })
  })
  it('refuses a bad url, header or timeout', () => {
    expect(buildConfig('http', d({ ht_url: '' })).error).toMatch(/URL/)
    expect(buildConfig('http', d({ ht_url: 'ftp://x' })).error).toMatch(/http:\/\//)
    expect(buildConfig('http', d({ ht_url: 'https://x' })).error).toMatch(/https/)
    expect(buildConfig('http', d({ ht_url: '{input}' })).error).toBeNull()
    expect(buildConfig('http', d({ ht_url: 'http://h', ht_headers: 'nocolon' })).error).toMatch(/Name: value/)
    expect(buildConfig('http', d({ ht_url: 'http://h', ht_timeout: '0' })).error).toMatch(/timeout/)
  })
})

describe('try / catch node (naru task 1995)', () => {
  const draft = (over: Record<string, unknown>) => ({
    ...draftFromConfig('trycatch', defaultConfig('trycatch')),
    ...over,
  })
  it('is in the palette and offers ok / caught handles', () => {
    expect(NODE_KINDS.find((p) => p.kind === 'trycatch')?.label).toBe('Try / Catch')
    expect(hasInput('trycatch')).toBe(true)
    expect(sourceHandles('trycatch', {})).toEqual(['ok', 'caught'])
    expect(edgeNeedsBranch('trycatch')).toBe(true)
    expect(branchForHandle('trycatch', 'caught')).toBe('caught')
    expect(branchForHandle('trycatch', 'ok')).toBe('ok')
    expect(branchForHandle('trycatch', null)).toBe('ok')
    expect(summarize('trycatch', defaultConfig('trycatch'))).toBe('try cli · ok / caught')
  })
  it('builds a wrap with an optional timeout and round-trips', () => {
    const d = draft({ rt_wrap_config: '{"command":"false"}', timeout_secs: '9' })
    const built = buildConfig('trycatch', d)
    expect(built).toEqual({ config: { wrap: { kind: 'cli', config: { command: 'false' } }, timeout_secs: 9 }, error: null })
    expect(buildConfig('trycatch', draft({ rt_wrap_config: '{}' })).config).toEqual({ wrap: { kind: 'cli', config: {} } })
    expect(draftFromConfig('trycatch', built.config!).rt_wrap_kind).toBe('cli')
  })
  it('refuses bad JSON, a bad timeout and control kinds', () => {
    expect(buildConfig('trycatch', draft({ rt_wrap_config: '{' })).error).toMatch(/JSON/)
    expect(buildConfig('trycatch', draft({ timeout_secs: '3601' })).error).toMatch(/timeout/)
    expect(buildConfig('trycatch', draft({ rt_wrap_kind: 'branch' })).error).toMatch(/cannot wrap/)
  })
})

describe('notify node (naru task 1998)', () => {
  const d = (over: Record<string, string>) => ({ ...draftFromConfig('notify', defaultConfig('notify')), ...over })
  it('is a palette kind with a card summary', () => {
    expect(NODE_KINDS.find((p) => p.kind === 'notify')?.label).toBe('Notify')
    expect(hasInput('notify')).toBe(true)
    expect(summarize('notify', { mode: 'phone', message: 'hi' })).toBe('phone · hi')
    expect(summarize('notify', { mode: 'speak' })).toBe('speak · the input')
  })
  it('builds and reads back its config', () => {
    expect(buildConfig('notify', d({})).config).toEqual({ mode: 'phone' })
    const built = buildConfig('notify', d({ nt_message: ' hi ', nt_title: 'T', nt_open: 'live' }))
    expect(built.config).toEqual({ mode: 'phone', message: 'hi', title: 'T', open: 'live' })
    expect(draftFromConfig('notify', built.config!).nt_title).toBe('T')
    // Title and open only apply to phone mode.
    expect(buildConfig('notify', d({ nt_mode: 'speak', nt_title: 'T', nt_open: 'live' })).config).toEqual({ mode: 'speak' })
  })
  it('rejects bad values', () => {
    expect(buildConfig('notify', d({ nt_mode: 'shout' })).error).toMatch(/mode/)
    expect(buildConfig('notify', d({ nt_message: 'x'.repeat(4097) })).error).toMatch(/message/)
    expect(buildConfig('notify', d({ nt_open: '../x' })).error).toMatch(/open/)
  })
})

describe('git node (naru task 1999)', () => {
  const d = (over: Record<string, string | boolean>) => ({ ...draftFromConfig('git', defaultConfig('git')), ...over })
  it('is a palette kind with a card summary', () => {
    expect(NODE_KINDS.find((p) => p.kind === 'git')?.label).toBe('Git')
    expect(hasInput('git')).toBe(true)
    expect(summarize('git', { op: 'commit', message: 'x' })).toBe('commit · the project')
    expect(summarize('git', { op: 'diff', cwd: '/tmp/repo' })).toBe('diff · /tmp/repo')
  })
  it('builds and reads back each operation', () => {
    expect(buildConfig('git', d({})).config).toEqual({ op: 'commit', message: 'Update' })
    const commit = buildConfig('git', d({ gt_message: 'a $(x) "q"', gt_paths: ' a.txt  b/c ', gt_cwd: ' /r ', timeout_secs: '30' }))
    expect(commit.config).toEqual({ op: 'commit', cwd: '/r', message: 'a $(x) "q"', paths: ['a.txt', 'b/c'], timeout_secs: 30 })
    expect(draftFromConfig('git', commit.config!).gt_paths).toBe('a.txt b/c')
    expect(buildConfig('git', d({ gt_op: 'branch', gt_name: 'feat/{input}', gt_message: 'ignored' })).config).toEqual({ op: 'branch', name: 'feat/{input}' })
    expect(buildConfig('git', d({ gt_op: 'diff', gt_base: 'main', gt_stat: true })).config).toEqual({ op: 'diff', base: 'main', stat: true })
    expect(buildConfig('git', d({ gt_op: 'diff' })).config).toEqual({ op: 'diff' })
  })
  it('rejects bad values', () => {
    expect(buildConfig('git', d({ gt_op: 'push' })).error).toMatch(/operation/)
    expect(buildConfig('git', d({ gt_message: '  ' })).error).toMatch(/message/)
    expect(buildConfig('git', d({ gt_op: 'branch', gt_name: '' })).error).toMatch(/name/)
    expect(buildConfig('git', d({ gt_op: 'branch', gt_name: '-x' })).error).toMatch(/start with -/)
    expect(buildConfig('git', d({ gt_op: 'branch', gt_name: 'a b' })).error).toMatch(/whitespace/)
    expect(buildConfig('git', d({ gt_op: 'diff', gt_base: '--output=x' })).error).toMatch(/start with -/)
    expect(buildConfig('git', d({ timeout_secs: '0' })).error).toMatch(/timeout/)
  })
})

describe('file node (naru task 2000)', () => {
  const d = (over: Record<string, string | boolean>) => ({ ...draftFromConfig('file', defaultConfig('file')), ...over })
  it('is a palette kind with a card summary', () => {
    expect(NODE_KINDS.find((p) => p.kind === 'file')?.label).toBe('Read / Write File')
    expect(hasInput('file')).toBe(true)
    expect(summarize('file', { op: 'read', path: '' })).toBe('read · unset')
    expect(summarize('file', { op: 'write', path: 'out/x.txt', append: true })).toBe('write · out/x.txt · append')
  })
  it('builds and reads back each operation', () => {
    expect(buildConfig('file', d({})).config).toEqual({ op: 'read', path: 'notes.txt' })
    const w = buildConfig('file', d({ fl_op: 'write', fl_path: ' out/x.txt ', fl_content: 'hi', fl_append: true }))
    expect(w.config).toEqual({ op: 'write', path: 'out/x.txt', content: 'hi', append: true })
    expect(draftFromConfig('file', w.config!).fl_append).toBe(true)
    // read drops write-only fields
    expect(buildConfig('file', d({ fl_content: 'x', fl_append: true })).config).toEqual({ op: 'read', path: 'notes.txt' })
  })
  it('refuses an empty path', () => {
    expect(buildConfig('file', d({ fl_path: ' ' })).error).toMatch(/path/)
  })
})

describe('memory node (naru task 2002)', () => {
  const d = (over: Record<string, string>) => ({ ...draftFromConfig('memory', defaultConfig('memory')), ...over })
  it('is a palette kind with a card summary', () => {
    expect(NODE_KINDS.find((p) => p.kind === 'memory')?.label).toBe('Memory Add / Search')
    expect(hasInput('memory')).toBe(true)
    expect(summarize('memory', { op: 'add' })).toBe('add · (empty)')
    expect(summarize('memory', { op: 'search', query: 'walnut' })).toBe('search · walnut')
  })
  it('builds and reads back each operation', () => {
    expect(buildConfig('memory', d({})).config).toEqual({ op: 'add' })
    const a = buildConfig('memory', d({ mm_text: 'likes {input}', mm_query: 'ignored', mm_project: ' P ' }))
    expect(a.config).toEqual({ op: 'add', text: 'likes {input}', project: 'P' })
    const s = buildConfig('memory', d({ mm_op: 'search', mm_query: 'walnut', mm_limit: '5', mm_text: 'ignored' }))
    expect(s.config).toEqual({ op: 'search', query: 'walnut', limit: 5 })
    expect(draftFromConfig('memory', s.config!).mm_limit).toBe('5')
  })
  it('refuses a bad limit', () => {
    expect(buildConfig('memory', d({ mm_op: 'search', mm_limit: '0' })).error).toMatch(/limit/)
  })
})

describe('verify node (naru task 2003)', () => {
  const d = (over: Record<string, string>) => ({ ...draftFromConfig('verify', defaultConfig('verify')), ...over })
  it('is a palette kind with a card summary', () => {
    expect(NODE_KINDS.find((p) => p.kind === 'verify')?.label).toBe('Verify')
    expect(hasInput('verify')).toBe(true)
    expect(summarize('verify', { mode: 'test', command: 'cargo test' })).toBe('test · cargo test')
    expect(summarize('verify', { mode: 'browser', command: 'khora go' })).toBe('browser · khora go')
  })
  it('builds and reads back its config', () => {
    expect(buildConfig('verify', d({})).config).toEqual({ mode: 'test', command: 'true' })
    const b = buildConfig('verify', d({ vf_mode: 'browser', vf_url: ' http://x/ ', vf_expect: 'ok', timeout_secs: '60' }))
    expect(b.config).toEqual({ mode: 'browser', command: 'true', url: 'http://x/', expect: 'ok', timeout_secs: 60 })
    expect(draftFromConfig('verify', b.config!).vf_url).toBe('http://x/')
    // url does not apply to test mode
    expect(buildConfig('verify', d({ vf_url: 'http://x/' })).config).toEqual({ mode: 'test', command: 'true' })
  })
  it('refuses an empty command, a bad mode or a bad timeout', () => {
    expect(buildConfig('verify', d({ vf_command: '  ' })).error).toMatch(/command/)
    expect(buildConfig('verify', d({ vf_mode: 'visual' })).error).toMatch(/mode/)
    expect(buildConfig('verify', d({ timeout_secs: '0' })).error).toMatch(/timeout/)
  })
})

describe('board node (naru task 2001)', () => {
  const d = (over: Record<string, string>) => ({ ...draftFromConfig('board', defaultConfig('board')), ...over })
  it('is a palette kind with a card summary', () => {
    expect(NODE_KINDS.find((p) => p.kind === 'board')?.label).toBe('Whiteboard')
    expect(hasInput('board')).toBe(true)
    expect(summarize('board', { kind: 'markdown' })).toBe('markdown · the input')
    expect(summarize('board', { kind: 'html', title: 'Report' })).toBe('html · Report')
  })
  it('builds and reads back its config', () => {
    expect(buildConfig('board', d({})).config).toEqual({ kind: 'markdown' })
    const b = buildConfig('board', d({ bd_kind: 'html', bd_title: ' T ', bd_body: '# Hi {input}' }))
    expect(b.config).toEqual({ kind: 'html', title: 'T', body: '# Hi {input}' })
    expect(draftFromConfig('board', b.config!).bd_body).toBe('# Hi {input}')
  })
  it('refuses a bad format or an over-long title', () => {
    expect(buildConfig('board', d({ bd_kind: 'svg' })).error).toMatch(/format/)
    expect(buildConfig('board', d({ bd_title: 'x'.repeat(201) })).error).toMatch(/title/)
  })
})

describe('comment node (naru task 2008)', () => {
  const d = (over: Record<string, string>) => ({ ...draftFromConfig('comment', defaultConfig('comment')), ...over })
  it('is a palette kind with no connections', () => {
    expect(NODE_KINDS.find((p) => p.kind === 'comment')?.label).toBe('Comment')
    expect(hasInput('comment')).toBe(false)
    expect(hasOutput('comment')).toBe(false)
    expect(summarize('comment', { text: 'group of\n  three' })).toBe('group of three')
  })
  it('builds and reads back its config', () => {
    expect(buildConfig('comment', d({})).config).toEqual({ color: 'accent' })
    const b = buildConfig('comment', d({ cm_text: 'note', cm_color: 'warn' }))
    expect(b.config).toEqual({ color: 'warn', text: 'note' })
    const back = draftFromConfig('comment', b.config!)
    expect([back.cm_text, back.cm_color]).toEqual(['note', 'warn'])
  })
  it('refuses an unknown colour and falls back to accent on read', () => {
    expect(buildConfig('comment', d({ cm_color: '#fff' })).error).toMatch(/colour/)
    expect(draftFromConfig('comment', { color: 'teal' }).cm_color).toBe('accent')
  })
})

describe('palette groups', () => {
  beforeEach(() => localStorage.clear())

  it('put every palette kind in exactly one group', () => {
    const grouped = PALETTE_GROUPS.flatMap((g) => g.kinds)
    expect([...grouped].sort()).toEqual([...kinds].sort())
  })

  it('remember the collapsed groups, and read junk as none', () => {
    expect(loadPaletteCollapsed()).toEqual([])
    savePaletteCollapsed(['AI', 'Data'])
    expect(loadPaletteCollapsed()).toEqual(['AI', 'Data'])
    localStorage.setItem(PALETTE_COLLAPSED_KEY, 'not json{')
    expect(loadPaletteCollapsed()).toEqual([])
    localStorage.setItem(PALETTE_COLLAPSED_KEY, '{"a":1}')
    expect(loadPaletteCollapsed()).toEqual([])
  })
})
