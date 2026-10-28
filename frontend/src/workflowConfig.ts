// Pure logic for the workflow builder (mesa task 1607, docs/workflows.md):
// the seven node kinds, the config each starts with, the one-line summary a
// card shows, and the editor's draft ⇄ config round trip with the shape
// checks the backend's `core::workflow::validate_config` makes. The server
// stays the authority (a rejected save comes back as an inline error), so the
// checks here only exist to say *which field* is wrong before the round trip.

import type { WorkflowNodeKind } from './types/WorkflowNodeKind'
import type { WorkflowTrigger } from './types/WorkflowTrigger'

export type NodeConfig = Record<string, unknown>

export interface KindInfo {
  kind: WorkflowNodeKind
  label: string
  /** The default title a node dropped from the palette gets. */
  title: string
}

/** Palette order. */
export const NODE_KINDS: readonly KindInfo[] = [
  { kind: 'trigger', label: 'Trigger', title: 'Start' },
  // Trigger source (naru task 2004): fires on an interval or a UTC cron expression.
  { kind: 'schedule', label: 'Schedule', title: 'Schedule' },
  // Trigger source (naru task 2005): an HTTP POST starts the run, its JSON body is the typed `body` pin.
  { kind: 'webhook', label: 'Webhook', title: 'Webhook' },
  // Trigger source (naru task 2006): a task created or changing status starts the run.
  { kind: 'task-event', label: 'Task event', title: 'Task event' },
  // Trigger source (naru task 2007): a watched path changing starts the run.
  { kind: 'file-watch', label: 'File watch', title: 'File watch' },
  { kind: 'prompt', label: 'Prompt', title: 'Prompt' },
  { kind: 'agent', label: 'Agent', title: 'Agent' },
  { kind: 'cli', label: 'CLI tool', title: 'Command' },
  { kind: 'script', label: 'Script', title: 'Script' },
  { kind: 'branch', label: 'Branch', title: 'Gate' },
  { kind: 'decide', label: 'Decide', title: 'Decide' },
  // Flow node (naru task 1990): many-way branch on the input value.
  { kind: 'switch', label: 'Switch', title: 'Switch' },
  { kind: 'output', label: 'Output', title: 'Output' },
  // Data node (naru task 1985): text to a typed value.
  { kind: 'parse-json', label: 'Parse JSON', title: 'Parse JSON' },
  // Data node (naru task 1986): get/set a named, typed value for the run.
  { kind: 'variable', label: 'Variable', title: 'Variable' },
  // Data node (naru task 1987): map or filter a list.
  { kind: 'mapfilter', label: 'Map / Filter', title: 'Map / Filter' },
  // Data node (naru task 1988): run a script once per list item.
  { kind: 'foreach', label: 'For Each', title: 'For Each' },
  // Flow nodes (naru task 1989): fan out, then wait for every branch.
  { kind: 'parallel', label: 'Parallel', title: 'Parallel' },
  { kind: 'join', label: 'Join', title: 'Join' },
  // Flow node (naru task 1991): retry / timeout wrapper around a cli, script, prompt or agent.
  { kind: 'retry', label: 'Retry', title: 'Retry / Timeout' },
  // Flow node (naru task 1992): wait for a duration or until a UTC time.
  { kind: 'delay', label: 'Delay', title: 'Delay' },
  // Flow node (naru task 1993): pause the run until a person approves or rejects.
  { kind: 'gate', label: 'Gate', title: 'Approval gate' },
  { kind: 'trycatch', label: 'Try / Catch', title: 'Try / Catch' },
  // Flow node (naru task 1994): run another workflow, its last output coming out.
  { kind: 'subworkflow', label: 'Sub-workflow', title: 'Run workflow' },
  // Action node (naru task 1996): create, update or read a Naru task.
  { kind: 'task', label: 'Naru task', title: 'Naru task' },
  // Action node (naru task 1997): one HTTP request, the response coming out as JSON.
  { kind: 'http', label: 'HTTP request', title: 'HTTP request' },
  // Action node (naru task 1998): tell the phone, or say it in the live conversation.
  { kind: 'notify', label: 'Notify', title: 'Notify' },
  // Action node (naru task 1999): commit, switch branch, or diff a git working tree.
  { kind: 'git', label: 'Git', title: 'Git' },
  // Action node (naru task 2000): read or write a file.
  { kind: 'file', label: 'Read / Write File', title: 'File' },
  // Action node (naru task 2002): add to or search a project's notebook.
  { kind: 'memory', label: 'Memory Add / Search', title: 'Memory' },
  // Action node (naru task 2003): run a test or browser check, pass/fail with evidence.
  { kind: 'verify', label: 'Verify', title: 'Verify' },
  // Action node (naru task 2001): push a markdown or html board to the live whiteboard.
  { kind: 'board', label: 'Whiteboard', title: 'Whiteboard' },
  // Editor-only (naru task 2008): a coloured, titled box to group and label nodes; never run.
  { kind: 'comment', label: 'Comment', title: 'Comment' },
]


/** The palette's collapsible groups (naru task 2422), in palette order. Every
 *  `NODE_KINDS` kind is in exactly one (workflowConfig.test.ts holds that). */
export const PALETTE_GROUPS: readonly { name: string; kinds: readonly WorkflowNodeKind[] }[] = [
  { name: 'Triggers', kinds: ['trigger', 'schedule', 'webhook', 'task-event', 'file-watch'] },
  { name: 'AI', kinds: ['prompt', 'agent'] },
  { name: 'Run', kinds: ['cli', 'script', 'subworkflow'] },
  {
    name: 'Logic',
    kinds: ['branch', 'decide', 'switch', 'foreach', 'mapfilter', 'parallel', 'join'],
  },
  { name: 'Control', kinds: ['retry', 'trycatch', 'delay', 'gate'] },
  { name: 'Data', kinds: ['parse-json', 'variable', 'output'] },
  {
    name: 'Actions',
    kinds: ['task', 'http', 'notify', 'git', 'file', 'memory', 'verify', 'board'],
  },
  { name: 'Notes', kinds: ['comment'] },
]

// Which palette groups are collapsed: one per-browser list, default none.
export const PALETTE_COLLAPSED_KEY = 'naru-wf-palette-collapsed'

export function loadPaletteCollapsed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PALETTE_COLLAPSED_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

export function savePaletteCollapsed(names: string[]): void {
  try {
    localStorage.setItem(PALETTE_COLLAPSED_KEY, JSON.stringify(names))
  } catch {
    // Storage unavailable — the groups just won't stay collapsed.
  }
}

/** Kinds made by a pin's context menu (naru task 1981), not dropped from the
 *  palette: they need a struct to be for. */
const SHAPE_KINDS: readonly KindInfo[] = [
  { kind: 'break', label: 'Break', title: 'Break' },
  { kind: 'make', label: 'Make', title: 'Make' },
]

export function kindInfo(kind: WorkflowNodeKind): KindInfo {
  return [...NODE_KINDS, ...SHAPE_KINDS].find((k) => k.kind === kind)!
}

