import { describe, expect, it } from 'vitest'
import { BURST_MAX, callIds, chipOffset, chipSide, chipText, coalesce, newBursts, toolDetail, toolKind, toolLabel } from './toolBurst'
import type { OrbitAgent } from './types/OrbitAgent'
import type { OrbitTool } from './types/OrbitTool'

const call = (name: string, summary = '', error = false) => ({ name, summary, error })
const tool = (at: number, name: string, summary = '', error = false): OrbitTool => ({ at, name, summary, error })
const agent = (key: string, role = 'build'): OrbitAgent => ({
  key,
  role,
  label: role,
  detail: null,
  state: 'working',
  startedAt: 0,
  lastEventAt: 0,
  tools: [],
})

describe('toolKind / toolLabel / toolDetail', () => {
  it('sorts calls into kinds', () => {
    expect(toolKind('Bash', 'ls -la')).toBe('shell')
    expect(toolKind('Bash', 'naru task show 1')).toBe('naru')
    expect(toolKind('Bash', 'cd /x && NARU_DB=/t.db naru task list')).toBe('naru')
    expect(toolKind('Bash', 'echo mesa')).toBe('shell')
    expect(toolKind('Read')).toBe('read')
    expect(toolKind('Edit')).toBe('write')
    expect(toolKind('Grep')).toBe('search')
    expect(toolKind('WebFetch')).toBe('web')
    expect(toolKind('mcp__claude_ai_Gmail__get_thread')).toBe('web')
    expect(toolKind('Agent')).toBe('agent')
    expect(toolKind('Whatever')).toBe('other')
  })
  it('labels an MCP tool by its last segment', () => {
    expect(toolLabel('mcp__srv__get_thread')).toBe('get_thread')
    expect(toolLabel('Read')).toBe('Read')
  })
  it('picks one short word of detail', () => {
    expect(toolDetail('Read', '/x/y/store.rs')).toBe('store.rs')
    expect(toolDetail('Bash', 'FOO=1 cargo test --lib')).toBe('cargo')
    expect(toolDetail('Bash', 'naru task show 1')).toBe('naru task')
    expect(toolDetail('WebFetch', 'https://docs.rs/serde/latest')).toBe('docs.rs')
    expect(toolDetail('Grep', 'fn watch_from_text')).toBe('fn')
    expect(toolDetail('Read', '/x/a_very_long_file_name_indeed.rs')).toBe('a_very_long_f…')
    expect(toolDetail('Read', '')).toBe('')
  })
})

describe('coalesce / chipText', () => {
  it('folds a burst of one tool into ×n and keeps a single call’s detail', () => {
    const chips = coalesce([call('Read', '/a.rs'), call('Read', '/b.rs'), call('Bash', 'ls'), call('Read', '/c.rs')])
    expect(chips.map(chipText)).toEqual(['▤ Read ×3', '$ Bash ls'])
  })
  it('never makes more than BURST_MAX chips, folding the oldest into +n', () => {
    const chips = coalesce([call('Read'), call('Read'), call('Grep'), call('Edit', '/x.rs'), call('Bash', 'ls', true), call('WebFetch')])
    expect(chips).toHaveLength(BURST_MAX)
    expect(chips.map(chipText)).toEqual(['+4', '$ Bash ls', '◎ WebFetch'])
    expect(chips.map((c) => c.error)).toEqual([false, true, false])
    // An error among the folded calls tints the +n chip.
    expect(coalesce([call('Read', '', true), call('Grep'), call('Edit'), call('Bash')])[0].error).toBe(true)
  })
  it('tints a coalesced chip red when any call in it failed', () => {
    const chips = coalesce([call('Bash', 'a'), call('Bash', 'b', true)])
    expect(chips).toHaveLength(1)
    expect(chips[0].error).toBe(true)
  })
})

describe('newBursts', () => {
  it('records the first feed without bursting, then bursts only new calls', () => {
    const feed1 = [{ node: 'task-1', tools: [tool(10, 'Read', '/a.rs')], agents: [agent('s/a')] }]
    const r1 = newBursts(feed1, null)
    expect(r1.bursts).toEqual([])
    const feed2 = [{ node: 'task-1', tools: [tool(10, 'Read', '/a.rs'), tool(12, 'Edit', '/a.rs', true)], agents: [agent('s/a'), agent('s/b', 'test')] }]
    const r2 = newBursts(feed2, r1.seen)
    expect(r2.bursts).toHaveLength(1)
    expect(r2.bursts[0].node).toBe('task-1')
    expect(r2.bursts[0].chips.map(chipText)).toEqual(['✎ Edit a.rs', '✦ Agent test'])
    expect(r2.bursts[0].chips[0].error).toBe(true)
    // The same feed again: nothing new.
    expect(newBursts(feed2, r2.seen).bursts).toEqual([])
  })
  it('bursts a call again, red, when it fails after it was first seen open', () => {
    const r1 = newBursts([{ node: 'n', tools: [tool(1, 'Bash', 'sleep 9')] }], null)
    const r2 = newBursts([{ node: 'n', tools: [tool(1, 'Bash', 'sleep 9')] }], r1.seen)
    expect(r2.bursts).toEqual([])
    const r3 = newBursts([{ node: 'n', tools: [tool(1, 'Bash', 'sleep 9', true)] }], r2.seen)
    expect(r3.bursts).toHaveLength(1)
    expect(r3.bursts[0].chips[0].error).toBe(true)
    expect(newBursts([{ node: 'n', tools: [tool(1, 'Bash', 'sleep 9', true)] }], r3.seen).bursts).toEqual([])
  })
  it('keeps two identical calls in one second apart', () => {
    const ids = callIds('n', [tool(5, 'Read', '/a'), tool(5, 'Read', '/a')])
    expect(new Set(ids).size).toBe(2)
  })
  it('forgets calls the feed no longer carries', () => {
    const r1 = newBursts([{ node: 'n', tools: [tool(1, 'Read')] }], null)
    const r2 = newBursts([{ node: 'n', tools: [] }], r1.seen)
    expect(r2.seen.size).toBe(0)
  })
})

describe('chipSide / chipOffset', () => {
  it('leaves horizontally away from the centre, right when level', () => {
    expect(chipSide({ x: 0, y: 0 }, { x: -5, y: 3 })).toBe(-1)
    expect(chipSide({ x: 0, y: 0 }, { x: 5, y: -3 })).toBe(1)
    expect(chipSide({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(1)
  })
  it('stacks a burst in a column centred on the node', () => {
    const at = [0, 1, 2].map((i) => chipOffset(-1, i, 3, 40, 20))
    expect(at.map((p) => p.x)).toEqual([-40, -40, -40])
    expect(at[1].y).toBeCloseTo(0)
    expect(at[0].y).toBeCloseTo(-at[2].y)
    expect(at[2].y - at[1].y).toBeGreaterThan(20)
    expect(chipOffset(1, 0, 1, 40, 20)).toEqual({ x: 40, y: 0 })
  })
})
