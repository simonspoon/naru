// The pure half of the Git tab's branch and stash actions (naru task 2741,
// docs/git-tab.md "Branch and stash writes"): which controls are off and why,
// their labels, the target lines, the name check of the forms. The gate that
// actually sends is `createGitRefActions` in gitActions.ts. No DOM, no React:
// covered by `gitRefs.test.ts`. Every string from the repo (branch names,
// stash messages, paths) is only ever rendered as a text node.
import { activeWorktreePath } from './gitPanel'
import type { GitBranch } from './types/GitBranch'
import type { GitStatus } from './types/GitStatus'
import type { GitWorktree } from './types/GitWorktree'

/** Where a write acts, as the view on screen was loaded for it. */
export type RefCtx = {
  /** Full path of the selected worktree; null = unresolved: nothing is sent. */
  worktree: string | null
  /** The worktree's branch; the short sha when detached. */
  branch: string
  detached: boolean
  /** The worktree is the repo's main checkout. */
  isMain: boolean
  /** Linked worktrees of the repo (everything but the main checkout). */
  linked: number
  /** merge | rebase | cherry-pick | revert | bisect, else null. */
  operation: string | null
  /** Uncommitted changes in it; null = not known (the view is loading). */
  dirty: boolean | null
  /** The view on screen is another worktree's (a switch is loading). */
  stale: boolean
}

export function refCtxOf(input: {
  worktrees: GitWorktree[] | null
  selected: string | null
  status: GitStatus
  operation: string | null
  fresh: boolean
}): RefCtx {
  const list = input.worktrees ?? []
  const path = activeWorktreePath(list, input.selected)
  const w = list.find((x) => x.path === path)
  return {
    worktree: path,
    branch: input.status.branch,
    detached: w?.detached ?? false,
    isMain: w?.is_main ?? false,
    linked: list.filter((x) => !x.is_main).length,
    operation: input.fresh ? input.operation : null,
    dirty: input.fresh ? input.status.dirty > 0 : null,
    stale: !input.fresh,
  }
}

/** No commits yet: a worktree on a branch name that no branch row carries. */
export function isUnborn(branches: GitBranch[] | null, ctx: RefCtx): boolean {
  return (
    branches !== null &&
    !ctx.detached &&
    ctx.worktree !== null &&
    !branches.some((b) => b.kind === 'local' && b.is_head)
  )
}

const OPERATIONS: Record<string, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
  bisect: 'Bisect',
}

export const operationReason = (op: string): string =>
  `${OPERATIONS[op] ?? op} in progress in this worktree. Finish or abort it in the terminal.`

export const NO_WORKTREE = 'The worktree path is unknown.'
export const LOADING_WORKTREE = 'Loading this worktree.'
export const NO_COMMITS = 'No commits yet.'

/** Why every write control is off, whatever the row: no worktree, a loading
 * one, or a write / dialog in flight. */
export function writeOffReason(ctx: RefCtx, busy: boolean): string | null {
  if (busy) return 'Another git action is in progress.'
  if (ctx.worktree === null) return NO_WORKTREE
  if (ctx.stale) return LOADING_WORKTREE
  return null
}

/** A name git would read as a flag: the server refuses to act on it. */
const dashReason = (name: string): string | null =>
  name.startsWith('-') ? "Rename it in the terminal." : null

/** The worktree that holds the branch when it is another one. */
const heldElsewhere = (b: GitBranch): string | null => (b.worktree !== null && !b.is_head ? b.worktree : null)

export function switchReason(ctx: RefCtx, b: GitBranch): string | null {
  const held = heldElsewhere(b)
  if (held !== null) return `Checked out in ${held}`
  if (b.is_head) return 'Already the current branch'
  const dash = dashReason(b.name)
  if (dash !== null) return dash
  if (ctx.operation !== null) return operationReason(ctx.operation)
  return null
}

export function renameReason(b: GitBranch): string | null {
  const held = heldElsewhere(b)
  if (held !== null) return `Checked out in ${held}`
  return dashReason(b.name)
}

export function deleteReason(b: GitBranch): string | null {
  const held = heldElsewhere(b)
  if (held !== null) return `Checked out in ${held}`
  if (b.is_head) return "Can't delete the checked-out branch"
  return dashReason(b.name)
}

/** "New branch" from the header or the detached note (from HEAD). */
export function newBranchReason(unborn: boolean): string | null {
  return unborn ? NO_COMMITS : null
}

/** Why "Switch to it" of a new branch is off: switching is refused mid-operation. */
export function switchToItReason(ctx: RefCtx): string | null {
  return ctx.operation !== null ? operationReason(ctx.operation) : null
}

export function stashPushReason(ctx: RefCtx, unborn: boolean): string | null {
  if (ctx.operation !== null) return operationReason(ctx.operation)
  return unborn ? NO_COMMITS : null
}

/** Apply and Pop (not Drop) are refused mid-operation. */
export function stashApplyReason(ctx: RefCtx): string | null {
  return ctx.operation !== null ? operationReason(ctx.operation) : null
}

export type RefVerb =
  | 'switch'
  | 'rename'
  | 'delete'
  | 'branch-from-remote'
  | 'apply'
  | 'pop'
  | 'drop'
  | 'new-branch'
  | 'stash'
  | 'branch-here'

/** The tooltip and aria-label of a control: names its target, and for the ones
 * that act on the worktree, the worktree's full path and branch. */
