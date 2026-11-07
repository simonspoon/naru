// Custom panels (naru task 2613, docs/custom-panels.md): the pure half. A
// panel is a library item of kind `panel` whose body is an HTML fragment run in
// a sandboxed iframe; it reaches Naru only through `window.naru.call`, which
// posts a request to the page. Everything the page decides lives here so it is
// testable without a DOM render: reading the manifest, the browser-side grant
// store, the request/reply protocol, the read-only method table and the
// document the iframe is given.
//
// Enforcement is in the parent page (`dispatch`), never in the iframe, and the
// grant lives in this browser's localStorage, where a sandboxed frame cannot
// reach it and a CLI/API caller cannot write it.

import type { Project } from './types/Project'
import type { Status } from './types/Status'
import type { TaskSummary } from './types/TaskSummary'

/** Each permission word a manifest may ask for, with the line the prompt shows. */
export const PERMISSIONS = {
  'projects:read': 'Read your projects (names, descriptions, folders)',
  'tasks:read': 'Read tasks',
  'stats:read': 'Read task counts per project',
} as const

export type Permission = keyof typeof PERMISSIONS

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PERMISSIONS, value)
}

/** The permission each method needs. A method absent here does not exist. */
export const METHOD_PERMISSION: Record<string, Permission> = {
  'projects.list': 'projects:read',
  'project.get': 'projects:read',
  'tasks.list': 'tasks:read',
  stats: 'stats:read',
}

const STATUSES: readonly Status[] = ['backlog', 'todo', 'in_progress', 'done', 'cancelled']

// --- Manifest ----------------------------------------------------------

export type Manifest = { title?: string; permissions: Permission[] }

/**
 * Reads `<meta name="naru-panel" content='{"title":…,"permissions":[…]}'>`
 * from a panel body. Parsed here, in the page, with `DOMParser` — an inert
 * document — never by the panel itself. No meta = no permissions; bad JSON or
 * an unknown permission word is an `error` the tab shows instead of running.
 */
export function parseManifest(body: string): Manifest | { error: string } {
  const doc = new DOMParser().parseFromString(body, 'text/html')
  const meta = doc.querySelector('meta[name="naru-panel"]')
  if (meta === null) return { permissions: [] }
  let raw: unknown
  try {
    raw = JSON.parse(meta.getAttribute('content') ?? '')
  } catch {
    return { error: 'The naru-panel manifest is not valid JSON.' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'The naru-panel manifest must be a JSON object.' }
  }
  const m = raw as { title?: unknown; permissions?: unknown }
  if (m.title !== undefined && typeof m.title !== 'string') {
    return { error: 'The manifest title must be a string.' }
  }
  const asked = m.permissions ?? []
  if (!Array.isArray(asked)) return { error: 'The manifest permissions must be a list.' }
  const permissions: Permission[] = []
  for (const p of asked) {
    if (!isPermission(p)) return { error: `Unknown permission ${JSON.stringify(p)}.` }
    if (!permissions.includes(p)) permissions.push(p)
  }
  const title = m.title?.trim()
  return title ? { title, permissions } : { permissions }
}

// --- Grants (browser-side) ---------------------------------------------

export const GRANTS_KEY = 'naru-panel-grants'

export type Grants = Record<string, Permission[]>

/** A stored value as grants; anything malformed reads as none. */
export function parseGrants(raw: string | null): Grants {
  if (raw === null) return {}
  try {
    const v = JSON.parse(raw) as { v?: unknown; grants?: unknown }
    if (v?.v !== 1 || typeof v.grants !== 'object' || v.grants === null) return {}
    const out: Grants = {}
    for (const [key, list] of Object.entries(v.grants)) {
      if (Array.isArray(list)) out[key] = list.filter(isPermission)
    }
    return out
  } catch {
    return {}
  }
}

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadGrants(): Grants {
  return parseGrants(store()?.getItem(GRANTS_KEY) ?? null)
}

export function saveGrants(grants: Grants): void {
  try {
    store()?.setItem(GRANTS_KEY, JSON.stringify({ v: 1, grants }))
  } catch {
    // storage full or blocked: the panel simply asks again next time
  }
}

