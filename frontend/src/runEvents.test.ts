import { describe, expect, it } from 'vitest'
import fixture from './runEvents.fixture.jsonl?raw'
import {
  RUN_RESULT_MAX,
  parseEventLines,
  runControls,
  runEntries,
} from './runEvents'

const assistant = (content: unknown[]) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
})

describe('runEntries', () => {
  it('turns assistant text and tool_use blocks into entries in order', () => {
    const out = runEntries([
      assistant([
        { type: 'thinking', thinking: '', signature: 'abc' },
        { type: 'text', text: 'looking' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: 'cargo test\nmore', description: 'x' },
        },
        {
          type: 'tool_use',
          id: 't2',
          name: 'Read',
          input: { file_path: '/a/b/c/d/e.rs' },
        },
      ]),
    ])
    expect(out).toEqual([
      { kind: 'text', text: 'looking' },
      { kind: 'tool', id: 't1', name: 'Bash', target: 'cargo test' },
      { kind: 'tool', id: 't2', name: 'Read', target: '…/c/d/e.rs' },
    ])
  })

  it('reads tool results, flags errors and truncates', () => {
    const long = 'x'.repeat(RUN_RESULT_MAX + 50)
    const out = runEntries([
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'boom',
              is_error: true,
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't2',
              content: [{ type: 'text', text: long }],
            },
          ],
        },
      },
    ])
    expect(out[0]).toEqual({
      kind: 'tool_result',
      toolId: 't1',
      text: 'boom',
      isError: true,
      truncated: false,
    })
    expect(out[1]).toMatchObject({
      kind: 'tool_result',
      isError: false,
      truncated: true,
    })
    expect((out[1] as { text: string }).text.length).toBe(RUN_RESULT_MAX + 1)
  })

  it('shows a user text message', () => {
    expect(
      runEntries([
        { type: 'user', message: { role: 'user', content: 'hello' } },
      ]),
    ).toEqual([{ kind: 'user', text: 'hello' }])
  })

  it('reads result lines, including an interrupted turn', () => {
    const out = runEntries([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.0044,
        result: 'done',
      },
      { type: 'result', subtype: 'error_during_execution', is_error: true },
    ])
    expect(out).toEqual([
      {
        kind: 'result',
        subtype: 'success',
        isError: false,
        costUsd: 0.0044,
        text: 'done',
      },
      {
        kind: 'result',
        subtype: 'error_during_execution',
        isError: true,
        costUsd: null,
        text: '',
      },
    ])
  })

  it('labels every runner lifecycle event', () => {
    const labels = [
      { event: 'claude_started', resume: false },
      { event: 'claude_started', resume: true },
      { event: 'message_delivered', file: 'f.json' },
      { event: 'message_delivered', source: 'resume' },
      { event: 'interrupt_requested', request_id: 'r' },
      { event: 'stop_requested' },
      { event: 'idle_timeout', secs: 900 },
      { event: 'resumed' },
      { event: 'exited', status: 'finished', exit_code: 0 },
      { event: 'failed', error: 'no claude' },
    ].map((e) => runEntries([{ type: 'naru_runner', at: 1, ...e }])[0])
    expect(labels.map((l) => (l as { label: string }).label)).toEqual([
      'claude started',
      'claude resumed',
      'message delivered',
      'continue prompt delivered',
      'interrupt requested',
      'stop requested',
      'idle timeout (900s)',
      'run resumed',
      'exited · finished (code 0)',
      'failed · no claude',
    ])
  })

  it('hides protocol noise', () => {
    expect(
      runEntries([
        { type: 'system', subtype: 'init', tools: [] },
        { type: 'system', subtype: 'hook_started' },
        {
          type: 'control_response',
          response: { subtype: 'success', request_id: 'r' },
        },
        { type: 'rate_limit_event' },
        { type: 'mystery' },
        null,
        42,
      ]),
    ).toEqual([])
  })

  it('keeps a malformed line as raw text and never as markup', () => {
    const out = runEntries([
      '{"type":"assis',
      '  ',
      assistant([{ type: 'text', text: '<img src=x onerror=1>' }]),
    ])
    expect(out).toEqual([
      { kind: 'raw', text: '{"type":"assis' },
      { kind: 'text', text: '<img src=x onerror=1>' },
    ])
  })

  it('tolerates wrong-typed fields', () => {
    expect(
      runEntries([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 5 },
              'x',
              { type: 'tool_use', input: 3 },
            ],
          },
        },
      ]),
    ).toEqual([{ kind: 'tool', id: '', name: 'tool', target: '' }])
  })
})

