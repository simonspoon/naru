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
    expect(api.discard).toHaveBeenCalledWith({ worktree: WT, repo: 'sub', paths: ['a', 'b'] })
  })

  it('does not call the api until the confirm settles', async () => {
    let release: (v: boolean) => void = () => {}
    const { api, actions } = harness(() => new Promise<boolean>((r) => (release = r)))
    const p = actions.discard(ctx, [untrackedDir('pkg/')])
    await Promise.resolve()
    expect(api.discard).not.toHaveBeenCalled()
    release(true)
    await p
    expect(api.discard).toHaveBeenCalledWith({ worktree: WT, paths: ['pkg/'] })
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
    const out = await actions.commit({ ...ctx, repo: 'sub' }, { message: 'msg', amend: false, published: false })
    expect(out).toEqual({ ok: true, result: commitResult })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.commit).toHaveBeenCalledTimes(1)
    expect(api.commit).toHaveBeenCalledWith({ worktree: WT, repo: 'sub', message: 'msg' })
  })

  it('an unpublished amend never asks and sends expected_head', async () => {
    const { api, confirm, actions } = harness(false)
    await actions.commit(ctx, { message: 'm', amend: true, expectedHead: HEAD, published: false })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.commit).toHaveBeenCalledWith({ worktree: WT, message: 'm', amend: true, expected_head: HEAD })
  })

  it('a published amend: false never reaches the api', async () => {
    const { api, confirm, actions } = harness(false)
    const out = await actions.commit(ctx, { message: 'm', amend: true, expectedHead: HEAD, published: true, plan })
    expect(out).toEqual({ ok: false, reason: 'cancelled' })
    expect(confirm).toHaveBeenCalledWith(plan)
    expect(api.commit).not.toHaveBeenCalled()
  })

  it('a published amend: true sends once with allow_published, after the answer', async () => {
    let release: (v: boolean) => void = () => {}
    const { api, confirm, actions } = harness(() => new Promise<boolean>((r) => (release = r)))
    const p = actions.commit(ctx, { message: 'm', amend: true, expectedHead: HEAD, published: true, plan })
    await Promise.resolve()
    expect(api.commit).not.toHaveBeenCalled()
    release(true)
    expect(await p).toEqual({ ok: true, result: commitResult })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.commit).toHaveBeenCalledTimes(1)
    expect(api.commit).toHaveBeenCalledWith({
      worktree: WT,
      message: 'm',
      amend: true,
      expected_head: HEAD,
      allow_published: true,
    })
  })

  it('sends nothing without a worktree, or an amend without its expected head', async () => {
    const { api, confirm, actions } = harness(true)
    const none = { worktree: null, branch: 'b' }
    expect(await actions.commit(none, { message: 'm', amend: false, published: false })).toEqual({
      ok: false,
      reason: 'no-worktree',
    })
    expect(await actions.commit(ctx, { message: 'm', amend: true, published: false })).toEqual({
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
    const out = await actions.commit(ctx, { message: 'm', amend: false, published: false })
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
