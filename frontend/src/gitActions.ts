// The working tree's write actions (naru task 2738, docs/git-tab.md "Working
// tree view"): the texts of the confirm dialog and of the controls, and
// `createGitActions`, the ONLY way the UI reaches the discard endpoint. Every
// discard goes through `confirm(plan)` first; `api.discard` is called nowhere
// else, and `gitActions.test.ts` pins both that and the single reference to
// `discardProjectGit` and the discard route string. No React, no DOM.
import {
  applyProjectGitStash,
  commitProjectGit,
  createProjectGitBranch,
  deleteProjectGitBranch,
  discardProjectGit,
  discardProjectGitHunks,
  dropProjectGitStash,
  getProjectGit,
  popProjectGitStash,
  pushProjectGitStash,
  renameProjectGitBranch,
  stageProjectGit,
  stageProjectGitHunks,
  switchProjectGitBranch,
  unstageProjectGit,
  unstageProjectGitHunks,
} from './api'
import type {
  GitBranchCreateBody,
  GitBranchDeleteBody,
  GitBranchRenameBody,
  GitBranchSwitchBody,
  GitCommitBody,
  GitHunkBody,
  GitStashEntryBody,
  GitStashPushBody,
  GitWriteBody,
} from './api'
import { picksSubject } from './gitHunks'
import type { HunkPick } from './gitHunks'
import { shortFolder } from './gitPanel'
import type { BulkTarget } from './gitWorktree'
import type { GitBranchDeleteResult } from './types/GitBranchDeleteResult'
import type { GitCommitResult } from './types/GitCommitResult'
import type { GitRefResult } from './types/GitRefResult'
import type { GitRepoView } from './types/GitRepoView'
import type { GitStash } from './types/GitStash'

/** Paths the discard dialog lists before "and N more". */
export const PLAN_LIST_MAX = 10

/** Lines the hunk-discard dialog lists before "and N more". */
export const HUNK_LIST_MAX = 200

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
  /** The list's accessible name; default "Affected paths". */
  listLabel?: string
  /** The list holds lines of text (whitespace kept), not paths. */
  mono?: boolean
}

/** What the confirm dialog shows. A discard's plan, widened (naru task 2741):
 * a branch or stash confirm is not always "cannot be undone", and its list may
 * end in an "and more" of unknown size (`moreLabel`). */
export type ConfirmPlan = Omit<DiscardPlan, 'irreversible'> & {
  irreversible?: string
  /** Shown instead of "and N more" when `more > 0`. */
  moreLabel?: string
}

