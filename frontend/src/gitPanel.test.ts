import { describe, expect, it } from 'vitest'
import {
  GROUP_CAP,
  GROUP_STEP,
  activeWorktreePath,
  aheadBehind,
  branchBadges,
  branchTitle,
  branchTrackText,
  changedText,
  detailsByPath,
  disabledReason,
  filterBranches,
  filterCountLabel,
  groupBranches,
  groupOpen,
  groupedName,
  moreCount,
  orderWorktrees,
  parseSections,
  parseSideOpen,
  sameScope,
  shortFolder,
  shownCount,
  stashMessage,
  stashSub,
  worktreeLabel,
  worktreeSelectable,
  worktreeTitle,
} from './gitPanel'
import type { GitBranch } from './types/GitBranch'
import type { GitStash } from './types/GitStash'
import type { GitWorktree } from './types/GitWorktree'

const wt = (o: Partial<GitWorktree>): GitWorktree => ({
  path: '/r',
  branch: 'main',
  head: 'abcdef0123456789',
  is_current: false,
  is_main: false,
  detached: false,
  bare: false,
  locked: false,
  lock_reason: null,
  prunable: false,
  prunable_reason: null,
  ...o,
})

const br = (name: string, o: Partial<GitBranch> = {}): GitBranch => ({
  name,
  kind: 'local',
  remote: null,
  hash: 'a'.repeat(40),
  short_hash: 'aaaaaaa',
  date: '2026-01-01T00:00:00Z',
  subject: 's',
  upstream: null,
  upstream_gone: false,
  ahead: null,
  behind: null,
  is_head: false,
  worktree: null,
  merged: null,
  ...o,
})

const rbr = (remote: string, rest: string): GitBranch =>
  br(`${remote}/${rest}`, { kind: 'remote', remote })

describe('worktrees', () => {
  it('pins main first and keeps the rest in order', () => {
    const ws = [wt({ path: '/a' }), wt({ path: '/m', is_main: true }), wt({ path: '/b' })]
    expect(orderWorktrees(ws).map((w) => w.path)).toEqual(['/m', '/a', '/b'])
  })
  it('shortens a folder to its last two segments', () => {
    expect(shortFolder('/Users/x/code/proj/wt-a')).toBe('…/proj/wt-a')
    expect(shortFolder('/a/b')).toBe('/a/b')
    expect(shortFolder('/')).toBe('/')
    expect(shortFolder('/a/ünï/-x')).toBe('…/ünï/-x')
  })
  it('is selectable unless bare or prunable', () => {
    expect(worktreeSelectable(wt({}))).toBe(true)
    expect(worktreeSelectable(wt({ bare: true }))).toBe(false)
    expect(worktreeSelectable(wt({ prunable: true }))).toBe(false)
    expect(disabledReason(wt({}))).toBeNull()
    expect(disabledReason(wt({ prunable: true, prunable_reason: 'gitdir file points to non-existent location' }))).toContain(
      'non-existent',
    )
    expect(disabledReason(wt({ bare: true }))).toContain('Bare')
  })
  it('labels by branch or 8-char sha', () => {
    expect(worktreeLabel(wt({ branch: '-weird/ünï' }))).toBe('-weird/ünï')
    expect(worktreeLabel(wt({ branch: null, detached: true }))).toBe('abcdef01')
  })
  it('picks the active worktree: the pick, else is_current', () => {
    const ws = [wt({ path: '/a' }), wt({ path: '/b', is_current: true })]
    expect(activeWorktreePath(ws, null)).toBe('/b')
    expect(activeWorktreePath(ws, '/a')).toBe('/a')
    expect(activeWorktreePath([wt({})], null)).toBeNull()
  })
  it('merges details by path', () => {
    const m = detailsByPath([
      { path: '/a', changed: 1, ahead: 0, behind: 0, subject: 's', date: null },
    ])
    expect(m.get('/a')?.changed).toBe(1)
    expect(detailsByPath(null).size).toBe(0)
  })
  it('words the changed count', () => {
    expect(changedText(null)).toBeNull()
    expect(changedText(0)).toBe('clean')
    expect(changedText(3)).toBe('3 changed')
  })
  it('hides ahead/behind at 0/0 and for nulls', () => {
    expect(aheadBehind(0, 0)).toEqual({ ahead: null, behind: null })
    expect(aheadBehind(null, null)).toEqual({ ahead: null, behind: null })
    expect(aheadBehind(2, 0)).toEqual({ ahead: '↑2', behind: null })
    expect(aheadBehind(0, 5)).toEqual({ ahead: null, behind: '↓5' })
    expect(aheadBehind(1, 2)).toEqual({ ahead: '↑1', behind: '↓2' })
  })
  it('titles carry path, reason, base branch and subject', () => {
    const t = worktreeTitle(
      wt({ path: '/w/a', locked: true, lock_reason: 'on usb' }),
      { path: '/w/a', changed: 1, ahead: 2, behind: 1, subject: 'fix it', date: null },
      'trunk',
    )
    expect(t).toContain('/w/a')
    expect(t).toContain('Locked: on usb')
    expect(t).toContain('2 ahead, 1 behind trunk')
    expect(t).toContain('fix it')
  })
})

