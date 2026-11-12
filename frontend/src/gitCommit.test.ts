import { describe, expect, it } from 'vitest'
import {
  adoptStaleAmend,
  afterSuccess,
  amendConfirmPlan,
  dropStaleAmend,
  staleAmend,
  amendState,
  amendingNow,
  applyPrepared,
  commitButtonLabel,
  commitState,
  composeMessage,
  createSubmitGuard,
  draftKey,
  parseDraft,
  serializeDraft,
  splitMessage,
  startAmend,
  stopAmend,
  subjectGuide,
  successText,
  withFields,
  activeFields,
} from './gitCommit'
import type { CommitStateIn } from './gitCommit'
import type { GitCommitInfo } from './types/GitCommitInfo'

const WT = '/Users/me/code/app-wt'
const head = { hash: 'a'.repeat(40), short_hash: 'abc1234', message: 'Fix the thing\n\nLonger why.\n', is_merge: false }
const info = (o: Partial<GitCommitInfo> = {}): GitCommitInfo => ({
  branch: 'main',
  detached: false,
  unborn: false,
  head,
  upstream: null,
  head_published: false,
  published_on: null,
  author_name: 'Ada',
  author_email: 'ada@example.com',
  operation: null,
  prepared_message: null,
  ...o,
})
const inp = (o: Partial<CommitStateIn> = {}): CommitStateIn => ({
  worktree: WT,
  busy: false,
  info: info(),
  hasConflicts: false,
  stagedCount: 2,
  subject: 'Do it',
  amending: false,
  ...o,
})

describe('message', () => {
  it('composes subject and body with one blank line, or the subject alone', () => {
    expect(composeMessage('s', 'b')).toBe('s\n\nb')
    expect(composeMessage('s', '')).toBe('s')
    expect(composeMessage('s', '  \n ')).toBe('s')
  })

  it('splits at the first line and the blank separator, dropping the trailing newline', () => {
    expect(splitMessage('s\n\nb1\nb2\n')).toEqual({ subject: 's', body: 'b1\nb2' })
    expect(splitMessage('only\n')).toEqual({ subject: 'only', body: '' })
    expect(splitMessage('s\r\n\r\nb\r\n')).toEqual({ subject: 's', body: 'b' })
    expect(splitMessage('s\nno blank')).toEqual({ subject: 's', body: 'no blank' })
  })

  it('round-trips', () => {
    const cases = [
      { subject: 's', body: '' },
      { subject: 's', body: 'b' },
      { subject: 's', body: 'l1\n\nl2\n  indented' },
      { subject: '# not a comment', body: '# also kept' },
      { subject: 's', body: '\nstarts with a blank line' },
    ]
    for (const f of cases) expect(splitMessage(composeMessage(f.subject, f.body))).toEqual(f)
    for (const m of ['s', 's\n\nb', 's\n\nb\n\nc']) expect(composeMessage(...Object.values(splitMessage(m)) as [string, string])).toBe(m)
  })
})

describe('subject guide', () => {
  it('counts code points against 50 and 72', () => {
    expect(subjectGuide('a'.repeat(50))).toEqual({ count: 50, level: 'ok', text: '50/50' })
    expect(subjectGuide('a'.repeat(51)).level).toBe('long')
    expect(subjectGuide('a'.repeat(52)).text).toBe('52/50')
    expect(subjectGuide('a'.repeat(72)).level).toBe('long')
    expect(subjectGuide('a'.repeat(73)).level).toBe('over')
    expect(subjectGuide('😀'.repeat(50)).count).toBe(50)
  })
})

