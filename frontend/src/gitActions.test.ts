import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PLAN_LIST_MAX,
  controlLabel,
  createGitActions,
  alertText,
  describeError,
  discardHunkPlan,
  discardPlan,
  hunkFailurePrefix,
  failurePrefix,
  commitFailurePrefix,
} from './gitActions'
import type { DiscardItem, DiscardPlan, GitWriteApi } from './gitActions'
import type { GitRepoView } from './types/GitRepoView'

const WT = '/Users/me/code/app-wt'
const view = { files: [], operation: null } as unknown as GitRepoView
const tracked = (path: string, alsoStaged = false): DiscardItem => ({
  path,
  untracked: false,
  folder: false,
  alsoStaged,
})
const untrackedFile = (path: string): DiscardItem => ({
  path,
  untracked: true,
  folder: false,
  alsoStaged: false,
})
const untrackedDir = (path: string): DiscardItem => ({
  path,
  untracked: true,
  folder: true,
  alsoStaged: false,
})

const commitResult = { hash: 'a'.repeat(40), short_hash: 'aaaaaaa', amended: false, view }

function harness(answer: boolean | (() => Promise<boolean>) = true) {
  const api: GitWriteApi = {
    stage: vi.fn(async () => view),
    unstage: vi.fn(async () => view),
    discard: vi.fn(async () => view),
    stageHunks: vi.fn(async () => view),
    unstageHunks: vi.fn(async () => view),
    discardHunks: vi.fn(async () => view),
    commit: vi.fn(async () => commitResult),
  }
  const confirm = vi.fn(async (plan: DiscardPlan) => {
    void plan
    return typeof answer === 'function' ? answer() : answer
  })
  return { api, confirm, actions: createGitActions({ api, confirm }) }
}
const ctx = { worktree: WT, branch: 'feat/x' }

describe('discardPlan text', () => {
  it('names the count in the title and the staged-kept consequence', () => {
    const p = discardPlan([tracked('a'), tracked('b'), tracked('c')], WT, 'feat/x')
    expect(p.title).toBe('Discard changes to 3 files?')
    expect(p.confirmLabel).toBe('Discard 3 files')
    expect(p.consequences).toContain(
      'The working tree copies are reset to the staged version. Staged changes are kept.',
    )
    expect(p.irreversible).toBe('This cannot be undone.')
    expect(p.worktree).toBe(WT)
    expect(p.branch).toBe('feat/x')
  })

  it('says which part of a staged-and-modified file is lost and which is kept', () => {
    const one = discardPlan([tracked('a', true)], WT, 'b')
    expect(one.title).toBe('Discard changes to 1 file?')
    expect(one.confirmLabel).toBe('Discard file')
    expect(one.consequences.join(' ')).toContain('only its unstaged edits are lost')
    expect(one.consequences.join(' ')).toContain('the staged ones are kept')
    const many = discardPlan([tracked('a', true), tracked('b', true), tracked('c')], WT, 'b')
    expect(many.consequences.join(' ')).toContain('2 files also have staged changes')
  })

  it('untracked file and folder wording', () => {
    const file = discardPlan([untrackedFile('n.txt')], WT, 'b')
    expect(file.title).toBe('Delete untracked file?')
    expect(file.confirmLabel).toBe('Delete file')
    expect(file.consequences).toEqual(['The untracked file is deleted from disk.'])
    const dir = discardPlan([untrackedDir('pkg/')], WT, 'b')
    expect(dir.title).toBe('Delete untracked folder?')
    expect(dir.consequences).toEqual(['The untracked folder and everything in it is deleted from disk.'])
    const mixed = discardPlan([tracked('a'), untrackedDir('pkg/')], WT, 'b')
    expect(mixed.consequences).toHaveLength(2)
  })

  it('lists up to PLAN_LIST_MAX paths then "and N more", with the full count in the title', () => {
    const items = Array.from({ length: 25 }, (_, i) => tracked(`f${i}`))
    const p = discardPlan(items, WT, 'b')
    expect(PLAN_LIST_MAX).toBe(10)
    expect(p.listed).toHaveLength(10)
    expect(p.more).toBe(15)
    expect(p.paths).toHaveLength(25)
    expect(p.title).toContain('25 files')
  })
})

describe('labels', () => {
  it('every control label names the worktree and branch', () => {
    expect(controlLabel('stage', '3 files', WT, 'feat/x')).toBe(
      'Stage 3 files in …/code/app-wt (feat/x)',
    )
    expect(controlLabel('discard', 'a.ts', WT, 'main')).toContain('app-wt (main)')
    expect(controlLabel('stage', 'a.ts', null, 'main')).toContain('unavailable')
  })

  it('failure prefixes say what was attempted', () => {
    expect(failurePrefix('stage', { paths: ['a', 'b', 'c'] }, WT)).toBe(
      `Could not stage 3 files in ${WT}:`,
    )
    expect(failurePrefix('stage', { all: true }, WT)).toBe(`Could not stage all changes in ${WT}:`)
    expect(failurePrefix('unstage', { all: true }, WT)).toBe(
      `Could not unstage all staged files in ${WT}:`,
    )
    expect(failurePrefix('discard', { paths: ['a'] }, WT)).toBe(
      `Could not discard changes to 1 file in ${WT}:`,
    )
    expect(failurePrefix('delete', { paths: ['a'] }, WT)).toBe(`Could not delete 1 item in ${WT}:`)
  })

  it('describeError keeps an ApiError code and message', () => {
    const e = Object.assign(new Error('fatal: Unable to create index.lock'), { code: 'conflict' })
    expect(describeError(e)).toEqual({ code: 'conflict', message: 'fatal: Unable to create index.lock' })
    expect(describeError('boom')).toEqual({ code: 'error', message: 'boom' })
  })
})