/** Records exactly `perms` as `itemKey`'s grant (least privilege: a body that
 *  now asks for fewer drops the rest). */
export function grant(itemKey: string, perms: readonly Permission[]): Grants {
  const grants = { ...loadGrants(), [itemKey]: [...perms] }
  saveGrants(grants)
  return grants
}

export function revoke(itemKey: string): Grants {
  const grants = { ...loadGrants() }
  delete grants[itemKey]
  saveGrants(grants)
  return grants
}

/** The panel may run iff everything it asks for is granted. */
export function covers(granted: readonly string[], requested: readonly string[]): boolean {
  return requested.every((p) => granted.includes(p))
}

// --- Protocol ----------------------------------------------------------

export type Request = { naru: 1; id: string | number; method: string; params?: unknown }
export type Reply =
  | { naru: 1; id: string | number; result: unknown }
  | { naru: 1; id: string | number; error: { code: string; message: string } }

/** A panel's message as a request, or null for anything that is not one —
 *  `naru: 1` is a number, so the board / mark-skin / key-relay messages
 *  (`naru: '<string>'`) never match. `key` is the per-load key `buildSrcdoc`
 *  put in the SDK: a document the frame navigated to does not hold it, so it
 *  cannot use the panel's grant. */
export function parseRequest(data: unknown, key: string): Request | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.naru !== 1 || d.k !== key) return null
  if (typeof d.method !== 'string') return null
  if (typeof d.id !== 'string' && !(typeof d.id === 'number' && Number.isFinite(d.id))) return null
  return { naru: 1, id: d.id, method: d.method, params: d.params }
}

export type Deps = {
  listProjects: (includeArchived?: boolean) => Promise<Project[]>
  getProject: (id: number) => Promise<Project>
  listTasks: (filters?: { project?: number; status?: Status }) => Promise<TaskSummary[]>
}

class Usage extends Error {}

function fail(id: Request['id'], code: string, message: string): Reply {
  return { naru: 1, id, error: { code, message } }
}

function paramsObject(params: unknown): Record<string, unknown> {
  if (params === undefined) return {}
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Usage('params must be an object')
  }
  return params as Record<string, unknown>
}

function optInt(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Usage(`${key} must be an integer`)
  return v
}

export type ProjectStats = {
  id: number
  name: string
  total: number
  blocked: number
  by_status: Record<Status, number>
}

/** Per-project task tallies in project-list order; a task whose project is not
 *  in `projects` (archived, say) is dropped. */
export function computeStats(projects: Project[], tasks: TaskSummary[]): { projects: ProjectStats[] } {
  const byId = new Map<number, ProjectStats>()
  const out = projects.map((p) => {
    const s: ProjectStats = {
      id: p.id,
      name: p.name,
      total: 0,
      blocked: 0,
      by_status: { backlog: 0, todo: 0, in_progress: 0, done: 0, cancelled: 0 },
    }
    byId.set(p.id, s)
    return s
  })
  for (const t of tasks) {
    const s = byId.get(t.project_id)
    if (s === undefined) continue
    s.total += 1
    s.by_status[t.status] += 1
    if (t.blocked) s.blocked += 1
  }
  return { projects: out }
}

/**
 * Answers one request. `granted` is what this browser's store says right now —
 * the caller reads it per request, so a revoke is immediate. Unknown method or
 * bad params are `usage`, a missing permission `forbidden`, and an API failure
 * passes its own code and message through.
 */
