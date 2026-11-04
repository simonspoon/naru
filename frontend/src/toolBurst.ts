// Tool-call bursts for the Agent watcher orbit (naru task 2568,
// docs/agent-watcher.md). Each poll of `/api/agents/orbit` carries every
// node's tool calls of the last `orbit::TOOL_SECS`; this module picks the ones
// not seen before, sorts each into a kind (icon and colour), coalesces a burst
// into at most BURST_MAX chips per node and sends them out from the node. Pure:
// the page only draws and times them.

import type { OrbitAgent } from './types/OrbitAgent'
import type { OrbitTool } from './types/OrbitTool'
import type { Pt } from './agentOrbit'

export type ToolKind = 'shell' | 'read' | 'write' | 'search' | 'web' | 'naru' | 'agent' | 'other'

export const KIND_ICON: Record<ToolKind, string> = {
  shell: '$',
  read: '▤',
  write: '✎',
  search: '⌕',
  web: '◎',
  naru: '◆',
  agent: '✦',
  other: '•',
}

const KINDS: [ToolKind, string[]][] = [
  ['shell', ['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Monitor']],
  ['read', ['Read', 'NotebookRead', 'LS']],
  ['write', ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']],
  ['search', ['Grep', 'Glob', 'ToolSearch']],
  ['web', ['WebFetch', 'WebSearch']],
  ['agent', ['Agent', 'Task', 'SendMessage', 'TaskStop']],
]

/** A naru (or mesa) command line, possibly behind env assignments or a `cd … &&`. */
const NARU_CMD = /(?:^|&&\s*|;\s*|\s)(?:naru|mesa)\s+(\S+)/

/** The kind of a call: by tool name, and a shell call running `naru …` is `naru`. */
export function toolKind(name: string, summary = ''): ToolKind {
  if ((name === 'Bash' || name === 'Monitor') && NARU_CMD.test(summary)) return 'naru'
  for (const [kind, names] of KINDS) if (names.includes(name)) return kind
  if (name.startsWith('mcp__')) return 'web'
  return 'other'
}

/** A tool name as a chip says it: an MCP tool by its last segment. */
export function toolLabel(name: string): string {
  return name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name
}

const DETAIL_MAX = 14

/** One word of detail: a file's base name, a command's name (a naru subcommand), else the first word. */
export function toolDetail(name: string, summary: string): string {
  const s = summary.trim()
  if (!s) return ''
  let word: string
  const naru = toolKind(name, s) === 'naru' ? NARU_CMD.exec(s) : null
  if (naru) word = `naru ${naru[1]}`
  else if (name === 'Bash' || name === 'Monitor') word = s.split(/\s+/).find((w) => !/^\w+=/.test(w)) ?? s
  else if (s.startsWith('/') || s.startsWith('~') || s.startsWith('./')) word = s.split('/').filter(Boolean).pop() ?? s
  else if (/^https?:\/\//.test(s)) word = s.replace(/^https?:\/\//, '').split('/')[0]
  else word = s.split(/\s+/)[0]
  return word.length <= DETAIL_MAX ? word : `${word.slice(0, DETAIL_MAX - 1)}…`
}

/** One node's tool calls in one feed, as the page needs them. */
export type NodeTools = { node: string; tools: OrbitTool[]; agents?: OrbitAgent[] }

/**
 * A stable id per call: node, start, name and input, plus the occurrence
 * count, so two identical calls in the same second stay two.
 */
export function callIds(node: string, tools: OrbitTool[]): string[] {
  const n = new Map<string, number>()
  return tools.map((t) => {
    const base = `${node}|${t.at}|${t.name}|${t.summary}`
    const k = (n.get(base) ?? 0) + 1
    n.set(base, k)
    return `${base}|${k}`
  })
}

/** At most this many chips leave one node per poll; more coalesce into `+n`. */
export const BURST_MAX = 3

export type Chip = {
  kind: ToolKind
  label: string
  count: number
  /** One word, shown only for a single call. */
  detail: string
  error: boolean
}

/**
 * Coalesce one node's new calls (oldest first) into chips: one per tool
 * name, `Read ×5`, in order of first use. Past BURST_MAX, the newest
 * BURST_MAX − 1 groups stay and the rest fold into one `+n` chip (n = calls)
 * up front; an error anywhere in a chip tints it.
 */
export function coalesce(calls: { name: string; summary: string; error: boolean }[]): Chip[] {
  const groups: Chip[] = []
  const at = new Map<string, Chip>()
  for (const c of calls) {
    const g = at.get(c.name)
    if (g) {
      g.count++
      g.detail = ''
      g.error ||= c.error
      continue
    }
    const chip: Chip = { kind: toolKind(c.name, c.summary), label: toolLabel(c.name), count: 1, detail: toolDetail(c.name, c.summary), error: c.error }
    at.set(c.name, chip)
    groups.push(chip)
  }
  if (groups.length <= BURST_MAX) return groups
  const keep = groups.slice(-(BURST_MAX - 1))
  const rest = groups.slice(0, groups.length - keep.length)
  const more: Chip = {
    kind: 'other',
    label: `+${rest.reduce((n, g) => n + g.count, 0)}`,
    count: 1,
    detail: '',
    error: rest.some((g) => g.error),
  }
  return [more, ...keep]
}

/** A chip's text: icon, label, `×n` for a coalesced one, else its detail. */
export function chipText(c: Chip): string {
  const head = c.kind === 'other' && c.label.startsWith('+') ? c.label : `${KIND_ICON[c.kind]} ${c.label}`
  return c.count > 1 ? `${head} ×${c.count}` : c.detail ? `${head} ${c.detail}` : head
}

export type Burst = { node: string; chips: Chip[] }

/**
 * What changed since the last poll: every call not in `seen`, coalesced per
 * node, plus an `Agent` call for each sub-agent key new under its node (a
 * launch has no tool row of its own — its dot is the row). `seen` is the
 * previous poll's answer, `null` on the first feed, which only records, so a
 * page open does not replay the last half minute. A call seen open that
 * later fails comes out once more, as an error. The new `seen` holds only
 * what this feed carries: a call older than the feed's window never returns.
 */
export function newBursts(nodes: NodeTools[], seen: Set<string> | null): { bursts: Burst[]; seen: Set<string> } {
  const next = new Set<string>()
  const bursts: Burst[] = []
  for (const n of nodes) {
    const fresh: { name: string; summary: string; error: boolean }[] = []
    callIds(n.node, n.tools).forEach((id, i) => {
      const t = n.tools[i]
      // An error is recorded apart, so a call first seen open bursts again,
      // red, when its result comes back failed.
      const err = `${id}|error`
      next.add(id)
      if (t.error) next.add(err)
      if (seen && (!seen.has(id) || (t.error && !seen.has(err)))) fresh.push({ name: t.name, summary: t.summary, error: t.error })
    })
    for (const a of n.agents ?? []) {
      const id = `${n.node}|agent|${a.key}`
      next.add(id)
      if (seen && !seen.has(id)) fresh.push({ name: 'Agent', summary: a.role, error: false })
    }
    if (fresh.length > 0) bursts.push({ node: n.node, chips: coalesce(fresh) })
  }
  return { bursts, seen: next }
}

/**
 * Which way a node's chips leave: horizontally away from `from` (Naru, or
 * the job a dot hangs off), right when level. Every label in the orbit sits
 * above or below its node, so a sideways flight never lands on one.
 */
export function chipSide(from: Pt, at: Pt): 1 | -1 {
  return at.x < from.x - 1e-6 ? -1 : 1
}

/** Vertical pitch between stacked chips, in chip font sizes. */
const CHIP_PITCH = 1.7

/**
 * Where chip `i` of `n` ends its flight, relative to the node's edge: `dist`
 * out to `side`, the chips stacked in a column centred on the node.
 */
export function chipOffset(side: 1 | -1, i: number, n: number, dist: number, px: number): Pt {
  return { x: side * dist, y: (i - (n - 1) / 2) * px * CHIP_PITCH }
}