export function isNodeKind(value: unknown): value is WorkflowNodeKind {
  return NODE_KINDS.some((k) => k.kind === value)
}

export const PROMPT_MODELS = ['haiku', 'sonnet', 'opus'] as const
export const BRANCH_OPS = ['contains', 'regex', 'score_above', 'score_below', 'equals'] as const
export const OUTPUT_TARGETS = ['log', 'task', 'inbox', 'board'] as const
export const TRIGGER_MODES: readonly WorkflowTrigger[] = ['manual', 'time', 'voice', 'ambient']
/** The label of a decide node's catch-all edge; no option may be it. */
export const DECIDE_FALLBACK = 'fallback'
/** The label of a switch node's catch-all edge; no case may be labelled it. */
export const SWITCH_DEFAULT = 'default'
export const SWITCH_OPS = ['equals', 'contains', 'regex'] as const
/** A decide node's confidence threshold when its config names none. */
export const DEFAULT_DECIDE_THRESHOLD = 0.5
/** The ambient engine's event vocabulary (`core::workflow::AMBIENT_EVENTS`). */
export const AMBIENT_EVENTS = ['idea', 'can-help', 'wake'] as const
export const INBOX_KINDS = ['task-summary', 'change-request'] as const

/** The config a node of `kind` is created with — one the server accepts as it
 *  is, so a palette drop never fails on an empty field. A script node has no
 *  honest default: it gets `script` (the first script the page knows of) or the
 *  placeholder `unset`, which the server accepts at creation (a script that does
 *  not exist is a runtime failure) and the card summarises as unset. */
export function defaultConfig(kind: WorkflowNodeKind, script?: string, agent?: string): NodeConfig {
  switch (kind) {
    case 'trigger':
      return { mode: 'manual' }
    case 'schedule':
      return { every_minutes: 60 }
    case 'webhook':
      return {}
    case 'task-event':
      return { event: 'created' }
    case 'file-watch':
      return { path: 'unset', event: 'any' }
    case 'prompt':
      return { model: 'haiku', thinking: false, prompt: 'Summarise the input in one line.' }
    case 'agent':
      return { agent: agent ?? 'unset', prompt: 'Review the input.' }
    case 'cli':
      return { command: 'cat' }
    case 'script':
      return { script: script ?? 'unset', values: {} }
    case 'branch':
      return { op: 'contains', value: 'yes' }
    case 'decide':
      return { question: 'Which one fits? {input}', options: ['yes', 'no'], threshold: DEFAULT_DECIDE_THRESHOLD }
    case 'switch':
      return { op: 'equals', cases: [{ match: 'a', label: 'a' }, { match: 'b', label: 'b' }] }
    case 'output':
      return { target: 'log', log: 'default' }
    case 'break':
    case 'make':
      return { struct: '' }
    case 'parse-json':
      return {}
    case 'variable':
      return { op: 'set', name: 'var' }
    case 'mapfilter':
      return { mode: 'map', expr: '{item}' }
    case 'foreach':
      return { body: 'echo "$1"' }
    case 'parallel':
    case 'join':
      return {}
    case 'delay':
      return { seconds: 5 }
    case 'gate':
      return { timeout_secs: GATE_DEFAULT_TIMEOUT }
    case 'subworkflow':
      return { workflow: '' }
    case 'task':
      return { action: 'create', project: 'unset' }
    case 'http':
      return { method: 'GET', url: 'http://127.0.0.1/' }
    case 'notify':
      return { mode: 'phone' }
    case 'git':
      return { op: 'commit', message: 'Update' }
    case 'file':
      return { op: 'read', path: 'notes.txt' }
    case 'memory':
      return { op: 'add' }
    case 'verify':
      return { mode: 'test', command: 'true' }
    case 'comment':
      return { color: 'accent' }
    case 'board':
      return { kind: 'markdown' }
    case 'trycatch':
      return { wrap: { kind: 'cli', config: { command: '' } } }
    case 'retry':
      return {
        wrap: { kind: 'cli', config: { command: '' } },
        attempts: 3,
        backoff_ms: 1000,
        backoff_factor: 2,
        timeout_secs: 60,
      }
  }
}

