// Pure logic for the run view (naru task 1831): `GET /api/runs/{id}?tail=N`
// answers `{job, events}` where `events` is events.jsonl line by line —
// claude's stream-json stdout verbatim plus the runner's own `naru_runner`
// lines (src/core/runner.rs). The runner's views are `serde_json::Value`, not
// ts-rs types, so the shapes here are declared by hand and every read is
// defensive: a line that does not parse arrives as a bare string, and a field
// that is not the type expected is treated as absent. Everything in an entry
// is untrusted plain text — render it as text, never as HTML.
import { chatToolTarget } from './agentChat'

/** The job fields the run view reads (`runner::Job` + `view()`'s derived keys). */
export type RunStatus = 'running' | 'idle' | 'finished' | 'failed' | 'stopped'

export type RunJob = {
  job_id: string
  session_id?: string
  name?: string
  model?: string
  cwd?: string
  status: RunStatus
  runner_alive?: boolean
  pending_messages?: number
  last_result?: string | null
  last_subtype?: string | null
  last_is_error?: boolean | null
}

/** `GET /api/runs/{id}?tail=N`. */
export type RunShown = { job: RunJob; events: unknown[] }

export type RunEntry =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      target: string
      /** Set on an Agent/Task launch row that has subagent events (task 1865). */
      subagent?: SubagentGroup
    }
  | {
      kind: 'tool_result'
      toolId: string
      text: string
      isError: boolean
      truncated: boolean
    }
  | { kind: 'user'; text: string }
  | {
      kind: 'result'
      subtype: string
      isError: boolean
      costUsd: number | null
      text: string
    }
  | { kind: 'lifecycle'; event: string; label: string }
  | { kind: 'raw'; text: string }
  /** Subagent events whose launching tool call is outside the loaded window. */
  | ({ kind: 'subagent' } & SubagentGroup)

/** The folded work of one subagent: `count` is its event lines. */
export type SubagentGroup = {
  label: string
  entries: RunEntry[]
  count: number
}

export const EARLIER_SUBAGENT = 'earlier subagent'

export type RunControls = { send: boolean; interrupt: boolean; stop: boolean }

/** A tool result's text is cut here; `truncated` tells the row to say so. */
export const RUN_RESULT_MAX = 600
const TARGET_MAX = 200

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** A tool_use input's one-line target: the field an agent would name first. */
function toolTarget(input: unknown): string {
  if (!isRecord(input)) return ''
  for (const key of [
    'command',
    'file_path',
    'path',
    'pattern',
    'url',
    'description',
    'query',
  ]) {
    const v = str(input[key])
    if (v) return chatToolTarget(cut(v.split('\n')[0], TARGET_MAX))
  }
  for (const v of Object.values(input)) {
    const s = str(v)
    if (s) return cut(s.split('\n')[0], TARGET_MAX)
  }
  return ''
}

/** A tool_result's `content` is a string or a list of `{type:'text'}` blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) ? (str(b.text) ?? '') : ''))
      .filter((t) => t !== '')
      .join('\n')
  }
  return ''
}

function lifecycleLabel(ev: Record<string, unknown>): string {
  const event = str(ev.event) ?? 'event'
  switch (event) {
    case 'claude_started':
      return ev.resume === true ? 'claude resumed' : 'claude started'
    case 'message_delivered':
      return ev.source === 'resume'
        ? 'continue prompt delivered'
        : 'message delivered'
    case 'interrupt_requested':
      return 'interrupt requested'
    case 'stop_requested':
      return 'stop requested'
    case 'idle_timeout':
      return typeof ev.secs === 'number'
        ? `idle timeout (${ev.secs}s)`
        : 'idle timeout'
    case 'resumed':
      return 'run resumed'
    case 'exited':
      return `exited${str(ev.status) ? ` · ${str(ev.status)}` : ''}${
        typeof ev.exit_code === 'number' ? ` (code ${ev.exit_code})` : ''
      }`
    case 'failed':
      return `failed${str(ev.error) ? ` · ${cut(str(ev.error) as string, TARGET_MAX)}` : ''}`
    case 'stopped':
      return `stopped${str(ev.by) ? ` · ${str(ev.by)}` : ''}`
    default:
      return event.replace(/_/g, ' ')
  }
}

function contentBlocks(ev: Record<string, unknown>): unknown[] {
  const message = ev.message
  if (!isRecord(message)) return []
  const content = message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

function entriesOf(ev: unknown): RunEntry[] {
  if (typeof ev === 'string')
    return ev.trim() ? [{ kind: 'raw', text: cut(ev, RUN_RESULT_MAX) }] : []
  if (!isRecord(ev)) return []
  switch (ev.type) {
    case 'naru_runner': {
      const event = str(ev.event)
      return event
        ? [{ kind: 'lifecycle', event, label: lifecycleLabel(ev) }]
        : []
    }
    case 'assistant': {
      const out: RunEntry[] = []
      for (const b of contentBlocks(ev)) {
        if (!isRecord(b)) continue
        if (b.type === 'text') {
          const text = str(b.text)
          if (text && text.trim()) out.push({ kind: 'text', text })
        } else if (b.type === 'tool_use') {
          out.push({
            kind: 'tool',
            id: str(b.id) ?? '',
            name: str(b.name) ?? 'tool',
            target: toolTarget(b.input),
          })
        }
      }
      return out
    }
    case 'user': {
      const out: RunEntry[] = []
      for (const b of contentBlocks(ev)) {
        if (!isRecord(b)) continue
        if (b.type === 'tool_result') {
          const full = resultText(b.content)
          out.push({
            kind: 'tool_result',
            toolId: str(b.tool_use_id) ?? '',
            text: cut(full, RUN_RESULT_MAX),
            isError: b.is_error === true,
            truncated: full.length > RUN_RESULT_MAX,
          })
        } else if (b.type === 'text') {
          const text = str(b.text)
          if (text && text.trim()) out.push({ kind: 'user', text })
        }
      }
      return out
    }
    case 'result':
      return [
        {
          kind: 'result',
          subtype: str(ev.subtype) ?? 'result',
          isError: ev.is_error === true,
          costUsd:
            typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
          text: str(ev.result) ?? '',
        },
      ]
    // system (hooks, init, titles, thinking_tokens), control_response,
    // rate_limit_event and anything unknown are protocol noise.
    default:
      return []
  }
}

/** The parent tool_use id of a subagent line; '' = owned by one, id unknown. */
function subagentParent(ev: unknown): string | null {
  if (!isRecord(ev)) return null
  const parent = str(ev.parent_tool_use_id)
  if (parent !== null) return parent
  return ev.type === 'system' && ev.owned_by_subagent === true ? '' : null
}