describe('alertText', () => {
  it('shows git verbatim, but a vanished path quietly', () => {
    const base = { prefix: 'Could not stage 1 file in /w:', message: 'fatal: x' }
    expect(alertText({ ...base, code: 'conflict' })).toEqual(base)
    const quiet = alertText({ ...base, code: 'not_found' })
    expect(quiet.prefix).toBe(base.prefix)
    expect(quiet.message).toContain('no longer in the list')
  })
})

describe('the confirm gate (destructive_ops_without_confirm = 0)', () => {
  it('confirm -> false never calls api.discard (tracked, untracked, selection, folder)', async () => {
    const { api, confirm, actions } = harness(false)
    const cases: DiscardItem[][] = [
      [tracked('a.ts')],
      [untrackedFile('n.txt')],
      [tracked('a'), tracked('b'), tracked('c')],
      [untrackedDir('pkg/')],
      [tracked('src/x.ts'), tracked('src/y.ts')],
    ]
    for (const items of cases) {
      const out = await actions.discard(ctx, items)
      expect(out).toEqual({ ok: false, reason: 'cancelled' })
    }
    expect(confirm).toHaveBeenCalledTimes(cases.length)
    expect(api.discard).not.toHaveBeenCalled()
    expect(api.stage).not.toHaveBeenCalled()
    expect(api.unstage).not.toHaveBeenCalled()
  })

  it('confirm -> true calls api.discard once with exactly the planned paths and the worktree', async () => {
    const { api, confirm, actions } = harness(true)
    const out = await actions.discard({ ...ctx, repo: 'sub' }, [tracked('a'), tracked('b'), tracked('a')])
    expect(out).toEqual({ ok: true, view })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0].paths).toEqual(['a', 'b'])
    expect(api.discard).toHaveBeenCalledTimes(1)
    expect(api.discard).toHaveBeenCalledWith({ worktree: WT, repo: 'sub', paths: ['a', 'b'], confirm: true })
  })

  it('does not call the api until the confirm settles', async () => {
    let release: (v: boolean) => void = () => {}
    const { api, actions } = harness(() => new Promise<boolean>((r) => (release = r)))
    const p = actions.discard(ctx, [untrackedDir('pkg/')])
    await Promise.resolve()
    expect(api.discard).not.toHaveBeenCalled()
    release(true)
    await p
    expect(api.discard).toHaveBeenCalledWith({ worktree: WT, paths: ['pkg/'], confirm: true })
  })

  it('stage and unstage never ask, and send one request for all', async () => {
    const { api, confirm, actions } = harness(false)
    await actions.stage(ctx, { paths: ['a', 'b'] })
    await actions.stage(ctx, { all: true })
    await actions.unstage(ctx, { all: true })
    await actions.unstage(ctx, { paths: ['c'] })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.stage).toHaveBeenNthCalledWith(1, { worktree: WT, paths: ['a', 'b'] })
    expect(api.stage).toHaveBeenNthCalledWith(2, { worktree: WT, all: true })
    expect(api.unstage).toHaveBeenNthCalledWith(1, { worktree: WT, all: true })
    expect(api.unstage).toHaveBeenNthCalledWith(2, { worktree: WT, paths: ['c'] })
    expect(api.discard).not.toHaveBeenCalled()
  })

  it('sends nothing without an explicit worktree path, or with nothing to act on', async () => {
    const { api, confirm, actions } = harness(true)
    const none = { worktree: null, branch: 'b' }
    expect(await actions.stage(none, { all: true })).toEqual({ ok: false, reason: 'no-worktree' })
    expect(await actions.unstage(none, { paths: ['a'] })).toEqual({ ok: false, reason: 'no-worktree' })
    expect(await actions.discard(none, [tracked('a')])).toEqual({ ok: false, reason: 'no-worktree' })
    expect(await actions.stage(ctx, { paths: [] })).toEqual({ ok: false, reason: 'empty' })
    expect(await actions.discard(ctx, [])).toEqual({ ok: false, reason: 'empty' })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.stage).not.toHaveBeenCalled()
    expect(api.unstage).not.toHaveBeenCalled()
    expect(api.discard).not.toHaveBeenCalled()
  })

  it('turns a failure into the server message with a prefix, and never retries', async () => {
    const { api, actions } = harness(true)
    const err = Object.assign(new Error("fatal: Unable to create '/r/.git/index.lock': File exists."), {
      code: 'conflict',
    })
    vi.mocked(api.stage).mockRejectedValueOnce(err)
    const out = await actions.stage(ctx, { paths: ['a', 'b', 'c'] })
    expect(out).toEqual({
      ok: false,
      reason: 'error',
      code: 'conflict',
      message: "fatal: Unable to create '/r/.git/index.lock': File exists.",
      prefix: `Could not stage 3 files in ${WT}:`,
    })
    expect(api.stage).toHaveBeenCalledTimes(1)
  })
})