export async function dispatch(req: Request, granted: readonly string[], deps: Deps): Promise<Reply> {
  const needs = Object.prototype.hasOwnProperty.call(METHOD_PERMISSION, req.method)
    ? METHOD_PERMISSION[req.method]
    : undefined
  if (needs === undefined) return fail(req.id, 'usage', `unknown method ${req.method}`)
  if (!granted.includes(needs)) return fail(req.id, 'forbidden', `${req.method} needs the ${needs} permission`)
  try {
    const p = paramsObject(req.params)
    switch (req.method) {
      case 'projects.list': {
        const inc = p.include_archived
        if (inc !== undefined && typeof inc !== 'boolean') throw new Usage('include_archived must be a boolean')
        return { naru: 1, id: req.id, result: await deps.listProjects(inc === true) }
      }
      case 'project.get': {
        const id = optInt(p, 'id')
        if (id === undefined) throw new Usage('id is required')
        return { naru: 1, id: req.id, result: await deps.getProject(id) }
      }
      case 'tasks.list': {
        const project = optInt(p, 'project')
        const status = p.status
        if (status !== undefined && !STATUSES.includes(status as Status)) throw new Usage('status is not a task status')
        return { naru: 1, id: req.id, result: await deps.listTasks({ project, status: status as Status | undefined }) }
      }
      default: {
        const [projects, tasks] = await Promise.all([deps.listProjects(), deps.listTasks()])
        return { naru: 1, id: req.id, result: computeStats(projects, tasks) }
      }
    }
  } catch (e) {
    if (e instanceof Usage) return fail(req.id, 'usage', e.message)
    const err = e as { code?: unknown; message?: unknown }
    return fail(
      req.id,
      typeof err.code === 'string' ? err.code : 'error',
      typeof err.message === 'string' ? err.message : 'request failed',
    )
  }
}

// --- The iframe document -----------------------------------------------

/** The panel's Content-Security-Policy: `api.rs::RENDER_CSP` minus
 *  `frame-ancestors` and `sandbox`, which a meta tag ignores (the iframe's
 *  `sandbox` attribute does the second). Inline script and style, data: media,
 *  nothing fetched, nowhere to submit. */
export const PANEL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
  "font-src data:; media-src data:; form-action 'none'; base-uri 'none'"

/** A fresh per-load SDK key. `getRandomValues`, not `randomUUID`: the latter
 *  is secure-context only and `serve --lan` may be plain http; and never
 *  `Math.random`, since a guessable key is no key. */
export function newPanelKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('')
}

/** The panel-side SDK (ES5), with `__PERMISSIONS__` standing for the granted
 *  list and `__KEY__` for the per-load key every request carries. It answers
 *  only the parent window's `naru: 1` replies. */
export const SDK_SCRIPT =
  '(function(){var P=__PERMISSIONS__,K=__KEY__,pending={},seq=0;' +
  "window.addEventListener('message',function(e){var d=e.data;" +
  'if(e.source!==parent||!d||d.naru!==1||!Object.prototype.hasOwnProperty.call(pending,d.id))return;' +
  'var p=pending[d.id];delete pending[d.id];' +
  'if(d.error){var x=new Error(d.error.message);x.code=d.error.code;p.reject(x)}else p.resolve(d.result)});' +
  'window.naru={permissions:P,call:function(method,params){return new Promise(function(resolve,reject){' +
  "var id=++seq;pending[id]={resolve:resolve,reject:reject};parent.postMessage({naru:1,k:K,id:id,method:method,params:params},'*')})}}})();"

/** `:root{--naru-…}` for the theme variables a panel may style with. A key
 *  that is not a `--naru-` name, or a value that could close the rule or the
 *  element, is dropped. */
export function themeStyle(vars: Record<string, string>): string {
  const decls = Object.entries(vars)
    .filter(([k, v]) => /^--naru-[a-z0-9-]+$/.test(k) && !/[<{};]/.test(v))
    .map(([k, v]) => `${k}:${v}`)
  return `:root{${decls.join(';')}}`
}

/**
 * The document the iframe's `srcdoc` holds. The CSP meta is the first child of
 * `<head>`, before the SDK and before any author markup, so nothing the author
 * writes runs unconstrained.
 */
export function buildSrcdoc(
  body: string,
  opts: { permissions: readonly string[]; themeVars: Record<string, string>; key: string },
): string {
  // `<` is escaped so a permission list or key can never end the <script> element.
  const perms = JSON.stringify([...opts.permissions]).replace(/</g, '\\u003c')
  const key = JSON.stringify(opts.key).replace(/</g, '\\u003c')
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">` +
    `<style>${themeStyle(opts.themeVars)}</style>` +
    `<script>${SDK_SCRIPT.replace('__KEY__', () => key).replace('__PERMISSIONS__', () => perms)}</script>` +
    `</head><body>${body}</body></html>`
  )
}
