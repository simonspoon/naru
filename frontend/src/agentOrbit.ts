// Orbit layout for the Agent watcher (naru task 2541, docs/agent-watcher.md).
// Pure geometry and grouping over the `/api/agents/orbit` feed: where each
// running job sits on the ring, where its sub-agent dots cluster, how the
// queue groups by project, and the sparkline points. The page only draws.

import type { CcSessionChat } from './types/CcSessionChat'
import type { OrbitAgent } from './types/OrbitAgent'
import type { OrbitJob } from './types/OrbitJob'
import type { OrbitNaru } from './types/OrbitNaru'
import type { OrbitProject } from './types/OrbitProject'
import type { OrbitQueued } from './types/OrbitQueued'

/** The orbit's SVG viewBox is VIEW × VIEW with Naru at (C, C). */
export const VIEW = 1000
export const C = VIEW / 2
export const NARU_R = 80
/** Jobs sit between RING_MIN (just started) and RING (hours old) from Naru. */
export const RING = 280
export const RING_MIN = 170
export const NODE_R = 46
/** Where a job's sub-agent dots sit, however close in the job is. */
export const DOT_RING = 440
/** A job nearer Naru than this carries its label on the outer side. */
const LABEL_OUT_BELOW = 240
export const DOT_R = 14
/** Font sizes in viewBox units: a job's title, its project · stage line, a dot's label. */
export const TITLE_PX = 26
export const SUB_PX = 21
export const DOT_PX = 20
/** Angle between neighbouring sub-agent dots, and the clear gap kept between two jobs' clusters. */
const DOT_STEP = (14 * Math.PI) / 180
/** Naru's own dots sit nearer the centre, where the same arc is shorter, so they spread wider. */
const NARU_DOT_STEP = (22 * Math.PI) / 180
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

/** How many sub-agent dots one cluster can show with `n` clusters on the ring. */
export function maxDots(n: number, step = DOT_STEP): number {
  const room = (2 * Math.PI) / Math.max(n, 1) - CLUSTER_GAP
  return Math.max(1, Math.min(MAX_DOTS, Math.floor(room / step) + 1))
}

/** Age at which a session reaches the outer edge; anything older stays there. */
export const AGE_FULL_S = 4 * 3600

/**
 * Distance from Naru for something `age` seconds old: log-scaled, so a
 * minute-old session and an hours-old one both stay visible and distinct
 * (1 min ≈ 13%, 5 min ≈ 33%, 30 min ≈ 63%, 1 h ≈ 75%, 4 h and up = 100%).
 */
