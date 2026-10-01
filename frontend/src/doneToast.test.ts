import { describe, expect, it } from 'vitest'
import {
  TOAST_MAX,
  detectDone,
  seedCursor,
  dismissToast,
  pushToasts,
  toastHref,
  type DoneState,
  type DoneTask,
} from './doneToast'

const task = (id: number, project_id = 1, updated_at = '2026-01-01 00:00:10'): DoneTask => ({
  id,
  name: `t${id}`,
  project_id,
  updated_at,
})
const start = (cursor = '2026-01-01 00:00:00'): DoneState => ({ cursor, seen: new Set() })

describe('seedCursor', () => {
  it('formats the client clock as Naru text, a minute back', () => {
    expect(seedCursor(new Date('2026-03-05T10:00:30.900Z'))).toBe('2026-03-05 09:59:30')
  })
})

describe('detectDone', () => {
  it('seeds without firing, recording ids and moving the cursor', () => {
    const r = detectDone(start(), [task(1), task(2, 1, '2026-01-01 00:00:20')], true)
    expect(r.fresh).toEqual([])
    expect([...r.state.seen]).toEqual([1, 2])
    expect(r.state.cursor).toBe('2026-01-01 00:00:20')
  })
  it('keeps the cursor when a poll is empty', () => {
    const r = detectDone(start('2026-01-01 00:00:05'), [])
    expect(r.state.cursor).toBe('2026-01-01 00:00:05')
    expect(r.fresh).toEqual([])
  })
  it('fires for new ids, and a >= boundary row returning does not refire', () => {
    const a = detectDone(start(), [task(1)], true)
    const b = detectDone(a.state, [task(1), task(2)])
    expect(b.fresh.map((t) => t.id)).toEqual([2])
    expect(b.state.cursor).toBe('2026-01-01 00:00:10')
    const c = detectDone(b.state, [task(1), task(2)])
    expect(c.fresh).toEqual([])
  })
  it('fires a same-second sibling that arrives in a later poll', () => {
    const a = detectDone(start(), [task(1)])
    const b = detectDone(a.state, [task(1), task(2)])
    expect(b.fresh.map((t) => t.id)).toEqual([2])
  })
  it('toasts a task at most once per page life, even if rewritten', () => {
    const a = detectDone(start(), [task(1)])
    const b = detectDone(a.state, [task(1, 1, '2026-01-01 00:05:00')])
    expect(b.fresh).toEqual([])
    expect(b.state.cursor).toBe('2026-01-01 00:05:00')
  })
})

describe('toast stack', () => {
  it('resolves project names, stacks in order and caps', () => {
    const names = new Map([[1, 'Alpha']])
    let s = pushToasts([], [task(1), task(2, 9)], names, 0)
    expect(s.map((t) => t.project)).toEqual(['Alpha', null])
    s = pushToasts(s, [task(3), task(4), task(5)], names, 2)
    expect(s).toHaveLength(TOAST_MAX)
    expect(s.map((t) => t.taskId)).toEqual([2, 3, 4, 5])
  })
  it('dismisses by key and links to the task panel', () => {
    const s = pushToasts([], [task(7, 3)], new Map(), 10)
    expect(toastHref(s[0])).toBe('#/projects/3/tasks/7')
    expect(dismissToast(s, 10)).toEqual([])
  })
})
