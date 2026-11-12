// The working tree's write actions (naru task 2738, docs/git-tab.md "Working
// tree view"): the texts of the confirm dialog and of the controls, and
// `createGitActions`, the ONLY way the UI reaches the discard endpoint. Every
// discard goes through `confirm(plan)` first; `api.discard` is called nowhere
// else, and `gitActions.test.ts` pins both that and the single reference to
// `discardProjectGit` and the discard route string. No React, no DOM.
import { discardProjectGit, stageProjectGit, unstageProjectGit } from './api'
import type { GitWriteBody } from './api'
import { shortFolder } from './gitPanel'
import type { BulkTarget } from './gitWorktree'
import type { GitRepoView } from './types/GitRepoView'

/** Paths the discard dialog lists before "and N more". */
export const PLAN_LIST_MAX = 10

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export type Verb = 'stage' | 'unstage' | 'discard' | 'delete'

/** What a discard is about to do to one entry. */
export type DiscardItem = {
  path: string
  untracked: boolean
  /** An untracked folder (`dir/`). */
  folder: boolean
  /** A tracked file that also has staged changes (it is in Staged too). */
  alsoStaged: boolean
}

export type DiscardPlan = {
  title: string
  /** Full path and branch of the worktree the paths are in. */
  worktree: string
  branch: string
  /** Every path that will be sent. */
  paths: string[]
  /** The first `PLAN_LIST_MAX` of them, for the dialog. */
  listed: string[]
  more: number
  consequences: string[]
  confirmLabel: string
  irreversible: string
}

/** The whole text of the destructive dialog, from what is about to be lost. */
export function discardPlan(items: DiscardItem[], worktree: string, branch: string): DiscardPlan {
  const paths = [...new Set(items.map((i) => i.path))]
  const n = paths.length
  const tracked = items.filter((i) => !i.untracked)
  const files = items.filter((i) => i.untracked && !i.folder)
  const folders = items.filter((i) => i.untracked && i.folder)
  let title: string
  let confirmLabel: string
  if (tracked.length === items.length) {
    title = `Discard changes to ${plural(n, 'file')}?`
    confirmLabel = n === 1 ? 'Discard file' : `Discard ${plural(n, 'file')}`
  } else if (files.length === items.length) {
    title = n === 1 ? 'Delete untracked file?' : `Delete ${n} untracked files?`
    confirmLabel = n === 1 ? 'Delete file' : `Delete ${plural(n, 'file')}`
  } else if (folders.length === items.length) {
    title = n === 1 ? 'Delete untracked folder?' : `Delete ${n} untracked folders?`
    confirmLabel = n === 1 ? 'Delete folder' : `Delete ${plural(n, 'folder')}`
  } else {
    title = `Discard ${plural(n, 'item')}?`
    confirmLabel = `Discard ${plural(n, 'item')}`
  }
  const consequences: string[] = []
  if (tracked.length > 0) {
    consequences.push(
      `${tracked.length === 1 ? 'The working tree copy is' : 'The working tree copies are'} reset to the staged version. Staged changes are kept.`,
    )
    const both = tracked.filter((i) => i.alsoStaged).length
    if (both > 0) {
      consequences.push(
        both === tracked.length && both === 1
          ? 'This file also has staged changes: only its unstaged edits are lost; the staged ones are kept.'
          : `${plural(both, 'file')} also ${both === 1 ? 'has' : 'have'} staged changes: only the unstaged edits are lost; the staged ones are kept.`,
      )
    }
  }
  if (files.length > 0) {
    consequences.push(
      files.length === 1
        ? 'The untracked file is deleted from disk.'
        : `${files.length} untracked files are deleted from disk.`,
    )
  }
  if (folders.length > 0) {
    consequences.push(
      folders.length === 1
        ? 'The untracked folder and everything in it is deleted from disk.'
        : `${folders.length} untracked folders and everything in them are deleted from disk.`,
    )
  }
  return {
    title,
    worktree,
    branch,
    paths,
    listed: paths.slice(0, PLAN_LIST_MAX),
    more: Math.max(0, n - PLAN_LIST_MAX),
    consequences,
    confirmLabel,
    irreversible: 'This cannot be undone.',
  }
}

/** The tooltip / aria-label of a write control: always names the worktree it
 * acts in. `subject` is what it acts on ("src/a.ts", "3 files", "all changes"). */
export function controlLabel(
  verb: Verb,
  subject: string,
  worktree: string | null,
  branch: string,
): string {
  const word = verb[0].toUpperCase() + verb.slice(1)
  if (worktree === null) return `${word} ${subject}: unavailable, the worktree path is unknown`
  return `${word} ${subject} in ${shortFolder(worktree)} (${branch})`
}

