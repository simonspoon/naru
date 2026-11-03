// Orbit layout for the Agent watcher (naru task 2541, docs/agent-watcher.md).
// Pure geometry and grouping over the `/api/agents/orbit` feed: where each
// running job sits on the ring, where its sub-agent dots cluster, how the
// queue groups by project, and the sparkline points. The page only draws.

import type { OrbitAgent } from './types/OrbitAgent'
import type { OrbitJob } from './types/OrbitJob'
import type { OrbitNaru } from './types/OrbitNaru'
import type { OrbitProject } from './types/OrbitProject'
import type { OrbitQueued } from './types/OrbitQueued'

/** The orbit's SVG viewBox is VIEW × VIEW with Naru at (C, C). */
export const VIEW = 1000
export const C = VIEW / 2
export const NARU_R = 80
export const RING = 280
export const NODE_R = 46
export const DOT_RING = 440
export const DOT_R = 14
/** Font sizes in viewBox units: a job's title, its project · stage line, a dot's label. */
export const TITLE_PX = 26
export const SUB_PX = 21
export const DOT_PX = 20
/** Angle between neighbouring sub-agent dots, and the clear gap kept between two jobs' clusters. */
const DOT_STEP = (14 * Math.PI) / 180
const CLUSTER_GAP = (30 * Math.PI) / 180
const MAX_DOTS = 6

export type Pt = { x: number; y: number }
export type Box = { x0: number; y0: number; x1: number; y1: number }

/** A point `r` from the centre at angle `a` (radians, 0 = top, clockwise). */
export function polar(r: number, a: number): Pt {
  return { x: C + r * Math.sin(a), y: C - r * Math.cos(a) }
}

/**
 * Job `i` of `n`, evenly spaced clockwise from the top. From seven jobs on the
 * ring turns half a step, so no job sits level with Naru, where its label
 * would meet the labels of both neighbours.
 */
export function jobAngle(i: number, n: number): number {
  return (2 * Math.PI * (i + (n >= 7 ? 0.5 : 0))) / Math.max(n, 1)
}

/** How many sub-agent dots one job can show with `n` jobs on the ring. */
export function maxDots(n: number): number {
  const room = (2 * Math.PI) / Math.max(n, 1) - CLUSTER_GAP
  return Math.max(1, Math.min(MAX_DOTS, Math.floor(room / DOT_STEP) + 1))
}