function str(config: NodeConfig, key: string): string {
  const v = config[key]
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

const OP_TEXT: Record<string, string> = {
  contains: 'contains',
  regex: 'matches',
  score_above: 'score >',
  score_below: 'score <',
  equals: '=',
}

/** The muted one-line summary under a card's title ("Haiku · prompt",
 *  "score > 0.8"). Total: a malformed config summarises as what it has. */
export function summarize(kind: WorkflowNodeKind, config: NodeConfig): string {
  switch (kind) {
    case 'trigger': {
      const mode = str(config, 'mode') || 'manual'
      if (mode === 'time') return `every ${str(config, 'every_minutes') || '?'} min`
      if (mode === 'ambient') {
        const events = optionList(config.events)
        return `ambient · ${events.length > 0 ? events.join(', ') : '?'}`
      }
      const phrase = str(config, 'phrase')
      return phrase ? `${mode} · “${clip(phrase, 24)}”` : mode
    }
    case 'schedule': {
      const cron = str(config, 'cron')
      return cron ? `cron ${clip(cron, 24)} UTC` : `every ${str(config, 'every_minutes') || '?'} min`
    }
    case 'webhook':
      return `POST → ${str(config, 'type') || 'any'}`
    case 'file-watch':
      return `${str(config, 'event') || 'any'} · ${clip(str(config, 'path'), 28) || 'no path'}`
    case 'task-event': {
      const event = str(config, 'event') || 'created'
      const where = str(config, 'project') || 'any project'
      if (event === 'created') return `created · ${where}`
      const status = str(config, 'status')
      const what = event === 'status' ? (status ? `status → ${status}` : 'status change') : status ? `any → ${status}` : 'any change'
      return `${what} · ${where}`
    }
    case 'prompt': {
      const model = str(config, 'model') || '?'
      const name = model.startsWith('local:') ? model : model[0]?.toUpperCase() + model.slice(1)
      return `${name}${config.thinking === true ? ' · thinking' : ''} · prompt`
    }
    case 'agent':
      return `${clip(str(config, 'agent'), 20) || 'unset'} · ${str(config, 'model') || 'default'}`
    case 'cli':
      return clip(str(config, 'command'), 34) || 'no command'
    case 'script':
      return `script ${clip(str(config, 'script'), 28) || 'unset'}`
    case 'branch': {
      const op = str(config, 'op') || 'contains'
      return `${OP_TEXT[op] ?? op} ${clip(str(config, 'value'), 24)}`.trim()
    }
    case 'decide': {
      const options = optionList(config.options)
      const t = str(config, 'threshold') || String(DEFAULT_DECIDE_THRESHOLD)
      return `${clip(options.join(' | '), 28) || 'no options'} · ≥ ${t}`
    }
    case 'switch': {
      const labels = caseList(config.cases).map((k) => k.label || k.match)
      const op = str(config, 'op') || 'equals'
      return labels.length > 0 ? `${op} ${clip(labels.join(' | '), 28)}` : 'no cases'
    }
    case 'output': {
      const target = str(config, 'target') || 'log'
      if (target === 'log') return `log · ${str(config, 'log') || 'default'}`
      if (target === 'task') return `task · ${str(config, 'project') || '?'}`
      if (target === 'inbox') return `inbox · task ${str(config, 'task_id') || '?'}`
      return `board${str(config, 'title') ? ` · ${clip(str(config, 'title'), 24)}` : ''}`
    }
    case 'break':
      return `splits ${str(config, 'struct') || '?'}`
    case 'make':
      return `builds ${str(config, 'struct') || '?'}`
    case 'parse-json':
      return `JSON → ${str(config, 'type') || 'any'}`
    case 'variable':
      return `${str(config, 'op') || 'set'} ${str(config, 'name') || '?'}`
    case 'mapfilter':
      return `${str(config, 'mode') || 'map'} · ${str(config, 'expr') || '?'}`
    case 'foreach':
      return `for each · ${str(config, 'body').split('\n').find((l) => l.trim() !== '')?.trim() || '?'}`
    case 'parallel':
      return 'fan out'
    case 'join':
      return 'wait for all'
    case 'delay':
      return typeof config.until === 'string' && config.until !== ''
        ? `until ${config.until}`
        : typeof config.seconds === 'number'
          ? `wait ${config.seconds}s`
          : 'unset'
    case 'gate':
      return `${str(config, 'message') || 'approval'} · ${str(config, 'timeout_secs') || GATE_DEFAULT_TIMEOUT}s`
    case 'subworkflow':
      return str(config, 'workflow') || 'pick a workflow'
    case 'task': {
      const action = str(config, 'action') || 'create'
      const target = action === 'create' ? str(config, 'project') : `#${str(config, 'task')}`
      return `${action} · ${target || '?'}`
    }
    case 'http':
      return httpSummary(config)
    case 'notify':
      return `${str(config, 'mode') === 'speak' ? 'speak' : 'phone'} · ${str(config, 'message').slice(0, 30) || 'the input'}`
    case 'file':
      return fileSummary(config)
    case 'memory':
      return memorySummary(config)
    case 'verify':
      return verifySummary(config)
    case 'comment':
      return clip(str(config, 'text'), 60)
    case 'board':
      return `${str(config, 'kind') === 'html' ? 'html' : 'markdown'} · ${clip(str(config, 'title') || str(config, 'body'), 30) || 'the input'}`
    case 'git': {
      const op = str(config, 'op') || 'commit'
      return `${op} · ${clip(str(config, 'cwd'), 24) || 'the project'}`
    }
    case 'trycatch': {
      const wrap = config.wrap as { kind?: unknown } | undefined
      return `try ${typeof wrap?.kind === 'string' ? wrap.kind : '?'} · ok / caught`
    }
    case 'retry': {
      const wrap = config.wrap as { kind?: unknown } | undefined
      const parts = [`retry ×${str(config, 'attempts') || '1'}`]
      if (config.backoff_ms) parts.push(`${config.backoff_ms}ms ×${str(config, 'backoff_factor') || '1'}`)
      if (config.timeout_secs) parts.push(`${config.timeout_secs}s timeout`)
      return `${parts.join(' · ')} · ${typeof wrap?.kind === 'string' ? wrap.kind : '?'}`
    }
  }
}

export interface SwitchCase {
  match: string
  label: string
}

/** The strings in a config's `options`, whatever else it holds. */
function optionList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : []
}

/** A switch node's cases, whatever else its config holds. */
function caseList(raw: unknown): SwitchCase[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
    .map((c) => ({
      match: typeof c.match === 'string' ? c.match : '',
      label: typeof c.label === 'string' ? c.label : '',
    }))
}

/** Whether an edge leaving a node of `kind` must carry a label: a branch's
 *  `true`/`false`, a decide node's option or `fallback`. */
export function edgeNeedsBranch(sourceKind: WorkflowNodeKind): boolean {
  return sourceKind === 'branch' || sourceKind === 'decide' || sourceKind === 'switch' || sourceKind === 'gate' || sourceKind === 'trycatch'
}

/** A gate's two flow handles, top to bottom: the edge `branch` each carries. */
const GATE_HANDLES = ['approved', 'rejected'] as const

/** A try / catch node's two flow handles: success, then a caught failure. */
const TRYCATCH_HANDLES = ['ok', 'caught'] as const

/** The labelled source handles a node offers, in the order they are drawn:
 *  `true`/`false` on a branch, one per option plus `fallback` on a decide
 *  node, `approved`/`rejected` on a gate, none (one unlabelled handle)
 *  elsewhere. */
export function sourceHandles(kind: WorkflowNodeKind, config: NodeConfig): string[] {
  if (kind === 'branch') return ['true', 'false']
  if (kind === 'decide') return [...optionList(config.options), DECIDE_FALLBACK]
  if (kind === 'switch') return [...caseList(config.cases).map((k) => k.label || k.match), SWITCH_DEFAULT]
  if (kind === 'gate') return [...GATE_HANDLES]
  if (kind === 'trycatch') return [...TRYCATCH_HANDLES]
  return []
}

/** The `branch` an edge dragged from `handle` of a node of `sourceKind`
 *  carries: the handle's own id on a branch (default `true`) or decide
 *  (default `fallback`) node, nothing anywhere else. */
export function branchForHandle(
  sourceKind: WorkflowNodeKind,
  handle: string | null | undefined,
): string | undefined {
  if (sourceKind === 'branch') return handle === 'false' ? 'false' : 'true'
  if (sourceKind === 'decide') return handle ? handle : DECIDE_FALLBACK
  if (sourceKind === 'switch') return handle ? handle : SWITCH_DEFAULT
  if (sourceKind === 'gate') return handle === 'rejected' ? 'rejected' : 'approved'
  if (sourceKind === 'trycatch') return handle === 'caught' ? 'caught' : 'ok'
  return undefined
}

/** The CSS class an edge's label colours it with: only the two branch
 *  verdicts have one — a decide option is free text and never a class name. */
export function edgeLabelClass(branch: string | null): string {
  return branch === 'true' || branch === 'false' ? `wf-edge-${branch}` : ''
}

/** A sample JSON body for a webhook node's `curl` line, by its body type
 *  (a struct type name has no known field list here, so it gets `{}`). */
export function webhookSample(type: string): string {
  if (type.startsWith('list<')) return '[]'
  switch (type) {
    case 'string':
      return '"text"'
    case 'number':
      return '1'
    case 'bool':
      return 'true'
    case 'any':
    case '':
      return '{"hello":"world"}'
    default:
      return '{}'
  }
}

/** Whether a node of `kind` takes incoming / offers outgoing connections
 *  (a trigger has no incoming edge; an output has nowhere to send). */
