import { describe, expect, it } from 'vitest'
import {
  branchNameProblem,
  branchTargetLine,
  defaultSwitch,
  deleteReason,
  isUnborn,
  newBranchReason,
  newBranchTitle,
  offersStashSwitch,
  operationReason,
  refCtxOf,
  refLabel,
  renameReason,
  stashApplyReason,
  stashPushReason,
  stashTargetLine,
  stashMessageProblem,
  switchReason,
  switchToItReason,
  writeOffReason,
} from './gitRefs'
import type { RefCtx } from './gitRefs'
import type { GitBranch } from './types/GitBranch'
import type { GitWorktree } from './types/GitWorktree'

const WT = '/Users/me/app'
const ctx: RefCtx = {
  worktree: WT,
  branch: 'main',
  detached: false,
  isMain: true,
  linked: 2,
  operation: null,
  dirty: false,
  stale: false,
}
const branch = (name: string, over: Partial<GitBranch> = {}): GitBranch =>
  ({
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
    ...over,
  }) as GitBranch
const wt = (path: string, over: Partial<GitWorktree> = {}): GitWorktree =>
  ({
    path,
    branch: 'main',
    head: 'a'.repeat(40),
    is_current: false,
    is_main: false,
    detached: false,
    bare: false,
    locked: false,
    lock_reason: null,
    prunable: false,
    prunable_reason: null,
    ...over,
  }) as GitWorktree

describe('refCtxOf', () => {
  const status = { branch: 'main', dirty: 3, ahead: 0, behind: 0 }
  it('reads the worktree, main-ness, linked count and dirtiness', () => {
    const ws = [wt('/m', { is_main: true, is_current: true }), wt('/a'), wt('/b', { detached: true })]
    expect(refCtxOf({ worktrees: ws, selected: null, status, operation: 'merge', fresh: true })).toEqual({
      worktree: '/m',
      branch: 'main',
      detached: false,
      isMain: true,
      linked: 2,
      operation: 'merge',
      dirty: true,
      stale: false,
    })
    const d = refCtxOf({ worktrees: ws, selected: '/b', status, operation: null, fresh: true })
    expect(d.detached).toBe(true)
    expect(d.isMain).toBe(false)
  })

  it('an unresolved worktree is null and a loading view is stale with unknown dirt', () => {
    expect(refCtxOf({ worktrees: null, selected: null, status, operation: null, fresh: true }).worktree).toBeNull()
    const s = refCtxOf({ worktrees: [wt('/m', { is_current: true })], selected: null, status, operation: 'rebase', fresh: false })
    expect(s.stale).toBe(true)
    expect(s.dirty).toBeNull()
    expect(s.operation).toBeNull()
  })
})

describe('isUnborn', () => {
  it('no head branch row on a non-detached worktree', () => {
    expect(isUnborn([], ctx)).toBe(true)
    expect(isUnborn([branch('main', { is_head: true })], ctx)).toBe(false)
    expect(isUnborn([branch('x')], { ...ctx, detached: true })).toBe(false)
    expect(isUnborn(null, ctx)).toBe(false)
  })
})

describe('disabled reasons', () => {
  it('a branch held by another worktree: switch, rename, delete off with its path', () => {
    const b = branch('feat', { worktree: '/agents/wt1' })
    for (const r of [switchReason(ctx, b), renameReason(b), deleteReason(b)]) {
      expect(r).toBe('Checked out in /agents/wt1')
    }
  })

  it('the current branch: no switch, no delete, rename allowed', () => {
    const b = branch('main', { is_head: true, worktree: WT })
    expect(switchReason(ctx, b)).toBe('Already the current branch')
    expect(deleteReason(b)).toBe("Can't delete the checked-out branch")
    expect(renameReason(b)).toBeNull()
  })

  it('an operation in progress blocks switch, stash, apply and pop, not drop or rename', () => {
    const c = { ...ctx, operation: 'merge' }
    expect(switchReason(c, branch('x'))).toBe(operationReason('merge'))
    expect(operationReason('merge')).toBe('Merge in progress in this worktree. Finish or abort it in the terminal.')
    expect(stashPushReason(c, false)).toBe(operationReason('merge'))
    expect(stashApplyReason(c)).toBe(operationReason('merge'))
    expect(renameReason(branch('x'))).toBeNull()
    expect(switchToItReason(c)).toBe(operationReason('merge'))
    expect(newBranchReason(false)).toBeNull()
    expect(defaultSwitch({ kind: 'head' }, c)).toBe(false)
  })

  it('an unborn HEAD blocks new branch and stash', () => {
    expect(newBranchReason(true)).toBe('No commits yet.')
    expect(stashPushReason(ctx, true)).toBe('No commits yet.')
  })

  it('a name starting with "-" is never handed to git', () => {
    const b = branch('-weird')
    expect(switchReason(ctx, b)).toBe("Rename it in the terminal.")
    expect(renameReason(b)).toBe("Rename it in the terminal.")
    expect(deleteReason(b)).toBe("Rename it in the terminal.")
  })

  it('every control is off while busy, without a worktree, or while loading', () => {
    expect(writeOffReason(ctx, false)).toBeNull()
    expect(writeOffReason(ctx, true)).toMatch(/in progress/)
    expect(writeOffReason({ ...ctx, worktree: null }, false)).toBe('The worktree path is unknown.')
    expect(writeOffReason({ ...ctx, stale: true }, false)).toBe('Loading this worktree.')
  })
})

