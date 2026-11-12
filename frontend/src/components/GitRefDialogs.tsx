import { useMemo } from 'react'
import { getProjectGitBranches } from '../api'
import type { RefCtx } from '../gitRefs'
import type { GitRefOps } from '../useGitRefOps'
import { useFetch } from '../useFetch'
import { GitConfirmDialog } from './GitConfirmDialog'
import { GitFormDialog } from './GitFormDialog'
import type { FormSpec } from './GitFormDialog'

/** The open form needs the local names for its "already exists" check; read
 * once when it opens (the server checks again). */
function FormHost({
  projectId,
  repo,
  ctx,
  spec,
  ops,
}: {
  projectId: number
  repo: string | undefined
  ctx: RefCtx
  spec: FormSpec
  ops: GitRefOps
}) {
  const { data } = useFetch(
    () => getProjectGitBranches(projectId, ctx.worktree ?? undefined, repo),
    `git-form-br-${projectId}-${repo ?? ''}-${ctx.worktree ?? ''}`,
  )
  const existing = useMemo(
    () => (data?.branches ?? []).filter((b) => b.kind === 'local').map((b) => b.name),
    [data],
  )
  return (
    <GitFormDialog
      spec={spec}
      ctx={ctx}
      existing={existing}
      busy={ops.busy}
      suspended={ops.pending !== null}
      onSubmit={ops.submitForm}
      onCancel={ops.closeForm}
    />
  )
}

/** The branch and stash forms and confirms (naru task 2741), mounted by
 * `GitRepoPane` so they work with the side panel closed. */
export function GitRefDialogs({
  projectId,
  repo,
  ctx,
  ops,
}: {
  projectId: number
  repo: string | undefined
  ctx: RefCtx
  ops: GitRefOps
}) {
  return (
    <>
      {ops.form !== null && (
        <FormHost projectId={projectId} repo={repo} ctx={ctx} spec={ops.form.spec} ops={ops} />
      )}
      {ops.pending !== null && (
        <GitConfirmDialog key={ops.pending.plan.title} plan={ops.pending.plan} onResolve={ops.resolvePending} />
      )}
    </>
  )
}