describe('branch grouping', () => {
  it('puts plain names first, then / groups, then remotes', () => {
    const g = groupBranches([
      rbr('origin', 'main'),
      br('feat/a'),
      br('main'),
      br('feat/b/c'),
      br('fix/z'),
      br('-dash'),
      br('ünï/ß'),
    ])
    expect(g.ungrouped.map((b) => b.name)).toEqual(['main', '-dash'])
    expect(g.groups.map((x) => x.key)).toEqual([
      'local:feat',
      'local:fix',
      'local:ünï',
      'remote:origin',
    ])
    expect(g.groups[0].branches.map(groupedName)).toEqual(['a', 'b/c'])
    expect(g.groups[3].remote).toBe(true)
  })
  it('groups a remote whose name contains / by its remote field', () => {
    const b = rbr('my/fork', 'feat/x')
    expect(groupedName(b)).toBe('feat/x')
    const g = groupBranches([b, rbr('origin', 'main')])
    expect(g.groups.map((x) => x.label)).toEqual(['my/fork', 'origin'])
  })
  it('falls back to the first segment when a remote is unknown', () => {
    const b = br('up/x', { kind: 'remote', remote: null })
    expect(groupBranches([b]).groups[0].label).toBe('up')
    expect(groupedName(b)).toBe('x')
  })
  it('never treats a leading slash as a group', () => {
    expect(groupBranches([br('/odd')]).ungrouped).toHaveLength(1)
  })
})

describe('branch filter', () => {
  const all = [br('Feat/Alpha'), br('main'), rbr('origin', 'feat/beta'), br('ünï/ÄÖ')]
  it('matches case-insensitively over every kind', () => {
    expect(filterBranches(all, 'FEAT').map((b) => b.name)).toEqual(['Feat/Alpha', 'origin/feat/beta'])
    expect(filterBranches(all, 'äö').map((b) => b.name)).toEqual(['ünï/ÄÖ'])
    expect(filterBranches(all, '  ')).toHaveLength(4)
    expect(filterBranches(all, 'zzz')).toEqual([])
    expect(filterBranches([br('-x')], '-x')).toHaveLength(1)
  })
  it('counts N of M only while filtering', () => {
    expect(filterCountLabel('', 4, 4)).toBeNull()
    expect(filterCountLabel('fe', 2, 4)).toBe('2 of 4')
  })
  it('auto-expands groups while filtering, remotes default closed', () => {
    const [loc, rem] = groupBranches([br('a/b'), rbr('o', 'x')]).groups
    expect(groupOpen(loc, false, {})).toBe(true)
    expect(groupOpen(rem, false, {})).toBe(false)
    expect(groupOpen(rem, true, {})).toBe(true)
    expect(groupOpen(loc, false, { [loc.key]: false })).toBe(false)
  })
})

