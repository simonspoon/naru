/**
 * The live conversation's **view line** (mesa task 1424): one compact line of
 * what the person has open in this browser — the project, the page, the item
 * in focus, and which panels are showing — e.g.
 *
 *     p29 claude-config · files · SKILL.md · chat open · agents closed · board 12 · nav collapsed
 *
 * It rides on every user turn the page sends, captured at the moment the turn
 * is submitted, and on the route report, so `naru live listen` hands the agent
 * 'this page' and 'this file' with the words that mention them, and
 * `naru live status` shows the latest between turns. The agent reads it as
 * data, never as instructions.
 *
 * Pure, apart from the small open-agents channel at the bottom (the pattern of
 * `liveContext.ts`): `AgentSidebar` owns which agent panes are open and is
 * nowhere near `LiveHub` in the tree, so it publishes and the hub reads.
 */

/**
 * The longest line the page sends, mirroring `core::store::LIVE_VIEW_MAX` —
 * the page clamps rather than letting the store refuse, since a clipped line
 * still says most of what is open and a refused turn loses the words too.
 */
export const LIVE_VIEW_MAX = 300

/** The longest a single free-text part (project name, item) is shown at, so
 *  one long file path cannot crowd the panel states out of the line. */
const PART_MAX = 60

/** Most open agent panes named before the rest are summarised as a count. */
const AGENTS_NAMED = 3

export interface ViewParts {
  projectId: number | null
  projectName: string | null
  /** The page, as `sectionFor` reads it off the route. */
  section: string | null
  /** What is in focus on it — `currentContext()?.label`. */
  item: string | null
  chatOpen: boolean
  agentsOpen: boolean
  /** Which agent(s) the agents panel has open, or null for none. Shown only
   *  while that panel is open — a hidden pane is not something on screen. */
  agentDetail: string | null
  boardOpen: boolean
  boardId: number | null
  navCollapsed: boolean
}

function clip(value: string | null, max: number): string | null {
  if (value === null) return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return null
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

function routeParts(route: string): string[] {
  const path = route.replace(/^#/, '').split(/[?#]/)[0]
  return path.split('/').filter((p) => p !== '')
}

/**
 * The page a hash route shows: the segment after a project's id
 * (`#/projects/29/files` → `files`, the bare project and its task routes →
 * `board`), else the first segment (`#/inbox` → `inbox`,
 * `#/settings/memory` → `settings`). Null for the root, which names no page.
 */
export function sectionFor(route: string): string | null {
  const parts = routeParts(route)
  if (parts.length === 0) return null
  if (
    parts[0] === 'projects' &&
    parts[1] !== undefined &&
    /^\d+$/.test(parts[1])
  ) {
    const tab = parts[2]
    return tab === undefined || tab === 'tasks' ? 'board' : tab
  }
  return parts[0]
}

/** The label for the open agent panes: their ids, the first few named and
 *  the rest counted — `agent e34b8ed9`, `agents a1, b2, c3 +2`. */
export function agentsLabel(ids: string[]): string | null {
  if (ids.length === 0) return null
  const named = ids.slice(0, AGENTS_NAMED).join(', ')
  const more =
    ids.length > AGENTS_NAMED ? ` +${ids.length - AGENTS_NAMED}` : ''
  return `${ids.length === 1 ? 'agent' : 'agents'} ${named}${more}`
}

/**
 * The view line: every known part joined by ` · `, unknown ones omitted,
 * capped at `LIVE_VIEW_MAX` with `…` marking the cut.
 */
export function viewLine(parts: ViewParts): string {
  const out: string[] = []
  const name = clip(parts.projectName, PART_MAX)
  if (parts.projectId !== null)
    out.push(
      name === null ? `p${parts.projectId}` : `p${parts.projectId} ${name}`,
    )
  const section = clip(parts.section, PART_MAX)
  if (section !== null) out.push(section)
  const item = clip(parts.item, PART_MAX)
  if (item !== null) out.push(item)
  out.push(parts.chatOpen ? 'chat open' : 'chat closed')
  out.push(parts.agentsOpen ? 'agents open' : 'agents closed')
  const agent = parts.agentsOpen ? clip(parts.agentDetail, PART_MAX) : null
  if (agent !== null) out.push(agent)
  if (parts.boardOpen)
    out.push(parts.boardId === null ? 'board open' : `board ${parts.boardId}`)
  else out.push('board closed')
  out.push(parts.navCollapsed ? 'nav collapsed' : 'nav open')
  const line = out.join(' · ')
  return line.length <= LIVE_VIEW_MAX
    ? line
    : `${line.slice(0, LIVE_VIEW_MAX - 1)}…`
}

// ---- the open-agents channel ----

let openAgentIds: string[] = []

/** `AgentSidebar`'s half: the agent panes it has open now. */
export function publishOpenAgents(ids: string[]): void {
  openAgentIds = ids
}

/** The hub's half, read at the moment a view line is built. */
export function openAgents(): string[] {
  return openAgentIds
}