describe('draft', () => {
  it('has one key per project, repo and worktree, and none without a worktree', () => {
    expect(draftKey(3, undefined, WT)).toBe(`naru-git-commit-draft:3::${WT}`)
    expect(draftKey(3, 'sub', WT)).not.toBe(draftKey(3, undefined, WT))
    expect(draftKey(3, undefined, '/other')).not.toBe(draftKey(3, undefined, WT))
    expect(draftKey(3, undefined, null)).toBeNull()
  })

  it('parses tolerantly: garbage is the empty draft', () => {
    for (const raw of [null, '', 'nope', '[]', '3', 'null', '{"subject":4,"body":[]}']) {
      expect(parseDraft(raw)).toEqual({ subject: '', body: '' })
    }
    expect(parseDraft('{"subject":"s","body":"b"}')).toEqual({ subject: 's', body: 'b' })
    expect(parseDraft('{"subject":"s","amend":{"head":"h","subject":"x"}}')).toEqual({
      subject: 's',
      body: '',
      amend: { head: 'h', subject: 'x', body: '', on: false },
    })
    expect(parseDraft('{"amend":{"subject":"x"}}')).toEqual({ subject: '', body: '' })
  })

  it('serializes an empty draft to null (its key is removed) and round-trips the rest', () => {
    expect(serializeDraft({ subject: '', body: '' })).toBeNull()
    expect(serializeDraft({ subject: ' ', body: '\n' })).toBeNull()
    const d = { subject: 's', body: 'b', amend: { head: 'h', subject: 'x', body: 'y', on: true } }
    expect(parseDraft(serializeDraft(d))).toEqual(d)
    expect(serializeDraft({ subject: '', body: '', amend: { head: 'h', subject: '', body: '', on: false } })).toBeNull()
  })

  it('amend loads HEAD message, keeps the ordinary draft, and restores only for the same HEAD', () => {
    const ordinary = { subject: 'typed', body: 'text' }
    const on = startAmend(ordinary, head)
    expect(on.amend).toMatchObject({ head: head.hash, subject: 'Fix the thing', body: 'Longer why.', on: true })
    expect(amendingNow(on, info())).toBe(true)
    expect(activeFields(on, true)).toMatchObject({ subject: 'Fix the thing' })
    const edited = withFields(on, true, { subject: 'Better' })
    expect(edited.subject).toBe('typed')
    // off: the ordinary draft returns untouched; the edit is kept for this HEAD
    const off = stopAmend(edited, head)
    expect(off).toMatchObject({ subject: 'typed', body: 'text' })
    expect(off.amend).toMatchObject({ subject: 'Better', on: false })
    expect(amendingNow(off, info())).toBe(false)
    expect(startAmend(off, head).amend).toMatchObject({ subject: 'Better', on: true })
    // unedited amend text is not kept
    expect(stopAmend(on, head).amend).toBeUndefined()
    // HEAD moved: the stored amend draft is not restored
    expect(amendingNow(on, info({ head: { ...head, hash: 'b'.repeat(40) } }))).toBe(false)
    expect(startAmend(off, { ...head, hash: 'b'.repeat(40) }).amend).toMatchObject({ subject: 'Fix the thing' })
    // an operation or an unborn HEAD turns it off
    expect(amendingNow(on, info({ operation: 'merge' }))).toBe(false)
    expect(amendingNow(on, info({ unborn: true, head: null }))).toBe(false)
    expect(amendingNow(on, null)).toBe(false)
  })

  it('clears on success; an amend keeps the ordinary draft that was set aside', () => {
    const d = startAmend({ subject: 'typed', body: '' }, head)
    expect(afterSuccess(d, false)).toEqual({ subject: '', body: '' })
    expect(afterSuccess(d, true)).toEqual({ subject: 'typed', body: '' })
  })

  it('merge default fills an empty draft only, never typed text', () => {
    const m = info({ operation: 'merge', prepared_message: "Merge branch 'x'\n\nConflicts:\n" })
    expect(applyPrepared({ subject: '', body: '' }, m)).toMatchObject({ subject: "Merge branch 'x'", body: 'Conflicts:' })
    const typed = { subject: 'mine', body: '' }
    expect(applyPrepared(typed, m)).toBe(typed)
    expect(applyPrepared({ subject: '', body: '' }, info()).subject).toBe('')
  })
})