export function hasInput(kind: WorkflowNodeKind): boolean {
  return kind !== 'comment' && kind !== 'trigger' && kind !== 'schedule' && kind !== 'webhook' && kind !== 'task-event' && kind !== 'file-watch'
}
export function hasOutput(kind: WorkflowNodeKind): boolean {
  return kind !== 'output' && kind !== 'comment'
}

/** The editor's working copy of a node's config: every field as the text a
 *  control holds, so a half-typed number is not a type error. */
export interface ConfigDraft {
  mode: string
  every_minutes: string
  /** A schedule node's cron expression (empty = an interval schedule). */
  cron: string
  phrase: string
  events: string[]
  model: string
  thinking: boolean
  prompt: string
  timeout_secs: string
  agent: string
  result_type: string
  retry: boolean
  command: string
  script: string
  values: [string, string][]
  op: string
  value: string
  question: string
  options: string[]
  cases: SwitchCase[]
  threshold: string
  target: string
  log: string
  project: string
  task_id: string
  kind: string
  title: string
  json_type: string
  te_event: string
  te_status: string
  fw_path: string
  fw_event: string
  var_op: string
  var_name: string
  mf_mode: string
  mf_expr: string
  fe_body: string
  rt_wrap_kind: string
  rt_wrap_config: string
  rt_attempts: string
  rt_backoff_ms: string
  rt_factor: string
  dl_mode: string
  dl_seconds: string
  dl_until: string
  gate_message: string
  gt_timeout: string
  sw_workflow: string
  tk_action: string
  tk_project: string
  tk_task: string
  tk_description: string
  tk_status: string
  tk_priority: string
  tk_result: string
  ht_method: string
  ht_url: string
  ht_headers: string
  ht_body: string
  ht_timeout: string
  nt_mode: string
  nt_message: string
  nt_title: string
  nt_open: string
  bd_kind: string
  bd_title: string
  bd_body: string
  gt_op: string
  gt_cwd: string
  gt_message: string
  gt_paths: string
  gt_name: string
  gt_base: string
  gt_stat: boolean
  fl_op: string
  fl_path: string
  fl_content: string
  fl_append: boolean
  mm_op: string
  mm_text: string
  mm_query: string
  mm_limit: string
  mm_project: string
  vf_mode: string
  vf_command: string
  vf_url: string
  vf_expect: string
  cm_text: string
  cm_color: string
}

/** A comment box's colours: theme tokens (mirrors `COMMENT_COLORS`), mapped to CSS variables. */
export const COMMENT_COLORS: readonly string[] = ['accent', 'accent2', 'good', 'warn', 'bad', 'muted']
export const COMMENT_COLOR_VARS: Record<string, string> = {
  accent: '--cyan',
  accent2: '--magenta',
  good: '--green',
  warn: '--amber',
  bad: '--red',
  muted: '--muted',
}

/** The modes of a verify node (mirrors `VERIFY_MODES`). */
export const VERIFY_MODES: readonly string[] = ['test', 'browser']

/** A verify node's card line: `test · command`. */
export function verifySummary(config: NodeConfig): string {
  const mode = str(config, 'mode') === 'browser' ? 'browser' : 'test'
  return `${mode} · ${clip(str(config, 'command'), 28) || 'unset'}`
}

/** The operations of a file node (mirrors `FILE_OPS`). */
export const FILE_OPS: readonly string[] = ['read', 'write']

/** A file node's card line: `read · path`, `write · path · append`. */
export function fileSummary(config: NodeConfig): string {
  const op = str(config, 'op') === 'write' ? 'write' : 'read'
  const path = clip(str(config, 'path'), 28) || 'unset'
  return `${op} · ${path}${op === 'write' && config.append === true ? ' · append' : ''}`
}

/** The operations of a memory node (mirrors `MEMORY_OPS`). */
export const MEMORY_OPS: readonly string[] = ['add', 'search']

/** A memory node's card line: `add · text`, `search · query` (`(empty)` when
 *  it takes the incoming input). */
export function memorySummary(config: NodeConfig): string {
  const search = str(config, 'op') === 'search'
  const body = clip(str(config, search ? 'query' : 'text'), 28) || '(empty)'
  return `${search ? 'search' : 'add'} · ${body}`
}

/** The operations of a git node (mirrors `GIT_OPS`). */
export const GIT_OPS: readonly string[] = ['commit', 'branch', 'diff']

/** A branch name or diff base is one argv word to git: it may not start with
 *  `-` or hold whitespace (mirrors `git_ref_check`). */
export function gitRefError(key: string, value: string): string | null {
  const v = value.trim()
  if (v === '') return `${key} cannot be empty`
  if (v.startsWith('-')) return `${key} cannot start with -`
  if (/\s/.test(v) || [...v].some((c) => c.charCodeAt(0) < 32)) return `${key} cannot contain whitespace`
  return null
}

/** The longest notify message (mirrors `NOTIFY_MESSAGE_MAX`). */
export const NOTIFY_MESSAGE_MAX = 4096

/** The longest board title (mirrors `BOARD_TITLE_MAX`). */
export const BOARD_TITLE_MAX = 200

/** Methods an http node may use (mirrors `HTTP_METHODS`). */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
/** Methods that carry a body. */
export const HTTP_BODY_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH']
export const HTTP_DEFAULT_TIMEOUT = 30
export const HTTP_MAX_TIMEOUT = 600

