import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PLAN_LIST_MAX,
  controlLabel,
  createGitActions,
  alertText,
  describeError,
  discardPlan,
  failurePrefix,
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

function harness(answer: boolean | (() => Promise<boolean>) = true) {
  const api: GitWriteApi = {
    stage: vi.fn(async () => view),
    unstage: vi.fn(async () => view),
    discard: vi.fn(async () => view),
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

  it('api.discard( is called once, inside gitActions.ts, after the confirm', () => {
    const src = readFileSync(join(root, 'gitActions.ts'), 'utf8')
    expect(src.match(/api\.discard\(/g)).toHaveLength(1)
    expect(src.indexOf('await confirm(plan)')).toBeGreaterThan(0)
    expect(src.indexOf('await confirm(plan)')).toBeLessThan(src.indexOf('api.discard('))
  })

  it('no other module calls api.discard(', () => {
    const offenders = sources
      .filter((p) => !p.endsWith('gitActions.ts'))
      .filter((p) => /\bapi\.discard\(/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(root.length + 1))
    expect(offenders).toEqual([])
  })
})