describe('HEAD moved under an amend', () => {
  const moved = info({ head: { ...head, hash: 'b'.repeat(40), short_hash: 'bbbbbbb' } })
  const typed = withFields(startAmend({ subject: 'ord', body: '' }, head), true, { subject: 'My text' })

  it('a live or edited amend draft for another HEAD is stale; same HEAD, none or unloaded is not', () => {
    expect(staleAmend(typed, moved)?.subject).toBe('My text')
    expect(staleAmend(typed, info())).toBeNull()
    expect(staleAmend(typed, null)).toBeNull()
    expect(staleAmend({ subject: 'x', body: '' }, moved)).toBeNull()
    const off = stopAmend(typed, head)
    expect(staleAmend(off, moved)?.on).toBe(false)
    const blankOff = { subject: '', body: '', amend: { head: head.hash, subject: '', body: '', on: false } }
    expect(staleAmend(blankOff, moved)).toBeNull()
    expect(staleAmend(typed, info({ head: null, unborn: true }))).not.toBeNull()
  })

  it('use-my-text re-aims the typed text at the new HEAD; discard keeps the ordinary draft', () => {
    const used = adoptStaleAmend(typed, moved.head!)
    expect(used.amend).toEqual({ head: 'b'.repeat(40), subject: 'My text', body: 'Longer why.', on: true })
    expect(used.subject).toBe('ord')
    expect(amendingNow(used, moved)).toBe(true)
    expect(staleAmend(used, moved)).toBeNull()
    expect(dropStaleAmend(typed)).toEqual({ subject: 'ord', body: '' })
  })

  it('a plain commit success still clears the amend draft', () => {
    expect(afterSuccess(typed, false)).toEqual({ subject: '', body: '' })
  })
})

describe('commitState', () => {
  it('commits when everything is in place', () => {
    expect(commitState(inp())).toEqual({ canCommit: true, reason: null, warnings: [] })
  })

  it('says why not, first reason wins', () => {
    expect(commitState(inp({ worktree: null })).reason).toBe('The worktree path is unknown.')
    expect(commitState(inp({ busy: true })).reason).toBe('Another change is in progress.')
    expect(commitState(inp({ info: null })).reason).toBe('Loading commit details…')
    expect(commitState(inp({ hasConflicts: true })).reason).toBe('Resolve the conflicts first.')
    const noId = commitState(inp({ info: info({ author_email: null }) }))
    expect(noId.canCommit).toBe(false)
    expect(noId.reason).toContain('git config user.name "Your Name"')
    expect(noId.reason).toContain('git config user.email you@example.com')
    expect(noId.reason).toContain('--global')
    expect(commitState(inp({ subject: '  ' })).reason).toBe('Enter a commit message.')
    expect(commitState(inp({ stagedCount: 0 })).reason).toBe('Nothing is staged.')
  })

  it('nothing staged is fine when amending or mid-merge', () => {
    expect(commitState(inp({ stagedCount: 0, amending: true })).canCommit).toBe(true)
    expect(commitState(inp({ stagedCount: 0, info: info({ operation: 'merge' }) })).canCommit).toBe(true)
    expect(commitState(inp({ stagedCount: 0, info: info({ operation: 'revert' }) })).canCommit).toBe(false)
  })

  it('warns about a detached HEAD, an operation and a published amend', () => {
    expect(commitState(inp({ info: info({ detached: true, branch: null }) })).warnings).toEqual([
      'HEAD is detached: this commit will be on no branch.',
    ])
    expect(commitState(inp({ info: info({ operation: 'merge' }) })).warnings).toEqual([
      'A merge is in progress: this commit concludes it.',
    ])
    expect(commitState(inp({ info: info({ operation: 'rebase' }) })).warnings[0]).toContain('rebase')
    const pub = info({ upstream: 'origin/main', head_published: true, published_on: 'origin/main' })
    expect(commitState(inp({ info: pub, amending: true })).warnings[0]).toContain('origin/main')
    expect(commitState(inp({ info: pub })).warnings).toEqual([])
    // Pushed without an upstream: the remote branch that holds it is named.
    const loose = info({ head_published: true, published_on: 'origin/feat' })
    expect(commitState(inp({ info: loose, amending: true })).warnings).toEqual([
      'The last commit is already on origin/feat: amending it asks you to confirm first.',
    ])
    const merge = info({ head: { ...head, is_merge: true } })
    expect(commitState(inp({ info: merge, amending: true })).warnings).toEqual([
      'The last commit is a merge commit: amending it asks you to confirm first.',
    ])
    expect(commitState(inp({ info: merge })).warnings).toEqual([])
  })
})

