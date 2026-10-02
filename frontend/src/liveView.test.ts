import { describe, expect, it } from 'vitest'
import {
  agentsLabel,
  LIVE_VIEW_MAX,
  sectionFor,
  viewLine,
  type ViewParts,
} from './liveView'

const base: ViewParts = {
  projectId: 29,
  projectName: 'claude-config',
  section: 'files',
  item: 'SKILL.md',
  chatOpen: true,
  agentsOpen: false,
  agentDetail: null,
  boardOpen: true,
  boardId: 12,
  navCollapsed: true,
}

describe('sectionFor', () => {
  it('reads the tab after a project id', () => {
    expect(sectionFor('#/projects/29/files')).toBe('files')
    expect(sectionFor('#/projects/29/workflows/4')).toBe('workflows')
    expect(sectionFor('#/projects/29/git?x=1')).toBe('git')
  })
  it('calls a bare project and its task routes the board', () => {
    expect(sectionFor('#/projects/29')).toBe('board')
    expect(sectionFor('#/projects/29/tasks/7')).toBe('board')
  })
  it('reads the first segment of every other page', () => {
    expect(sectionFor('#/inbox')).toBe('inbox')
    expect(sectionFor('#/settings/memory')).toBe('settings')
    expect(sectionFor('#/projects')).toBe('projects')
  })
  it('names nothing for the root', () => {
    expect(sectionFor('#/')).toBeNull()
    expect(sectionFor('')).toBeNull()
  })
})

describe('agentsLabel', () => {
  it('names one, a few, and counts the rest', () => {
    expect(agentsLabel([])).toBeNull()
    expect(agentsLabel(['e34b8ed9'])).toBe('agent e34b8ed9')
    expect(agentsLabel(['a', 'b', 'c', 'd', 'e'])).toBe('agents a, b, c +2')
  })
})

describe('viewLine', () => {
  it('builds the compact line from every part', () => {
    expect(viewLine(base)).toBe(
      'p29 claude-config · files · SKILL.md · chat open · agents closed · board 12 · nav collapsed',
    )
  })

  it('omits unknown parts', () => {
    expect(
      viewLine({
        ...base,
        projectId: null,
        projectName: null,
        section: 'inbox',
        item: '  ',
      }),
    ).toBe('inbox · chat open · agents closed · board 12 · nav collapsed')
    expect(viewLine({ ...base, projectName: null })).toMatch(/^p29 · files/)
  })

  it('changes with each panel toggled', () => {
    const lines = new Set([
      viewLine(base),
      viewLine({ ...base, chatOpen: false }),
      viewLine({ ...base, agentsOpen: true }),
      viewLine({ ...base, boardOpen: false }),
      viewLine({ ...base, navCollapsed: false }),
    ])
    expect(lines.size).toBe(5)
    expect(viewLine({ ...base, boardOpen: false })).toContain('board closed')
    expect(viewLine({ ...base, boardId: null })).toContain('board open')
    expect(viewLine({ ...base, navCollapsed: false })).toContain('nav open')
  })

  it('names the open agent only while the agents panel shows it', () => {
    const agent = { ...base, agentDetail: 'agent e34b8ed9' }
    expect(viewLine({ ...agent, agentsOpen: true })).toContain(
      'agents open · agent e34b8ed9',
    )
    expect(viewLine(agent)).not.toContain('e34b8ed9')
  })

  it('stays short in the typical case and never passes the bound', () => {
    expect(viewLine(base).split(/\s+/).length).toBeLessThan(25)
    const long = viewLine({
      ...base,
      item: 'x'.repeat(500),
      projectName: 'y'.repeat(500),
    })
    expect(long.length).toBeLessThanOrEqual(LIVE_VIEW_MAX)
    expect(long).toContain('…')
  })
})