describe('labels and target lines name the worktree', () => {
  it('switch, apply, pop, new branch and stash carry the full path and branch', () => {
    expect(refLabel('switch', 'feature/x', ctx)).toBe(`Switch to feature/x in ${WT} (branch main)`)
    expect(refLabel('apply', 'stash@{0}', ctx)).toBe(`Apply stash@{0} to main in ${WT}`)
    expect(refLabel('pop', 'stash@{0}', ctx)).toBe(`Pop stash@{0} onto main in ${WT}`)
    expect(refLabel('new-branch', '', ctx)).toBe(`New branch from main in ${WT}`)
    expect(refLabel('stash', '', ctx)).toBe(`Stash changes in main in ${WT}`)
    expect(refLabel('rename', 'feature/x', ctx)).toBe('Rename branch feature/x')
    expect(refLabel('delete', 'feature/x', ctx)).toBe('Delete branch feature/x')
    expect(refLabel('drop', 'stash@{0}', ctx)).toBe('Drop stash@{0}')
    expect(refLabel('branch-from-remote', 'origin/x', ctx)).toBe('Create local branch from origin/x')
  })

  it('an unresolved worktree is said, not guessed', () => {
    expect(refLabel('switch', 'x', { ...ctx, worktree: null })).toContain('unknown worktree')
    expect(branchTargetLine({ ...ctx, worktree: null })).toContain('unknown worktree')
  })

  it('the target lines state what the controls act on', () => {
    expect(branchTargetLine(ctx)).toBe(`Switch and New branch act on main · ${WT}`)
    expect(stashTargetLine(ctx)).toBe(
      `Stashes are shared by all worktrees. Apply, Pop and Stash act on main · ${WT}`,
    )
  })

  it('markup in a name stays a string', () => {
    expect(refLabel('delete', '<b>x</b>', ctx)).toBe('Delete branch <b>x</b>')
  })
})

describe('new branch forms', () => {
  it('titles and the switch default', () => {
    expect(newBranchTitle({ kind: 'head' }, ctx)).toBe('New branch from main')
    expect(newBranchTitle({ kind: 'head' }, { ...ctx, detached: true, branch: 'abc1234' })).toBe('New branch at abc1234')
    expect(newBranchTitle({ kind: 'commit', sha: 'abc1234def' }, ctx)).toBe('New branch at abc1234')
    expect(newBranchTitle({ kind: 'remote', name: 'origin/x' }, ctx)).toBe('New local branch from origin/x')
    expect(defaultSwitch({ kind: 'head' }, ctx)).toBe(true)
    expect(defaultSwitch({ kind: 'remote', name: 'origin/x' }, ctx)).toBe(false)
    expect(defaultSwitch({ kind: 'commit', sha: 'a' }, ctx)).toBe(false)
  })
})

describe('branchNameProblem', () => {
  const existing = ['main', 'feature/x']
  it('accepts slashes, unicode and ordinary names; empty is not a message', () => {
    for (const n of ['feat/new-thing', 'fix_123', 'ünï/çødé', '日本語', 'a.b', 'v1.0']) {
      expect(branchNameProblem(n, existing)).toBeNull()
    }
    expect(branchNameProblem('', existing)).toBeNull()
    expect(branchNameProblem('   ', existing)).toBeNull()
  })

  it('refuses what git refuses', () => {
    for (const n of [
      'a b', 'a\tb', '-x', '--force', '@', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b',
      'a@{b', '/a', 'a/', 'a//b', 'a.', 'x.lock', 'a/.hidden', '.hidden', 'a/b.lock',
    ]) {
      expect(branchNameProblem(n, existing), n).not.toBeNull()
    }
  })

  it('says when the name exists, and when a rename changes nothing', () => {
    expect(branchNameProblem('main', existing)).toBe('A branch named main already exists.')
    expect(branchNameProblem('feature/x', existing, 'feature/x')).toBe('That is already its name.')
    expect(branchNameProblem('feature/y', existing, 'feature/x')).toBeNull()
  })

  it('trims surrounding whitespace before judging', () => {
    expect(branchNameProblem('  ok  ', existing)).toBeNull()
  })
})

describe('stashMessageProblem', () => {
  it('is optional, one line, at most 200 bytes', () => {
    expect(stashMessageProblem('')).toBeNull()
    expect(stashMessageProblem('wip: parser')).toBeNull()
    expect(stashMessageProblem('a\nb')).not.toBeNull()
    expect(stashMessageProblem('x'.repeat(200))).toBeNull()
    expect(stashMessageProblem('x'.repeat(201))).not.toBeNull()
    expect(stashMessageProblem('é'.repeat(101))).not.toBeNull()
  })
})

describe('offersStashSwitch', () => {
  it('only for git refusing because local files would be overwritten', () => {
    const c = 'conflict'
    expect(offersStashSwitch({ code: c, message: 'error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt' })).toBe(true)
    expect(offersStashSwitch({ code: c, message: 'error: The following untracked working tree files would be overwritten by checkout:\n\tb' })).toBe(true)
    expect(offersStashSwitch({ code: c, message: 'fatal: invalid reference: x' })).toBe(false)
    expect(offersStashSwitch({ code: 'not_found', message: 'would be overwritten' })).toBe(false)
    expect(offersStashSwitch({ code: 'validation', message: 'would be overwritten' })).toBe(false)
  })
})

describe('branch names and unicode spaces', () => {
  it('only space, tab, newline, CR and controls are refused', () => {
    expect(branchNameProblem('a\u00a0b', [])).toBeNull()
    expect(branchNameProblem('a\u3000b', [])).toBeNull()
    for (const n of ['a b', 'a\tb', 'a\nb', 'a\rb']) expect(branchNameProblem(n, [])).not.toBeNull()
  })
})
