import { useState } from 'react'
import { WorkflowBuilderView } from '../pages/WorkflowBuilderView'
import { WorkflowListView } from '../pages/WorkflowListView'

/**
 * The Workflows dock panel (mesa task 1567, 1607): the workflows of the
 * project the route is on, listed and opened in place — the same two views
 * the project's Workflows tab shows, so a graph can sit beside a page that is
 * about something else. A link inside the list would navigate the *main*
 * panel to the builder's route; here it opens the builder in this panel
 * instead and leaves the route alone.
 */
export function WorkflowsPanel({ projectId }: { projectId: number | null }) {
  // The workflow open here, with the project it belongs to: switching project
  // in the route must not keep showing the previous project's graph.
  const [open, setOpen] = useState<{ projectId: number; id: number } | null>(null)
  if (projectId === null) {
    return (
      <p className="muted dock-empty-note">Open a project to see its workflows here.</p>
    )
  }
  const showing = open !== null && open.projectId === projectId ? open.id : null
  return (
    <div
      className="dock-workflows"
      onClickCapture={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        const m = a && /#\/projects\/(\d+)\/workflows\/(\d+)$/.exec(a.getAttribute('href') ?? '')
        if (!m || e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        setOpen({ projectId: Number(m[1]), id: Number(m[2]) })
      }}
    >
      {showing !== null ? (
        <>
          <button type="button" className="dock-workflows-back" onClick={() => setOpen(null)}>
            ← workflows
          </button>
          <WorkflowBuilderView key={showing} projectId={projectId} workflowId={showing} onDeleted={() => setOpen(null)} />
        </>
      ) : (
        <WorkflowListView projectId={projectId} />
      )}
    </div>
  )
}
