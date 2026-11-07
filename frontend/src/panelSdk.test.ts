import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSrcdoc,
  computeStats,
  covers,
  dispatch,
  GRANTS_KEY,
  grant,
  loadGrants,
  parseManifest,
  newPanelKey,
  parseRequest,
  PANEL_CSP,
  revoke,
  SDK_SCRIPT,
  themeStyle,
  type Deps,
} from './panelSdk'
import type { Project } from './types/Project'
import type { TaskSummary } from './types/TaskSummary'

const meta = (json: string) => `<meta name="naru-panel" content='${json}'><p>hi</p>`

describe('parseManifest', () => {
  it('reads title and permissions', () => {
    expect(parseManifest(meta('{"title":"Stats","permissions":["stats:read","tasks:read"]}'))).toEqual({
      title: 'Stats',
      permissions: ['stats:read', 'tasks:read'],
    })
  })
  it('a missing meta asks for nothing', () => {
    expect(parseManifest('<p>hi</p>')).toEqual({ permissions: [] })
  })
  it('bad JSON, a non-object and an unknown permission are errors', () => {
    expect(parseManifest(meta('{nope'))).toHaveProperty('error')
    expect(parseManifest(meta('[1]'))).toHaveProperty('error')
    expect(parseManifest(meta('{"permissions":"stats:read"}'))).toHaveProperty('error')
    const r = parseManifest(meta('{"permissions":["tasks:write"]}'))
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toContain('tasks:write')
  })
})

describe('covers', () => {
  it('is subset', () => {
    expect(covers(['a', 'b'], ['a'])).toBe(true)
    expect(covers(['a'], ['a', 'b'])).toBe(false)
    expect(covers([], [])).toBe(true)
  })
})

const proj = (id: number, name: string): Project => ({ id, name }) as unknown as Project
const task = (project_id: number, status: TaskSummary['status'], blocked = false): TaskSummary =>
  ({ project_id, status, blocked }) as unknown as TaskSummary

function deps(over: Partial<Deps> = {}): Deps {
  return {
    listProjects: vi.fn(async () => [proj(1, 'a'), proj(2, 'b')]),
    getProject: vi.fn(async (id: number) => proj(id, 'a')),
    listTasks: vi.fn(async () => [task(1, 'todo'), task(1, 'done'), task(2, 'todo', true), task(9, 'todo')]),
    ...over,
  }
}
const req = (method: string, params?: unknown) => ({ naru: 1 as const, id: 7, method, params })

describe('dispatch', () => {
  it('each method is forbidden without its permission', async () => {
    const d = deps()
    for (const [m, p] of [
      ['projects.list', 'projects:read'],
      ['project.get', 'projects:read'],
      ['tasks.list', 'tasks:read'],
      ['stats', 'stats:read'],
    ]) {
      const others = ['projects:read', 'tasks:read', 'stats:read'].filter((x) => x !== p)
      const r = await dispatch(req(m, { id: 1 }), others, d)
      expect(r).toMatchObject({ id: 7, error: { code: 'forbidden' } })
    }
    expect(d.listProjects).not.toHaveBeenCalled()
  })
  it('answers with the result when granted', async () => {
    const d = deps()
    expect(await dispatch(req('projects.list', { include_archived: true }), ['projects:read'], d)).toEqual({
      naru: 1,
      id: 7,
      result: [proj(1, 'a'), proj(2, 'b')],
    })
    expect(d.listProjects).toHaveBeenCalledWith(true)
    await dispatch(req('tasks.list', { project: 3, status: 'todo' }), ['tasks:read'], d)
    expect(d.listTasks).toHaveBeenCalledWith({ project: 3, status: 'todo' })
    await dispatch(req('project.get', { id: 4 }), ['projects:read'], d)
    expect(d.getProject).toHaveBeenCalledWith(4)
  })
  it('unknown method and bad params are usage', async () => {
    const all = ['projects:read', 'tasks:read', 'stats:read']
    for (const r of [
      await dispatch(req('nope'), all, deps()),
      await dispatch(req('toString'), all, deps()),
      await dispatch(req('project.get', { id: '1' }), all, deps()),
      await dispatch(req('project.get'), all, deps()),
      await dispatch(req('tasks.list', { status: 'weird' }), all, deps()),
      await dispatch(req('tasks.list', { project: 1.5 }), all, deps()),
      await dispatch(req('projects.list', { include_archived: 'yes' }), all, deps()),
      await dispatch(req('stats', [1]), all, deps()),
    ]) {
      expect(r).toMatchObject({ error: { code: 'usage' } })
    }
  })
  it('passes an API error through', async () => {
    const err = Object.assign(new Error('no such project'), { code: 'not_found' })
    const d = deps({ getProject: vi.fn(async () => Promise.reject(err)) })
    expect(await dispatch(req('project.get', { id: 1 }), ['projects:read'], d)).toEqual({
      naru: 1,
      id: 7,
      error: { code: 'not_found', message: 'no such project' },
    })
  })
  it('stats computes from the two lists', async () => {
    const r = await dispatch(req('stats'), ['stats:read'], deps())
    expect(r).toMatchObject({ result: { projects: [{ id: 1, total: 2 }, { id: 2, total: 1, blocked: 1 }] } })
  })
})