export function ageRadius(age: number | null, min = RING_MIN, max = RING): number {
  const a = Math.max(0, age ?? 0)
  const t = Math.min(1, Math.log1p(a / 60) / Math.log1p(AGE_FULL_S / 60))
  return min + t * (max - min)
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

/** Whether the disc of radius `r` at `p` meets box `b` (Naru is a disc, not a square). */
export function discOverlaps(p: Pt, r: number, b: Box): boolean {
  const dx = p.x - Math.max(b.x0, Math.min(p.x, b.x1))
  const dy = p.y - Math.max(b.y0, Math.min(p.y, b.y1))
  return dx * dx + dy * dy < r * r
}

/** Naru's painted disc, glow included, as the overlap test keeps clear of it. */
export const NARU_CLEAR = NARU_R + 12

export type DotLayout = { agent: OrbitAgent; at: Pt; text: string; textY: number }
export type OrbitLayout = { jobs: JobLayout[]; naru: DotLayout[] }
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
 * Place every job, and Naru's own sub-agents. A job's distance from Naru is
 * its age at `now` (`ageRadius`): new close in, old out on the ring. Its
 * sub-agent dots stay on DOT_RING, on the job's outer side. Naru's agents,
 * when it has any, take one more slot on the ring after the jobs, each dot at
 * its own age.
 *
 * When the full age range would paint two things over each other (a crowded
 * ring, or a label with no room beside Naru), the range is narrowed towards
 * the ring step by step: who is older still sits farther out, only less far.
 */
export function layoutOrbit(jobs: OrbitJob[], naruAgents: OrbitAgent[] = [], now = 0): OrbitLayout {
  let layout = placeAll(jobs, naruAgents, now, RING_MIN)
  for (let min = RING_MIN; clashes(layout) && min < RING; ) {
    min = Math.min(RING, min + RELAX_STEP)
    layout = placeAll(jobs, naruAgents, now, min)
  }
  return layout
}

/** How far the inner edge moves out per relax step. */
const RELAX_STEP = 15

/**
 * Whether anything that moves with age meets another painted box or leaves
 * the viewBox. Naru's disc and the jobs' dots on DOT_RING never move, so a
 * clash between two of them is one narrowing cannot fix, and is ignored.
 */
export function clashes(layout: OrbitLayout): boolean {
  const boxes = layoutBoxes(layout)
  const fixed = (part: string) => part === 'naru' || part.startsWith('dot')
  return boxes.some((p, i) => {
    const b = p.box
    if (!fixed(p.part) && (b.x0 < 0 || b.y0 < 0 || b.x1 > VIEW || b.y1 > VIEW)) return true
    return boxes
      .slice(i + 1)
      .some((q) => (fixed(p.part) && fixed(q.part) ? false : p.part === 'naru' ? discOverlaps({ x: C, y: C }, NARU_CLEAR, q.box) : overlaps(b, q.box)))
  })
}

function placeAll(jobs: OrbitJob[], naruAgents: OrbitAgent[], now: number, min: number): OrbitLayout {
  const n = jobs.length + (naruAgents.length > 0 ? 1 : 0)
  const k = maxDots(n)
  const chars = titleChars(n)
  const placed = jobs.map((job, i) => {
    const a = jobAngle(i, n)
    const r = ageRadius(job.startedAt == null ? null : now - job.startedAt, min)
    const at = polar(r, a)
    // Inner side normally; a node close in has no room there, but the gap out
    // to its dots (which stay on DOT_RING) has grown, so its label goes there.
    const inner = r >= LABEL_OUT_BELOW
    const below = (at.y <= C + 1) === inner
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
  const a = jobAngle(jobs.length, n)
  const shown = visibleAgents(naruAgents, maxDots(n, NARU_DOT_STEP))
  const naru = shown.map((agent, j) => {
    const r = ageRadius(agent.startedAt == null ? null : now - agent.startedAt, min)
    const p = polar(r, a + (j - (shown.length - 1) / 2) * NARU_DOT_STEP)
    const text = agent.state === 'done' ? `${agent.role} ✓` : agent.role
    return { agent, at: p, text, textY: p.y + DOT_R + 24 }
  })
  return { jobs: placed, naru }
}

/** Every box a layout paints, tagged with the job it belongs to — for the overlap test; `b` is a label boost (`textBoost`). */
export function layoutBoxes(layout: OrbitLayout, b = 1): { owner: number; part: string; box: Box }[] {
  const out: { owner: number; part: string; box: Box }[] = [{ owner: -1, part: 'naru', box: circleBox({ x: C, y: C }, NARU_R + 12) }]
  layout.naru.forEach((d, j) => {
    out.push({ owner: -1, part: `naru-dot${j}`, box: circleBox(d.at, DOT_R + 4) })
    out.push({ owner: -1, part: `naru-dot${j}-text`, box: textBox(d.at.x, boostY(d.at.y, d.textY, b), d.text, DOT_PX * b) })
  })
  layout.jobs.forEach((l, i) => {
    out.push({ owner: i, part: 'node', box: circleBox(l.at, NODE_R + 4) })
    out.push({ owner: i, part: 'title', box: textBox(l.at.x, boostY(l.at.y, l.titleY, b), l.title, TITLE_PX * b) })
    out.push({ owner: i, part: 'sub', box: textBox(l.at.x, boostY(l.at.y, l.subY, b), l.sub, SUB_PX * b) })
    l.dots.forEach((d, j) => {
      out.push({ owner: i, part: `dot${j}`, box: circleBox(d.at, DOT_R + 4) })
      out.push({ owner: i, part: `dot${j}-text`, box: textBox(d.at.x, boostY(d.at.y, d.textY, b), d.text, DOT_PX * b) })
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

/**
 * One message of a hover block: who spoke, and what (trimmed to one
 * paragraph's worth). A session's prompt is `asked` (its parent, a runner or a
 * person); `you` and `naru` are the live conversation's two sides.
 */
export type HoverTurn = { who: 'asked' | 'agent' | 'you' | 'naru'; text: string }

/** How many messages a hover block shows, and how long each may run. */
export const HOVER_TURNS = 4
const HOVER_CHARS = 280

/** `text` on one line, cut to `max` characters. */
export function squash(text: string, max = HOVER_CHARS): string {
  return clip(text.replace(/\s+/g, ' '), max)
}

/** The newest prompts and replies of a transcript (tool calls left out), oldest first. */
export function chatTurns(chat: CcSessionChat, n = HOVER_TURNS): HoverTurn[] {
  return chat.turns
    .filter((t) => t.kind !== 'tool' && t.text.trim() !== '')
    .slice(-n)
    .map((t) => ({ who: t.kind === 'prompt' ? 'asked' : 'agent', text: squash(t.text) }))
}

/** The session and transcript id a watcher sub-agent key (`<session>/<agent id>`) names. */
export function subagentRef(key: string): { sessionId: string; agentId: string } | null {
  const cut = key.indexOf('/')
  if (cut <= 0 || cut === key.length - 1) return null
  return { sessionId: key.slice(0, cut), agentId: key.slice(cut + 1) }
}

export type Rect = { left: number; top: number; right: number; bottom: number }

/**
 * Where a `w` × `h` hover block goes beside `anchor` inside a `vw` × `vh`
 * window: to the right when it fits, else to the left, else over it; level
 * with the anchor's top; always clamped `margin` inside the window.
 */
export function placeHover(anchor: Rect, w: number, h: number, vw: number, vh: number, gap = 12, margin = 8): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)))
  let left = anchor.right + gap
  if (left + w > vw - margin) left = anchor.left - gap - w
  if (left < margin) left = anchor.left
  return { left: clamp(left, margin, vw - margin - w), top: clamp(anchor.top, margin, vh - margin - h) }
}

/** Which watcher side panel a collapse state belongs to (naru task 2563). */
export type WatchPanel = 'stats' | 'queue'

/** localStorage key holding a panel's collapsed state; absent = expanded. */
export const panelKey = (panel: WatchPanel) => `naru-watcher-${panel}-collapsed`

/** Whether `panel` was left collapsed in this browser; expanded when storage is unreadable. */
export function loadCollapsed(panel: WatchPanel): boolean {
  try {
    return localStorage.getItem(panelKey(panel)) === '1'
  } catch {
    return false
  }
}

export function saveCollapsed(panel: WatchPanel, collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(panelKey(panel), '1')
    else localStorage.removeItem(panelKey(panel))
  } catch {
    // Storage unavailable — the toggle just won't persist.
  }
}

/** The watcher canvas's visible region in viewBox units (naru task 2564): what pan and zoom change. */
export type ViewBox = { x: number; y: number; w: number; h: number }

/** Zoom limits, as the narrowest and widest view (viewBox units). */
export const VIEW_MIN = 200
export const VIEW_MAX = 4 * VIEW

/** The smallest square a fit may show, so a near-empty map is not blown up. */
export const FIT_MIN = 700

/** A view showing every box with `pad` around it, centred, at least `FIT_MIN` across. */
export function fitView(boxes: Box[], pad = 30): ViewBox {
  if (boxes.length === 0) return { x: 0, y: 0, w: VIEW, h: VIEW }
  const x0 = Math.min(...boxes.map((b) => b.x0)) - pad
  const y0 = Math.min(...boxes.map((b) => b.y0)) - pad
  const x1 = Math.max(...boxes.map((b) => b.x1)) + pad
  const y1 = Math.max(...boxes.map((b) => b.y1)) + pad
  const w = Math.max(x1 - x0, FIT_MIN)
  const h = Math.max(y1 - y0, FIT_MIN)
  return { x: (x0 + x1 - w) / 2, y: (y0 + y1 - h) / 2, w, h }
}

/** Everything the orbit paints — the ring and every layout box, labels at boost `b` — for a fit. */
export function orbitBoxes(layout: OrbitLayout, b = 1): Box[] {
  return [circleBox({ x: C, y: C }, RING), ...layoutBoxes(layout, b).map((x) => x.box)]
}

/**
 * `v` zoomed by `factor` (>1 in) about `at`, which stays put on screen; the
 * factor is cut so the view stays within `VIEW_MIN`..`VIEW_MAX` across.
 */
export function zoomView(v: ViewBox, factor: number, at: Pt): ViewBox {
  const big = Math.max(v.w, v.h)
  const small = Math.min(v.w, v.h)
  const f = Math.min(Math.max(factor, big / VIEW_MAX), small / VIEW_MIN)
  const w = v.w / f
  const h = v.h / f
  return { x: at.x - (at.x - v.x) / f, y: at.y - (at.y - v.y) / f, w, h }
}

/** `v` dragged by `dx`, `dy` viewBox units (the content moves with the pointer). */
export function panView(v: ViewBox, dx: number, dy: number): ViewBox {
  return { ...v, x: v.x - dx, y: v.y - dy }
}

/** The smallest a label may be drawn on screen, in CSS pixels, and the most text may grow to get there. */
export const LABEL_MIN_PX = 9
export const BOOST_MAX = 1.6

/**
 * How much to enlarge every label when the map is drawn at `pxPerUnit`
 * screen pixels per viewBox unit (naru task 2564): enough that the smallest
 * label (`DOT_PX`) reaches `LABEL_MIN_PX`, never below 1 or above `BOOST_MAX`.
 * Zooming in raises `pxPerUnit`, so the boost fades as the person zooms.
 */
export function textBoost(pxPerUnit: number): number {
  if (!(pxPerUnit > 0)) return 1
  return Math.min(Math.max(LABEL_MIN_PX / (DOT_PX * pxPerUnit), 1), BOOST_MAX)
}

/** A label baseline `y` moved away from its anchor `from` in step with a boost, so stacked lines keep apart. */
export const boostY = (from: number, y: number, b: number) => from + (y - from) * b

/**
 * The largest boost up to `want`, in 0.05 steps, at which no enlarged label
 * meets anything else painted — so growing labels for a narrow tab never
 * stacks them on each other (only labels change size, so only they are checked).
 */
export function safeBoost(layout: OrbitLayout, want: number): number {
  for (let b = want; b > 1; b -= 0.05) {
    const boxes = layoutBoxes(layout, b)
    const text = (part: string) => part === 'title' || part === 'sub' || part.endsWith('-text')
    const clash = boxes.some((p, i) =>
      boxes.slice(i + 1).some((q) => (text(p.part) || text(q.part)) && (p.part === 'naru' ? discOverlaps({ x: C, y: C }, NARU_CLEAR, q.box) : overlaps(p.box, q.box))),
    )
    if (!clash) return b
  }
  return 1
}
