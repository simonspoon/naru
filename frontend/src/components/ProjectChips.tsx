import type { ProjectStatus } from '../projectStatus'

/**
 * A project's status chips (naru task 2805): queued and running task counts,
 * the branch when it is not the default, and a dot for uncommitted or unpushed
 * work. Zero counts render nothing, so a quiet project shows no chips.
 */
export function ProjectChips({ status }: { status: ProjectStatus }) {
  const { queued, running, branch, dirty } = status
  if (queued === 0 && running === 0 && branch === null && !dirty) return null
  return (
    <span className="pstat">
      {dirty && <span className="pstat-dot" title="uncommitted or unpushed changes" />}
      {branch !== null && (
        <span className="pstat-br" title={`branch ${branch}`}>
          {branch}
        </span>
      )}
      {queued > 0 && (
        <span className="pstat-chip pstat-q" title={`${queued} queued`}>
          {queued}
        </span>
      )}
      {running > 0 && (
        <span className="pstat-chip pstat-run" title={`${running} running`}>
          {running}
        </span>
      )}
    </span>
  )
}