/** `GET host/path` for an http node's card. */
export function httpSummary(config: NodeConfig): string {
  const method = str(config, 'method') || 'GET'
  const url = str(config, 'url').replace(/^https?:\/\//i, '')
  return `${method} ${url || 'unset'}`
}

/** The headers object as one `Name: value` line each. */
function headerLines(config: NodeConfig): string {
  const h = config.headers
  if (h === null || typeof h !== 'object' || Array.isArray(h)) return ''
  return Object.entries(h as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('\n')
}

/** Which of a task node's fields each action takes (mirrors `validate_config`). */
export const TASK_ACTION_FIELDS: Record<string, readonly string[]> = {
  create: ['project', 'description', 'status', 'priority'],
  update: ['task', 'description', 'status', 'priority', 'result'],
  read: ['task'],
}

/** A retry node's wrapped kind and its config as editable JSON text. */
function wrapOf(config: NodeConfig): { kind: string; config: string } {
  const w = config.wrap
  if (w === null || typeof w !== 'object') return { kind: 'cli', config: '{\n  "command": ""\n}' }
  const { kind, config: c } = w as { kind?: unknown; config?: unknown }
  return { kind: typeof kind === 'string' ? kind : 'cli', config: JSON.stringify(c ?? {}, null, 2) }
}

export function draftFromConfig(kind: WorkflowNodeKind, config: NodeConfig): ConfigDraft {
  const values: [string, string][] = []
  const raw = config.values
  if (kind === 'script' && raw !== null && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) values.push([k, String(v)])
  }
  return {
    mode: str(config, 'mode') || 'manual',
    every_minutes: str(config, 'every_minutes'),
    cron: str(config, 'cron'),
    phrase: str(config, 'phrase'),
    events: kind === 'trigger' ? optionList(config.events) : [],
    model: str(config, 'model') || (kind === 'agent' ? '' : 'haiku'),
    thinking: config.thinking === true,
    prompt: str(config, 'prompt'),
    timeout_secs: str(config, 'timeout_secs'),
    agent: str(config, 'agent'),
    result_type: str(config, 'result_type') || 'text',
    retry: config.retry !== false,
    command: str(config, 'command'),
    script: str(config, 'script'),
    values,
    op: str(config, 'op') || (kind === 'switch' ? 'equals' : 'contains'),
    value: str(config, 'value'),
    question: str(config, 'question'),
    options: kind === 'decide' ? optionList(config.options) : [],
    cases: kind === 'switch' ? caseList(config.cases) : [],
    threshold: str(config, 'threshold'),
    target: str(config, 'target') || 'log',
    log: str(config, 'log'),
    project: str(config, 'project'),
    task_id: str(config, 'task_id'),
    kind: str(config, 'kind') || 'task-summary',
    title: str(config, 'title'),
    json_type: str(config, 'type') || 'any',
    te_event: str(config, 'event') || 'created',
    te_status: str(config, 'status'),
    fw_path: str(config, 'path'),
    fw_event: str(config, 'event') || 'any',
    var_op: str(config, 'op') || 'set',
    var_name: str(config, 'name'),
    mf_mode: str(config, 'mode') === 'filter' ? 'filter' : 'map',
    mf_expr: str(config, 'expr'),
    fe_body: str(config, 'body'),
    rt_wrap_kind: wrapOf(config).kind,
    rt_wrap_config: wrapOf(config).config,
    rt_attempts: str(config, 'attempts') || '3',
    rt_backoff_ms: str(config, 'backoff_ms'),
    rt_factor: str(config, 'backoff_factor'),
    dl_mode: typeof config.until === 'string' && config.until !== '' ? 'until' : 'duration',
    dl_seconds: kind === 'delay' && config.seconds === undefined && config.until === undefined ? '5' : str(config, 'seconds'),
    dl_until: str(config, 'until'),
    gate_message: str(config, 'message'),
    gt_timeout: str(config, 'timeout_secs') || String(GATE_DEFAULT_TIMEOUT),
    sw_workflow: str(config, 'workflow'),
    tk_action: str(config, 'action') || 'create',
    tk_project: str(config, 'project'),
    tk_task: str(config, 'task'),
    tk_description: str(config, 'description'),
    tk_status: str(config, 'status'),
    tk_priority: str(config, 'priority'),
    tk_result: str(config, 'result'),
    ht_method: str(config, 'method') || 'GET',
    ht_url: str(config, 'url'),
    ht_headers: headerLines(config),
    ht_body: str(config, 'body'),
    ht_timeout: str(config, 'timeout_secs'),
    nt_mode: str(config, 'mode') === 'speak' ? 'speak' : 'phone',
    nt_message: str(config, 'message'),
    nt_title: str(config, 'title'),
    nt_open: str(config, 'open'),
    bd_kind: str(config, 'kind') === 'html' ? 'html' : 'markdown',
    bd_title: str(config, 'title'),
    bd_body: str(config, 'body'),
    gt_op: GIT_OPS.includes(str(config, 'op')) ? str(config, 'op') : 'commit',
    gt_cwd: str(config, 'cwd'),
    gt_message: str(config, 'message'),
    gt_paths: Array.isArray(config.paths) ? config.paths.join(' ') : '',
    gt_name: str(config, 'name'),
    gt_base: str(config, 'base'),
    gt_stat: config.stat === true,
    fl_op: FILE_OPS.includes(str(config, 'op')) ? str(config, 'op') : 'read',
    fl_path: str(config, 'path'),
    fl_content: str(config, 'content'),
    fl_append: config.append === true,
    mm_op: MEMORY_OPS.includes(str(config, 'op')) ? str(config, 'op') : 'add',
    mm_text: str(config, 'text'),
    mm_query: str(config, 'query'),
    mm_limit: config.limit === undefined ? '' : String(config.limit),
    mm_project: str(config, 'project'),
    vf_mode: VERIFY_MODES.includes(str(config, 'mode')) ? str(config, 'mode') : 'test',
    vf_command: str(config, 'command'),
    vf_url: str(config, 'url'),
    vf_expect: str(config, 'expect'),
    cm_text: str(config, 'text'),
    cm_color: COMMENT_COLORS.includes(str(config, 'color')) ? str(config, 'color') : 'accent',
  }
}

export type BuildResult = { config: NodeConfig; error: null } | { config: null; error: string }

const ok = (config: NodeConfig): BuildResult => ({ config, error: null })
const bad = (error: string): BuildResult => ({ config: null, error })

/** A whole number in `lo..=hi`, from the text of a field; `undefined` for a
 *  blank (the field is optional), `null` for text that is not one. */
function intIn(text: string, lo: number, hi: number): number | undefined | null {
  const t = text.trim()
  if (t === '') return undefined
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n >= lo && n <= hi ? n : null
}

/** The first thing wrong with a 5-field UTC cron expression, or null — a port
 *  of `core::workflow::parse_cron` (the server is authoritative). */
const CRON_FIELDS: readonly [string, number, number][] = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day-of-month', 1, 31],
  ['month', 1, 12],
  ['day-of-week', 0, 7],
]
export function cronError(expr: string): string | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return `cron needs 5 fields (minute hour day-of-month month day-of-week), got ${expr.trim() === '' ? 0 : parts.length}`
  for (let i = 0; i < 5; i++) {
    const [what, lo, hi] = CRON_FIELDS[i]
    for (const item of parts[i].split(',')) {
      const [range, step, extra] = item.split('/')
      if (extra !== undefined || (step !== undefined && !/^\d+$/.test(step)) || step === '0')
        return `cron ${what} field "${parts[i]}" has a bad step`
      const nums = range === '*' ? [] : range.split('-')
      if (nums.length > 2 || !nums.every((n) => /^\d+$/.test(n)))
        return `cron ${what} field "${parts[i]}" is not a number or range`
      const vals = nums.map(Number)
      if (vals.some((v) => v < lo || v > hi)) return `cron ${what} field "${parts[i]}" is out of range ${lo} to ${hi}`
      if (vals.length === 2 && vals[0] > vals[1]) return `cron ${what} field "${parts[i]}" runs backwards`
    }
  }
  return null
}

/** A gate's wait for a person, in seconds: the default and the cap (the server is authoritative). */
export const GATE_DEFAULT_TIMEOUT = 3600
export const GATE_MAX_TIMEOUT = 86400