export function refLabel(verb: RefVerb, subject: string, ctx: RefCtx): string {
  const where = ctx.worktree === null ? 'an unknown worktree' : `${ctx.worktree} (branch ${ctx.branch})`
  switch (verb) {
    case 'switch':
      return `Switch to ${subject} in ${where}`
    case 'rename':
      return `Rename branch ${subject}`
    case 'delete':
      return `Delete branch ${subject}`
    case 'branch-from-remote':
      return `Create local branch from ${subject}`
    case 'apply':
      return `Apply ${subject} to ${ctx.branch} in ${ctx.worktree ?? 'an unknown worktree'}`
    case 'pop':
      return `Pop ${subject} onto ${ctx.branch} in ${ctx.worktree ?? 'an unknown worktree'}`
    case 'drop':
      return `Drop ${subject}`
    case 'new-branch':
      return `New branch from ${ctx.branch} in ${ctx.worktree ?? 'an unknown worktree'}`
    case 'stash':
      return `Stash changes in ${ctx.branch} in ${ctx.worktree ?? 'an unknown worktree'}`
    case 'branch-here':
      return `Create branch here (${subject}) in ${where}`
  }
}

export function branchTargetLine(ctx: RefCtx): string {
  return `Switch and New branch act on ${ctx.branch} · ${ctx.worktree ?? 'unknown worktree'}`
}

export function stashTargetLine(ctx: RefCtx): string {
  return `Stashes are shared by all worktrees. Apply, Pop and Stash act on ${ctx.branch} · ${ctx.worktree ?? 'unknown worktree'}`
}

/** What a new branch starts at. */
export type NewBranchSource =
  | { kind: 'head' }
  | { kind: 'commit'; sha: string }
  | { kind: 'remote'; name: string }

export function newBranchTitle(src: NewBranchSource, ctx: RefCtx): string {
  switch (src.kind) {
    case 'head':
      return ctx.detached ? `New branch at ${ctx.branch}` : `New branch from ${ctx.branch}`
    case 'commit':
      return `New branch at ${src.sha.slice(0, 7)}`
    case 'remote':
      return `New local branch from ${src.name}`
  }
}

/** On by default from the header and a detached HEAD; off from a remote row or
 * a History commit (the person's checkout does not move unless asked). */
export function defaultSwitch(src: NewBranchSource, ctx: RefCtx): boolean {
  return src.kind === 'head' && switchToItReason(ctx) === null
}

/** Why a new branch name is not acceptable, or null. A convenience: the server
 * runs `git check-ref-format` and shows its own message. An empty name is not
 * a problem to show, only to not submit (`name.trim() === ''`). */
export function branchNameProblem(raw: string, existing: string[], renaming?: string): string | null {
  const name = raw.trim()
  if (name === '') return null
  // eslint-disable-next-line no-control-regex
  if (/[ \u0000-\u001f\u007f]/.test(name)) return 'A branch name cannot contain spaces or control characters.'
  if (name.startsWith('-')) return 'A branch name cannot start with "-".'
  if (name === '@') return 'A branch cannot be named "@".'
  if (name.includes('..')) return 'A branch name cannot contain "..".'
  if (/[~^:?*[\\]/.test(name)) return 'A branch name cannot contain any of ~ ^ : ? * [ \\'
  if (name.includes('@{')) return 'A branch name cannot contain "@{".'
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return 'A branch name cannot start or end with "/" or contain "//".'
  }
  if (name.endsWith('.')) return 'A branch name cannot end with ".".'
  if (name.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))) {
    return 'A branch name cannot have a part that starts with "." or ends with ".lock".'
  }
  if (renaming !== undefined && name === renaming) return 'That is already its name.'
  if (existing.includes(name)) return `A branch named ${name} already exists.`
  return null
}

/** The stash message: optional, one line, at most 200 bytes (the server's cap). */
export function stashMessageProblem(raw: string): string | null {
  const m = raw.trim()
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(m)) return 'A stash message is a single line.'
  if (new TextEncoder().encode(m).length > 200) return 'A stash message is at most 200 bytes.'
  return null
}

/** The status line while a write runs. */
export function busyText(
  what:
    | { kind: 'switch'; name: string; stash: boolean }
    | { kind: 'create'; name: string }
    | { kind: 'rename'; name: string; to: string }
    | { kind: 'delete'; name: string }
    | { kind: 'stash' }
    | { kind: 'apply' | 'pop' | 'drop'; stash: string },
): string {
  switch (what.kind) {
    case 'switch':
      return `${what.stash ? 'Stashing and switching' : 'Switching'} to ${what.name}…`
    case 'create':
      return `Creating ${what.name}…`
    case 'rename':
      return `Renaming ${what.name} to ${what.to}…`
    case 'delete':
      return `Deleting ${what.name}…`
    case 'stash':
      return 'Stashing changes…'
    case 'apply':
      return `Applying ${what.stash}…`
    case 'pop':
      return `Popping ${what.stash}…`
    case 'drop':
      return `Dropping ${what.stash}…`
  }
}

/** "Stash and switch" is offered only when git refused because the switch would
 * overwrite local changes or untracked files (a 409; the server runs git with
 * LC_ALL=C, so the text is stable). Any other failure offers nothing. */
export function offersStashSwitch(out: { code: string; message: string }): boolean {
  return out.code === 'conflict' && out.message.includes('would be overwritten')
}
