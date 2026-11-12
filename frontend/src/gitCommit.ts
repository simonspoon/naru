// The commit box's rules (naru task 2740, docs/git-tab.md "Commit box"): the
// draft record and its storage, message composing and splitting, the subject
// guide, why the button is off, when Amend is offered, the amend confirm
// dialog text (published, merge commit) and the labels. No React, no DOM; `components/GitCommitBox.tsx`
// only lays them out. Repo text (subjects, branches, paths) is data: nothing
// here builds markup from it.
import { plural } from './gitActions'
import type { DiscardPlan } from './gitActions'
import { shortFolder } from './gitPanel'
import type { GitCommitInfo } from './types/GitCommitInfo'
import type { GitHeadCommit } from './types/GitHeadCommit'

// ---- message ----

/** Subject and body as the two fields hold them. */
export type Fields = { subject: string; body: string }

/** The message git gets: the subject, then a blank line and the body when the
 * body has text. (The server normalises whitespace and commits it verbatim.) */
export function composeMessage(subject: string, body: string): string {
  return body.trim() === '' ? subject : `${subject}\n\n${body}`
}

/** The fields a whole message loads into: the first line, and what follows the
 * blank separator. CRLF is read as LF; trailing whitespace is dropped. */
export function splitMessage(message: string): Fields {
  const text = message.replace(/\r\n?/g, '\n').trimEnd()
  const nl = text.indexOf('\n')
  if (nl === -1) return { subject: text, body: '' }
  const rest = text.slice(nl + 1)
  // One blank line separates subject and body; any further blank lines are the body's.
  return { subject: text.slice(0, nl), body: rest.startsWith('\n') ? rest.slice(1) : rest }
}

// ---- subject guide ----

export const SUBJECT_SOFT = 50
export const SUBJECT_HARD = 72

export type SubjectGuide = { count: number; level: 'ok' | 'long' | 'over'; text: string }

/** Length in code points against the 50 / 72 convention. A guide, never a block. */
export function subjectGuide(subject: string): SubjectGuide {
  const count = [...subject].length
  const level = count <= SUBJECT_SOFT ? 'ok' : count <= SUBJECT_HARD ? 'long' : 'over'
  return { count, level, text: `${count}/${SUBJECT_SOFT}` }
}

// ---- draft ----

/** A saved amend draft: the fields typed against HEAD `head`. `on` = the switch
 * was on when it was saved. Only restored while HEAD is still `head`. */
export type AmendDraft = { head: string; subject: string; body: string; on: boolean }

export type CommitDraft = { subject: string; body: string; amend?: AmendDraft }

export const EMPTY_DRAFT: CommitDraft = { subject: '', body: '' }

/** One draft per project, repo and worktree path; null = no worktree path, so
 * nothing is stored. */
