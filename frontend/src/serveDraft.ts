import type { ConfigServe } from './types/ConfigServe'

/**
 * Pure draft logic for the Settings page's Server editor (mesa task 1621),
 * hoisted out of the component so it is unit-testable (see CLAUDE.md).
 *
 * Every `naru serve` flag is a key of the config's `serve` section. The same
 * rules as [`watchersDraft`](./watchersDraft.ts) apply: the port and the host
 * list are edited as text (a half-typed value has to survive a keystroke) and
 * only `changedServe` converts; a blank port or an empty host list is PUT as
 * `null`, the server's "remove this key, restore the default". The switches
 * are checkboxes showing `value ?? default` and are sent as explicit booleans.
 */

export const MIN_PORT = 1
export const MAX_PORT = 65535

export const BOOL_KEYS = [
  'lan',
  'watch_todo',
  'watch_inbox',
  'watch_cost',
  'watch_retro',
  'watch_workflows',
] as const
export type BoolKey = (typeof BOOL_KEYS)[number]

/** The watcher switches — the ones that take effect live, within a tick. */
export const WATCH_KEYS = [
  'watch_todo',
  'watch_inbox',
  'watch_cost',
  'watch_retro',
  'watch_workflows',
] as const

/** The boxes as typed. */
export type ServeDraft = {
  port: string
  allow_host: string
} & Record<BoolKey, boolean>

/** The editable state as loaded: an unset value shows its default. */
export function draftFrom(serve: ConfigServe): ServeDraft {
  const draft = {
    port: serve.port.value === null ? '' : String(serve.port.value),
    allow_host: (serve.allow_host.value ?? []).join('\n'),
  } as ServeDraft
  for (const key of BOOL_KEYS)
    draft[key] = serve[key].value ?? serve[key].default
  return draft
}

/** The complaint about the port box, or `null`. Blank is the default. */
export function portError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return 'not a whole number'
  const n = Number(trimmed)
  if (n < MIN_PORT || n > MAX_PORT) {
    return `must be between ${MIN_PORT} and ${MAX_PORT}`
  }
  return null
}

/** The names in the hosts box: one per line or comma separated, normalized. */
export function parseHosts(text: string): string[] {
  return (text ?? '')
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '')
}

/** The complaint about the hosts box, or `null`. */
export function hostsError(text: string): string | null {
  const bad = parseHosts(text).find((h) => /[/:]/.test(h))
  return bad ? `${bad}: give a bare hostname, no scheme, path or port` : null
}

function portOf(draft: ServeDraft): number | null {
  const trimmed = (draft.port ?? '').trim()
  return trimmed === '' ? null : Number(trimmed)
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** True when nothing drafted would be rejected by the server. */
export function isSavable(draft: ServeDraft): boolean {
  return portError(draft.port) === null && hostsError(draft.allow_host) === null
}

/** The keys that differ from what the server last reported. */
function changedKeys(serve: ConfigServe, draft: ServeDraft): string[] {
  const keys: string[] = []
  if (portOf(draft) !== serve.port.value) keys.push('port')
  if (!sameList(parseHosts(draft.allow_host), serve.allow_host.value ?? [])) {
    keys.push('allow_host')
  }
  for (const key of BOOL_KEYS) {
    if (draft[key] !== (serve[key].value ?? serve[key].default)) keys.push(key)
  }
  return keys
}

/** True when the draft differs from the server, or holds a rejected value. */
export function isDirty(serve: ConfigServe, draft: ServeDraft): boolean {
  return !isSavable(draft) || changedKeys(serve, draft).length > 0
}

/**
 * The subset to PUT: only the keys that changed, so two editors cannot
 * clobber each other. A blank port / empty host list sends `null`.
 */
export function changedServe(
  serve: ConfigServe,
  draft: ServeDraft,
): Record<string, number | boolean | string[] | null> {
  if (!isSavable(draft)) return {}
  const out: Record<string, number | boolean | string[] | null> = {}
  for (const key of changedKeys(serve, draft)) {
    if (key === 'port') out.port = portOf(draft)
    else if (key === 'allow_host') {
      const hosts = parseHosts(draft.allow_host)
      out.allow_host = hosts.length === 0 ? null : hosts
    } else out[key] = draft[key as BoolKey]
  }
  return out
}

/** The key's flag name, for "set by --lan on the command line". */
export function flagName(key: string): string {
  return '--' + key.replace(/_/g, '-')
}