/** "Could not stage 3 files in /path/to/worktree:" */
export function failurePrefix(verb: Verb, target: BulkTarget, worktree: string): string {
  const what =
    'all' in target
      ? verb === 'stage'
        ? 'all changes'
        : 'all staged files'
      : verb === 'delete'
        ? plural(target.paths.length, 'item')
        : plural(target.paths.length, 'file')
  const doing = verb === 'discard' ? 'discard changes to' : verb
  return `Could not ${doing} ${what} in ${worktree}:`
}

// ---- the write gate ----

/** The text of the error alert: what was attempted, then git's own message
 * verbatim. A path that left the list (404) gets a quiet sentence instead. */
export function alertText(out: { prefix: string; code: string; message: string }): {
  prefix: string
  message: string
} {
  if (out.code === 'not_found') {
    return {
      prefix: out.prefix,
      message: 'Some of these files are no longer in the list. It was refreshed; nothing was changed.',
    }
  }
  return { prefix: out.prefix, message: out.message }
}

/** What the three write routes look like to the gate. */
export interface GitWriteApi {
  stage(body: GitWriteBody): Promise<GitRepoView>
  unstage(body: GitWriteBody): Promise<GitRepoView>
  discard(body: GitWriteBody): Promise<GitRepoView>
}

/** The real routes of one project. The component gets its api only from
 * `createGitActions(projectGitApi(id), …)`; this is where the discard call is
 * bound. */
export function projectGitApi(projectId: number): GitWriteApi {
  return {
    stage: (b) => stageProjectGit(projectId, b),
    unstage: (b) => unstageProjectGit(projectId, b),
    discard: (b) => discardProjectGit(projectId, b),
  }
}

/** The worktree a write acts in, as the view on screen was loaded for it.
 * `worktree: null` = unresolved: nothing is sent. */
export type WriteCtx = { worktree: string | null; branch: string; repo?: string }

export type WriteOutcome =
  | { ok: true; view: GitRepoView }
  | { ok: false; reason: 'cancelled' | 'no-worktree' | 'empty' }
  | { ok: false; reason: 'error'; code: string; message: string; prefix: string }

function bodyFor(ctx: WriteCtx & { worktree: string }, target: BulkTarget): GitWriteBody {
  const body: GitWriteBody = { worktree: ctx.worktree }
  if (ctx.repo !== undefined) body.repo = ctx.repo
  if ('all' in target) body.all = true
  else body.paths = target.paths
  return body
}

/** A thrown `ApiError` carries the server's code and message; anything else
 * is shown by its message. */
export function describeError(e: unknown): { code: string; message: string } {
  const code = (e as { code?: unknown } | null)?.code
  return {
    code: typeof code === 'string' ? code : 'error',
    message: e instanceof Error ? e.message : String(e),
  }
}

/**
 * The gate. `discard` awaits `confirm(plan)` and calls `api.discard` only when
 * it answers true; `stage` / `unstage` never ask. Nothing is sent without an
 * explicit worktree path or with nothing to act on.
 */
export function createGitActions(deps: {
  api: GitWriteApi
  confirm: (plan: DiscardPlan) => Promise<boolean>
}) {
  const { api, confirm } = deps

  async function send(
    verb: Verb,
    ctx: WriteCtx,
    target: BulkTarget,
    call: (body: GitWriteBody) => Promise<GitRepoView>,
  ): Promise<WriteOutcome> {
    if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
    try {
      return { ok: true, view: await call(bodyFor({ ...ctx, worktree: ctx.worktree }, target)) }
    } catch (e) {
      return {
        ok: false,
        reason: 'error',
        ...describeError(e),
        prefix: failurePrefix(verb, target, ctx.worktree),
      }
    }
  }

  const empty = (t: BulkTarget) => 'paths' in t && t.paths.length === 0

  return {
    async stage(ctx: WriteCtx, target: BulkTarget): Promise<WriteOutcome> {
      if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
      if (empty(target)) return { ok: false, reason: 'empty' }
      return send('stage', ctx, target, (b) => api.stage(b))
    },
    async unstage(ctx: WriteCtx, target: BulkTarget): Promise<WriteOutcome> {
      if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
      if (empty(target)) return { ok: false, reason: 'empty' }
      return send('unstage', ctx, target, (b) => api.unstage(b))
    },
    async discard(ctx: WriteCtx, items: DiscardItem[]): Promise<WriteOutcome> {
      if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
      if (items.length === 0) return { ok: false, reason: 'empty' }
      const plan = discardPlan(items, ctx.worktree, ctx.branch)
      if (!(await confirm(plan))) return { ok: false, reason: 'cancelled' }
      const verb: Verb = items.every((i) => i.untracked) ? 'delete' : 'discard'
      return send(verb, ctx, { paths: plan.paths }, (b) => api.discard(b))
    },
  }
}