export function draftKey(projectId: number, repo: string | undefined, worktree: string | null) {
  return worktree === null ? null : `naru-git-commit-draft:${projectId}:${repo ?? ''}:${worktree}`
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Tolerant: anything that is not a draft record reads as the empty draft. */
export function parseDraft(raw: string | null): CommitDraft {
  if (raw === null) return EMPTY_DRAFT
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return EMPTY_DRAFT
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return EMPTY_DRAFT
  const o = v as Record<string, unknown>
  const draft: CommitDraft = { subject: str(o.subject), body: str(o.body) }
  const a = o.amend
  if (typeof a === 'object' && a !== null && !Array.isArray(a)) {
    const am = a as Record<string, unknown>
    if (typeof am.head === 'string' && am.head !== '') {
      draft.amend = { head: am.head, subject: str(am.subject), body: str(am.body), on: am.on === true }
    }
  }
  return draft
}

const blank = (f: Fields) => f.subject.trim() === '' && f.body.trim() === ''

/** The text to store, or null for an empty draft (its key is removed). */
export function serializeDraft(d: CommitDraft): string | null {
  const amend = d.amend !== undefined && !(blank(d.amend) && !d.amend.on) ? d.amend : undefined
  if (blank(d) && amend === undefined) return null
  return JSON.stringify(amend === undefined ? { subject: d.subject, body: d.body } : { ...d, amend })
}

function storage(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

export function loadDraft(key: string | null): CommitDraft {
  if (key === null) return EMPTY_DRAFT
  try {
    return parseDraft(storage()?.getItem(key) ?? null)
  } catch {
    return EMPTY_DRAFT
  }
}

export function saveDraft(key: string | null, d: CommitDraft) {
  if (key === null) return
  try {
    const s = serializeDraft(d)
    if (s === null) storage()?.removeItem(key)
    else storage()?.setItem(key, s)
  } catch {
    // private mode: the draft just is not kept
  }
}

/** Is the amend switch on for this HEAD? An amend draft belongs to the commit
 * it was typed against. */
export function amendingNow(d: CommitDraft, info: GitCommitInfo | null): boolean {
  const a = amendState(info)
  return (
    d.amend?.on === true &&
    a.offered &&
    !a.disabled &&
    info?.head != null &&
    d.amend.head === info.head.hash
  )
}

/** The two fields on screen: the amend draft while amending, else the ordinary one. */
export function activeFields(d: CommitDraft, amending: boolean): Fields {
  return amending && d.amend !== undefined ? d.amend : d
}

export function withFields(d: CommitDraft, amending: boolean, f: Partial<Fields>): CommitDraft {
  if (amending && d.amend !== undefined) return { ...d, amend: { ...d.amend, ...f } }
  return { ...d, ...f }
}

/** Switch on: the stored amend draft for this HEAD, else HEAD's message. The
 * ordinary fields are untouched. */
export function startAmend(d: CommitDraft, head: GitHeadCommit): CommitDraft {
  if (d.amend?.head === head.hash) return { ...d, amend: { ...d.amend, on: true } }
  return { ...d, amend: { head: head.hash, ...splitMessage(head.message), on: true } }
}

/** Switch off: the ordinary draft comes back as it was. The amend text is kept
 * for the same HEAD only when it was edited. */
export function stopAmend(d: CommitDraft, head: GitHeadCommit | null): CommitDraft {
  const a = d.amend
  if (a === undefined) return d
  const orig = head !== null && a.head === head.hash ? splitMessage(head.message) : null
  const edited = orig === null || orig.subject !== a.subject || orig.body !== a.body
  return { subject: d.subject, body: d.body, ...(edited ? { amend: { ...a, on: false } } : {}) }
}

export const STALE_AMEND_REASON = 'Decide what to do with your earlier amend text first.'

/** The amend draft whose commit is no longer HEAD (it moved while the person
 * was typing), when it is live or holds typed text; else null. While it
 * exists Amend cannot be re-ticked, so `startAmend` never replaces it. */
export function staleAmend(d: CommitDraft, info: GitCommitInfo | null): AmendDraft | null {
  const a = d.amend
  if (a === undefined || info === null) return null
  if (info.head?.hash === a.head) return null
  return a.on || !blank(a) ? a : null
}

export function staleAmendText(a: AmendDraft): string {
  return `The last commit changed since you started amending (your text was for ${a.head.slice(0, 7)}).`
}

/** "Use my text for the new commit": the typed text becomes an amend of the current HEAD. */
export function adoptStaleAmend(d: CommitDraft, head: GitHeadCommit): CommitDraft {
  const a = d.amend
  if (a === undefined) return d
  return { ...d, amend: { head: head.hash, subject: a.subject, body: a.body, on: true } }
}

/** "Discard it": the stale amend text goes; the ordinary draft is untouched. */
export function dropStaleAmend(d: CommitDraft): CommitDraft {
  return { subject: d.subject, body: d.body }
}

/** The draft after a commit went through: a plain commit clears everything
 * (the amend draft was typed against a HEAD that is no longer HEAD); an amend
 * keeps the ordinary draft that was set aside. */
export function afterSuccess(d: CommitDraft, amended: boolean): CommitDraft {
  return amended ? { subject: d.subject, body: d.body } : EMPTY_DRAFT
}

/** Mid merge, cherry-pick or revert the fields start from git's prepared
 * message, once, and only into an empty ordinary draft: typed text wins. */
export function applyPrepared(d: CommitDraft, info: GitCommitInfo): CommitDraft {
  const m = info.prepared_message
  if (m === null || m.trim() === '' || !blank(d)) return d
  return { ...d, ...splitMessage(m) }
}

// ---- the button ----

export const IDENTITY_FIX =
  'git config user.name "Your Name" and git config user.email you@example.com (add --global to set it for every repo)'

export type CommitStateIn = {
  /** Full path of the worktree; null = unknown. */
  worktree: string | null
  /** A write (stage, unstage, discard or this commit) is in flight. */
  busy: boolean
  /** Null until the commit info has loaded. */
  info: GitCommitInfo | null
  hasConflicts: boolean
  stagedCount: number
  subject: string
  amending: boolean
}

export type CommitState = { canCommit: boolean; reason: string | null; warnings: string[] }

const OPERATION_NAMES: Record<string, string> = {
  merge: 'merge',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
  rebase: 'rebase',
  bisect: 'bisect',
}

function operationWarning(op: string | null): string[] {
  if (op === null) return []
  if (op === 'merge' || op === 'cherry-pick' || op === 'revert') {
    return [`A ${OPERATION_NAMES[op]} is in progress: this commit concludes it.`]
  }
  return [`A ${OPERATION_NAMES[op] ?? op} is in progress in this worktree.`]
}

/** Whether the commit button works, why not (the first reason only), and the
 * lines to show whatever the answer. */
export function commitState(i: CommitStateIn): CommitState {
  const warnings: string[] = []
  if (i.info !== null) {
    if (i.info.detached) warnings.push('HEAD is detached: this commit will be on no branch.')
    warnings.push(...operationWarning(i.info.operation))
    if (i.amending && i.info.head_published && i.info.published_on !== null) {
      warnings.push(
        `The last commit is already on ${i.info.published_on}: amending it asks you to confirm first.`,
      )
    }
    if (i.amending && i.info.head_published && i.info.published_on === null) {
      warnings.push(
        'It could not be checked whether the last commit was pushed: amending it asks you to confirm first.',
      )
    }
    if (i.amending && i.info.head?.is_merge === true) {
      warnings.push('The last commit is a merge commit: amending it asks you to confirm first.')
    }
  }
  const no = (reason: string): CommitState => ({ canCommit: false, reason, warnings })
  if (i.worktree === null) return no('The worktree path is unknown.')
  if (i.busy) return no('Another change is in progress.')
  if (i.info === null) return no('Loading commit details…')
  if (i.hasConflicts) return no('Resolve the conflicts first.')
  if (i.info.author_name === null || i.info.author_email === null) {
    return no(`No git author identity is set. Run ${IDENTITY_FIX}.`)
  }
  if (i.subject.trim() === '') return no('Enter a commit message.')
  if (i.stagedCount === 0 && !i.amending && i.info.operation !== 'merge') {
    return no('Nothing is staged.')
  }
  return { canCommit: true, reason: null, warnings }
}

export type AmendState = { offered: boolean; disabled: boolean; reason: string | null }

/** Amend is not offered at all on an unborn HEAD, is shown but off during an
 * operation, and needs a HEAD commit to start from. */
export function amendState(info: GitCommitInfo | null): AmendState {
  if (info === null || info.unborn || info.head === null) {
    return { offered: false, disabled: true, reason: null }
  }
  if (info.operation !== null) {
    const op = OPERATION_NAMES[info.operation] ?? info.operation
    return {
      offered: true,
      disabled: true,
      reason: `A ${op} is in progress: finish or abort it before amending.`,
    }
  }
  return { offered: true, disabled: false, reason: null }
}

/** The dialog of an amend that asks first: the commit is already on a remote
 * branch (its upstream, or another one it was pushed to), it is a merge
 * commit, or both. Null when neither: that amend never asks. */
export function amendConfirmPlan(
  info: GitCommitInfo,
  worktree: string,
  branch: string,
): DiscardPlan | null {
  const head = info.head
  const merge = head?.is_merge === true
  if (!info.head_published && !merge) return null
  const on = info.published_on
  const line = head === null ? '' : `${head.short_hash} ${splitMessage(head.message).subject}`
  const consequences: string[] = []
  if (info.head_published && on !== null) {
    consequences.push(
      `This commit is already on ${on}.`,
      `Amending replaces it with a new commit, so ${branch} and ${on} diverge, and anyone who pulled the old commit keeps it.`,
    )
  } else if (info.head_published) {
    // The server's lookup failed or timed out; it fails closed (naru task 2802).
    consequences.push(
      'It could not be checked whether this commit was already pushed.',
      `If it was, amending replaces it with a new commit, so ${branch} and its remote branch diverge, and anyone who pulled the old commit keeps it.`,
    )
  }
  if (merge) {
    consequences.push(
      'This is a merge commit.',
      'Amending replaces it with a new merge commit of the same parents; anything staged becomes part of the merge itself.',
    )
  }
  return {
    title: !merge
      ? 'Amend a published commit?'
      : info.head_published
        ? 'Amend a published merge commit?'
        : 'Amend a merge commit?',
    worktree,
    branch,
    paths: [line],
    listed: [line],
    more: 0,
    consequences,
    confirmLabel: 'Amend commit',
    irreversible: 'This cannot be undone from here.',
    listLabel: 'The commit to be amended',
  }
}

// ---- labels ----

/** The button's text and aria-label: always names what it commits and where. */
export function commitButtonLabel(i: {
  worktree: string | null
  amending: boolean
  stagedCount: number
  info: GitCommitInfo | null
}): string {
  if (i.worktree === null) return 'Commit: unavailable, the worktree path is unknown'
  const where = `in ${shortFolder(i.worktree)}`
  const branch = i.info?.branch ?? 'detached HEAD'
  if (i.amending && i.info?.head != null) {
    return `Amend last commit ${i.info.head.short_hash} on ${branch} ${where}`
  }
  return i.stagedCount > 0
    ? `Commit ${plural(i.stagedCount, 'file')} to ${branch} ${where}`
    : `Commit to ${branch} ${where}`
}

/** "Committed abc1234" / "Amended abc1234". */
export function successText(amended: boolean, shortHash: string): string {
  return `${amended ? 'Amended' : 'Committed'} ${shortHash}`
}

// ---- double submit ----

/** A synchronous in-flight latch: `enter` is true once until `leave`. React
 * state is not enough for two keydowns before a render, so the box holds one of
 * these in a ref. */
export function createSubmitGuard() {
  let inFlight = false
  return {
    enter(): boolean {
      if (inFlight) return false
      inFlight = true
      return true
    },
    leave() {
      inFlight = false
    },
  }
}
