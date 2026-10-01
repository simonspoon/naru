import { useState } from 'react'
import { DiagramBoardView } from '../pages/DiagramBoardView'
import { DiagramListView } from '../pages/DiagramListView'

/**
 * The Diagrams dock panel (mesa task 1567): the boards of the project the
 * route is on, listed and opened in place — the same two views the project's
 * Diagrams tab shows, so a board can sit beside a page that is about
 * something else. A link inside the list would navigate the *main* panel to
 * the board's route; here it opens the board in this panel instead and leaves
 * the route alone.
 */
export function DiagramsPanel({ projectId }: { projectId: number | null }) {
  // The board open here, with the project it belongs to: switching project in
  // the route must not keep showing the previous project's board.
  const [open, setOpen] = useState<{ projectId: number; id: number } | null>(null)
  if (projectId === null) {
    return (
      <p className="muted dock-empty-note">Open a project to see its diagrams here.</p>
    )
  }
  const showing = open !== null && open.projectId === projectId ? open.id : null
  return (
    <div
      className="dock-diagrams"
      onClickCapture={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        const m = a && /#\/projects\/(\d+)\/diagrams\/(\d+)$/.exec(a.getAttribute('href') ?? '')
        if (!m || e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        setOpen({ projectId: Number(m[1]), id: Number(m[2]) })
      }}
    >
      {showing !== null ? (
        <>
          <button type="button" className="dock-diagrams-back" onClick={() => setOpen(null)}>
            ← diagrams
          </button>
          <DiagramBoardView projectId={projectId} diagramId={showing} />
        </>
      ) : (
        <DiagramListView projectId={projectId} />
      )}
    </div>
  )
}
