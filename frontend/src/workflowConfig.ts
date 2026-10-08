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
  { kind: 'prompt', label: 'Prompt', title: 'Prompt' },
  { kind: 'cli', label: 'CLI tool', title: 'Command' },
  { kind: 'script', label: 'Script', title: 'Script' },
  { kind: 'branch', label: 'Branch', title: 'Gate' },
  { kind: 'decide', label: 'Decide', title: 'Decide' },
  { kind: 'output', label: 'Output', title: 'Output' },
]

export function kindInfo(kind: WorkflowNodeKind): KindInfo {
  return NODE_KINDS.find((k) => k.kind === kind)!
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
export function defaultConfig(kind: WorkflowNodeKind, script?: string): NodeConfig {
  switch (kind) {
    case 'trigger':
      return { mode: 'manual' }
    case 'prompt':
      return { model: 'haiku', thinking: false, prompt: 'Summarise the input in one line.' }
    case 'cli':
      return { command: 'cat' }
    case 'script':
      return { script: script ?? 'unset', values: {} }
    case 'branch':
      return { op: 'contains', value: 'yes' }
    case 'decide':
      return { question: 'Which one fits? {input}', options: ['yes', 'no'], threshold: DEFAULT_DECIDE_THRESHOLD }
    case 'output':
      return { target: 'log', log: 'default' }
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
    case 'prompt': {
      const model = str(config, 'model') || '?'
      const name = model.startsWith('local:') ? model : model[0]?.toUpperCase() + model.slice(1)
      return `${name}${config.thinking === true ? ' · thinking' : ''} · prompt`
    }
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
    case 'output': {
      const target = str(config, 'target') || 'log'
      if (target === 'log') return `log · ${str(config, 'log') || 'default'}`
      if (target === 'task') return `task · ${str(config, 'project') || '?'}`
      if (target === 'inbox') return `inbox · task ${str(config, 'task_id') || '?'}`
      return `board${str(config, 'title') ? ` · ${clip(str(config, 'title'), 24)}` : ''}`
    }
  }
}

/** The strings in a config's `options`, whatever else it holds. */
function optionList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : []
}

/** Whether an edge leaving a node of `kind` must carry a label: a branch's
 *  `true`/`false`, a decide node's option or `fallback`. */
export function edgeNeedsBranch(sourceKind: WorkflowNodeKind): boolean {
  return sourceKind === 'branch' || sourceKind === 'decide'
}

/** The labelled source handles a node offers, in the order they are drawn:
 *  `true`/`false` on a branch, one per option plus `fallback` on a decide
 *  node, none (one unlabelled handle) elsewhere. */
export function sourceHandles(kind: WorkflowNodeKind, config: NodeConfig): string[] {
  if (kind === 'branch') return ['true', 'false']
  if (kind === 'decide') return [...optionList(config.options), DECIDE_FALLBACK]
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
  return undefined
}

/** The CSS class an edge's label colours it with: only the two branch
 *  verdicts have one — a decide option is free text and never a class name. */
export function edgeLabelClass(branch: string | null): string {
  return branch === 'true' || branch === 'false' ? `wf-edge-${branch}` : ''
}

/** Whether a node of `kind` takes incoming / offers outgoing connections
 *  (a trigger has no incoming edge; an output has nowhere to send). */
export function hasInput(kind: WorkflowNodeKind): boolean {
  return kind !== 'trigger'
}
export function hasOutput(kind: WorkflowNodeKind): boolean {
  return kind !== 'output'
}

/** The editor's working copy of a node's config: every field as the text a
 *  control holds, so a half-typed number is not a type error. */
export interface ConfigDraft {
  mode: string
  every_minutes: string
  phrase: string
  events: string[]
  model: string
  thinking: boolean
  prompt: string
  timeout_secs: string
  command: string
  script: string
  values: [string, string][]
  op: string
  value: string
  question: string
  options: string[]
  threshold: string
  target: string
  log: string
  project: string
  task_id: string
  kind: string
  title: string
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
    phrase: str(config, 'phrase'),
    events: kind === 'trigger' ? optionList(config.events) : [],
    model: str(config, 'model') || 'haiku',
    thinking: config.thinking === true,
    prompt: str(config, 'prompt'),
    timeout_secs: str(config, 'timeout_secs'),
    command: str(config, 'command'),
    script: str(config, 'script'),
    values,
    op: str(config, 'op') || 'contains',
    value: str(config, 'value'),
    question: str(config, 'question'),
    options: kind === 'decide' ? optionList(config.options) : [],
    threshold: str(config, 'threshold'),
    target: str(config, 'target') || 'log',
    log: str(config, 'log'),
    project: str(config, 'project'),
    task_id: str(config, 'task_id'),
    kind: str(config, 'kind') || 'task-summary',
    title: str(config, 'title'),
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