describe('per-group cap', () => {
  it('shows 50 then 100 more per press', () => {
    expect(shownCount(10, 0)).toBe(10)
    expect(shownCount(500, 0)).toBe(GROUP_CAP)
    expect(shownCount(500, 1)).toBe(GROUP_CAP + GROUP_STEP)
    expect(shownCount(120, 1)).toBe(120)
    expect(moreCount(500, 0)).toBe(100)
    expect(moreCount(120, 0)).toBe(70)
    expect(moreCount(120, 1)).toBe(0)
    expect(moreCount(10, 0)).toBe(0)
  })
})

describe('branch rows', () => {
  it('words the upstream track', () => {
    expect(branchTrackText(br('a', { upstream: 'o/a', upstream_gone: true }))).toEqual({
      gone: true,
      ahead: null,
      behind: null,
    })
    expect(branchTrackText(br('a', { upstream: 'o/a', ahead: 1, behind: 0 }))).toEqual({
      gone: false,
      ahead: '↑1',
      behind: null,
    })
  })
  it('badges current, in-worktree and merged', () => {
    expect(branchBadges(br('a', { is_head: true, worktree: '/x' }), '/x')).toEqual({
      current: true,
      inWorktree: null,
      merged: false,
    })
    expect(branchBadges(br('a', { worktree: '/other', merged: true }), '/x')).toEqual({
      current: false,
      inWorktree: '/other',
      merged: true,
    })
    expect(branchBadges(br('a', { worktree: '/x' }), '/x').inWorktree).toBeNull()
    expect(branchBadges(br('a', { is_head: true, merged: true }), '/x').merged).toBe(false)
    expect(branchBadges(br('a', { merged: false }), null).merged).toBe(false)
  })
  it('titles carry name, upstream, subject and sha', () => {
    const t = branchTitle(br('feat/x', { upstream: 'o/feat/x', ahead: 1, behind: 2, subject: 'Do it' }))
    expect(t).toContain('feat/x')
    expect(t).toContain('Upstream: o/feat/x')
    expect(t).toContain('1 ahead, 2 behind o/feat/x')
    expect(t).toContain('Do it')
    expect(t).toContain('aaaaaaa')
  })
  it('compares scopes by name and kind', () => {
    expect(sameScope({ name: 'main', kind: 'local' }, { name: 'main', kind: 'local' })).toBe(true)
    expect(sameScope({ name: 'main', kind: 'local' }, { name: 'main', kind: 'remote' })).toBe(false)
    expect(sameScope(null, null)).toBe(true)
    expect(sameScope(null, { name: 'a', kind: 'local' })).toBe(false)
  })
})

describe('stashes', () => {
  const s = (o: Partial<GitStash>): GitStash => ({
    index: 0,
    name: 'stash@{0}',
    hash: 'b'.repeat(40),
    message: 'wip',
    branch: 'main',
    date: '2026-01-01T00:00:00Z',
    ...o,
  })
  it('marks a blank message', () => {
    expect(stashMessage(s({ message: '  ' }))).toEqual({ text: '(no message)', empty: true })
    expect(stashMessage(s({ message: 'wip <b>' }))).toEqual({ text: 'wip <b>', empty: false })
  })
  it('says which branch and when', () => {
    const now = new Date('2026-01-01T02:00:00Z')
    expect(stashSub(s({}), now)).toBe('on main · 2 hours ago')
    expect(stashSub(s({ branch: null }), now)).toBe('2 hours ago')
  })
})

describe('storage', () => {
  it('defaults the side panel open', () => {
    expect(parseSideOpen(null)).toBe(true)
    expect(parseSideOpen('true')).toBe(true)
    expect(parseSideOpen('false')).toBe(false)
  })
  it('parses section flags, tolerating junk', () => {
    expect(parseSections(null)).toEqual({ worktrees: true, branches: true, stashes: true })
    expect(parseSections('{"branches":false,"stashes":3}')).toEqual({
      worktrees: true,
      branches: false,
      stashes: true,
    })
    expect(parseSections('not json').branches).toBe(true)
    expect(parseSections('null').worktrees).toBe(true)
  })
})
