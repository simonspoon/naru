import { useState } from 'react'
import {
  ACTIONS,
  CATEGORIES,
  behaviorLabel,
  filterActions,
  type ActionBehavior,
  type ActionCategory,
} from '../gestureBindings'

/** Settings > Gestures: search + category list + action list, and the
 *  behavior (toggle / always on / always off) of the selected action. */
export function ActionPicker({
  action,
  behavior,
  onPick,
  onDone,
}: {
  action: string
  behavior: ActionBehavior
  onPick: (action: string, behavior: ActionBehavior) => void
  onDone: () => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ActionCategory | null>(null)
  const list = filterActions(query, category)
  const chosen = ACTIONS.find((a) => a.id === action)

  return (
    <div className="gest-picker">
      <input
        type="search"
        autoFocus
        value={query}
        placeholder="Search actions"
        aria-label="search actions"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="gest-picker-body">
        <div className="gest-cats" role="group" aria-label="categories">
          <button type="button" className={category === null ? 'active' : ''} onClick={() => setCategory(null)}>
            All
          </button>
          {CATEGORIES.map((c) => (
            <button key={c} type="button" className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
        <ul className="gest-actions" aria-label="actions">
          {list.length === 0 && <li className="muted">No actions match</li>}
          {list.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className={a.id === action ? 'active' : ''}
                aria-pressed={a.id === action}
                onClick={() => onPick(a.id, 'toggle')}
              >
                <span>{a.label}</span> <span className="muted">{a.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="gest-picker-foot">
        <span>
          Selected: <strong>{chosen?.label ?? 'none'}</strong>
          {chosen?.behaviors && <> · Behavior: {behaviorLabel(behavior)}</>}
        </span>
        {chosen?.behaviors && (
          <span className="gest-seg" role="group" aria-label="behavior">
            {chosen.behaviors.map((b) => (
              <button
                key={b}
                type="button"
                className={b === behavior ? 'active' : ''}
                aria-pressed={b === behavior}
                onClick={() => onPick(chosen.id, b)}
              >
                {behaviorLabel(b)}
              </button>
            ))}
          </span>
        )}
        <button type="button" className="gest-primary" disabled={!chosen} onClick={onDone}>
          Use action
        </button>
      </div>
    </div>
  )
}
