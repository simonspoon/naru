import { useRef, useState } from 'react'
import { Markdown } from '../Markdown'
import { groupItems, moveSelection, type ListDetailProps } from '../../templateSpec'

/** A grouped list beside a markdown detail. Selection is internal (a
 * `selectedId` prop change re-seeds it; `onSelect` reports each pick). Up/Down
 * move it. On a phone the two stack: picking an item shows its detail with a
 * back button. */
export function ListDetail({
  items,
  details,
  selectedId,
  emptyList,
  emptyDetail,
  onSelect,
}: ListDetailProps & { onSelect?: (id: string) => void }) {
  const [sel, setSel] = useState<string | null>(selectedId ?? null)
  const [seen, setSeen] = useState(selectedId)
  if (selectedId !== seen) {
    setSeen(selectedId)
    setSel(selectedId ?? null)
  }
  const listRef = useRef<HTMLDivElement>(null)
  const ids = items.map((i) => i.id)

  function pick(id: string) {
    setSel(id)
    onSelect?.(id)
  }
  function onKeyDown(e: React.KeyboardEvent) {
    const delta = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!delta) return
    e.preventDefault()
    const next = moveSelection(ids, sel, delta)
    if (next === null) return
    pick(next)
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`)?.focus()
    })
  }

  const detail = sel !== null ? details[sel] : undefined
  return (
    <div className="tpl-ld" data-view={sel !== null ? 'detail' : 'list'}>
      <div className="tpl-ld-list" ref={listRef} onKeyDown={onKeyDown}>
        {items.length === 0 && <p className="muted">{emptyList ?? 'Nothing to show.'}</p>}
        {groupItems(items).map((g) => (
          <div key={g.group ?? ''}>
            {g.group !== null && (
              <div className="tpl-ld-group">
                {g.group} ({g.items.length})
              </div>
            )}
            {g.items.map((it) => (
              <button
                key={it.id}
                type="button"
                data-id={it.id}
                className={`tpl-ld-item${it.id === sel ? ' active' : ''}`}
                aria-current={it.id === sel ? 'true' : undefined}
                onClick={() => pick(it.id)}
              >
                <span className="tpl-ld-title">{it.title}</span>
                {it.meta && it.meta.length > 0 && <span className="tpl-meta">{it.meta.join(' · ')}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="tpl-ld-detail">
        {sel !== null && (
          <button type="button" className="tpl-ld-back" onClick={() => setSel(null)}>
            ‹ Back
          </button>
        )}
        {detail ? (
          <>
            {detail.title && <h2>{detail.title}</h2>}
            <Markdown text={detail.body} />
          </>
        ) : (
          <p className="muted">{emptyDetail ?? 'Pick an item.'}</p>
        )}
      </div>
    </div>
  )
}