describe('hunk and line writes', () => {
  const target = { path: 'src/a.ts', digest: 'd1', hunks: [{ index: 1 }] }
  const lost = ['-old', '+new']

  it('discardHunks: a false answer never reaches the api', async () => {
    const { api, confirm, actions } = harness(false)
    expect(await actions.discardHunks(ctx, target, lost)).toEqual({ ok: false, reason: 'cancelled' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.discardHunks).not.toHaveBeenCalled()
  })

  it('discardHunks: true sends once with exactly the planned body, after showing the lines', async () => {
    const { api, confirm, actions } = harness(true)
    const picks = { ...target, hunks: [{ index: 0, lines: [1, 2] }] }
    const out = await actions.discardHunks({ ...ctx, repo: 'sub' }, picks, lost)
    expect(out).toEqual({ ok: true, view })
    expect(confirm.mock.calls[0][0].listed).toEqual(lost)
    expect(api.discardHunks).toHaveBeenCalledTimes(1)
    expect(api.discardHunks).toHaveBeenCalledWith({
      worktree: WT,
      repo: 'sub',
      path: 'src/a.ts',
      digest: 'd1',
      hunks: [{ index: 0, lines: [1, 2] }],
      confirm: true,
    })
  })

  it('stage and unstage never ask', async () => {
    const { api, confirm, actions } = harness(false)
    await actions.stageHunks(ctx, target)
    await actions.unstageHunks(ctx, target)
    expect(confirm).not.toHaveBeenCalled()
    const body = { worktree: WT, path: 'src/a.ts', digest: 'd1', hunks: [{ index: 1 }] }
    expect(api.stageHunks).toHaveBeenCalledWith(body)
    expect(api.unstageHunks).toHaveBeenCalledWith(body)
    expect(api.discardHunks).not.toHaveBeenCalled()
  })

  it('sends nothing without a worktree or without hunks', async () => {
    const { api, confirm, actions } = harness(true)
    const none = { worktree: null, branch: 'b' }
    expect(await actions.stageHunks(none, target)).toEqual({ ok: false, reason: 'no-worktree' })
    expect(await actions.unstageHunks(none, target)).toEqual({ ok: false, reason: 'no-worktree' })
    expect(await actions.discardHunks(none, target, lost)).toEqual({ ok: false, reason: 'no-worktree' })
    expect(await actions.stageHunks(ctx, { ...target, hunks: [] })).toEqual({ ok: false, reason: 'empty' })
    expect(await actions.discardHunks(ctx, { ...target, hunks: [] }, lost)).toEqual({
      ok: false,
      reason: 'empty',
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.stageHunks).not.toHaveBeenCalled()
    expect(api.unstageHunks).not.toHaveBeenCalled()
    expect(api.discardHunks).not.toHaveBeenCalled()
  })

  it('a failure keeps the server message and names what was attempted; no retry', async () => {
    const { api, actions } = harness(true)
    const msg = 'The diff changed since it was shown. It was reloaded; nothing was applied.'
    vi.mocked(api.stageHunks).mockRejectedValueOnce(Object.assign(new Error(msg), { code: 'conflict' }))
    const out = await actions.stageHunks(ctx, target)
    expect(out).toEqual({
      ok: false,
      reason: 'error',
      code: 'conflict',
      message: msg,
      prefix: `Could not stage hunk 2 of src/a.ts in ${WT}:`,
    })
    expect(api.stageHunks).toHaveBeenCalledTimes(1)
  })

  it('the dialog says what is lost and caps the list at 200', () => {
    const many = Array.from({ length: 250 }, (_, i) => `+l${i}`)
    const p = discardHunkPlan('src/a.ts', many, WT, 'feat/x')
    expect(p.title).toBe('Discard this hunk?')
    expect(p.confirmLabel).toBe('Discard hunk')
    expect(p.consequences).toEqual([
      'The added lines are removed from the working file and the removed lines are restored. Staged changes are kept.',
    ])
    expect(p.irreversible).toBe('This cannot be undone.')
    expect(p.listed).toHaveLength(200)
    expect(p.more).toBe(50)
    expect(p.mono).toBe(true)
    expect(p.worktree).toBe(WT)
    expect(p.branch).toBe('feat/x')
  })

  it('failure prefixes and labels', () => {
    expect(hunkFailurePrefix('discard', 'a.ts', [{ index: 0, lines: [1, 2, 3] }], WT)).toBe(
      `Could not discard 3 selected lines of a.ts in ${WT}:`,
    )
    expect(controlLabel('stage', 'hunk 2 of src/a.ts', WT, 'feat/x')).toBe(
      'Stage hunk 2 of src/a.ts in …/code/app-wt (feat/x)',
    )
  })
})

describe('commit and amend', () => {
  const plan = { title: 'Amend a published commit?' } as DiscardPlan
  const HEAD = 'h'.repeat(40)

  it('a plain commit never asks and sends the message once', async () => {
    const { api, confirm, actions } = harness(false)
    const out = await actions.commit({ ...ctx, repo: 'sub' }, { message: 'msg', stagedDigest: 'd1', amend: false, published: false, merge: false })
    expect(out).toEqual({ ok: true, result: commitResult })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.commit).toHaveBeenCalledTimes(1)
    expect(api.commit).toHaveBeenCalledWith({ worktree: WT, repo: 'sub', message: 'msg', staged_digest: 'd1' })
  })

  it('an unpublished amend never asks and sends expected_head', async () => {
    const { api, confirm, actions } = harness(false)
    await actions.commit(ctx, { message: 'm', stagedDigest: 'd1', amend: true, expectedHead: HEAD, published: false, merge: false })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.commit).toHaveBeenCalledWith({
      worktree: WT,
      message: 'm',
      staged_digest: 'd1',
      amend: true,
      expected_head: HEAD,
    })
  })

  it('a published amend: false never reaches the api', async () => {
    const { api, confirm, actions } = harness(false)
    const out = await actions.commit(ctx, { message: 'm', stagedDigest: 'd1', amend: true, expectedHead: HEAD, published: true, merge: false, plan })
    expect(out).toEqual({ ok: false, reason: 'cancelled' })
    expect(confirm).toHaveBeenCalledWith(plan)
    expect(api.commit).not.toHaveBeenCalled()
  })

  it('a published amend: true sends once with allow_published, after the answer', async () => {
    let release: (v: boolean) => void = () => {}
    const { api, confirm, actions } = harness(() => new Promise<boolean>((r) => (release = r)))
    const p = actions.commit(ctx, { message: 'm', stagedDigest: 'd1', amend: true, expectedHead: HEAD, published: true, merge: false, plan })
    await Promise.resolve()
    expect(api.commit).not.toHaveBeenCalled()
    release(true)
    expect(await p).toEqual({ ok: true, result: commitResult })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.commit).toHaveBeenCalledTimes(1)
    expect(api.commit).toHaveBeenCalledWith({
      worktree: WT,
      message: 'm',
      staged_digest: 'd1',
      amend: true,
      expected_head: HEAD,
      allow_published: true,
    })
  })

  it('a merge amend asks too: false sends nothing, true sends allow_merge only', async () => {
    const req = { message: 'm', stagedDigest: 'd1', amend: true, expectedHead: HEAD, published: false, merge: true, plan }
    const no = harness(false)
    expect(await no.actions.commit(ctx, req)).toEqual({ ok: false, reason: 'cancelled' })
    expect(no.confirm).toHaveBeenCalledWith(plan)
    expect(no.api.commit).not.toHaveBeenCalled()
    // No plan to show: nothing is sent either.
    expect(await no.actions.commit(ctx, { ...req, plan: undefined })).toEqual({ ok: false, reason: 'cancelled' })
    const yes = harness(true)
    await yes.actions.commit(ctx, req)
    expect(yes.confirm).toHaveBeenCalledTimes(1)
    expect(yes.api.commit).toHaveBeenCalledWith({
      worktree: WT,
      message: 'm',
      staged_digest: 'd1',
      amend: true,
      expected_head: HEAD,
      allow_merge: true,
    })
    // Published and a merge: one question, both flags.
    const both = harness(true)
    await both.actions.commit(ctx, { ...req, published: true })
    expect(both.confirm).toHaveBeenCalledTimes(1)
    expect(both.api.commit).toHaveBeenCalledWith({
      worktree: WT,
      message: 'm',
      staged_digest: 'd1',
      amend: true,
      expected_head: HEAD,
      allow_published: true,
      allow_merge: true,
    })
  })

  it('sends nothing without a worktree, or an amend without its expected head', async () => {
    const { api, confirm, actions } = harness(true)
    const none = { worktree: null, branch: 'b' }
    expect(await actions.commit(none, { message: 'm', stagedDigest: 'd1', amend: false, published: false, merge: false })).toEqual({
      ok: false,
      reason: 'no-worktree',
    })
    expect(await actions.commit(ctx, { message: 'm', stagedDigest: 'd1', amend: true, published: false, merge: false })).toEqual({
      ok: false,
      reason: 'empty',
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.commit).not.toHaveBeenCalled()
  })

  it('a failure keeps git message verbatim under a prefix naming branch and worktree; no retry', async () => {
    const { api, actions } = harness(true)
    const msg = 'hook failed\nline 2'
    vi.mocked(api.commit).mockRejectedValueOnce(Object.assign(new Error(msg), { code: 'conflict' }))
    const out = await actions.commit(ctx, { message: 'm', stagedDigest: 'd1', amend: false, published: false, merge: false })
    expect(out).toEqual({
      ok: false,
      reason: 'error',
      code: 'conflict',
      message: msg,
      prefix: `Could not commit to feat/x in ${WT}:`,
    })
    expect(api.commit).toHaveBeenCalledTimes(1)
    expect(commitFailurePrefix(true, 'main', WT)).toBe(`Could not amend the last commit on main in ${WT}:`)
  })
})

