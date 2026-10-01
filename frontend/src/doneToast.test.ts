import { describe, expect, it } from 'vitest'
import {
  TOAST_MAX,
  detectDone,
  dismissToast,
  pushToasts,
  toastHref,
  type DoneTask,
} from './doneToast'

const task = (id: number, project_id = 1): DoneTask => ({ id, name: `t${id}`, project_id })

describe('detectDone', () => {
  it('seeds on the first poll without firing', () => {
    const r = detectDone(null, [task(1), task(2)])
    expect(r.fresh).toEqual([])
    expect([...r.seen]).toEqual([1, 2])
  })
  it('fires only for ids new since the last poll, never twice', () => {
    const a = detectDone(null, [task(1)])
    const b = detectDone(a.seen, [task(1), task(2)])
    expect(b.fresh.map((t) => t.id)).toEqual([2])
    const c = detectDone(b.seen, [task(1), task(2)])
    expect(c.fresh).toEqual([])
  })
  it('fires again when a task leaves done and returns', () => {
    const a = detectDone(null, [task(1)])
    const b = detectDone(a.seen, [])
    expect(detectDone(b.seen, [task(1)]).fresh.map((t) => t.id)).toEqual([1])
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