/** A delay node's `until`: HH:MM or an RFC3339 UTC instant (the server is authoritative). */
const DELAY_UNTIL = /^(?:[01]?\d|2[0-3]):[0-5]\d$|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** The kinds a retry or try / catch node can wrap (mirrors `validate_config`). */
export const RETRY_WRAPPABLE: readonly string[] = ['cli', 'script', 'prompt', 'agent']

const LOCAL_MODEL = /^local:[A-Za-z0-9._:/-]+$/

/** The config a draft saves as, or the first thing wrong with it. Mirrors
 *  `validate_config`'s shapes; it cannot know a regex's dialect or whether a
 *  script exists — those the server answers. */
export function buildConfig(kind: WorkflowNodeKind, d: ConfigDraft): BuildResult {
  switch (kind) {
    case 'trigger': {
      if (!TRIGGER_MODES.includes(d.mode as WorkflowTrigger)) return bad('mode must be manual, time, voice or ambient')
      const config: NodeConfig = { mode: d.mode }
      if (d.mode === 'time') {
        const n = intIn(d.every_minutes, 1, 10080)
        if (n === undefined || n === null) return bad('every minutes must be a whole number from 1 to 10080')
        config.every_minutes = n
      }
      if (d.mode === 'ambient') {
        if (d.events.length === 0) return bad('an ambient trigger needs at least one event')
        if (!d.events.every((e) => (AMBIENT_EVENTS as readonly string[]).includes(e)))
          return bad('events must be idea, can-help or wake')
        // Vocabulary order, whatever order the boxes were ticked in.
        config.events = AMBIENT_EVENTS.filter((e) => d.events.includes(e))
      }
      if (d.phrase.trim() !== '') config.phrase = d.phrase.trim()
      return ok(config)
    }
    case 'schedule': {
      const cron = d.cron.trim()
      if (cron !== '') {
        const err = cronError(cron)
        return err ? bad(err) : ok({ cron: cron.split(/\s+/).join(' ') })
      }
      const n = intIn(d.every_minutes, 1, 10080)
      if (n === undefined || n === null) return bad('every minutes must be a whole number from 1 to 10080')
      return ok({ every_minutes: n })
    }
    case 'prompt': {
      if (!(PROMPT_MODELS as readonly string[]).includes(d.model) && !LOCAL_MODEL.test(d.model))
        return bad('model must be haiku, sonnet, opus or local:<name>')
      if (d.prompt.trim() === '') return bad('the prompt cannot be empty')
      const config: NodeConfig = { model: d.model, thinking: d.thinking, prompt: d.prompt }
      const t = intIn(d.timeout_secs, 1, 3600)
      if (t === null) return bad('timeout must be a whole number of seconds from 1 to 3600')
      if (t !== undefined) config.timeout_secs = t
      return ok(config)
    }
    case 'agent': {
      if (d.agent.trim() === '') return bad('pick an agent')
      if (d.prompt.trim() === '') return bad('the prompt cannot be empty')
      const config: NodeConfig = { agent: d.agent.trim(), prompt: d.prompt }
      if (d.model !== '') {
        if (!(PROMPT_MODELS as readonly string[]).includes(d.model)) return bad('model must be haiku, sonnet or opus')
        config.model = d.model
      }
      const t = intIn(d.timeout_secs, 1, 3600)
      if (t === null) return bad('timeout must be a whole number of seconds from 1 to 3600')
      if (t !== undefined) config.timeout_secs = t
      if (d.result_type !== '' && d.result_type !== 'text') {
        config.result_type = d.result_type
        if (!d.retry) config.retry = false
      }
      return ok(config)
    }
    case 'cli': {
      if (d.command.trim() === '') return bad('the command cannot be empty')
      const config: NodeConfig = { command: d.command }
      const t = intIn(d.timeout_secs, 1, 86400)
      if (t === null) return bad('timeout must be a whole number of seconds from 1 to 86400')
      if (t !== undefined) config.timeout_secs = t
      return ok(config)
    }
    case 'script': {
      if (d.script.trim() === '') return bad('pick a script')
      const values: Record<string, string> = {}
      for (const [k, v] of d.values) {
        const name = k.trim()
        if (name === '') continue
        values[name] = v
      }
      return ok({ script: d.script.trim(), values })
    }
    case 'branch': {
      if (!(BRANCH_OPS as readonly string[]).includes(d.op)) return bad('pick an operator')
      if (d.op.startsWith('score_')) {
        const n = Number(d.value.trim())
        if (d.value.trim() === '' || !Number.isFinite(n)) return bad(`${d.op} needs a numeric value`)
        return ok({ op: d.op, value: n })
      }
      if (d.value === '') return bad('the value cannot be empty')
      return ok({ op: d.op, value: d.value })
    }
    case 'decide': {
      if (d.question.trim() === '') return bad('the question cannot be empty')
      const options = d.options.map((o) => o.trim()).filter((o) => o !== '')
      if (options.length < 2) return bad('a decide node needs at least two options')
      if (new Set(options).size !== options.length) return bad('options must be distinct')
      if (options.includes(DECIDE_FALLBACK)) return bad(`an option cannot be "${DECIDE_FALLBACK}"; that is the catch-all edge`)
      const t = d.threshold.trim()
      const threshold = t === '' ? DEFAULT_DECIDE_THRESHOLD : Number(t)
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return bad('threshold must be a number from 0 to 1')
      return ok({ question: d.question, options, threshold })
    }
    case 'switch': {
      if (!(SWITCH_OPS as readonly string[]).includes(d.op)) return bad('pick an operator')
      const cases: SwitchCase[] = []
      for (const k of d.cases) {
        const match = k.match.trim()
        if (match === '') return bad('every case needs a match')
        if (d.op === 'regex') {
          try {
            new RegExp(match)
          } catch {
            return bad(`"${match}" is not a valid regular expression`)
          }
        }
        cases.push({ match, label: k.label.trim() || match })
      }
      if (cases.length < 2) return bad('a switch node needs at least two cases')
      const labels = cases.map((k) => k.label)
      if (new Set(labels).size !== labels.length) return bad('case labels must be distinct')
      if (labels.includes(SWITCH_DEFAULT)) return bad(`a case cannot be labelled "${SWITCH_DEFAULT}"; that is the catch-all edge`)
      return ok({ op: d.op, cases })
    }
    case 'output': {
      switch (d.target) {
        case 'log':
          return ok({ target: 'log', log: d.log.trim() || 'default' })
        case 'task':
          if (d.project.trim() === '') return bad('a task target needs a project (id or name)')
          return ok({ target: 'task', project: d.project.trim() })
        case 'inbox': {
          const n = intIn(d.task_id, 1, Number.MAX_SAFE_INTEGER)
          if (n === undefined || n === null) return bad('an inbox target needs the task id the item names')
          if (!(INBOX_KINDS as readonly string[]).includes(d.kind)) return bad('kind must be task-summary or change-request')
          return ok({ target: 'inbox', task_id: n, kind: d.kind })
        }
        case 'board':
          return ok(d.title.trim() === '' ? { target: 'board' } : { target: 'board', title: d.title.trim() })
        default:
          return bad('target must be log, task, inbox or board')
      }
    }
    case 'file-watch': {
      if (d.fw_path.trim() === '') return bad('path required')
      const event = ['any', 'created', 'modified', 'deleted'].includes(d.fw_event) ? d.fw_event : 'any'
      return ok({ path: d.fw_path.trim(), event })
    }
    case 'task-event': {
      const event = ['created', 'status', 'any'].includes(d.te_event) ? d.te_event : 'created'
      const config: NodeConfig = { event }
      if (d.te_status.trim() !== '') {
        if (event === 'created') return bad('status needs event status or any')
        config.status = d.te_status.trim()
      }
      if (d.project.trim() !== '') config.project = d.project.trim()
      return ok(config)
    }
    case 'webhook':
    case 'parse-json':
      return ok(d.json_type && d.json_type !== 'any' ? { type: d.json_type } : {})
    case 'variable': {
      const name = d.var_name.trim()
      if (name === '') return bad('name required')
      const config: NodeConfig = { op: d.var_op === 'get' ? 'get' : 'set', name }
      if (d.json_type && d.json_type !== 'any') config.type = d.json_type
      return ok(config)
    }
    case 'mapfilter': {
      const expr = d.mf_expr.trim()
      if (expr === '') return bad('expression required')
      const mode = d.mf_mode === 'filter' ? 'filter' : 'map'
      if (mode === 'filter') {
        const m = /^(contains|not-contains|eq|regex):(.+)$/s.exec(expr)
        if (expr !== 'nonempty' && !m) return bad('unknown predicate: use contains:X, not-contains:X, eq:X, regex:RE or nonempty')
        if (m && m[1] === 'regex') {
          try {
            new RegExp(m[2])
          } catch {
            return bad('invalid regex')
          }
        }
      }
      return ok({ mode, expr })
    }
    case 'foreach': {
      if (d.fe_body.trim() === '') return bad('body required')
      const config: NodeConfig = { body: d.fe_body }
      const t = intIn(d.timeout_secs, 1, 3600)
      if (t === null) return bad('timeout must be a whole number of seconds from 1 to 3600')
      if (t !== undefined) config.timeout_secs = t
      return ok(config)
    }
    case 'parallel':
    case 'join':
      return ok({})
    case 'delay': {
      if (d.dl_mode === 'until') {
        if (!DELAY_UNTIL.test(d.dl_until.trim())) return bad('until must be HH:MM or 2026-10-17T14:30:00Z (UTC)')
        return ok({ until: d.dl_until.trim() })
      }
      const n = intIn(d.dl_seconds, 0, 3600)
      if (n === undefined || n === null) return bad('seconds must be a whole number from 0 to 3600')
      return ok({ seconds: n })
    }
    case 'gate': {
      const n = intIn(d.gt_timeout, 1, GATE_MAX_TIMEOUT)
      if (n === undefined || n === null) return bad(`timeout must be a whole number of seconds from 1 to ${GATE_MAX_TIMEOUT}`)
      const config: NodeConfig = { timeout_secs: n }
      if (d.gate_message.trim() !== '') config.message = d.gate_message.trim()
      return ok(config)
    }
    case 'subworkflow':
      return d.sw_workflow.trim() === '' ? bad('pick a workflow to run') : ok({ workflow: d.sw_workflow.trim() })
    case 'task': {
      const fields = TASK_ACTION_FIELDS[d.tk_action]
      if (!fields) return bad('action must be create, update or read')
      const values: Record<string, string> = {
        project: d.tk_project.trim(),
        task: d.tk_task.trim(),
        description: d.tk_description.trim(),
        status: d.tk_status.trim(),
        priority: d.tk_priority.trim(),
        result: d.tk_result.trim(),
      }
      const config: NodeConfig = { action: d.tk_action }
      for (const f of fields) if (values[f] !== '') config[f] = values[f]
      const literal = (v: string) => !v.includes('{input}')
      if (d.tk_action === 'create' && values.project === '') return bad('a create action needs a project (id or name)')
      if (d.tk_action !== 'create' && values.task === '') return bad('this action needs a task id')
      if (d.tk_action !== 'create' && literal(values.task) && !/^\d+$/.test(values.task)) return bad('task must be a whole number id')
      if (d.tk_action === 'update' && !['description', 'status', 'priority', 'result'].some((f) => values[f] !== '')) {
        return bad('an update needs at least one of description, status, priority, result')
      }
      return ok(config)
    }
    case 'http': {
      if (!(HTTP_METHODS as readonly string[]).includes(d.ht_method)) return bad('method must be GET, POST, PUT, PATCH or DELETE')
      const url = d.ht_url.trim()
      if (url === '') return bad('an HTTP node needs a URL')
      if (/^https:\/\//i.test(url)) return bad('https is not supported in this build; use an http:// URL')
      if (!/^http:\/\//i.test(url) && !url.toLowerCase().startsWith('{input}')) return bad('the URL must start with http://')
      const headers: Record<string, string> = {}
      for (const line of d.ht_headers.split('\n')) {
        if (line.trim() === '') continue
        const i = line.indexOf(':')
        if (i <= 0 || line.slice(0, i).trim() === '') return bad(`header "${line.trim()}" needs a "Name: value" form`)
        headers[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      const t = intIn(d.ht_timeout, 1, HTTP_MAX_TIMEOUT)
      if (t === null) return bad(`timeout must be a whole number of seconds from 1 to ${HTTP_MAX_TIMEOUT}`)
      const config: NodeConfig = { method: d.ht_method, url }
      if (Object.keys(headers).length > 0) config.headers = headers
      if (HTTP_BODY_METHODS.includes(d.ht_method) && d.ht_body !== '') config.body = d.ht_body
      if (t !== undefined) config.timeout_secs = t
      return ok(config)
    }
    case 'board': {
      if (d.bd_kind !== 'markdown' && d.bd_kind !== 'html') return bad('format must be markdown or html')
      const title = d.bd_title.trim()
      if (title.length > BOARD_TITLE_MAX) return bad(`title must be at most ${BOARD_TITLE_MAX} characters`)
      const config: NodeConfig = { kind: d.bd_kind }
      if (title !== '') config.title = title
      if (d.bd_body.trim() !== '') config.body = d.bd_body
      return ok(config)
    }
    case 'notify': {
      if (d.nt_mode !== 'phone' && d.nt_mode !== 'speak') return bad('mode must be phone or speak')
      const message = d.nt_message.trim()
      if (message.length > NOTIFY_MESSAGE_MAX) return bad(`message must be at most ${NOTIFY_MESSAGE_MAX} characters`)
      const config: NodeConfig = { mode: d.nt_mode }
      if (message !== '') config.message = message
      if (d.nt_mode === 'phone') {
        if (d.nt_title.trim() !== '') config.title = d.nt_title.trim()
        const open = d.nt_open.trim()
        if (open !== '') {
          if (!/^[\w\-./]+$/.test(open) || open.split('/').includes('..')) return bad('open must be a route like live or workflows/3')
          config.open = open
        }
      }
      return ok(config)
    }
    case 'git': {
      if (!GIT_OPS.includes(d.gt_op)) return bad('operation must be commit, branch or diff')
      const config: NodeConfig = { op: d.gt_op }
      if (d.gt_cwd.trim() !== '') config.cwd = d.gt_cwd.trim()
      if (d.gt_op === 'commit') {
        if (d.gt_message.trim() === '') return bad('the commit message cannot be empty')
        config.message = d.gt_message
        const paths = d.gt_paths.split(/\s+/).filter((p) => p !== '')
        if (paths.length > 0) config.paths = paths
      } else if (d.gt_op === 'branch') {
        const err = gitRefError('name', d.gt_name.replaceAll('{input}', 'x'))
        if (err !== null) return bad(err)
        config.name = d.gt_name.trim()
      } else {
        if (d.gt_base.trim() !== '') {
          const err = gitRefError('base', d.gt_base.replaceAll('{input}', 'x'))
          if (err !== null) return bad(err)
          config.base = d.gt_base.trim()
        }
        if (d.gt_stat) config.stat = true
      }
      const t = intIn(d.timeout_secs, 1, 3600)
      if (t === null) return bad('timeout must be a whole number of seconds from 1 to 3600')
      if (t !== undefined) config.timeout_secs = t
      return ok(config)
    }
    case 'file': {
      if (!FILE_OPS.includes(d.fl_op)) return bad('operation must be read or write')
      if (d.fl_path.trim() === '') return bad('the path cannot be empty')
      const config: NodeConfig = { op: d.fl_op, path: d.fl_path.trim() }
      if (d.fl_op === 'write') {
        if (d.fl_content !== '') config.content = d.fl_content
        if (d.fl_append) config.append = true
      }
      return ok(config)
    }
    case 'memory': {
      if (!MEMORY_OPS.includes(d.mm_op)) return bad('operation must be add or search')
      const config: NodeConfig = { op: d.mm_op }
      if (d.mm_op === 'add') {
        if (d.mm_text.trim() !== '') config.text = d.mm_text
      } else {
        if (d.mm_query.trim() !== '') config.query = d.mm_query
        const n = intIn(d.mm_limit, 1, 50)
        if (n === null) return bad('limit must be a whole number from 1 to 50')
        if (n !== undefined) config.limit = n
      }
      if (d.mm_project.trim() !== '') config.project = d.mm_project.trim()
      return ok(config)
    }
    case 'verify': {
      if (!VERIFY_MODES.includes(d.vf_mode)) return bad('mode must be test or browser')
      if (d.vf_command.trim() === '') return bad('the command cannot be empty')
      const config: NodeConfig = { mode: d.vf_mode, command: d.vf_command }
      if (d.vf_mode === 'browser' && d.vf_url.trim() !== '') config.url = d.vf_url.trim()
      if (d.vf_expect !== '') config.expect = d.vf_expect
      const t = intIn(d.timeout_secs, 1, 3600)
      if (t === null) return bad('timeout must be a whole number of seconds from 1 to 3600')
      if (t !== undefined) config.timeout_secs = t
      return ok(config)
    }
    case 'comment': {
      if (!COMMENT_COLORS.includes(d.cm_color)) return bad('colour must be one of the theme colours')
      const config: NodeConfig = { color: d.cm_color }
      if (d.cm_text !== '') config.text = d.cm_text
      return ok(config)
    }
    case 'trycatch': {
      if (!RETRY_WRAPPABLE.includes(d.rt_wrap_kind)) return bad(`a try / catch node cannot wrap ${d.rt_wrap_kind || 'that'}`)
      let wrapped: unknown
      try {
        wrapped = JSON.parse(d.rt_wrap_config)
      } catch {
        return bad('wrapped config is not valid JSON')
      }
      if (wrapped === null || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
        return bad('wrapped config must be a JSON object')
      }
      const t = intIn(d.timeout_secs, 1, 3600)
      if (t === null) return bad('timeout must be a whole number of seconds from 1 to 3600')
      const config: NodeConfig = { wrap: { kind: d.rt_wrap_kind, config: wrapped } }
      if (t !== undefined) config.timeout_secs = t
      return ok(config)
    }
    case 'retry': {
      if (!RETRY_WRAPPABLE.includes(d.rt_wrap_kind)) return bad(`a retry node cannot wrap ${d.rt_wrap_kind || 'that'}`)
      let wrapped: unknown
      try {
        wrapped = JSON.parse(d.rt_wrap_config)
      } catch {
        return bad('wrapped config is not valid JSON')
      }
      if (wrapped === null || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
        return bad('wrapped config must be a JSON object')
      }
      const attempts = intIn(d.rt_attempts, 1, 10)
      if (attempts === null) return bad('attempts must be a whole number from 1 to 10')
      const backoff = intIn(d.rt_backoff_ms, 0, 60000)
      if (backoff === null) return bad('backoff must be a whole number of milliseconds from 0 to 60000')
      const factor = intIn(d.rt_factor, 1, 10)
      if (factor === null) return bad('factor must be a whole number from 1 to 10')
      const t = intIn(d.timeout_secs, 1, 3600)
      if (t === null) return bad('timeout must be a whole number of seconds from 1 to 3600')
      const config: NodeConfig = { wrap: { kind: d.rt_wrap_kind, config: wrapped } }
      if (attempts !== undefined) config.attempts = attempts
      if (backoff !== undefined) config.backoff_ms = backoff
      if (factor !== undefined) config.backoff_factor = factor
      if (t !== undefined) config.timeout_secs = t
      return ok(config)
    }
    case 'break':
    case 'make':
      return bad('a break or make node takes its pins from its struct; there is no config to edit')
  }
}

/** A script's declared argument names not yet given a value row, so picking a
 *  script can offer rows for exactly what it takes. */
export function missingValueRows(
  argNames: readonly string[],
  values: readonly [string, string][],
): [string, string][] {
  const have = new Set(values.map(([k]) => k))
  return argNames.filter((n) => !have.has(n)).map((n) => [n, ''])
}

/** The drag payload a palette item travels as — its own type, so a file or
 *  text dragged over the canvas is never mistaken for a new node (`dragover`
 *  can only read the types, never the value). */
export const NODE_DRAG_MIME = 'application/x-naru-workflow-node'

/** The kind a drop carries, or null for anything that is not one of ours. */
export function decodeKindDrag(raw: string): WorkflowNodeKind | null {
  return isNodeKind(raw) ? raw : null
}

/** The key the inspector is remounted on: the node's identity plus what the
 *  server holds for its title and config, never its position or timestamp, so a
 *  drag or an auto-layout of the selected node keeps the draft being typed. */
export function inspectorKey(node: {
  id: number
  title: string
  config: NodeConfig
}): string {
  return `${node.id}:${JSON.stringify([node.title, node.config])}`
}
