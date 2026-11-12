import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createGitRefActions, projectGitRefApi } from './gitActions'
import type { ConfirmPlan, RefOutcome } from './gitActions'
import { busyText, defaultSwitch, newBranchTitle, offersStashSwitch, switchToItReason } from './gitRefs'
import type { NewBranchSource, RefCtx } from './gitRefs'
import type { FormSpec, FormValues } from './components/GitFormDialog'
import type { GitBranch } from './types/GitBranch'
import type { GitStash } from './types/GitStash'

/** The error banner: what was attempted, git's message verbatim, and (after a
 * refused switch on a dirty tree) the branch the "Stash and switch" button is for. */
export type RefAlert = { prefix: string; message: string; stashSwitch: string | null }

/** The Git tab's branch and stash actions (naru task 2741): the gate, the open
 * form or confirm, the status line, the alert and the notice. */
export type GitRefOps = ReturnType<typeof useGitRefOps>

/**
 * Lives in `GitRepoPane`, not in the side panel: a drawer panel unmounts when
 * it closes, and History's "Create branch here" has to work with it closed.
 * `busy` is the tab's one write flag (shared with the working tree's writes
 * and the commit box). `onChanged` re-reads everything after EVERY attempt
 * that reached the server, success or failure; nothing retries.
 */