/** The dialog of a hunk discard: THE LINES TO BE LOST, as text. */
export function discardHunkPlan(
  path: string,
  lost: string[],
  worktree: string,
  branch: string,
): DiscardPlan {
  return {
    title: 'Discard this hunk?',
    worktree,
    branch,
    paths: [path],
    listed: lost.slice(0, HUNK_LIST_MAX),
    more: Math.max(0, lost.length - HUNK_LIST_MAX),
    consequences: [
      'The added lines are removed from the working file and the removed lines are restored. Staged changes are kept.',
    ],
    confirmLabel: 'Discard hunk',
    irreversible: 'This cannot be undone.',
    listLabel: `Lines to be lost in ${path}`,
    mono: true,
  }
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

/** "Could not stage hunk 2 of src/a.ts in /path/to/worktree:" */
export function hunkFailurePrefix(
  verb: 'stage' | 'unstage' | 'discard',
  path: string,
  picks: HunkPick[],
  worktree: string,
): string {
  return `Could not ${verb} ${picksSubject(path, picks)} in ${worktree}:`
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
  stageHunks(body: GitHunkBody): Promise<GitRepoView>
  unstageHunks(body: GitHunkBody): Promise<GitRepoView>
  discardHunks(body: GitHunkBody): Promise<GitRepoView>
  commit(body: GitCommitBody): Promise<GitCommitResult>
}

/** The real routes of one project. The component gets its api only from
 * `createGitActions(projectGitApi(id), …)`; this is where the discard call is
 * bound. */
export function projectGitApi(projectId: number): GitWriteApi {
  return {
    stage: (b) => stageProjectGit(projectId, b),
    unstage: (b) => unstageProjectGit(projectId, b),
    discard: (b) => discardProjectGit(projectId, b),
    stageHunks: (b) => stageProjectGitHunks(projectId, b),
    unstageHunks: (b) => unstageProjectGitHunks(projectId, b),
    discardHunks: (b) => discardProjectGitHunks(projectId, b),
    commit: (b) => commitProjectGit(projectId, b),
  }
}

/** The worktree a write acts in, as the view on screen was loaded for it.
 * `worktree: null` = unresolved: nothing is sent. */
export type WriteCtx = { worktree: string | null; branch: string; repo?: string }

/** One file's hunks or lines, from the diff whose `digest` is given. */
export type HunkTarget = { path: string; digest: string; hunks: HunkPick[] }

export type WriteOutcome =
  | { ok: true; view: GitRepoView }
  | { ok: false; reason: 'cancelled' | 'no-worktree' | 'empty' }
  | { ok: false; reason: 'error'; code: string; message: string; prefix: string }

/** What the commit box asks of the gate (naru task 2740). `published` = the
 * amended HEAD is already on a remote branch, `merge` = it is a merge commit:
 * for either the gate asks `plan` first. */
export type CommitRequest = {
  message: string
  /** `GitRepoView.staged_digest` of the staged list on screen. */
  stagedDigest: string
  amend: boolean
  /** The `head.hash` the amended message was loaded from; required with `amend`. */
  expectedHead?: string
  published: boolean
  merge: boolean
  plan?: DiscardPlan
}

export type CommitOutcome =
  | { ok: true; result: GitCommitResult }
  | { ok: false; reason: 'cancelled' | 'no-worktree' | 'empty' | 'busy' }
  | { ok: false; reason: 'error'; code: string; message: string; prefix: string }

/** "Could not commit to main in /path/to/worktree:" */
export function commitFailurePrefix(amend: boolean, branch: string, worktree: string): string {
  return amend
    ? `Could not amend the last commit on ${branch} in ${worktree}:`
    : `Could not commit to ${branch} in ${worktree}:`
}

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

  async function sendHunks(
    verb: 'stage' | 'unstage' | 'discard',
    ctx: WriteCtx,
    t: HunkTarget,
    call: (body: GitHunkBody) => Promise<GitRepoView>,
  ): Promise<WriteOutcome> {
    if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
    if (t.hunks.length === 0) return { ok: false, reason: 'empty' }
    const body: GitHunkBody = { worktree: ctx.worktree, path: t.path, digest: t.digest, hunks: t.hunks }
    if (ctx.repo !== undefined) body.repo = ctx.repo
    try {
      return { ok: true, view: await call(body) }
    } catch (e) {
      return {
        ok: false,
        reason: 'error',
        ...describeError(e),
        prefix: hunkFailurePrefix(verb, t.path, t.hunks, ctx.worktree),
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
      return send(verb, ctx, { paths: plan.paths }, (b) => api.discard({ ...b, confirm: true }))
    },
    stageHunks: (ctx: WriteCtx, t: HunkTarget): Promise<WriteOutcome> =>
      sendHunks('stage', ctx, t, (b) => api.stageHunks(b)),
    unstageHunks: (ctx: WriteCtx, t: HunkTarget): Promise<WriteOutcome> =>
      sendHunks('unstage', ctx, t, (b) => api.unstageHunks(b)),
    /** Commit or amend. Amending a published HEAD or a merge commit asks first
     * (`req.plan`) and only then sends, with `allow_published` /
     * `allow_merge`; nothing else ever asks. */
    async commit(ctx: WriteCtx, req: CommitRequest): Promise<CommitOutcome> {
      if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
      if (req.amend && (req.expectedHead === undefined || req.expectedHead === '')) {
        return { ok: false, reason: 'empty' }
      }
      const body: GitCommitBody = {
        worktree: ctx.worktree,
        message: req.message,
        staged_digest: req.stagedDigest,
      }
      if (ctx.repo !== undefined) body.repo = ctx.repo
      if (req.amend) {
        body.amend = true
        body.expected_head = req.expectedHead
        if (req.published || req.merge) {
          if (req.plan === undefined || !(await confirm(req.plan))) {
            return { ok: false, reason: 'cancelled' }
          }
          if (req.published) body.allow_published = true
          if (req.merge) body.allow_merge = true
        }
      }
      try {
        return { ok: true, result: await api.commit(body) }
      } catch (e) {
        return {
          ok: false,
          reason: 'error',
          ...describeError(e),
          prefix: commitFailurePrefix(req.amend, ctx.branch, ctx.worktree),
        }
      }
    },
    /** Like `discard`: asks first, with the lines to be lost (`lost`). */
    async discardHunks(ctx: WriteCtx, t: HunkTarget, lost: string[]): Promise<WriteOutcome> {
      if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
      if (t.hunks.length === 0) return { ok: false, reason: 'empty' }
      const plan = discardHunkPlan(t.path, lost, ctx.worktree, ctx.branch)
      if (!(await confirm(plan))) return { ok: false, reason: 'cancelled' }
      return sendHunks('discard', ctx, t, (b) => api.discardHunks({ ...b, confirm: true }))
    },
  }
}

// ---- branch and stash writes (naru task 2741) ----

/** Commits the force-delete dialog lists (the server sends at most 50). */
export const UNMERGED_LIST_MAX = 50

/** What the main-checkout and detached-HEAD confirms of a switch need to know. */
export type SwitchInfo = { isMain: boolean; linked: number; detached: boolean }

const shortOf = (hash: string): string => hash.slice(0, 7)

/** The stash as the dialogs name it: `stash@{0}` and its message. */
const stashLine = (s: GitStash): string => (s.message.trim() === '' ? s.name : `${s.name}: ${s.message}`)

function plan(
  ctx: { worktree: string; branch: string },
  p: Omit<ConfirmPlan, 'worktree' | 'branch' | 'paths' | 'listed' | 'more'> &
    Partial<Pick<ConfirmPlan, 'listed' | 'more'>>,
): ConfirmPlan {
  return { worktree: ctx.worktree, branch: ctx.branch, paths: [], listed: [], more: 0, ...p }
}

/** The first dialog of a delete: always asked, before anything is sent. */
export function deleteBranchPlan(
  name: string,
  tip: string,
  ctx: { worktree: string; branch: string },
): ConfirmPlan {
  return plan(ctx, {
    title: `Delete branch ${name}?`,
    consequences: [
      `The branch ${name}${tip === '' ? '' : ` (at ${shortOf(tip)})`} is deleted. Git deletes it only when it is fully merged; if it is not, you see the commits that would be lost and are asked again.`,
    ],
    confirmLabel: 'Delete branch',
    irreversible: 'A deleted branch cannot be restored from here.',
    listLabel: 'Branch',
    listed: [name],
  })
}

/** The second, distinct dialog: git refused, so this lists what would become
 * unreachable (`unmerged`, up to 50, "and more" past that). */
export function forceDeletePlan(
  name: string,
  res: Pick<GitBranchDeleteResult, 'unmerged' | 'unmerged_more' | 'hash'>,
  ctx: { worktree: string; branch: string },
): ConfirmPlan {
  const n = res.unmerged.length
  const count = res.unmerged_more ? `${UNMERGED_LIST_MAX} or more commits` : plural(n, 'commit')
  return plan(ctx, {
    title: `Force delete branch ${name}?`,
    listed: res.unmerged.map((c) => `${c.short_hash} ${c.subject}`),
    more: res.unmerged_more ? 1 : 0,
    moreLabel: 'and more',
    consequences: [
      `Git refused: ${name} (at ${shortOf(res.hash)}) is not fully merged.`,
      n === 0 && !res.unmerged_more
        ? '0 commits become unreachable: every commit on it is also reachable from another branch, tag or worktree.'
        : `${count} ${n === 1 && !res.unmerged_more ? 'becomes' : 'become'} unreachable, found again only through the reflog.`,
    ],
    confirmLabel: 'Force delete branch',
    irreversible: 'This cannot be undone from here.',
    listLabel: `Commits only on ${name}`,
    mono: true,
  })
}

/** The dialog of a switch from the main checkout and/or a detached HEAD; null
 * when neither applies (a plain switch never asks). */
export function switchPlan(
  name: string,
  info: SwitchInfo,
  stash: boolean,
  ctx: { worktree: string; branch: string },
): ConfirmPlan | null {
  const consequences: string[] = []
  if (info.isMain) {
    consequences.push(
      `This is the main checkout. ${plural(info.linked, 'linked worktree')} ${info.linked === 1 ? 'is' : 'are'} based on it, agents' worktrees are made from it, and Naru may be served from this folder.`,
    )
  }
  if (info.detached) {
    consequences.push(
      `HEAD is detached at ${ctx.branch}. Commits made here are on no branch: once you switch, they are reachable only through the reflog. Create a branch here first to keep them.`,
    )
  }
  if (consequences.length === 0) return null
  if (stash) {
    consequences.push('Your uncommitted changes, including untracked files, are stashed first.')
  }
  return plan(ctx, {
    title: `${stash ? 'Stash and switch' : 'Switch'} to ${name}?`,
    consequences,
    confirmLabel: stash ? 'Stash and switch' : 'Switch branch',
    listLabel: 'Branch',
    listed: [name],
  })
}

/** Popping onto a dirty (or not known to be clean) tree. */
export function popPlan(
  stash: GitStash,
  dirty: boolean | null,
  ctx: { worktree: string; branch: string },
): ConfirmPlan {
  return plan(ctx, {
    title: `Pop ${stash.name}?`,
    listed: [stashLine(stash)],
    listLabel: 'Stash',
    consequences: [
      dirty === null
        ? 'It is not known whether this worktree has uncommitted changes.'
        : 'This worktree has uncommitted changes.',
      'The stash is applied on top of them and, when that succeeds, removed from the list. If it conflicts, git leaves the conflicts in the files and the stash stays.',
    ],
    confirmLabel: 'Pop stash',
  })
}

/** Applying onto a dirty (or not known to be clean) tree (naru task 2802). */
export function applyPlan(
  stash: GitStash,
  dirty: boolean | null,
  ctx: { worktree: string; branch: string },
): ConfirmPlan {
  return plan(ctx, {
    title: `Apply ${stash.name}?`,
    listed: [stashLine(stash)],
    listLabel: 'Stash',
    consequences: [
      dirty === null
        ? 'It is not known whether this worktree has uncommitted changes.'
        : 'This worktree has uncommitted changes.',
      'The stash is applied on top of them and stays in the list. If it conflicts, git leaves the conflicts in the files.',
    ],
    confirmLabel: 'Apply stash',
  })
}

export function dropPlan(stash: GitStash, ctx: { worktree: string; branch: string }): ConfirmPlan {
  return plan(ctx, {
    title: `Drop ${stash.name}?`,
    listed: [stashLine(stash)],
    listLabel: 'Stash',
    consequences: ['The stash is removed from the list for every worktree. Its changes are not applied anywhere.'],
    confirmLabel: 'Drop stash',
    irreversible: 'A dropped stash cannot be restored from here.',
  })
}

/** What the branch and stash routes look like to the gate. */
export interface GitRefApi {
  createBranch(body: GitBranchCreateBody): Promise<GitRefResult>
  switchBranch(body: GitBranchSwitchBody): Promise<GitRefResult>
  renameBranch(body: GitBranchRenameBody): Promise<GitRefResult>
  deleteBranch(body: GitBranchDeleteBody): Promise<GitBranchDeleteResult>
  pushStash(body: GitStashPushBody): Promise<GitRefResult>
  applyStash(body: GitStashEntryBody): Promise<GitRefResult>
  popStash(body: GitStashEntryBody): Promise<GitRefResult>
  dropStash(body: GitStashEntryBody): Promise<GitRefResult>
  /** A fresh read of the worktree: has it uncommitted changes? null = unknown. */
  readDirty(worktree: string, repo: string | undefined): Promise<boolean | null>
}

/** The real routes of one project. The component gets its api only from
 * `createGitRefActions(projectGitRefApi(id), …)`; this is where the delete and
 * drop calls are bound. */
export function projectGitRefApi(projectId: number): GitRefApi {
  return {
    createBranch: (b) => createProjectGitBranch(projectId, b),
    switchBranch: (b) => switchProjectGitBranch(projectId, b),
    renameBranch: (b) => renameProjectGitBranch(projectId, b),
    deleteBranch: (b) => deleteProjectGitBranch(projectId, b),
    pushStash: (b) => pushProjectGitStash(projectId, b),
    applyStash: (b) => applyProjectGitStash(projectId, b),
    popStash: (b) => popProjectGitStash(projectId, b),
    dropStash: (b) => dropProjectGitStash(projectId, b),
    readDirty: async (worktree, repo) => {
      const v = await getProjectGit(projectId, worktree, repo)
      return v.repo === null ? null : v.repo.status.dirty > 0
    },
  }
}

export type RefOutcome =
  | { ok: true; notice: string | null; deleted?: boolean }
  | { ok: false; reason: 'cancelled' | 'no-worktree' | 'empty' }
  | { ok: false; reason: 'error'; code: string; message: string; prefix: string }

/** Where a branch or stash write acts: `worktree: null` = unresolved, nothing is sent. */
export type RefWriteCtx = { worktree: string | null; branch: string; repo?: string }

export type NewBranchRequest = {
  name: string
  fromCommit?: string
  fromRemote?: string
  switch?: boolean
  info: SwitchInfo
}

export type StashEntryRequest = { stash: GitStash }

/** Failure texts: what was attempted and where, then git's message verbatim. */
export const refFailurePrefix = {
  create: (name: string, wt: string) => `Could not create branch ${name} in ${wt}:`,
  switch: (name: string, wt: string, stash: boolean) =>
    `Could not ${stash ? 'stash and switch' : 'switch'} to ${name} in ${wt}:`,
  rename: (name: string, to: string, wt: string) => `Could not rename ${name} to ${to} in ${wt}:`,
  delete: (name: string, wt: string) => `Could not delete branch ${name} in ${wt}:`,
  stash: (wt: string) => `Could not stash changes in ${wt}:`,
  entry: (verb: 'apply' | 'pop' | 'drop', stash: string, wt: string) =>
    `Could not ${verb} ${stash} in ${wt}:`,
}

/**
 * The branch and stash gate (naru task 2741), like `createGitActions`.
 *
 * - `deleteBranch` awaits `confirm(deleteBranchPlan)` before the first call. A
 *   refusal as unmerged (a 200 with `deleted: false`) awaits a SECOND, distinct
 *   `confirm(forceDeletePlan)` listing what would become unreachable; only a
 *   yes sends `force` with that result's `hash` as `expected_hash`.
 * - `dropStash` always confirms; `popStash` and `applyStash` read the worktree fresh and confirm unless it is known clean (a failed read asks).
 * - The server refuses those without `confirm: true` (naru task 2802), which
 *   is put in the body only after a yes.
 * - `switchBranch` confirms from the main checkout and from a detached HEAD
 *   (and so does a create that switches in the main checkout). The stash
 *   variant (`stashAndSwitch`) is its own method, only for the explicit
 *   "Stash and switch" button; `switchBranch` never sends `stash`.
 * - A `false` answer sends nothing. Nothing is sent without an explicit
 *   worktree path.
 */
export function createGitRefActions(deps: {
  api: GitRefApi
  confirm: (plan: ConfirmPlan) => Promise<boolean>
}) {
  const { api, confirm } = deps

  const base = (ctx: RefWriteCtx & { worktree: string }): { worktree: string; repo?: string } =>
    ctx.repo === undefined ? { worktree: ctx.worktree } : { worktree: ctx.worktree, repo: ctx.repo }

  async function guarded(
    prefix: string,
    call: () => Promise<RefOutcome>,
  ): Promise<RefOutcome> {
    try {
      return await call()
    } catch (e) {
      return { ok: false, reason: 'error', ...describeError(e), prefix }
    }
  }

  async function doSwitch(
    ctx: RefWriteCtx,
    name: string,
    info: SwitchInfo,
    stash: boolean,
  ): Promise<RefOutcome> {
    if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
    if (name === '') return { ok: false, reason: 'empty' }
    const wt = { worktree: ctx.worktree, branch: ctx.branch }
    const p = switchPlan(name, info, stash, wt)
    if (p !== null && !(await confirm(p))) return { ok: false, reason: 'cancelled' }
    const body: GitBranchSwitchBody = { ...base({ ...ctx, worktree: ctx.worktree }), name }
    if (stash) body.stash = true
    return guarded(refFailurePrefix.switch(name, ctx.worktree, stash), async () => ({
      ok: true,
      notice: (await api.switchBranch(body)).notice,
    }))
  }

  async function entry(
    verb: 'apply' | 'pop' | 'drop',
    ctx: RefWriteCtx,
    req: StashEntryRequest,
    call: (b: GitStashEntryBody) => Promise<GitRefResult>,
  ): Promise<RefOutcome> {
    if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
    const wt = { worktree: ctx.worktree, branch: ctx.branch }
    let confirmed = false
    if (verb === 'drop') {
      if (!(await confirm(dropPlan(req.stash, wt)))) return { ok: false, reason: 'cancelled' }
      confirmed = true
    } else {
      // The tab's cached view can be stale (an agent may have dirtied the
      // tree since): decide from a read made now; a failed read = unknown = ask.
      const dirty = await api.readDirty(ctx.worktree, ctx.repo).catch(() => null)
      if (dirty !== false) {
        const p = verb === 'pop' ? popPlan(req.stash, dirty, wt) : applyPlan(req.stash, dirty, wt)
        if (!(await confirm(p))) return { ok: false, reason: 'cancelled' }
        confirmed = true
      }
    }
    const body: GitStashEntryBody = {
      ...base({ ...ctx, worktree: ctx.worktree }),
      index: req.stash.index,
      hash: req.stash.hash,
    }
    if (confirmed) body.confirm = true
    return guarded(refFailurePrefix.entry(verb, req.stash.name, ctx.worktree), async () => ({
      ok: true,
      notice: (await call(body)).notice,
    }))
  }

  return {
    async createBranch(ctx: RefWriteCtx, req: NewBranchRequest): Promise<RefOutcome> {
      if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
      if (req.name === '') return { ok: false, reason: 'empty' }
      if (req.switch === true && req.info.isMain) {
        const p = switchPlan(req.name, { ...req.info, detached: false }, false, {
          worktree: ctx.worktree,
          branch: ctx.branch,
        })
        if (p !== null) {
          p.title = `Create ${req.name} and switch to it?`
          p.confirmLabel = 'Create and switch'
          if (!(await confirm(p))) return { ok: false, reason: 'cancelled' }
        }
      }
      const body: GitBranchCreateBody = { ...base({ ...ctx, worktree: ctx.worktree }), name: req.name }
      if (req.fromCommit !== undefined) body.from_commit = req.fromCommit
      if (req.fromRemote !== undefined) body.from_remote = req.fromRemote
      if (req.switch === true) body.switch = true
      return guarded(refFailurePrefix.create(req.name, ctx.worktree), async () => ({
        ok: true,
        notice: (await api.createBranch(body)).notice,
      }))
    },
    switchBranch: (ctx: RefWriteCtx, name: string, info: SwitchInfo): Promise<RefOutcome> =>
      doSwitch(ctx, name, info, false),
    /** Only the explicit "Stash and switch" button after a refused switch. */
    stashAndSwitch: (ctx: RefWriteCtx, name: string, info: SwitchInfo): Promise<RefOutcome> =>
      doSwitch(ctx, name, info, true),
    async renameBranch(ctx: RefWriteCtx, name: string, newName: string): Promise<RefOutcome> {
      if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
      if (name === '' || newName === '') return { ok: false, reason: 'empty' }
      const body: GitBranchRenameBody = {
        ...base({ ...ctx, worktree: ctx.worktree }),
        name,
        new_name: newName,
      }
      return guarded(refFailurePrefix.rename(name, newName, ctx.worktree), async () => ({
        ok: true,
        notice: (await api.renameBranch(body)).notice,
      }))
    },
    /** Always asks; a refusal as unmerged asks again, with the commits. */
    async deleteBranch(
      ctx: RefWriteCtx,
      name: string,
      tip: string,
      /** False once the selected worktree is no longer the one the delete started for. */
      stillHere: () => boolean = () => true,
    ): Promise<RefOutcome> {
      if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
      if (name === '') return { ok: false, reason: 'empty' }
      const wt = { worktree: ctx.worktree, branch: ctx.branch }
      if (!(await confirm(deleteBranchPlan(name, tip, wt)))) return { ok: false, reason: 'cancelled' }
      const b = base({ ...ctx, worktree: ctx.worktree })
      return guarded(refFailurePrefix.delete(name, ctx.worktree), async () => {
        const first = await api.deleteBranch({ ...b, name })
        if (first.deleted) return { ok: true, notice: null, deleted: true }
        if (!stillHere() || !(await confirm(forceDeletePlan(name, first, wt)))) {
          return { ok: false, reason: 'cancelled' }
        }
        const forced = await api.deleteBranch({ ...b, name, force: true, expected_hash: first.hash })
        if (!forced.deleted) {
          return {
            ok: false,
            reason: 'error',
            code: 'conflict',
            message: `${name} was not deleted.${forced.refusal ? `\n${forced.refusal}` : ''}`,
            prefix: refFailurePrefix.delete(name, wt.worktree),
          }
        }
        return { ok: true, notice: null, deleted: true }
      })
    },
    async pushStash(ctx: RefWriteCtx, message: string, includeUntracked: boolean): Promise<RefOutcome> {
      if (ctx.worktree === null) return { ok: false, reason: 'no-worktree' }
      const body: GitStashPushBody = base({ ...ctx, worktree: ctx.worktree })
      if (message.trim() !== '') body.message = message.trim()
      if (includeUntracked) body.include_untracked = true
      return guarded(refFailurePrefix.stash(ctx.worktree), async () => ({
        ok: true,
        notice: (await api.pushStash(body)).notice,
      }))
    },
    applyStash: (ctx: RefWriteCtx, req: StashEntryRequest): Promise<RefOutcome> =>
      entry('apply', ctx, req, (b) => api.applyStash(b)),
    popStash: (ctx: RefWriteCtx, req: StashEntryRequest): Promise<RefOutcome> =>
      entry('pop', ctx, req, (b) => api.popStash(b)),
    dropStash: (ctx: RefWriteCtx, req: StashEntryRequest): Promise<RefOutcome> =>
      entry('drop', ctx, req, (b) => api.dropStash(b)),
  }
}