describe('computeStats', () => {
  it('tallies per status and blocked, in project order, dropping unlisted projects', () => {
    const s = computeStats(
      [proj(2, 'b'), proj(1, 'a')],
      [task(1, 'todo'), task(1, 'done', true), task(1, 'todo', true), task(2, 'cancelled'), task(5, 'todo')],
    )
    expect(s.projects.map((p) => p.id)).toEqual([2, 1])
    expect(s.projects[1]).toEqual({
      id: 1,
      name: 'a',
      total: 3,
      blocked: 2,
      by_status: { backlog: 0, todo: 2, in_progress: 0, done: 1, cancelled: 0 },
    })
    expect(s.projects[0].by_status.cancelled).toBe(1)
    expect(s.projects.reduce((n, p) => n + p.total, 0)).toBe(4)
  })
})

describe('newPanelKey', () => {
  it('is 32 hex chars and differs per call', () => {
    const a = newPanelKey()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(newPanelKey()).not.toBe(a)
  })
})

describe('parseRequest', () => {
  it('accepts the envelope', () => {
    expect(parseRequest({ naru: 1, k: 'K', id: 'a', method: 'stats' }, 'K')).toMatchObject({ id: 'a', method: 'stats' })
    expect(parseRequest({ naru: 1, k: 'K', id: 3, method: 'stats', params: { x: 1 } }, 'K')).toMatchObject({ id: 3 })
  })
  it('rejects anything else, including other naru messages', () => {
    for (const d of [
      null,
      'x',
      42,
      {},
      { naru: '1', id: 1, method: 'stats' },
      { naru: 'board-theme', vars: {} },
      { naru: 1, id: 1 },
      { naru: 1, id: {}, method: 'stats' },
      { naru: 1, id: NaN, method: 'stats' },
      { naru: 1, id: 1, method: 5 },
      { naru: 1, id: 1, method: 'stats' },
      { naru: 1, k: 'other', id: 1, method: 'stats' },
    ]) {
      expect(parseRequest(d, 'K')).toBeNull()
    }
  })
})

describe('grants', () => {
  beforeEach(() => localStorage.clear())
  it('round-trips through localStorage and revokes', () => {
    expect(loadGrants()).toEqual({})
    grant('id:3', ['stats:read'])
    grant('builtin:project-stats', ['stats:read', 'tasks:read'])
    expect(loadGrants()).toEqual({ 'id:3': ['stats:read'], 'builtin:project-stats': ['stats:read', 'tasks:read'] })
    expect(JSON.parse(localStorage.getItem(GRANTS_KEY)!)).toMatchObject({ v: 1 })
    revoke('id:3')
    expect(loadGrants()).toEqual({ 'builtin:project-stats': ['stats:read', 'tasks:read'] })
  })
  it('malformed storage reads as none and unknown words are dropped', () => {
    localStorage.setItem(GRANTS_KEY, '{nope')
    expect(loadGrants()).toEqual({})
    localStorage.setItem(GRANTS_KEY, JSON.stringify({ v: 2, grants: { a: ['stats:read'] } }))
    expect(loadGrants()).toEqual({})
    localStorage.setItem(GRANTS_KEY, JSON.stringify({ v: 1, grants: { a: ['stats:read', 'root'] } }))
    expect(loadGrants()).toEqual({ a: ['stats:read'] })
  })
})

describe('buildSrcdoc', () => {
  const doc = buildSrcdoc('<p id="author">x</p>', { permissions: ['stats:read'], themeVars: { '--naru-bg': 'rgb(1, 2, 3)' }, key: 'abc' })
  it('puts the CSP meta first in <head>, before the SDK and the author body', () => {
    const parsed = new DOMParser().parseFromString(doc, 'text/html')
    const first = parsed.head.firstElementChild!
    expect(first.tagName).toBe('META')
    expect(first.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(first.getAttribute('content')).toBe(PANEL_CSP)
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<script>'))
    expect(doc.indexOf('<script>')).toBeLessThan(doc.indexOf('id="author"'))
    expect(doc.startsWith('<!doctype html><html><head>')).toBe(true)
  })
  it('inlines the granted list and the theme', () => {
    expect(doc).toContain('var P=["stats:read"]')
    expect(doc).not.toContain('__PERMISSIONS__')
    expect(doc).toContain('K="abc"')
    expect(doc).not.toContain('__KEY__')
    expect(doc).toContain(':root{--naru-bg:rgb(1, 2, 3)}')
    expect(SDK_SCRIPT).toContain('e.source!==parent')
  })
  it('a hostile theme value or permission cannot break out', () => {
    expect(themeStyle({ '--naru-a': 'x;}</style>', '--naru-b': 'ok', '--other': 'y', '--naru-c': 'a{b' })).toBe(
      ':root{--naru-b:ok}',
    )
    const d = buildSrcdoc('', { permissions: ['</script><b>'], themeVars: {}, key: '</script>' })
    expect(d.match(/<\/script>/g)).toHaveLength(1)
  })
})