function launchLabel(type: string | null, description: string | null): string {
  const parts = [type, description].filter((p): p is string => !!p && !!p.trim())
  return parts.length > 0 ? cut(parts.join(' · '), TARGET_MAX) : 'subagent'
}

/**
 * events.jsonl lines -> the ordered, readable entries of a run. Subagent
 * lines (a string `parent_tool_use_id`, or a system line with
 * `owned_by_subagent: true`) stay out of the list: they fold into the
 * launching tool entry's `subagent`, or — launch outside the window — into one
 * trailing `earlier subagent` entry.
 */
export function runEntries(events: readonly unknown[]): RunEntry[] {
  // A launch is labelled from its own tool_use input, else from the
  // system/task_started line naming it by tool_use_id.
  const labels = new Map<string, string>()
  for (const ev of events) {
    if (!isRecord(ev)) continue
    if (ev.type === 'system' && ev.subtype === 'task_started') {
      const id = str(ev.tool_use_id)
      if (id && !labels.has(id))
        labels.set(id, launchLabel(str(ev.subagent_type), str(ev.description)))
    } else if (ev.type === 'assistant') {
      for (const b of contentBlocks(ev)) {
        if (!isRecord(b) || b.type !== 'tool_use' || !isRecord(b.input)) continue
        const id = str(b.id)
        const type = str(b.input.subagent_type)
        const description = str(b.input.description)
        if (id && (type || description))
          labels.set(id, launchLabel(type, description))
      }
    }
  }
  const out: RunEntry[] = []
  const launches = new Map<string, Extract<RunEntry, { kind: 'tool' }>>()
  const owned: { parent: string; ev: unknown }[] = []
  let lastParent = ''
  for (const ev of events) {
    const parent = subagentParent(ev)
    if (parent !== null) {
      // An owned system line carries no id: it follows the previous subagent line.
      const p = parent === '' ? lastParent : parent
      if (parent !== '') lastParent = parent
      owned.push({ parent: p, ev })
      continue
    }
    for (const e of entriesOf(ev)) {
      out.push(e)
      if (e.kind === 'tool' && e.id) launches.set(e.id, e)
    }
  }
  const orphan: SubagentGroup = { label: EARLIER_SUBAGENT, entries: [], count: 0 }
  for (const { parent, ev } of owned) {
    const launch = launches.get(parent)
    let group = orphan
    if (launch) {
      launch.subagent ??= {
        label: labels.get(parent) ?? 'subagent',
        entries: [],
        count: 0,
      }
      group = launch.subagent
    }
    group.count += 1
    group.entries.push(...entriesOf(ev))
  }
  if (orphan.count > 0) out.push({ kind: 'subagent', ...orphan })
  return out
}

/** The run's controls: send and stop until it is over, interrupt only mid-turn. */
export function runControls(
  job: Pick<RunJob, 'status'> | null | undefined,
): RunControls {
  const status = job?.status
  const live = status === 'running' || status === 'idle'
  return { send: live, interrupt: status === 'running', stop: live }
}

/** Splits a raw events.jsonl body into the shape the API's `events` has. */
export function parseEventLines(body: string): unknown[] {
  return body
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l) as unknown
      } catch {
        return l
      }
    })
}