/** Cut `s` to `max` characters with an ellipsis (SVG text cannot ellipsise). */
export function clip(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

/** Title length budget: fewer characters as the ring gets crowded. */
export function titleChars(n: number): number {
  return n <= 5 ? 16 : n <= 6 ? 14 : 11
}

const STAGE_WORDS: Record<string, string> = {
  recon: 'looking',
  plan: 'planning',
  build: 'building',
  review: 'reviewing',
  verify: 'testing',
  working: 'working',
}

/** A job's second line: what it is doing, in one or two words. */
export function stageText(job: OrbitJob): string {
  if (job.state === 'waiting') return 'needs you'
  if (job.state === 'stalled') return 'stalled'
  if (job.state === 'idle') return 'idle'
  return STAGE_WORDS[job.stage] ?? job.stage.toLowerCase()
}

/** A dot's label: its role (a workflow step: its node title), ticked when done. */
export function dotText(job: OrbitJob, agent: OrbitAgent): string {
  const word = job.kind === 'workflow' ? clip(agent.label, 8) : agent.role
  return agent.state === 'done' ? `${word} ✓` : word
}

/** The `k` agents a job shows: everything unfinished first, then the newest done, in feed order. */
export function visibleAgents(agents: OrbitAgent[], k: number): OrbitAgent[] {
  if (agents.length <= k) return agents
  const rank = (a: OrbitAgent) => (a.state === 'done' ? 1 : 0)
  const picked = agents
    .map((a, i) => ({ a, i }))
    .sort((p, q) => rank(p.a) - rank(q.a) || (q.a.lastEventAt ?? 0) - (p.a.lastEventAt ?? 0) || q.i - p.i)
    .slice(0, k)
  return picked.sort((p, q) => p.i - q.i).map((p) => p.a)
}

/** Rough text box: SVG text has no layout before render, so width is estimated per glyph. */
export function textBox(x: number, baseline: number, text: string, px: number, anchor: 'middle' | 'start' = 'middle'): Box {
  const w = text.length * px * 0.58
  const x0 = anchor === 'middle' ? x - w / 2 : x
  return { x0, y0: baseline - px * 0.8, x1: x0 + w, y1: baseline + px * 0.25 }
}

export function circleBox(p: Pt, r: number): Box {
  return { x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r }
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

export type DotLayout = { agent: OrbitAgent; at: Pt; text: string; textY: number }
export type JobLayout = {
  job: OrbitJob
  at: Pt
  title: string
  sub: string
  /** Baselines of the title and the project · stage line. */
  titleY: number
  subY: number
  dots: DotLayout[]
}

/**
 * Place every job. The label sits on the inner side of the node (below it in
 * the top half, above it in the bottom half) so it never meets the job's own
 * dots, which cluster on the outer side.
 */
export function layoutJobs(jobs: OrbitJob[]): JobLayout[] {
  const n = jobs.length
  const k = maxDots(n)
  const chars = titleChars(n)
  return jobs.map((job, i) => {
    const a = jobAngle(i, n)
    const at = polar(RING, a)
    const below = at.y <= C + 1
    const titleY = below ? at.y + NODE_R + 30 : at.y - NODE_R - 36
    const subY = titleY + 26
    const shown = visibleAgents(job.agents, k)
    const dots = shown.map((agent, j) => {
      const da = a + (j - (shown.length - 1) / 2) * DOT_STEP
      const p = polar(DOT_RING, da)
      return { agent, at: p, text: dotText(job, agent), textY: p.y + DOT_R + 24 }
    })
    const sub = [job.projectName, stageText(job)].filter(Boolean).join(' · ')
    return { job, at, title: clip(job.title, chars), sub: clip(sub, chars + (n <= 5 ? 6 : 4)), titleY, subY, dots }
  })
}

/** Every box a layout paints, tagged with the job it belongs to — for the overlap test. */
export function layoutBoxes(layout: JobLayout[]): { owner: number; part: string; box: Box }[] {
  const out: { owner: number; part: string; box: Box }[] = [{ owner: -1, part: 'naru', box: circleBox({ x: C, y: C }, NARU_R + 12) }]
  layout.forEach((l, i) => {
    out.push({ owner: i, part: 'node', box: circleBox(l.at, NODE_R + 4) })
    out.push({ owner: i, part: 'title', box: textBox(l.at.x, l.titleY, l.title, TITLE_PX) })
    out.push({ owner: i, part: 'sub', box: textBox(l.at.x, l.subY, l.sub, SUB_PX) })
    l.dots.forEach((d, j) => {
      out.push({ owner: i, part: `dot${j}`, box: circleBox(d.at, DOT_R + 4) })
      out.push({ owner: i, part: `dot${j}-text`, box: textBox(d.at.x, d.textY, d.text, DOT_PX) })
    })
  })
  return out
}

export type QueueGroup = { key: string; name: string; color: string; workflow: boolean; items: OrbitQueued[] }

/**
 * Queued tasks under one heading per project (project-list order), then every
 * workflow under one grey "Workflows" heading. No numbering: projects run
 * side by side, so a position would mean nothing.
 */
export function groupQueue(queue: OrbitQueued[], projects: OrbitProject[]): QueueGroup[] {
  const groups: QueueGroup[] = []
  const byProject = new Map<number, QueueGroup>()
  for (const p of projects) {
    const g = { key: `p${p.id}`, name: p.name, color: p.color, workflow: false, items: [] as OrbitQueued[] }
    byProject.set(p.id, g)
    groups.push(g)
  }
  const flows: QueueGroup = { key: 'workflows', name: 'Workflows', color: '', workflow: true, items: [] }
  for (const q of queue) {
    if (q.kind === 'workflow') {
      flows.items.push(q)
      continue
    }
    let g = q.projectId == null ? undefined : byProject.get(q.projectId)
    if (!g) {
      g = { key: `p${q.projectId ?? 'none'}`, name: q.projectName ?? 'No project', color: q.color, workflow: false, items: [] }
      if (q.projectId != null) byProject.set(q.projectId, g)
      groups.push(g)
    }
    g.items.push(q)
  }
  if (flows.items.length) groups.push(flows)
  return groups.filter((g) => g.items.length > 0)
}

/** `points` for an SVG polyline: `values` (0..max) spread over w × h, newest at the right. */
export function sparkPoints(values: number[], w: number, h: number, max = 100): string {
  if (values.length === 0) return ''
  const step = values.length > 1 ? w / (values.length - 1) : 0
  return values
    .map((v, i) => {
      const y = h - (Math.max(0, Math.min(v, max)) / max) * h
      return `${(values.length > 1 ? i * step : w).toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/** Percent of `used` over `total`, or null when either is unknown or total is 0. */
export function pct(used: number | null, total: number | null): number | null {
  if (used == null || total == null || total <= 0) return null
  return (used / total) * 100
}

/** How Naru's voice bars move: `speaking` lively, `idle` gently (live but quiet), `off` still. */
export function voiceMotion(naru: OrbitNaru): 'speaking' | 'idle' | 'off' {
  if (!naru.active || naru.state === 'off') return 'off'
  return naru.state === 'speaking' ? 'speaking' : 'idle'
}

function workflowHref(projectId: number | null, workflowId: number | null): string {
  const base = projectId == null ? '#/workflows' : `#/projects/${projectId}/workflows`
  return workflowId == null ? base : `${base}/${workflowId}`
}

function taskHref(projectId: number | null, id: number): string {
  return projectId == null ? `#/tasks/${id}` : `#/projects/${projectId}/tasks/${id}`
}

/** Where a job links: its task panel, or its workflow. */
export function jobHref(job: OrbitJob): string {
  return job.kind === 'workflow' ? workflowHref(job.projectId, job.workflowId) : taskHref(job.projectId, job.id)
}

export function queuedHref(q: OrbitQueued): string {
  return q.kind === 'workflow' ? workflowHref(q.projectId, q.id) : taskHref(q.projectId, q.id)
}