export function useGitRefOps({
  projectId,
  repo,
  ctx,
  busy,
  setBusy,
  onChanged,
  onBranchGone,
}: {
  projectId: number
  repo: string | undefined
  ctx: RefCtx
  busy: boolean
  setBusy: (b: boolean) => void
  onChanged: () => Promise<void>
  /** A branch was renamed or deleted: drop a History scope on it. */
  onBranchGone: (name: string) => void
}) {
  const [status, setStatus] = useState<string | null>(null)
  const [alert, setAlert] = useState<RefAlert | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [form, setForm] = useState<{ spec: FormSpec; source: NewBranchSource | null } | null>(null)
  const [pending, setPending] = useState<{
    plan: ConfirmPlan
    resolve: (ok: boolean) => void
  } | null>(null)
  const pendingRef = useRef(pending)
  const busyRef = useRef(false)
  const worktreeRef = useRef(ctx.worktree)
  useEffect(() => {
    worktreeRef.current = ctx.worktree
  })
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  // A form or dialog never outlives the worktree it was opened for.
  const [prevWorktree, setPrevWorktree] = useState(ctx.worktree)
  if (ctx.worktree !== prevWorktree) {
    setPrevWorktree(ctx.worktree)
    setForm(null)
    setPending(null)
    setAlert(null)
    setNotice(null)
  }
  useEffect(
    () => () => {
      pendingRef.current?.resolve(false)
    },
    [ctx.worktree],
  )

  const confirm = useCallback(
    (plan: ConfirmPlan) => new Promise<boolean>((resolve) => setPending({ plan, resolve })),
    [],
  )
  const resolvePending = useCallback((ok: boolean) => {
    pendingRef.current?.resolve(ok)
    setPending(null)
  }, [])
  const actions = useMemo(
    () => createGitRefActions({ api: projectGitRefApi(projectId), confirm }),
    [projectId, confirm],
  )

  const wctx = { worktree: ctx.worktree, branch: ctx.branch, repo }
  const info = { isMain: ctx.isMain, linked: ctx.linked, detached: ctx.detached }

  /** Runs one write: busy for its whole length (the dialogs included), every
   * view re-read after it whatever happened. Null = it was not started. */
  async function run(
    what: string,
    op: () => Promise<RefOutcome>,
    after?: (out: Extract<RefOutcome, { ok: true }>) => void,
    inline = false,
  ): Promise<RefOutcome | null> {
    if (busy || busyRef.current) return null
    busyRef.current = true
    setBusy(true)
    setStatus(what)
    setAlert(null)
    setNotice(null)
    try {
      const out = await op()
      // A gone branch's scope is dropped BEFORE the re-read, so History does
      // not reload once against a ref that no longer exists.
      if (out.ok) after?.(out)
      if (out.ok || out.reason === 'error') {
        try {
          await onChanged()
        } catch {
          // the next focus refetch matches reality
        }
      }
      if (out.ok) {
        if (out.notice !== null) setNotice(out.notice)
      } else if (out.reason === 'error' && !inline) {
        setAlert({ prefix: out.prefix, message: out.message, stashSwitch: null })
      } else if (out.reason === 'no-worktree') {
        setAlert({ prefix: 'Nothing was sent:', message: 'The worktree path is unknown.', stashSwitch: null })
      }
      return out
    } finally {
      busyRef.current = false
      setBusy(false)
      setStatus(null)
    }
  }

  const stashSwitchOffer = (name: string, out: RefOutcome | null) => {
    if (out === null || out.ok || out.reason !== 'error' || !offersStashSwitch(out)) return
    setAlert((a) => (a === null ? a : { ...a, stashSwitch: name }))
  }

  return {
    busy,
    /** The status line while a write runs. */
    status,
    alert,
    notice,
    form,
    pending,
    resolvePending,
    /** A form or confirm is open: every write control is off. */
    dialogOpen: form !== null || pending !== null,
    dismiss: () => {
      setAlert(null)
      setNotice(null)
    },

    openCreate(src: NewBranchSource) {
      const from =
        src.kind === 'head'
          ? ctx.detached
            ? `From HEAD, detached at ${ctx.branch}.`
            : `From the tip of ${ctx.branch}.`
          : src.kind === 'commit'
            ? `From commit ${src.sha}.`
            : `From ${src.name}.`
      setForm({
        source: src,
        spec: {
          kind: 'create',
          title: newBranchTitle(src, ctx),
          from,
          switchDefault: defaultSwitch(src, ctx),
          switchOff: switchToItReason(ctx),
          source: src,
        },
      })
    },
    openRename(b: GitBranch) {
      setForm({ source: null, spec: { kind: 'rename', name: b.name, current: b.is_head } })
    },
    openStash() {
      setForm({ source: null, spec: { kind: 'stash' } })
    },
    closeForm() {
      if (!busyRef.current) setForm(null)
    },
    /** Resolves to the failure to show inline in the open form, or null. */
    async submitForm(v: FormValues): Promise<{ prefix: string; message: string } | null> {
      const f = form
      if (f === null) return null
      const spec = f.spec
      let out: RefOutcome | null
      if (spec.kind === 'create') {
        const src = spec.source
        out = await run(
          busyText({ kind: 'create', name: v.name }),
          () =>
            actions.createBranch(wctx, {
              name: v.name,
              fromCommit: src.kind === 'commit' ? src.sha : undefined,
              fromRemote: src.kind === 'remote' ? src.name : undefined,
              switch: v.switch,
              info,
            }),
          undefined,
          true,
        )
      } else if (spec.kind === 'rename') {
        const old = spec.name
        out = await run(
          busyText({ kind: 'rename', name: old, to: v.name }),
          () => actions.renameBranch(wctx, old, v.name),
          () => onBranchGone(old),
          true,
        )
      } else {
        out = await run(
          busyText({ kind: 'stash' }),
          () => actions.pushStash(wctx, v.message, v.untracked),
          undefined,
          true,
        )
      }
      if (out === null) return null
      if (out.ok) {
        setForm(null)
        return null
      }
      if (out.reason === 'error') return { prefix: out.prefix, message: out.message }
      return null
    },

    async switchTo(b: GitBranch) {
      const out = await run(busyText({ kind: 'switch', name: b.name, stash: false }), () =>
        actions.switchBranch(wctx, b.name, info),
      )
      stashSwitchOffer(b.name, out)
    },
    /** Only the explicit "Stash and switch" button of the alert. */
    async stashSwitch(name: string) {
      await run(busyText({ kind: 'switch', name, stash: true }), () =>
        actions.stashAndSwitch(wctx, name, info),
      )
    },
    async deleteBranch(b: GitBranch) {
      await run(
        busyText({ kind: 'delete', name: b.name }),
        () => actions.deleteBranch(wctx, b.name, b.hash, () => worktreeRef.current === wctx.worktree),
        (out) => {
          if (out.deleted === true) onBranchGone(b.name)
        },
      )
    },
    async apply(s: GitStash) {
      await run(busyText({ kind: 'apply', stash: s.name }), () =>
        actions.applyStash(wctx, { stash: s }),
      )
    },
    async pop(s: GitStash) {
      await run(busyText({ kind: 'pop', stash: s.name }), () =>
        actions.popStash(wctx, { stash: s }),
      )
    },
    async drop(s: GitStash) {
      await run(busyText({ kind: 'drop', stash: s.name }), () =>
        actions.dropStash(wctx, { stash: s }),
      )
    },
  }
}