describe('amendState', () => {
  it('is not offered without a HEAD, disabled with a reason during an operation', () => {
    expect(amendState(null).offered).toBe(false)
    expect(amendState(info({ unborn: true, head: null })).offered).toBe(false)
    expect(amendState(info({ head: null })).offered).toBe(false)
    expect(amendState(info())).toEqual({ offered: true, disabled: false, reason: null })
    const op = amendState(info({ operation: 'rebase' }))
    expect(op).toMatchObject({ offered: true, disabled: true })
    expect(op.reason).toContain('rebase')
  })
})

describe('amend confirm dialog', () => {
  it('is null for an ordinary unpublished commit', () => {
    expect(amendConfirmPlan(info(), WT, 'main')).toBeNull()
  })

  it('a commit pushed without an upstream names the remote branch that holds it', () => {
    const p = amendConfirmPlan(info({ head_published: true, published_on: 'origin/feat' }), WT, 'feat')!
    expect(p.title).toBe('Amend a published commit?')
    expect(p.consequences[0]).toBe('This commit is already on origin/feat.')
    expect(p.consequences[1]).toContain('feat and origin/feat diverge')
  })

  it('a merge commit says so, alone or with the published lines', () => {
    const merged = { ...head, is_merge: true }
    const m = amendConfirmPlan(info({ head: merged }), WT, 'main')!
    expect(m.title).toBe('Amend a merge commit?')
    expect(m.consequences).toEqual([
      'This is a merge commit.',
      'Amending replaces it with a new merge commit of the same parents; anything staged becomes part of the merge itself.',
    ])
    expect(m.listed).toEqual(['abc1234 Fix the thing'])
    expect(m.confirmLabel).toBe('Amend commit')
    const both = amendConfirmPlan(
      info({ head: merged, upstream: 'origin/main', head_published: true, published_on: 'origin/main' }),
      WT,
      'main',
    )!
    expect(both.title).toBe('Amend a published merge commit?')
    expect(both.consequences).toHaveLength(4)
    expect(both.consequences[0]).toBe('This commit is already on origin/main.')
    expect(both.consequences[2]).toBe('This is a merge commit.')
  })

  it('names the worktree, branch, commit and the consequence', () => {
    const p = amendConfirmPlan(
      info({ upstream: 'origin/main', head_published: true, published_on: 'origin/main' }),
      WT,
      'main',
    )!
    expect(p.title).toBe('Amend a published commit?')
    expect(p.worktree).toBe(WT)
    expect(p.branch).toBe('main')
    expect(p.listed).toEqual(['abc1234 Fix the thing'])
    expect(p.more).toBe(0)
    expect(p.consequences[0]).toBe('This commit is already on origin/main.')
    expect(p.consequences[1]).toContain('diverge')
    expect(p.consequences[1]).toContain('anyone who pulled')
    expect(p.confirmLabel).toBe('Amend commit')
    expect(p.irreversible).not.toBe('')
  })
})

describe('labels', () => {
  it('always name what and where', () => {
    const base = { worktree: WT, amending: false, stagedCount: 3, info: info() }
    expect(commitButtonLabel(base)).toBe('Commit 3 files to main in …/code/app-wt')
    expect(commitButtonLabel({ ...base, stagedCount: 1 })).toBe('Commit 1 file to main in …/code/app-wt')
    expect(commitButtonLabel({ ...base, amending: true })).toBe(
      'Amend last commit abc1234 on main in …/code/app-wt',
    )
    expect(commitButtonLabel({ ...base, info: info({ branch: null, detached: true }) })).toContain('detached HEAD')
    expect(commitButtonLabel({ ...base, worktree: null })).toContain('unavailable')
  })

  it('success text', () => {
    expect(successText(false, 'abc1234')).toBe('Committed abc1234')
    expect(successText(true, 'abc1234')).toBe('Amended abc1234')
  })
})

describe('submit guard', () => {
  it('lets only one of two synchronous entries through until it leaves', () => {
    const g = createSubmitGuard()
    expect([g.enter(), g.enter()]).toEqual([true, false])
    g.leave()
    expect(g.enter()).toBe(true)
  })
})
