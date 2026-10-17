// The typed-pins editors of the workflow builder (naru task 1981): the type
// picker, a node's pin list, and the "Type: Review" card that defines a
// workflow's struct types. All logic lives in `workflowTypes.ts`.

import { useEffect, useState } from 'react'
import { updateWorkflow } from '../api'
import type { WorkflowNode } from '../types/WorkflowNode'
import type { WorkflowType } from '../types/WorkflowType'
import {
  PRIMITIVES,
  listElem,
  listOf,
  typeUsages,
  validateTypeDraft,
  type NodePinSet,
} from '../workflowTypes'

/** One type picker: primitives, `list of…` (with a nested picker for the
 *  element), then the workflow's structs. */
export function TypeSelect({
  value,
  types,
  onChange,
  label,
}: {
  value: string
  types: readonly WorkflowType[]
  onChange: (ty: string) => void
  label: string
}) {
  const elem = listElem(value)
  return (
    <span className="wf-type-select">
      <select
        aria-label={label}
        value={elem !== null ? 'list' : value}
        onChange={(e) => onChange(e.target.value === 'list' ? listOf(elem ?? 'any') : e.target.value)}
      >
        {PRIMITIVES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        <option value="list">list of…</option>
        {types.length > 0 && <option disabled>──────</option>}
        {types.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name}
          </option>
        ))}
        {/* A type the workflow no longer defines stays visible, not silently any. */}
        {elem === null && !(PRIMITIVES as readonly string[]).includes(value) && !types.some((t) => t.name === value) && (
          <option value={value}>{value}</option>
        )}
      </select>
      {elem !== null && (
        <TypeSelect
          value={elem}
          types={types}
          label={`${label} element`}
          onChange={(inner) => onChange(listOf(inner))}
        />
      )}
    </span>
  )
}

/** A node's declared input / output pins: name, type, remove, add. */
export function PinsEditor({
  pins,
  types,
  onChange,
}: {
  pins: NodePinSet
  types: readonly WorkflowType[]
  onChange: (pins: NodePinSet) => void
}) {
  const side = (key: 'inputs' | 'outputs', title: string) => (
    <div className="wf-values">
      <span className="wf-field-label">{title}</span>
      {pins[key].map((p, i) => (
        <div key={i} className="wf-value-row">
          <input
            type="text"
            value={p.name}
            aria-label={`${title} pin name`}
            placeholder="name"
            onChange={(e) =>
              onChange({ ...pins, [key]: pins[key].map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
            }
          />
          <TypeSelect
            value={p.ty}
            types={types}
            label={`${p.name || 'pin'} type`}
            onChange={(ty) => onChange({ ...pins, [key]: pins[key].map((x, j) => (j === i ? { ...x, ty } : x)) })}
          />
          <button
            type="button"
            title="remove pin"
            onClick={() => onChange({ ...pins, [key]: pins[key].filter((_, j) => j !== i) })}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({
            ...pins,
            [key]: [...pins[key], { name: key === 'inputs' ? 'input' : 'result', ty: 'any' }],
          })
        }
      >
        + {key === 'inputs' ? 'input' : 'output'} pin
      </button>
    </div>
  )
  return (
    <div className="wf-pins-editor">
      {side('inputs', 'input pins')}
      {side('outputs', 'output pins')}
      <span className="wf-field-hint muted">
        A typed pin only wires to a pin of the same type (or any). Save the node, then drag from its dot.
      </span>
    </div>
  )
}

/** The workflow's struct types as cards: "Type: Review" with its fields.
 *  Edits save on blur / change as one PATCH of the whole list; a refusal
 *  (duplicate name, a type pins still use) shows inline and nothing is lost. */
export function WorkflowTypesCard({
  workflowId,
  types,
  nodes,
  onChanged,
  onClose,
}: {
  workflowId: number
  types: WorkflowType[]
  nodes: WorkflowNode[]
  onChanged: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<WorkflowType[]>(types)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const key = JSON.stringify(types)
  // The server's list is the truth: a refetch replaces the draft.
  const [seen, setSeen] = useState(key)
  if (seen !== key) {
    setSeen(key)
    setDraft(JSON.parse(key) as WorkflowType[])
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function save(next: WorkflowType[]) {
    setDraft(next)
    const bad = validateTypeDraft(next)
    if (bad) {
      setError(bad)
      return
    }
    if (JSON.stringify(next) === key) {
      setError(null)
      return
    }
    setBusy(true)
    updateWorkflow(workflowId, { types: next }).then(
      () => {
        setError(null)
        setBusy(false)
        onChanged()
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      },
    )
  }

  const patch = (i: number, t: WorkflowType) => draft.map((x, j) => (j === i ? t : x))
  const nextName = () => {
    let n = 1
    while (draft.some((t) => t.name.toLowerCase() === `type${n}`)) n++
    return `Type${n}`
  }

  return (
    <div className="wf-types-card nowheel nopan nodrag" role="dialog" aria-label="Workflow types">
      <div className="wf-inspector-head">
        <b>Types</b>
        <span className="wf-head-btns">
          <button type="button" className="wf-icon-btn" aria-label="Close types" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>
      {draft.length === 0 && <p className="muted">No types yet. Add one to type your pins.</p>}
      {draft.map((t, i) => {
        const used = typeUsages(t.name, nodes, types)
        return (
          <div key={i} className="wf-type" aria-label={`Type: ${t.name}`}>
            <div className="wf-type-head">
              <span className="muted">Type:</span>
              <input
                type="text"
                value={t.name}
                aria-label="type name"
                onChange={(e) => setDraft(patch(i, { ...t, name: e.target.value }))}
                onBlur={() => save(draft)}
              />
              <button
                type="button"
                title={used.length > 0 ? `In use by ${used.join(', ')}` : 'delete type'}
                disabled={busy || used.length > 0}
                onClick={() => save(draft.filter((_, j) => j !== i))}
              >
                delete
              </button>
            </div>
            {t.fields.map((f, k) => (
              <div key={k} className="wf-value-row">
                <input
                  type="text"
                  value={f.name}
                  aria-label="field name"
                  placeholder="field"
                  onChange={(e) =>
                    setDraft(patch(i, { ...t, fields: t.fields.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) }))
                  }
                  onBlur={() => save(draft)}
                />
                <TypeSelect
                  value={f.ty}
                  types={draft.filter((o) => o.name !== t.name)}
                  label={`${f.name || 'field'} type`}
                  onChange={(ty) =>
                    save(patch(i, { ...t, fields: t.fields.map((x, j) => (j === k ? { ...x, ty } : x)) }))
                  }
                />
                <button
                  type="button"
                  title="remove field"
                  disabled={busy}
                  onClick={() => save(patch(i, { ...t, fields: t.fields.filter((_, j) => j !== k) }))}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="wf-ghost"
              disabled={busy}
              onClick={() => {
                let n = t.fields.length + 1
                while (t.fields.some((x) => x.name === `field${n}`)) n++
                setDraft(patch(i, { ...t, fields: [...t.fields, { name: `field${n}`, ty: 'string' }] }))
                save(patch(i, { ...t, fields: [...t.fields, { name: `field${n}`, ty: 'string' }] }))
              }}
            >
              + field
            </button>
          </div>
        )
      })}
      {error && (
        <p className="error wf-inspector-error" role="alert">
          {error}
        </p>
      )}
      <div className="wf-inspector-actions">
        <button type="button" disabled={busy} onClick={() => save([...draft, { name: nextName(), fields: [] }])}>
          + type
        </button>
      </div>
    </div>
  )
}