describe('real fixture', () => {
  it('drops no assistant text or tool entries', () => {
    const lines = parseEventLines(fixture)
    expect(lines).toHaveLength(21)
    let want = 0
    for (const l of lines as {
      type?: string
      message?: { content?: { type: string }[] }
    }[]) {
      if (l.type === 'assistant' || l.type === 'user') {
        want += (l.message?.content ?? []).filter((b) =>
          ['text', 'tool_use', 'tool_result'].includes(b.type),
        ).length
      }
    }
    const out = runEntries(lines)
    const got = out.filter((e) =>
      ['text', 'tool', 'tool_result', 'user'].includes(e.kind),
    ).length
    expect(want).toBe(4)
    expect(got).toBe(want)
    expect(out.filter((e) => e.kind === 'raw')).toEqual([])
    expect(out.find((e) => e.kind === 'tool_result')).toMatchObject({
      isError: true,
    })
    expect(out.filter((e) => e.kind === 'result')).toHaveLength(2)
    expect(out.filter((e) => e.kind === 'lifecycle')).toHaveLength(3)
  })
})

describe('runEntries subagent attribution', () => {
  const sub = (type: string, parent: string, content: unknown[]) => ({
    type,
    parent_tool_use_id: parent,
    message: { role: type, content },
  })

  it('folds subagent lines into the launching tool entry with a count', () => {
    const out = runEntries([
      assistant([
        {
          type: 'tool_use',
          id: 't1',
          name: 'Agent',
          input: { subagent_type: 'implementer', description: 'do it' },
        },
      ]),
      sub('assistant', 't1', [{ type: 'text', text: 'SUBSECRET one' }]),
      sub('assistant', 't1', [
        { type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'ls' } },
      ]),
      sub('user', 't1', [
        { type: 'tool_result', tool_use_id: 's1', content: 'SUBSECRET out' },
      ]),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }],
        },
      },
    ])
    expect(out.map((e) => e.kind)).toEqual(['tool', 'tool_result'])
    expect(JSON.stringify(out.map((e) => ({ ...e, subagent: undefined })))).not.toContain(
      'SUBSECRET',
    )
    const tool = out[0]
    if (tool.kind !== 'tool') throw new Error('expected tool')
    expect(tool.subagent?.count).toBe(3)
    expect(tool.subagent?.label).toBe('implementer · do it')
    expect(tool.subagent?.entries).toHaveLength(3)
  })

  it('puts a subagent line with an unknown launch in a trailing group', () => {
    const out = runEntries([
      sub('assistant', 'gone', [{ type: 'text', text: 'orphan one' }]),
      assistant([{ type: 'text', text: 'main' }]),
      sub('assistant', 'gone', [{ type: 'text', text: 'orphan two' }]),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ kind: 'text', text: 'main' })
    expect(out[1]).toMatchObject({
      kind: 'subagent',
      label: 'earlier subagent',
      count: 2,
    })
  })
})

describe('runControls', () => {
  it('enables controls by status', () => {
    expect(runControls({ status: 'running' })).toEqual({
      send: true,
      interrupt: true,
      stop: true,
    })
    expect(runControls({ status: 'idle' })).toEqual({
      send: true,
      interrupt: false,
      stop: true,
    })
    for (const status of ['finished', 'failed', 'stopped'] as const) {
      expect(runControls({ status })).toEqual({
        send: false,
        interrupt: false,
        stop: false,
      })
    }
    expect(runControls(null)).toEqual({
      send: false,
      interrupt: false,
      stop: false,
    })
  })
})