describe('the discard endpoint has one caller', () => {
  const root = join(__dirname)
  const sources: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) sources.push(p)
    }
  }
  walk(root)
  const withText = (needle: string) =>
    sources
      .filter((p) => readFileSync(p, 'utf8').includes(needle))
      .map((p) => p.slice(root.length + 1))
      .sort()

  it('discardProjectGit is defined in api.ts and used only by gitActions.ts', () => {
    expect(withText('discardProjectGit')).toEqual(['api.ts', 'gitActions.ts'])
  })

  it('the /git/discard route string lives only in api.ts', () => {
    expect(withText('/git/discard')).toEqual(['api.ts'])
  })

  it('discardProjectGitHunks and its route string are just as confined', () => {
    expect(withText('discardProjectGitHunks')).toEqual(['api.ts', 'gitActions.ts'])
    expect(withText('/git/discard-hunks')).toEqual(['api.ts'])
    const src = readFileSync(join(root, 'gitActions.ts'), 'utf8')
    expect(src.match(/api\.discardHunks\(/g)).toHaveLength(1)
    expect(src.indexOf('await confirm(plan)', src.indexOf('async discardHunks'))).toBeLessThan(
      src.indexOf('api.discardHunks('),
    )
  })

  it('api.discard( is called once, inside gitActions.ts, after the confirm', () => {
    const src = readFileSync(join(root, 'gitActions.ts'), 'utf8')
    expect(src.match(/api\.discard\(/g)).toHaveLength(1)
    expect(src.indexOf('await confirm(plan)')).toBeGreaterThan(0)
    expect(src.indexOf('await confirm(plan)')).toBeLessThan(src.indexOf('api.discard('))
  })

  it('commitProjectGit is defined in api.ts and used only by gitActions.ts', () => {
    expect(withText('commitProjectGit')).toEqual(['api.ts', 'gitActions.ts'])
    const src = readFileSync(join(root, 'gitActions.ts'), 'utf8')
    expect(src.match(/api\.commit\(/g)).toHaveLength(1)
    expect(src.indexOf('await confirm(req.plan)')).toBeLessThan(src.indexOf('api.commit('))
  })

  it('no other module calls api.discard(', () => {
    const offenders = sources
      .filter((p) => !p.endsWith('gitActions.ts'))
      .filter((p) => /\bapi\.discard\(/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(root.length + 1))
    expect(offenders).toEqual([])
  })
})

// ---- branch and stash writes (naru task 2741) ----

import {
  UNMERGED_LIST_MAX,
  createGitRefActions,
  deleteBranchPlan,
  dropPlan,
  forceDeletePlan,
  popPlan,
  switchPlan,
} from './gitActions'
import type { ConfirmPlan, GitRefApi } from './gitActions'
import type { GitBranchDeleteResult } from './types/GitBranchDeleteResult'
import type { GitCommit } from './types/GitCommit'
import type { GitRefResult } from './types/GitRefResult'
import type { GitStash } from './types/GitStash'

const refResult = (notice: string | null = null): GitRefResult => ({ view, notice })
const commit = (n: number): GitCommit =>
  ({ hash: `${n}`.padStart(40, 'a'), short_hash: `abc${n}`.padEnd(7, '0'), subject: `subject ${n}` }) as GitCommit
const TIP = 'b'.repeat(40)
const merged: GitBranchDeleteResult = {
  deleted: true,
  refusal: null,
  hash: TIP,
  unmerged: [],
  unmerged_more: false,
  view,
}
const refused = (n: number, more = false): GitBranchDeleteResult => ({
  deleted: false,
  refusal: "error: the branch 'x' is not fully merged.",
  hash: TIP,
  unmerged: Array.from({ length: n }, (_, i) => commit(i + 1)),
  unmerged_more: more,
  view,
})
const stash: GitStash = {
  index: 2,
  name: 'stash@{2}',
  hash: 'c'.repeat(40),
  message: 'wip <b>x</b>',
  branch: 'main',
  date: '2026-01-01T00:00:00Z',
}
const plain = { isMain: false, linked: 2, detached: false }

function refHarness(answers: boolean | boolean[] = true) {
  const queue = Array.isArray(answers) ? [...answers] : null
  const api: GitRefApi = {
    createBranch: vi.fn(async () => refResult()),
    switchBranch: vi.fn(async () => refResult()),
    renameBranch: vi.fn(async () => refResult()),
    deleteBranch: vi.fn(async () => merged),
    pushStash: vi.fn(async () => refResult()),
    applyStash: vi.fn(async () => refResult()),
    popStash: vi.fn(async () => refResult()),
    dropStash: vi.fn(async () => refResult()),
    readDirty: vi.fn(async () => false as boolean | null),
  }
  const confirm = vi.fn(async (p: ConfirmPlan) => {
    void p
    return queue === null ? (answers as boolean) : (queue.shift() ?? false)
  })
  return { api, confirm, actions: createGitRefActions({ api, confirm }) }
}
const rctx = { worktree: WT, branch: 'feat/x' }

describe('delete branch: always asks, twice before a force', () => {
  it('a false answer never reaches the api', async () => {
    const { api, confirm, actions } = refHarness(false)
    const out = await actions.deleteBranch(rctx, 'old', TIP)
    expect(out).toEqual({ ok: false, reason: 'cancelled' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.deleteBranch).not.toHaveBeenCalled()
  })

  it('a merged branch: one confirm, one call, no force', async () => {
    const { api, confirm, actions } = refHarness()
    const out = await actions.deleteBranch({ ...rctx, repo: 'sub' }, 'old', TIP)
    expect(out).toEqual({ ok: true, notice: null, deleted: true })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.deleteBranch).toHaveBeenCalledTimes(1)
    expect(api.deleteBranch).toHaveBeenCalledWith({ worktree: WT, repo: 'sub', name: 'old' })
  })

  it('an unmerged refusal asks a SECOND, distinct confirm before force', async () => {
    const { api, confirm, actions } = refHarness()
    vi.mocked(api.deleteBranch)
      .mockResolvedValueOnce(refused(3))
      .mockResolvedValueOnce(merged)
    const out = await actions.deleteBranch(rctx, 'old', TIP)
    expect(out).toEqual({ ok: true, notice: null, deleted: true })
    expect(confirm).toHaveBeenCalledTimes(2)
    const [first, second] = confirm.mock.calls.map((c) => c[0])
    expect(first.title).not.toBe(second.title)
    expect(second.listed).toEqual(['abc1000 subject 1', 'abc2000 subject 2', 'abc3000 subject 3'])
    expect(api.deleteBranch).toHaveBeenNthCalledWith(1, { worktree: WT, name: 'old' })
    expect(api.deleteBranch).toHaveBeenNthCalledWith(2, {
      worktree: WT,
      name: 'old',
      force: true,
      expected_hash: TIP,
    })
  })

  it('a force reply with deleted: false is an error, not ok', async () => {
    const { api, actions } = refHarness()
    vi.mocked(api.deleteBranch)
      .mockResolvedValueOnce(refused(1))
      .mockResolvedValueOnce({ ...refused(1), refusal: 'still there' })
    const out = await actions.deleteBranch(rctx, 'old', TIP)
    expect(out).toMatchObject({ ok: false, reason: 'error', message: 'old was not deleted.\nstill there' })
  })

  it('a changed worktree selection before the second confirm cancels it', async () => {
    const { api, confirm, actions } = refHarness()
    vi.mocked(api.deleteBranch).mockResolvedValueOnce(refused(1))
    const out = await actions.deleteBranch(rctx, 'old', TIP, () => false)
    expect(out).toEqual({ ok: false, reason: 'cancelled' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.deleteBranch).toHaveBeenCalledTimes(1)
  })

  it('declining the second confirm sends no force', async () => {
    const { api, confirm, actions } = refHarness([true, false])
    vi.mocked(api.deleteBranch).mockResolvedValueOnce(refused(1))
    const out = await actions.deleteBranch(rctx, 'old', TIP)
    expect(out).toEqual({ ok: false, reason: 'cancelled' })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(api.deleteBranch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.deleteBranch).mock.calls[0][0]).not.toHaveProperty('force')
  })

  it('the second dialog states the count, even 0, and "and more" past the cap', () => {
    const wt = { worktree: WT, branch: 'main' }
    const zero = forceDeletePlan('x', refused(0), wt)
    expect(zero.consequences.join(' ')).toMatch(/0 commits become unreachable/)
    expect(zero.listed).toEqual([])
    const one = forceDeletePlan('x', refused(1), wt)
    expect(one.consequences.join(' ')).toMatch(/1 commit becomes unreachable/)
    const many = forceDeletePlan('x', refused(UNMERGED_LIST_MAX, true), wt)
    expect(many.listed).toHaveLength(UNMERGED_LIST_MAX)
    expect(many.more).toBeGreaterThan(0)
    expect(many.moreLabel).toBe('and more')
    expect(many.consequences.join(' ')).toMatch(/50 or more commits/)
    expect(many.worktree).toBe(WT)
    expect(many.title).toContain('x')
  })

  it('every dialog names the branch and the worktree path and branch', () => {
    const wt = { worktree: WT, branch: 'main' }
    for (const p of [deleteBranchPlan('gone', TIP, wt), forceDeletePlan('gone', refused(1), wt)]) {
      expect(p.title).toContain('gone')
      expect(p.worktree).toBe(WT)
      expect(p.branch).toBe('main')
    }
  })

  it('an error on the first call is reported with git text, no second confirm', async () => {
    const { api, confirm, actions } = refHarness()
    vi.mocked(api.deleteBranch).mockRejectedValueOnce(
      Object.assign(new Error('fatal: nope'), { code: 'conflict' }),
    )
    const out = await actions.deleteBranch(rctx, 'old', TIP)
    expect(out).toEqual({
      ok: false,
      reason: 'error',
      code: 'conflict',
      message: 'fatal: nope',
      prefix: `Could not delete branch old in ${WT}:`,
    })
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('no worktree sends nothing and asks nothing', async () => {
    const { api, confirm, actions } = refHarness()
    expect(await actions.deleteBranch({ worktree: null, branch: 'x' }, 'old', TIP)).toEqual({
      ok: false,
      reason: 'no-worktree',
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.deleteBranch).not.toHaveBeenCalled()
  })
})

describe('stash drop and pop', () => {
  it('drop always confirms; false sends nothing', async () => {
    const { api, confirm, actions } = refHarness(false)
    expect(await actions.dropStash(rctx, { stash })).toEqual({
      ok: false,
      reason: 'cancelled',
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.dropStash).not.toHaveBeenCalled()
  })

  it('drop sends worktree, index and hash after the confirm', async () => {
    const { api, confirm, actions } = refHarness()
    const out = await actions.dropStash({ ...rctx, repo: 'sub' }, { stash })
    expect(out.ok).toBe(true)
    expect(confirm.mock.calls[0][0].title).toContain('stash@{2}')
    expect(confirm.mock.calls[0][0].worktree).toBe(WT)
    expect(api.dropStash).toHaveBeenCalledWith({
      worktree: WT,
      repo: 'sub',
      index: 2,
      hash: stash.hash,
      confirm: true,
    })
  })

  it('pop reads the worktree fresh: dirty or unknown asks, clean does not', async () => {
    for (const fresh of [true, null] as const) {
      const { api, confirm, actions } = refHarness(false)
      vi.mocked(api.readDirty).mockResolvedValueOnce(fresh)
      await actions.popStash(rctx, { stash })
      expect(api.readDirty).toHaveBeenCalledWith(WT, undefined)
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(api.popStash).not.toHaveBeenCalled()
    }
    const failed = refHarness(false)
    vi.mocked(failed.api.readDirty).mockRejectedValueOnce(new Error('offline'))
    await failed.actions.popStash(rctx, { stash })
    expect(failed.confirm).toHaveBeenCalledTimes(1)
    expect(failed.api.popStash).not.toHaveBeenCalled()
    const clean = refHarness(false)
    const out = await clean.actions.popStash(rctx, { stash })
    expect(out.ok).toBe(true)
    expect(clean.confirm).not.toHaveBeenCalled()
    expect(clean.api.popStash).toHaveBeenCalledWith({ worktree: WT, index: 2, hash: stash.hash })
  })

  it('pop and apply onto a dirty tree send confirm: true only after a yes', async () => {
    for (const verb of ['popStash', 'applyStash'] as const) {
      const no = refHarness(false)
      vi.mocked(no.api.readDirty).mockResolvedValueOnce(true)
      expect(await no.actions[verb](rctx, { stash })).toEqual({ ok: false, reason: 'cancelled' })
      expect(no.confirm).toHaveBeenCalledTimes(1)
      expect(no.api[verb]).not.toHaveBeenCalled()
      const yes = refHarness()
      vi.mocked(yes.api.readDirty).mockResolvedValueOnce(true)
      expect((await yes.actions[verb](rctx, { stash })).ok).toBe(true)
      expect(yes.confirm.mock.calls[0][0].title).toBe(verb === 'popStash' ? 'Pop stash@{2}?' : 'Apply stash@{2}?')
      expect(yes.api[verb]).toHaveBeenCalledWith({ worktree: WT, index: 2, hash: stash.hash, confirm: true })
    }
  })

  it('apply onto a clean tree never asks; a stale list (409) is the error text', async () => {
    const { api, confirm, actions } = refHarness(false)
    vi.mocked(api.applyStash).mockRejectedValueOnce(
      Object.assign(new Error('The stash list changed since it was shown.'), { code: 'conflict' }),
    )
    const out = await actions.applyStash(rctx, { stash })
    expect(confirm).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      ok: false,
      reason: 'error',
      message: 'The stash list changed since it was shown.',
      prefix: `Could not apply stash@{2} in ${WT}:`,
    })
  })

  it('the dialog texts are plain strings, never markup', () => {
    const p = dropPlan(stash, { worktree: WT, branch: 'main' })
    expect(p.listed[0]).toBe('stash@{2}: wip <b>x</b>')
    expect(popPlan(stash, null, { worktree: WT, branch: 'main' }).consequences[0]).toMatch(/not known/)
  })
})

describe('switch', () => {
  it('a plain switch never asks and sends no stash', async () => {
    const { api, confirm, actions } = refHarness(false)
    const out = await actions.switchBranch(rctx, 'dev', plain)
    expect(out.ok).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(api.switchBranch).toHaveBeenCalledWith({ worktree: WT, name: 'dev' })
  })

  it('the main checkout asks, with the linked count, path and branch; false sends nothing', async () => {
    const { api, confirm, actions } = refHarness(false)
    const out = await actions.switchBranch(rctx, 'dev', { isMain: true, linked: 3, detached: false })
    expect(out).toEqual({ ok: false, reason: 'cancelled' })
    expect(api.switchBranch).not.toHaveBeenCalled()
    const p = confirm.mock.calls[0][0]
    expect(p.worktree).toBe(WT)
    expect(p.branch).toBe('feat/x')
    expect(p.title).toContain('dev')
    expect(p.consequences.join(' ')).toMatch(/main checkout/)
    expect(p.consequences.join(' ')).toMatch(/3 linked worktrees/)
    expect(p.consequences.join(' ')).toMatch(/Naru may be served/)
  })

  it('a detached HEAD asks and says the commits are only in the reflog', async () => {
    const { api, confirm, actions } = refHarness(true)
    await actions.switchBranch({ worktree: WT, branch: 'abc1234' }, 'dev', { ...plain, detached: true })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0].consequences.join(' ')).toMatch(/reflog/)
    expect(confirm.mock.calls[0][0].consequences.join(' ')).toMatch(/Create a branch/)
    expect(api.switchBranch).toHaveBeenCalledWith({ worktree: WT, name: 'dev' })
  })

  it('stash is only ever sent by stashAndSwitch', async () => {
    const { api, actions } = refHarness()
    await actions.switchBranch(rctx, 'dev', plain)
    await actions.stashAndSwitch({ ...rctx, repo: 'sub' }, 'dev', plain)
    expect(api.switchBranch).toHaveBeenNthCalledWith(1, { worktree: WT, name: 'dev' })
    expect(api.switchBranch).toHaveBeenNthCalledWith(2, {
      worktree: WT,
      repo: 'sub',
      name: 'dev',
      stash: true,
    })
  })

  it('stash and switch in the main checkout asks too, and mentions the stash', async () => {
    const { api, confirm, actions } = refHarness(false)
    await actions.stashAndSwitch(rctx, 'dev', { isMain: true, linked: 1, detached: false })
    expect(api.switchBranch).not.toHaveBeenCalled()
    expect(confirm.mock.calls[0][0].consequences.join(' ')).toMatch(/stashed first/)
    expect(switchPlan('x', plain, false, { worktree: WT, branch: 'b' })).toBeNull()
  })

  it('git refusing a switch is the error text, tree untouched', async () => {
    const { api, actions } = refHarness()
    vi.mocked(api.switchBranch).mockRejectedValueOnce(
      Object.assign(new Error('error: Your local changes would be overwritten'), { code: 'conflict' }),
    )
    expect(await actions.switchBranch(rctx, 'dev', plain)).toMatchObject({
      ok: false,
      reason: 'error',
      message: 'error: Your local changes would be overwritten',
      prefix: `Could not switch to dev in ${WT}:`,
    })
  })
})

describe('create, rename, stash push: exact bodies', () => {
  it('create sends only what is set', async () => {
    const { api, confirm, actions } = refHarness()
    await actions.createBranch(rctx, { name: 'a', info: plain })
    await actions.createBranch(
      { ...rctx, repo: 'sub' },
      { name: 'b', fromCommit: 'd'.repeat(40), switch: true, info: plain },
    )
    await actions.createBranch(rctx, { name: 'c', fromRemote: 'origin/x', switch: false, info: plain })
    expect(vi.mocked(api.createBranch).mock.calls.map((c) => c[0])).toEqual([
      { worktree: WT, name: 'a' },
      { worktree: WT, repo: 'sub', name: 'b', from_commit: 'd'.repeat(40), switch: true },
      { worktree: WT, name: 'c', from_remote: 'origin/x' },
    ])
    expect(confirm).not.toHaveBeenCalled()
  })

  it('create with switch in the main checkout asks first', async () => {
    const { api, confirm, actions } = refHarness(false)
    const out = await actions.createBranch(rctx, {
      name: 'n',
      switch: true,
      info: { isMain: true, linked: 2, detached: false },
    })
    expect(out).toEqual({ ok: false, reason: 'cancelled' })
    expect(api.createBranch).not.toHaveBeenCalled()
    expect(confirm.mock.calls[0][0].worktree).toBe(WT)
    await actions.createBranch(rctx, { name: 'n', info: { isMain: true, linked: 2, detached: false } })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.createBranch).toHaveBeenCalledTimes(1)
  })

  it('rename, stash push bodies and the empty-stash notice', async () => {
    const { api, actions } = refHarness()
    vi.mocked(api.pushStash).mockResolvedValueOnce(refResult('No local changes to stash.'))
    await actions.renameBranch(rctx, 'old', 'new/name')
    expect(api.renameBranch).toHaveBeenCalledWith({ worktree: WT, name: 'old', new_name: 'new/name' })
    const out = await actions.pushStash(rctx, '  my work ', true)
    expect(out).toEqual({ ok: true, notice: 'No local changes to stash.' })
    expect(api.pushStash).toHaveBeenCalledWith({ worktree: WT, message: 'my work', include_untracked: true })
    await actions.pushStash(rctx, '   ', false)
    expect(vi.mocked(api.pushStash).mock.calls[1][0]).toEqual({ worktree: WT })
  })

  it('nothing is sent without a worktree path', async () => {
    const { api, actions } = refHarness()
    const none = { worktree: null, branch: 'x' }
    expect((await actions.createBranch(none, { name: 'a', info: plain })).ok).toBe(false)
    expect((await actions.switchBranch(none, 'a', plain)).ok).toBe(false)
    expect((await actions.renameBranch(none, 'a', 'b')).ok).toBe(false)
    expect((await actions.pushStash(none, '', false)).ok).toBe(false)
    expect((await actions.applyStash(none, { stash })).ok).toBe(false)
    expect((await actions.dropStash(none, { stash })).ok).toBe(false)
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled()
  })
})

describe('the branch and stash endpoints are confined', () => {
  const root = join(__dirname)
  const sources: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) sources.push(p)
    }
  }
  walk(root)
  const withText = (needle: string) =>
    sources
      .filter((p) => readFileSync(p, 'utf8').includes(needle))
      .map((p) => p.slice(root.length + 1))
      .sort()
  const gate = readFileSync(join(root, 'gitActions.ts'), 'utf8')

  it('deleteProjectGitBranch and dropProjectGitStash: api.ts and gitActions.ts only', () => {
    expect(withText('deleteProjectGitBranch')).toEqual(['api.ts', 'gitActions.ts'])
    expect(withText('dropProjectGitStash')).toEqual(['api.ts', 'gitActions.ts'])
    expect(withText('popProjectGitStash')).toEqual(['api.ts', 'gitActions.ts'])
    expect(withText('switchProjectGitBranch')).toEqual(['api.ts', 'gitActions.ts'])
  })

  it('the route strings live only in api.ts', () => {
    // Generated types/ files quote the route in a doc comment; they call nothing.
    const code = (needle: string) => withText(needle).filter((p) => !p.startsWith('types/'))
    for (const r of ['/git/branch-delete', '/git/stash-drop', '/git/stash-pop', '/git/branch-switch']) {
      expect(code(r)).toEqual(['api.ts'])
    }
  })

  it('projectGitRefApi is used only by gitActions.ts and useGitRefOps.ts', () => {
    expect(withText('projectGitRefApi')).toEqual(['gitActions.ts', 'useGitRefOps.ts'])
  })

  it('the force call is one site, after a second confirm of the force plan', () => {
    expect(gate.match(/force: true/g)).toHaveLength(1)
    expect(gate.match(/api\.deleteBranch\(/g)).toHaveLength(2)
    const first = gate.indexOf('await confirm(deleteBranchPlan(')
    const firstCall = gate.indexOf('api.deleteBranch(')
    const second = gate.indexOf('confirm(forceDeletePlan(')
    const forceCall = gate.indexOf('force: true')
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(firstCall)
    expect(firstCall).toBeLessThan(second)
    expect(second).toBeLessThan(forceCall)
  })

  it('api.dropStash( is called once, after its confirm; stash is sent by one method', () => {
    expect(gate.match(/api\.dropStash\(/g)).toHaveLength(1)
    expect(gate.indexOf('await confirm(dropPlan(')).toBeLessThan(gate.indexOf('api.dropStash('))
    expect(gate.match(/body\.stash = true/g)).toHaveLength(1)
  })

  it('no other module calls the delete, drop or force api', () => {
    const offenders = sources
      .filter((p) => !p.endsWith('gitActions.ts'))
      .filter((p) => /\bapi\.(deleteBranch|dropStash|popStash|switchBranch)\(/.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(root.length + 1))
    expect(offenders).toEqual([])
  })

  it('the Git ref components and hook render repo text as text nodes only', () => {
    const mine = [
      'components/GitSidePanel.tsx',
      'components/GitFormDialog.tsx',
      'components/GitConfirmDialog.tsx',
      'components/GitRefDialogs.tsx',
      'components/GitRefMessages.tsx',
      'pages/GitView.tsx',
    ]
    for (const f of mine) {
      expect(readFileSync(join(root, f), 'utf8')).not.toContain('dangerouslySetInnerHTML')
    }
  })
})
