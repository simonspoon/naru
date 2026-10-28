import { createPortal } from 'react-dom'
import { BUILTIN_TITLE, readOnlyTitle } from './workflowBuiltin'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useNodesState,
  useStore,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  createWorkflowEdge,
  createWorkflowNode,
  deleteWorkflowEdge,
  decideWorkflowGate,
  deleteWorkflowNode,
  listLibrary,
  listScripts,
  listWorkflows,
  listWorkflowGates,
  updateWorkflowNode,
} from './api'
import { loadBoardView, saveBoardView } from './boardView'
import { layoutNodes } from './layout'
import { useFetch } from './useFetch'
import { cssVar, onThemeChange } from './theme'
import {
  BRANCH_OPS,
  COMMENT_COLORS,
  COMMENT_COLOR_VARS,
  INBOX_KINDS,
  NODE_DRAG_MIME,
  OUTPUT_TARGETS,
  PALETTE_GROUPS,
  PROMPT_MODELS,
  RETRY_WRAPPABLE,
  AMBIENT_EVENTS,
  TRIGGER_MODES,
  branchForHandle,
  buildConfig,
  decodeKindDrag,
  defaultConfig,
  edgeLabelClass,
  draftFromConfig,
  hasInput,
  hasOutput,
  HTTP_BODY_METHODS,
  HTTP_DEFAULT_TIMEOUT,
  HTTP_METHODS,
  inspectorKey,
  kindInfo,
  loadPaletteCollapsed,
  missingValueRows,
  savePaletteCollapsed,
  SWITCH_OPS,
  sourceHandles,
  summarize,
  type ConfigDraft,
  webhookSample,
} from './workflowConfig'
import { gateBadge, gateByNode, stepClass, stepStatusByNode } from './workflowRun'
import type { LibraryItem } from './types/LibraryItem'
import type { Script } from './types/Script'
import type { Workflow } from './types/Workflow'
import type { WorkflowGate } from './types/WorkflowGate'
import type { WorkflowNode } from './types/WorkflowNode'
import type { WorkflowNodeKind } from './types/WorkflowNodeKind'
import type { WorkflowRun } from './types/WorkflowRun'
import type { WorkflowStepStatus } from './types/WorkflowStepStatus'
import type { WorkflowType } from './types/WorkflowType'
import type { WorkflowView } from './types/WorkflowView'
import { PinsEditor, WorkflowTypesCard } from './components/WorkflowTypesCard'
import {
  effectivePin,
  isList,
  pinColorVar,
  pinHandleId,
  pinOfHandle,
  pinType,
  pinsConfig,
  pinsOf,
  refusalReason,
  shapePlan,
  typesMatch,
  type NodePinSet,
  type PinSide,
} from './workflowTypes'
import { KindIcon, SpeakIcon } from './components/WorkflowIcon'
import { PANEL_H, PANEL_W, kindColorVar, pinsFor, placePanel } from './workflowLayout'

/** A wire being dragged: which side it started on and its pin's type, so the
 *  other cards can dim the pins it cannot land on. */
type DragFrom = { side: PinSide; ty: string } | null
type PinMenuOpen = (at: { x: number; y: number }, nodeId: number, side: PinSide, pin: string, ty: string) => void
type CardData = {
  node: WorkflowNode
  status: WorkflowStepStatus | undefined
  types: WorkflowType[]
  drag: DragFrom
  onPinMenu: PinMenuOpen
  /** The shown run's approval for a `gate` node, if it has reached one. */
  gate: WorkflowGate | undefined
  /** Gate ids with a decision in flight, and the last refusal to show. */
  gateBusy: number | null
  gateError: string | null
  onDecide: (gate: WorkflowGate, decision: 'approved' | 'rejected') => void
}
type CardNode = Node<CardData, 'card'>

/** A decide card's flow handles sit in rows of their own below the title,
 *  summary and input pins: the first row starts `DECIDE_ROWS_TOP` px down. */
const DECIDE_ROWS_TOP = 84
const DECIDE_ROW = 20

/** One node as a Blueprint-style card: a header tinted by kind, a muted
 *  summary, round typed data pins (decorative: the graph carries no data
 *  types), and white triangle flow handles for the connections it may take.
 *  A branch offers two labelled flow handles so the edge's `true`/`false` is
 *  decided by where the line is dragged from, and a decide node one per option
 *  plus `fallback`. The last run's step state is a ring. */
function NodeCard({ data, selected }: NodeProps<CardNode>) {
  const { node, status, types, drag, onPinMenu, gate, gateBusy, gateError, onDecide } = data
  const pressTimer = useRef<number | undefined>(undefined)
  const typedPins = pinsOf(node, types)
  const typedRows = Math.max(typedPins.inputs.length, typedPins.outputs.length)
  const isShape = node.kind === 'break' || node.kind === 'make'
  const decideHandles = node.kind === 'decide' || node.kind === 'switch' || node.kind === 'gate' || node.kind === 'trycatch' ? sourceHandles(node.kind, node.config) : []
  const pins = typedRows > 0 ? { inputs: [], outputs: [] } : pinsFor(node.kind)
  const rows = Math.max(pins.inputs.length, pins.outputs.length)
  if (node.kind === 'comment') {
    // Editor-only group box (naru task 2008): no handles, drawn behind the nodes.
    const color = typeof node.config.color === 'string' && COMMENT_COLOR_VARS[node.config.color] ? node.config.color : 'accent'
    const text = typeof node.config.text === 'string' ? node.config.text : ''
    return (
      <div
        className={`wf-comment${selected ? ' selected' : ''}`}
        style={{ ['--cc' as string]: `var(${COMMENT_COLOR_VARS[color]})` }}
        aria-label={`Comment: ${node.title}`}
      >
        <b className="wf-comment-title">{node.title}</b>
        {text !== '' && <div className="wf-comment-text">{text}</div>}
      </div>
    )
  }
  // A data pin that is a real connection point (typed): a handle, coloured by
  // its type, with a chip naming it and a menu for Break / Make.
  const typedPin = (side: PinSide, p: { name: string; ty: string }) => {
    const dim = drag !== null && drag.side !== side && !typesMatch(drag.ty, p.ty)
    const ok = drag !== null && drag.side !== side && typesMatch(drag.ty, p.ty)
    const open = (e: React.MouseEvent | React.KeyboardEvent, at?: { x: number; y: number }) => {
      e.preventDefault()
      e.stopPropagation()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      onPinMenu(at ?? { x: r.left, y: r.bottom }, node.id, side, p.name, p.ty)
    }
    const handle = (
      <Handle
        key={`h-${side}-${p.name}`}
        id={pinHandleId(side, p.name)}
        type={side === 'in' ? 'target' : 'source'}
        position={side === 'in' ? Position.Left : Position.Right}
        className={`wf-pin wf-pin-handle${isList(p.ty) ? ' wf-pin-list' : ''}${dim ? ' wf-pin-dim' : ''}${ok ? ' wf-pin-ok' : ''}`}
        style={{ ['--pin' as string]: `var(${pinColorVar(p.ty)})` }}
        tabIndex={0}
        aria-label={`${p.name}, ${p.ty}, ${side === 'in' ? 'input' : 'output'}`}
        title={`${p.name}: ${p.ty}`}
        onContextMenu={(e) => open(e, { x: e.clientX, y: e.clientY })}
        onKeyDown={(e) => {
          if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') open(e)
        }}
        onTouchStart={(e) => {
          const t = e.touches[0]
          pressTimer.current = window.setTimeout(() => onPinMenu({ x: t.clientX, y: t.clientY }, node.id, side, p.name, p.ty), 500)
        }}
        onTouchEnd={() => window.clearTimeout(pressTimer.current)}
        onTouchMove={() => window.clearTimeout(pressTimer.current)}
      />
    )
    const label = (
      <span className="wf-pin-name">
        {p.name}
        {p.ty !== 'any' && <span className="wf-pin-chip">{p.ty}</span>}
      </span>
    )
    return side === 'in' ? (
      <>
        {handle}
        {label}
      </>
    ) : (
      <>
        {label}
        {handle}
      </>
    )
  }
  return (
    <div
      style={{
        ['--kc' as string]: `var(${kindColorVar(node.kind)})`,
        ...(decideHandles.length > 0 && node.kind !== 'gate' ? { paddingBottom: DECIDE_ROW * decideHandles.length + 8 } : {}),
      }}
      className={`wf-node wf-kind-${node.kind}${selected ? ' selected' : ''} ${stepClass(status)}`}
      title={status ? `last run: ${status}` : undefined}
    >
      {hasInput(node.kind) && !isShape && (
        <Handle
          type="target"
          position={Position.Left}
          className="wf-flow-pin"
          aria-label="flow in"
          style={{ top: 16 }}
        />
      )}
      <div className="wf-node-head">
        <span className="wf-node-icon" aria-hidden="true">
          <KindIcon kind={node.kind} />
        </span>
        <b className="wf-node-title">{node.title}</b>
      </div>
      {status && node.kind !== 'gate' && <span className="wf-node-step">{status}</span>}
      {status && node.kind === 'gate' && !gate && <span className="wf-node-step">{status}</span>}
      <div className="wf-node-body">
        <div className="wf-node-sum">{summarize(node.kind, node.config)}</div>
        {typedRows > 0 && (
          <div className="wf-pin-rows">
            {Array.from({ length: typedRows }, (_, i) => (
              <div key={i} className="wf-pin-row">
                <span className="wf-pin-cell">{typedPins.inputs[i] && typedPin('in', typedPins.inputs[i])}</span>
                <span className="wf-pin-cell wf-pin-cell-out">
                  {typedPins.outputs[i] && typedPin('out', typedPins.outputs[i])}
                </span>
              </div>
            ))}
          </div>
        )}
        {rows > 0 && (
          <div className="wf-pin-rows">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="wf-pin-row">
                <span className="wf-pin-cell">
                  {pins.inputs[i] && (
                    <>
                      <span
                        className={`wf-pin wf-pin-${pins.inputs[i].type}`}
                        role="img"
                        aria-label={`${pins.inputs[i].label} in`}
                      />
                      {pins.inputs[i].label}
                    </>
                  )}
                </span>
                <span className="wf-pin-cell wf-pin-cell-out">
                  {pins.outputs[i] && (
                    <>
                      {pins.outputs[i].label}
                      <span
                        className={`wf-pin wf-pin-${pins.outputs[i].type}`}
                        role="img"
                        aria-label={`${pins.outputs[i].label} out`}
                      />
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {node.kind === 'gate' && (
        <>
          {/* The two flow-handle rows live in this spacer, as a decide card's live in its padding. */}
          <div style={{ height: DECIDE_ROW * decideHandles.length + 4 }} aria-hidden="true" />
          {gate && (
            <div className="wf-gate nodrag nopan">
              <span className={`wf-gate-badge wf-gate-${gateBadge(gate).tone}`}>{gateBadge(gate).text}</span>
              {gate.message !== '' && (
                <span className="wf-gate-msg" title={gate.message}>
                  {gate.message}
                </span>
              )}
              {gate.status === 'pending' && (
                <span className="wf-gate-actions">
                  <button
                    type="button"
                    className="wf-gate-btn wf-gate-approve"
                    aria-label={`Approve gate ${node.title}`}
                    disabled={gateBusy === gate.id}
                    onClick={() => onDecide(gate, 'approved')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="wf-gate-btn wf-gate-reject"
                    aria-label={`Reject gate ${node.title}`}
                    disabled={gateBusy === gate.id}
                    onClick={() => onDecide(gate, 'rejected')}
                  >
                    Reject
                  </button>
                </span>
              )}
              {gateError !== null && gate.status === 'pending' && <span className="wf-gate-error error">{gateError}</span>}
            </div>
          )}
        </>
      )}
      {node.kind === 'branch' ? (
        <>
          <Handle
            id="true"
            type="source"
            position={Position.Right}
            className="wf-flow-pin wf-handle-true"
            aria-label="true out"
            style={{ top: '50%' }}
          />
          <span className="wf-branch-label wf-branch-true" style={{ top: '50%' }}>
            true
          </span>
          <Handle
            id="false"
            type="source"
            position={Position.Right}
            className="wf-flow-pin wf-handle-false"
            aria-label="false out"
            style={{ top: '80%' }}
          />
          <span className="wf-branch-label wf-branch-false" style={{ top: '80%' }}>
            false
          </span>
        </>
      ) : node.kind === 'decide' || node.kind === 'switch' || node.kind === 'gate' || node.kind === 'trycatch' ? (
        decideHandles.map((label, i) => {
          const top = DECIDE_ROWS_TOP + DECIDE_ROW * i + DECIDE_ROW / 2
          return (
            <Fragment key={label}>
              <Handle
                id={label}
                type="source"
                position={Position.Right}
                className="wf-flow-pin"
                aria-label={`${label} out`}
                style={{ top }}
              />
              <span
                className={`wf-branch-label${node.kind === 'trycatch' ? (label === 'ok' ? ' wf-branch-true' : ' wf-branch-caught') : ''}`}
                style={{ top }}
              >
                {label}
              </span>
            </Fragment>
          )
        })
      ) : (
        hasOutput(node.kind) &&
        !isShape && (
          <Handle
            type="source"
            position={Position.Right}
            className="wf-flow-pin"
            aria-label="flow out"
            style={{ top: 16 }}
          />
        )
      )}
    </div>
  )
}

const nodeTypes = { card: NodeCard }

/** A comment box's default size on the canvas (naru task 2008). */
const COMMENT_W = 320
const COMMENT_H = 200

const MIN_ZOOM = 0.3
const MAX_ZOOM = 2

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="wf-field">
      <span className="wf-field-label">{label}</span>
      {children}
      {hint && <span className="wf-field-hint muted">{hint}</span>}
    </label>
  )
}

/** The selected node's editor: title plus real controls for its kind's config,
 *  saved with one PATCH (which replaces the whole config). Remounted per node
 *  and per saved state by its parent's key, so the draft always starts from
 *  what the server holds. */
/** The webhook node's inspector block: the body type, the endpoint and a
 *  copyable curl line (naru task 2005). */
function WebhookFields({
  node,
  draft,
  types,
  set,
}: {
  node: WorkflowNode
  draft: ConfigDraft
  types: WorkflowType[]
  set: <K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) => void
}) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle')
  const path = `/api/workflows/${node.workflow_id}/webhook`
  const curl = `curl -X POST -H 'Content-Type: application/json' -d '${webhookSample(draft.json_type)}' ${window.location.origin}${path}`
  useEffect(() => {
    if (copied !== 'ok') return
    const t = window.setTimeout(() => setCopied('idle'), 1500)
    return () => window.clearTimeout(t)
  }, [copied])
  return (
    <>
      <Field
        label="body type"
        hint="any, string, number, bool, a list, or a type from the Types card; a body that does not fit fails the node"
      >
        <select value={draft.json_type} onChange={(e) => set('json_type', e.target.value)}>
          {['any', 'string', 'number', 'bool', 'list<string>', 'list<number>', 'list<bool>'].map((t) => (
            <option key={t}>{t}</option>
          ))}
          {types.flatMap((t) => [
            <option key={t.name}>{t.name}</option>,
            <option key={`list<${t.name}>`}>{`list<${t.name}>`}</option>,
          ])}
        </select>
      </Field>
      <Field label="endpoint" hint="POST a JSON body; the response is the finished run">
        <code className="wf-webhook-url">POST {path}</code>
      </Field>
      <Field label="example">
        <pre className="wf-webhook-curl">{curl}</pre>
        <button
          type="button"
          className="wf-webhook-copy"
          aria-label="Copy curl command"
          onClick={() => {
            navigator.clipboard.writeText(curl).then(
              () => setCopied('ok'),
              () => setCopied('failed'),
            )
          }}
        >
          {copied === 'ok' ? 'Copied' : 'Copy'}
        </button>
        {copied === 'failed' && <span className="muted"> copy failed — select the text instead</span>}
      </Field>
    </>
  )
}

function NodeInspector({
  node,
  types,
  scripts,
  workflows,
  agents,
  onSaved,
  onError,
  onDeleted,
  expanded,
  onExpand,
  onCollapse,
  onClose,
  style,
  readOnly = false,
}: {
  /** A built-in's node: inspect only (naru task 2103). */
  readOnly?: boolean
  node: WorkflowNode
  types: WorkflowType[]
  scripts: Script[]
  /** Every workflow, for a sub-workflow node's picker (the node's own is left out). */
  workflows: Workflow[]
  agents: LibraryItem[] | null
  onSaved: () => void
  onError: (message: string | null) => void
  onDeleted: () => void
  expanded: boolean
  onExpand: () => void
  onCollapse: () => void
  onClose: () => void
  /** Where the floating panel sits; absent in the modal. */
  style?: React.CSSProperties
}) {
  const [title, setTitle] = useState(node.title)
  const [draft, setDraft] = useState<ConfigDraft>(() => draftFromConfig(node.kind, node.config))
  const [formError, setFormError] = useState<string | null>(null)
  const isShape = node.kind === 'break' || node.kind === 'make'
  const [declaredPins, setDeclaredPins] = useState<NodePinSet>(() => {
    const p = isShape ? { inputs: [], outputs: [] } : pinsOf(node, types)
    return { inputs: p.inputs, outputs: p.outputs }
  })
  const set = <K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const info = kindInfo(node.kind)

  function save() {
    // A break / make keeps its struct; only its title is editable.
    const built = isShape ? { error: null, config: node.config } : buildConfig(node.kind, draft)
    if (built.error !== null) {
      setFormError(built.error)
      return
    }
    setFormError(null)
    // A break/make's pins come from its struct, an agent's are fixed by the server.
    const pins = isShape || node.kind === 'agent' || node.kind === 'git' || node.kind === 'file' || node.kind === 'memory' || node.kind === 'verify' || node.kind === 'comment' ? undefined : pinsConfig(declaredPins)
    const config = pins ? { ...built.config, pins } : built.config
    updateWorkflowNode(node.id, { title: title.trim() || node.title, config }).then(
      () => {
        onError(null)
        onSaved()
      },
      (err: unknown) => setFormError(err instanceof Error ? err.message : String(err)),
    )
  }

  function remove() {
    deleteWorkflowNode(node.id).then(
      () => {
        onError(null)
        onDeleted()
      },
      (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
    )
  }

  const scriptArgs = scripts.find((s) => s.name === draft.script || String(s.id) === draft.script)?.args ?? []
  const localModel = draft.model.startsWith('local:')

  const big: { key: 'prompt' | 'command' | 'question'; label: string } | null =
    node.kind === 'prompt' || node.kind === 'agent'
      ? { key: 'prompt', label: 'prompt' }
      : node.kind === 'cli'
        ? { key: 'command', label: 'command' }
        : node.kind === 'decide'
          ? { key: 'question', label: 'question' }
          : null
  const typedSet = pinsOf(node, types)
  const typedMode = typedSet.inputs.length + typedSet.outputs.length > 0
  const pins = typedMode
      ? {
          inputs: typedSet.inputs.map((p) => ({ label: p.name, type: p.ty })),
          outputs: typedSet.outputs.map((p) => ({ label: p.name, type: p.ty })),
        }
      : pinsFor(node.kind)

  const fields = (
    <>
      <Field label="title">
        <input type="text" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </Field>

      {node.kind === 'trigger' && (
        <>
          <Field label="mode">
            <select value={draft.mode} onChange={(e) => set('mode', e.target.value)}>
              {TRIGGER_MODES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          {draft.mode === 'time' && (
            <Field label="every (minutes)" hint="1 to 10080; run by serve --watch-workflows">
              <input
                type="text"
                inputMode="numeric"
                value={draft.every_minutes}
                onChange={(e) => set('every_minutes', e.target.value)}
              />
            </Field>
          )}
          {draft.mode === 'ambient' && (
            <Field label="events" hint="which ambient-engine events run this workflow">
              {AMBIENT_EVENTS.map((ev) => (
                <label key={ev} className="wf-check">
                  <input
                    type="checkbox"
                    checked={draft.events.includes(ev)}
                    onChange={(e) =>
                      set('events', e.target.checked ? [...draft.events, ev] : draft.events.filter((x) => x !== ev))
                    }
                  />{' '}
                  {ev}
                </label>
              ))}
            </Field>
          )}
          <Field label="phrase" hint="what a spoken request says to run it (optional)">
            <input type="text" value={draft.phrase} onChange={(e) => set('phrase', e.target.value)} />
          </Field>
        </>
      )}

      {node.kind === 'task-event' && (
        <>
          <Field label="event" hint="a task being created, changing status, or either">
            <div className="wf-seg" role="radiogroup" aria-label="Task event">
              {(
                [
                  ['created', 'Created'],
                  ['status', 'Status change'],
                  ['any', 'Any'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={draft.te_event === v}
                  className={draft.te_event === v ? 'active' : ''}
                  onClick={() => set('te_event', v)}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          {draft.te_event !== 'created' && (
            <Field label="status" hint="Only fire when the task lands in this status.">
              <select aria-label="Task status" value={draft.te_status} onChange={(e) => set('te_status', e.target.value)}>
                <option value="">any status</option>
                {['backlog', 'todo', 'in_progress', 'done', 'cancelled'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="project" hint="id or name; blank = every project">
            <input type="text" aria-label="Task project" value={draft.project} onChange={(e) => set('project', e.target.value)} />
          </Field>
        </>
      )}
      {node.kind === 'file-watch' && (
        <>
          <Field label="path" hint="file or folder; checked on each workflow tick, so a create-and-delete between ticks is missed">
            <input
              type="text"
              aria-label="Watched path"
              placeholder="/path/to/file"
              value={draft.fw_path}
              onChange={(e) => set('fw_path', e.target.value)}
            />
          </Field>
          <Field label="event" hint="what counts as a change">
            <select aria-label="File event" value={draft.fw_event} onChange={(e) => set('fw_event', e.target.value)}>
              {['any', 'created', 'modified', 'deleted'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
        </>
      )}
      {node.kind === 'schedule' && (
        <>
          <Field label="repeat" hint="UTC; run by serve --watch-workflows">
            <div className="wf-seg" role="radiogroup" aria-label="Schedule mode">
              {(['interval', 'cron'] as const).map((m) => {
                const active = (m === 'cron') === (draft.cron !== '')
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? 'active' : ''}
                    onClick={() => set('cron', m === 'cron' ? '* * * * *' : '')}
                  >
                    {m === 'cron' ? 'Cron' : 'Every N minutes'}
                  </button>
                )
              })}
            </div>
          </Field>
          {draft.cron === '' ? (
            <Field label="every (minutes)" hint="1 to 10080">
              <input
                type="text"
                inputMode="numeric"
                value={draft.every_minutes}
                onChange={(e) => set('every_minutes', e.target.value)}
              />
            </Field>
          ) : (
            <Field label="cron" hint="UTC, 5 fields: minute hour day-of-month month day-of-week">
              <input
                type="text"
                className="wf-cron-input"
                aria-label="Cron expression"
                value={draft.cron}
                placeholder="*/5 * * * *"
                onChange={(e) => set('cron', e.target.value)}
              />
            </Field>
          )}
        </>
      )}

      {node.kind === 'prompt' && (
        <>
          <Field label="model">
            <select
              value={localModel ? 'local' : draft.model}
              onChange={(e) => set('model', e.target.value === 'local' ? 'local:' : e.target.value)}
            >
              {PROMPT_MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
              <option value="local">local:&lt;name&gt;</option>
            </select>
          </Field>
          {localModel && (
            <Field label="local model name" hint="run with ollama; thinking is ignored">
              <input
                type="text"
                value={draft.model.slice('local:'.length)}
                placeholder="llama3.2"
                onChange={(e) => set('model', `local:${e.target.value}`)}
              />
            </Field>
          )}
          <label className="wf-check">
            <input
              type="checkbox"
              checked={draft.thinking}
              onChange={(e) => set('thinking', e.target.checked)}
            />
            thinking {draft.thinking ? 'on' : 'off'}
          </label>
          {!expanded && (
            <Field label="prompt" hint="the node's input follows it after a blank line">
              <textarea
                rows={5}
                value={draft.prompt}
                onChange={(e) => set('prompt', e.target.value)}
              />
            </Field>
          )}
          <Field label="timeout (seconds)" hint="1 to 3600, default 600">
            <input
              type="text"
              inputMode="numeric"
              value={draft.timeout_secs}
              onChange={(e) => set('timeout_secs', e.target.value)}
            />
          </Field>
        </>
      )}

      {node.kind === 'agent' && (
        <>
          <Field
            label="agent"
            hint={agents === null ? 'loading…' : agents.length === 0 ? 'no agent definitions in the library' : undefined}
          >
            <select
              value={draft.agent}
              disabled={agents === null || agents.length === 0}
              onChange={(e) => set('agent', e.target.value)}
            >
              {!(agents ?? []).some((a) => a.name === draft.agent) && (
                <option value={draft.agent}>
                  {draft.agent && draft.agent !== 'unset' ? `${draft.agent} (missing)` : '— pick an agent —'}
                </option>
              )}
              {(agents ?? []).map((a) => (
                <option key={a.id ?? a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          {!expanded && (
            <Field label="prompt" hint="{input} is replaced by the node's input; else it follows after a blank line">
              <textarea rows={5} value={draft.prompt} onChange={(e) => set('prompt', e.target.value)} />
            </Field>
          )}
          <Field label="model">
            <select value={draft.model} onChange={(e) => set('model', e.target.value)}>
              <option value="">default (agent&apos;s own)</option>
              {PROMPT_MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="timeout (seconds)" hint="1 to 3600, default 600">
            <input
              type="text"
              inputMode="numeric"
              value={draft.timeout_secs}
              onChange={(e) => set('timeout_secs', e.target.value)}
            />
          </Field>
          <Field label="result type" hint="text, or a type from the Types card; a reply that does not fit fails the node">
            <select value={draft.result_type} onChange={(e) => set('result_type', e.target.value)}>
              <option value="text">text</option>
              {types.map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
            </select>
          </Field>
          {draft.result_type !== 'text' && (
            <label className="wf-check">
              <input type="checkbox" checked={draft.retry} onChange={(e) => set('retry', e.target.checked)} />
              retry once on an invalid reply
            </label>
          )}
        </>
      )}

      {node.kind === 'cli' && (
        <>
          {!expanded && (
            <Field label="command" hint="bash -c, verbatim; the input is on stdin and $NARU_INPUT">
              <textarea
                rows={4}
                value={draft.command}
                onChange={(e) => set('command', e.target.value)}
              />
            </Field>
          )}
          <Field label="timeout (seconds)" hint="1 to 86400, default 600">
            <input
              type="text"
              inputMode="numeric"
              value={draft.timeout_secs}
              onChange={(e) => set('timeout_secs', e.target.value)}
            />
          </Field>
        </>
      )}

      {node.kind === 'script' && (
        <>
          <Field label="script">
            <select
              value={draft.script}
              onChange={(e) => {
                const picked = scripts.find((s) => s.name === e.target.value)
                setDraft((d) => ({
                  ...d,
                  script: e.target.value,
                  values: [
                    ...d.values,
                    ...missingValueRows(picked?.args.map((a) => a.name) ?? [], d.values),
                  ],
                }))
              }}
            >
              {!scripts.some((s) => s.name === draft.script) && (
                <option value={draft.script}>{draft.script || '— pick a script —'}</option>
              )}
              {scripts.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="wf-values">
            <span className="wf-field-label">values</span>
            {draft.values.map(([k, v], i) => (
              <div key={i} className="wf-value-row">
                <input
                  type="text"
                  value={k}
                  placeholder={scriptArgs[i]?.name ?? 'name'}
                  onChange={(e) =>
                    set('values', draft.values.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))
                  }
                />
                <input
                  type="text"
                  value={v}
                  placeholder="value"
                  onChange={(e) =>
                    set('values', draft.values.map((r, j) => (j === i ? [r[0], e.target.value] : r)))
                  }
                />
                <button
                  type="button"
                  title="remove"
                  onClick={() => set('values', draft.values.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={() => set('values', [...draft.values, ['', '']])}>
              + value
            </button>
            <span className="wf-field-hint muted">
              A value may contain <code>{'{input}'}</code>, replaced by this node&apos;s input text.
            </span>
          </div>
        </>
      )}

      {node.kind === 'branch' && (
        <>
          <Field label="operator">
            <select value={draft.op} onChange={(e) => set('op', e.target.value)}>
              {BRANCH_OPS.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
          <Field
            label="value"
            hint={
              draft.op.startsWith('score_')
                ? 'a number; compared with the first number in the input'
                : draft.op === 'regex'
                  ? 'POSIX extended regex (grep -E)'
                  : undefined
            }
          >
            <input type="text" value={draft.value} onChange={(e) => set('value', e.target.value)} />
          </Field>
          <p className="wf-field-hint muted">
            Drag the <span className="wf-branch-true-text">true</span> or{' '}
            <span className="wf-branch-false-text">false</span> handle to wire each way.
          </p>
        </>
      )}

      {node.kind === 'decide' && (
        <>
          {!expanded && (
            <Field label="question" hint="may contain {input}, replaced by this node's input text">
              <textarea rows={3} value={draft.question} onChange={(e) => set('question', e.target.value)} />
            </Field>
          )}
          <div className="wf-values">
            <span className="wf-field-label">options</span>
            {draft.options.map((o, i) => (
              <div key={i} className="wf-value-row">
                <input
                  type="text"
                  value={o}
                  onChange={(e) =>
                    set(
                      'options',
                      draft.options.map((x, j) => (j === i ? e.target.value : x)),
                    )
                  }
                />
                <button
                  type="button"
                  title="remove"
                  onClick={() =>
                    set(
                      'options',
                      draft.options.filter((_, j) => j !== i),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={() => set('options', [...draft.options, ''])}>
              + option
            </button>
          </div>
          <Field label="threshold" hint="0 to 1; below it the fallback edge is taken (default 0.5)">
            <input
              type="text"
              inputMode="decimal"
              value={draft.threshold}
              onChange={(e) => set('threshold', e.target.value)}
            />
          </Field>
          <p className="wf-field-hint muted">
            Drag an option&apos;s handle to wire it; the <b>fallback</b> handle is taken on no decision,
            low confidence or an error. Save the node first after changing its options.
          </p>
        </>
      )}

      {node.kind === 'switch' && (
        <>
          <Field label="match" hint="how the input is compared with each case">
            <select value={draft.op} onChange={(e) => set('op', e.target.value)}>
              {SWITCH_OPS.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
          <div className="wf-values">
            <span className="wf-field-label">cases (first match wins)</span>
            {draft.cases.map((k, i) => (
              <div key={i} className="wf-value-row">
                <input
                  type="text"
                  value={k.match}
                  aria-label={`Case ${i + 1} match`}
                  placeholder="match"
                  onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                  onChange={(e) =>
                    set(
                      'cases',
                      draft.cases.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)),
                    )
                  }
                />
                <input
                  type="text"
                  value={k.label}
                  aria-label={`Case ${i + 1} label`}
                  placeholder="label (optional)"
                  onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                  onChange={(e) =>
                    set(
                      'cases',
                      draft.cases.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                    )
                  }
                />
                <button
                  type="button"
                  title="remove"
                  aria-label={`Remove case ${i + 1}`}
                  onClick={() =>
                    set(
                      'cases',
                      draft.cases.filter((_, j) => j !== i),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={() => set('cases', [...draft.cases, { match: '', label: '' }])}>
              + case
            </button>
            <div className="wf-value-row">
              <input type="text" value="default" readOnly aria-label="Default case" />
            </div>
          </div>
          <p className="wf-field-hint muted">
            Drag a case&apos;s handle to wire it; the <b>default</b> handle is taken when nothing matches (with no
            default edge, everything downstream is skipped). Save the node first after changing its cases.
          </p>
        </>
      )}

      {node.kind === 'variable' && (
        <>
          <Field label="operation">
            <select value={draft.var_op} onChange={(e) => set('var_op', e.target.value)}>
              <option>set</option>
              <option>get</option>
            </select>
          </Field>
          <Field label="name" hint="identifier, e.g. count; a get must be wired downstream of its set">
            <input type="text" value={draft.var_name} onChange={(e) => set('var_name', e.target.value)} />
          </Field>
          <Field
            label="type"
            hint={draft.var_op === 'get' ? 'the type of the stored value' : 'the input is parsed as JSON and must fit this type'}
          >
            <select value={draft.json_type} onChange={(e) => set('json_type', e.target.value)}>
              {['any', 'string', 'number', 'bool', 'list<string>', 'list<number>', 'list<bool>'].map((t) => (
                <option key={t}>{t}</option>
              ))}
              {types.flatMap((t) => [
                <option key={t.name}>{t.name}</option>,
                <option key={`list<${t.name}>`}>{`list<${t.name}>`}</option>,
              ])}
            </select>
          </Field>
        </>
      )}

      {node.kind === 'foreach' && (
        <>
          <Field label="body" hint="bash script, run once per item; the item is $1 (also $NARU_INPUT and stdin)">
            <textarea
              rows={4}
              style={{ fontFamily: 'var(--font-mono)' }}
              value={draft.fe_body}
              onChange={(e) => set('fe_body', e.target.value)}
            />
          </Field>
          <Field label="timeout (s)" hint="seconds per item; blank = the default">
            <input
              type="text"
              inputMode="numeric"
              value={draft.timeout_secs}
              onChange={(e) => set('timeout_secs', e.target.value)}
            />
          </Field>
        </>
      )}

      {node.kind === 'delay' && (
        <>
          <Field label="wait">
            <select aria-label="Delay mode" value={draft.dl_mode} onChange={(e) => set('dl_mode', e.target.value)}>
              <option value="duration">Duration</option>
              <option value="until">Until</option>
            </select>
          </Field>
          {draft.dl_mode === 'until' ? (
            <Field label="until" hint="HH:MM or 2026-10-17T14:30:00Z, UTC; at most an hour ahead. Passes its input through unchanged.">
              <input type="text" aria-label="Delay until" placeholder="14:30 or 2026-10-17T14:30:00Z" value={draft.dl_until} onChange={(e) => set('dl_until', e.target.value)} />
            </Field>
          ) : (
            <Field label="seconds" hint="0 to 3600. Passes its input through unchanged.">
              <input type="number" min={0} max={3600} aria-label="Delay seconds" value={draft.dl_seconds} onChange={(e) => set('dl_seconds', e.target.value)} />
            </Field>
          )}
        </>
      )}

      {node.kind === 'gate' && (
        <>
          <Field label="message" hint="Shown on the card and in the phone notification.">
            <input type="text" aria-label="Gate message" placeholder="Ship it?" value={draft.gate_message} onChange={(e) => set('gate_message', e.target.value)} />
          </Field>
          <Field label="timeout (seconds)" hint="1 to 86400. When it runs out the gate rejects.">
            <input type="number" min={1} max={86400} aria-label="Gate timeout seconds" value={draft.gt_timeout} onChange={(e) => set('gt_timeout', e.target.value)} />
          </Field>
          <Field label="on timeout">
            <span className="muted">reject</span>
          </Field>
        </>
      )}

      {node.kind === 'subworkflow' && (
        <Field label="workflow" hint="Runs this workflow with the node's input; its last step's output comes out. A loop or a chain over 8 workflows is refused on save.">
          <select aria-label="Child workflow" value={draft.sw_workflow} onChange={(e) => set('sw_workflow', e.target.value)}>
            {!workflows.some((w) => w.name === draft.sw_workflow) && (
              <option value={draft.sw_workflow}>{draft.sw_workflow || '— pick a workflow —'}</option>
            )}
            {workflows
              .filter((w) => w.id !== node.workflow_id)
              .map((w) => (
                <option key={w.id} value={w.name}>
                  {w.name}
                </option>
              ))}
          </select>
        </Field>
      )}

      {node.kind === 'task' && (
        <>
          <Field label="action" hint="Create a task, update one, or read one. Its output is the task as JSON.">
            <select aria-label="Task action" value={draft.tk_action} onChange={(e) => set('tk_action', e.target.value)}>
              <option value="create">create</option>
              <option value="update">update</option>
              <option value="read">read</option>
            </select>
          </Field>
          {draft.tk_action === 'create' && (
            <Field label="project" hint="A project id or name. May hold {input}.">
              <input type="text" aria-label="Task project" value={draft.tk_project} onChange={(e) => set('tk_project', e.target.value)} />
            </Field>
          )}
          {draft.tk_action !== 'create' && (
            <Field label="task id" hint="A task id. May hold {input}, so an upstream node can pick the task.">
              <input type="text" aria-label="Task id" value={draft.tk_task} onChange={(e) => set('tk_task', e.target.value)} />
            </Field>
          )}
          {draft.tk_action !== 'read' && (
            <>
              <Field label="description" hint="May hold {input}. A create with none uses the node's input.">
                <textarea rows={3} aria-label="Task description" value={draft.tk_description} onChange={(e) => set('tk_description', e.target.value)} />
              </Field>
              <Field label="status" hint="Blank leaves it alone (create: the default).">
                <select aria-label="Task status" value={draft.tk_status} onChange={(e) => set('tk_status', e.target.value)}>
                  <option value="">—</option>
                  {['backlog', 'todo', 'in_progress', 'done', 'cancelled'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                  {draft.tk_status.includes('{input}') && <option>{draft.tk_status}</option>}
                </select>
              </Field>
              <Field label="priority">
                <select aria-label="Task priority" value={draft.tk_priority} onChange={(e) => set('tk_priority', e.target.value)}>
                  <option value="">—</option>
                  {['low', 'medium', 'high'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                  {draft.tk_priority.includes('{input}') && <option>{draft.tk_priority}</option>}
                </select>
              </Field>
            </>
          )}
          {draft.tk_action === 'update' && (
            <Field label="result" hint="May hold {input}.">
              <textarea rows={3} aria-label="Task result" value={draft.tk_result} onChange={(e) => set('tk_result', e.target.value)} />
            </Field>
          )}
        </>
      )}

      {node.kind === 'http' && (
        <>
          <Field label="method" hint="The request method.">
            <select aria-label="HTTP method" value={draft.ht_method} onChange={(e) => set('ht_method', e.target.value)}>
              {HTTP_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="url" hint="An http:// URL (this build has no TLS). May hold {input}.">
            <input type="text" aria-label="HTTP URL" value={draft.ht_url} onChange={(e) => set('ht_url', e.target.value)} />
          </Field>
          <Field label="headers" hint="One Name: value per line. Values may hold {input}.">
            <textarea rows={3} aria-label="HTTP headers" value={draft.ht_headers} onChange={(e) => set('ht_headers', e.target.value)} />
          </Field>
          {HTTP_BODY_METHODS.includes(draft.ht_method) && (
            <Field label="body" hint="Sent as is. May hold {input}.">
              <textarea rows={4} aria-label="HTTP body" value={draft.ht_body} onChange={(e) => set('ht_body', e.target.value)} />
            </Field>
          )}
          <Field label="timeout (s)" hint="The whole call; the node fails past it. A non-2xx status is data, not a failure.">
            <input type="text" inputMode="numeric" aria-label="HTTP timeout" placeholder={String(HTTP_DEFAULT_TIMEOUT)} value={draft.ht_timeout} onChange={(e) => set('ht_timeout', e.target.value)} />
          </Field>
        </>
      )}

      {node.kind === 'notify' && (
        <>
          <Field label="mode" hint="Phone sends through vox; speak says it in the live conversation.">
            <select aria-label="Notify mode" value={draft.nt_mode} onChange={(e) => set('nt_mode', e.target.value)}>
              <option value="phone">Phone</option>
              <option value="speak">Speak</option>
            </select>
          </Field>
          <Field label="message" hint="May hold {input}. Empty sends the node's input.">
            <textarea rows={3} aria-label="Notify message" placeholder="the node's input" value={draft.nt_message} onChange={(e) => set('nt_message', e.target.value)} />
          </Field>
          {draft.nt_mode === 'phone' && (
            <>
              <Field label="title" hint="The notification's title.">
                <input type="text" aria-label="Notify title" value={draft.nt_title} onChange={(e) => set('nt_title', e.target.value)} />
              </Field>
              <Field label="open route" hint="Adds an Open Naru button to this route.">
                <input type="text" aria-label="Notify open route" placeholder="live" value={draft.nt_open} onChange={(e) => set('nt_open', e.target.value)} />
              </Field>
            </>
          )}
        </>
      )}

      {node.kind === 'board' && (
        <>
          <Field label="format" hint="Markdown or HTML page shown on the whiteboard.">
            <select aria-label="Board format" value={draft.bd_kind} onChange={(e) => set('bd_kind', e.target.value)}>
              <option value="markdown">Markdown</option>
              <option value="html">HTML</option>
            </select>
          </Field>
          <Field label="title" hint="Optional caption.">
            <input type="text" aria-label="Board title" value={draft.bd_title} onChange={(e) => set('bd_title', e.target.value)} />
          </Field>
          <Field label="body" hint="May hold {input}. Empty pushes the node's input.">
            <textarea rows={4} aria-label="Board body" placeholder="the node's input" value={draft.bd_body} onChange={(e) => set('bd_body', e.target.value)} />
          </Field>
        </>
      )}

      {node.kind === 'git' && (
        <>
          <Field label="operation">
            <select aria-label="Git operation" value={draft.gt_op} onChange={(e) => set('gt_op', e.target.value)}>
              <option value="commit">Commit</option>
              <option value="branch">Branch</option>
              <option value="diff">Diff</option>
            </select>
          </Field>
          <Field label="folder" hint="Blank = the project's folder.">
            <input type="text" aria-label="Git folder" value={draft.gt_cwd} onChange={(e) => set('gt_cwd', e.target.value)} />
          </Field>
          {draft.gt_op === 'commit' && (
            <>
              <Field label="message" hint="May hold {input}. Passed as one argument, never shell-parsed.">
                <textarea rows={3} aria-label="Git commit message" value={draft.gt_message} onChange={(e) => set('gt_message', e.target.value)} />
              </Field>
              <Field label="paths" hint="Blank = all changes. Separate with spaces.">
                <input type="text" aria-label="Git paths" value={draft.gt_paths} onChange={(e) => set('gt_paths', e.target.value)} />
              </Field>
            </>
          )}
          {draft.gt_op === 'branch' && (
            <Field label="name" hint="An existing branch is switched to; a new one is created. May hold {input}.">
              <input type="text" aria-label="Git branch name" value={draft.gt_name} onChange={(e) => set('gt_name', e.target.value)} />
            </Field>
          )}
          {draft.gt_op === 'diff' && (
            <>
              <Field label="base" hint="Blank = working tree vs HEAD.">
                <input type="text" aria-label="Git diff base" value={draft.gt_base} onChange={(e) => set('gt_base', e.target.value)} />
              </Field>
              <label className="wf-check">
                <input type="checkbox" aria-label="Git diff summary only" checked={draft.gt_stat} onChange={(e) => set('gt_stat', e.target.checked)} />
                summary only (--stat)
              </label>
            </>
          )}
          <Field label="timeout (s)" hint="The whole git call; the node fails past it.">
            <input type="text" inputMode="numeric" aria-label="Git timeout" placeholder="600" value={draft.timeout_secs} onChange={(e) => set('timeout_secs', e.target.value)} />
          </Field>
        </>
      )}

      {node.kind === 'comment' && (
        <>
          <Field label="text" hint="Shown under the title. Editor-only: a comment never runs.">
            <textarea rows={3} aria-label="Comment text" value={draft.cm_text} onChange={(e) => set('cm_text', e.target.value)} />
          </Field>
          <div className="wf-field">
            <span className="wf-field-label">colour</span>
            <div className="wf-comment-swatches" role="radiogroup" aria-label="Comment colour">
              {COMMENT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={draft.cm_color === c}
                  aria-label={c}
                  title={c}
                  className={`wf-comment-swatch${draft.cm_color === c ? ' on' : ''}`}
                  style={{ ['--cc' as string]: `var(${COMMENT_COLOR_VARS[c]})` }}
                  onClick={() => set('cm_color', c)}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {node.kind === 'verify' && (
        <>
          <Field label="mode">
            <select aria-label="Verify mode" value={draft.vf_mode} onChange={(e) => set('vf_mode', e.target.value)}>
              <option value="test">Test</option>
              <option value="browser">Browser</option>
            </select>
          </Field>
          <Field label="command" hint="Runs under bash in the project folder. Exit 0 = pass.">
            <textarea rows={3} aria-label="Verify command" value={draft.vf_command} onChange={(e) => set('vf_command', e.target.value)} />
          </Field>
          {draft.vf_mode === 'browser' && (
            <Field label="url" hint="Reaches the command as $NARU_VERIFY_URL. May hold {input}.">
              <input type="text" aria-label="Verify url" value={draft.vf_url} onChange={(e) => set('vf_url', e.target.value)} />
            </Field>
          )}
          <Field label="expect" hint="Text that must appear in the output.">
            <input type="text" aria-label="Verify expect" value={draft.vf_expect} onChange={(e) => set('vf_expect', e.target.value)} />
          </Field>
          <Field label="timeout (s)" hint="The whole check; the node fails past it.">
            <input type="text" inputMode="numeric" aria-label="Verify timeout" placeholder="300" value={draft.timeout_secs} onChange={(e) => set('timeout_secs', e.target.value)} />
          </Field>
        </>
      )}

      {node.kind === 'file' && (
        <>
          <Field label="operation">
            <select aria-label="Operation" value={draft.fl_op} onChange={(e) => set('fl_op', e.target.value)}>
              <option value="read">Read</option>
              <option value="write">Write</option>
            </select>
          </Field>
          <Field label="path" hint="Relative paths resolve against the project folder.">
            <input type="text" aria-label="File path" value={draft.fl_path} onChange={(e) => set('fl_path', e.target.value)} />
          </Field>
          {draft.fl_op === 'write' && (
            <>
              <Field label="content" hint="May hold {input}. Leave empty to write the incoming input.">
                <textarea rows={3} aria-label="File content" value={draft.fl_content} onChange={(e) => set('fl_content', e.target.value)} />
              </Field>
              <label className="wf-check">
                <input type="checkbox" aria-label="Append to the file" checked={draft.fl_append} onChange={(e) => set('fl_append', e.target.checked)} />
                append
              </label>
            </>
          )}
        </>
      )}

      {node.kind === 'memory' && (
        <>
          <Field label="operation">
            <select aria-label="Operation" value={draft.mm_op} onChange={(e) => set('mm_op', e.target.value)}>
              <option value="add">Add</option>
              <option value="search">Search</option>
            </select>
          </Field>
          {draft.mm_op === 'add' ? (
            <Field label="text" hint="May hold {input}. Leave empty to add the incoming input.">
              <textarea rows={3} aria-label="Memory text" value={draft.mm_text} onChange={(e) => set('mm_text', e.target.value)} />
            </Field>
          ) : (
            <>
              <Field label="query" hint="May hold {input}. Leave empty to search the incoming input.">
                <input type="text" aria-label="Memory query" value={draft.mm_query} onChange={(e) => set('mm_query', e.target.value)} />
              </Field>
              <Field label="limit" hint="1 to 50; blank = 10.">
                <input type="text" inputMode="numeric" aria-label="Memory limit" value={draft.mm_limit} onChange={(e) => set('mm_limit', e.target.value)} />
              </Field>
            </>
          )}
          <Field label="project" hint="Id or name; blank = the workflow's project.">
            <input type="text" aria-label="Memory project" value={draft.mm_project} onChange={(e) => set('mm_project', e.target.value)} />
          </Field>
        </>
      )}

      {node.kind === 'trycatch' && (
        <>
          <Field label="wrap" hint="the node to try; a failure takes the caught edge and the run keeps going">
            <select value={draft.rt_wrap_kind} onChange={(e) => set('rt_wrap_kind', e.target.value)}>
              {RETRY_WRAPPABLE.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          <Field label="wrapped config" hint="the wrapped node's config as JSON, e.g. {&quot;command&quot;: &quot;…&quot;} for cli">
            <textarea
              rows={4}
              style={{ fontFamily: 'var(--font-mono)' }}
              value={draft.rt_wrap_config}
              onChange={(e) => set('rt_wrap_config', e.target.value)}
            />
          </Field>
          <Field label="timeout (s)" hint="1 to 3600; blank = the wrapped node's own">
            <input type="text" inputMode="numeric" value={draft.timeout_secs} onChange={(e) => set('timeout_secs', e.target.value)} />
          </Field>
        </>
      )}

      {node.kind === 'retry' && (
        <>
          <Field label="wrap" hint="the node to run; control kinds cannot be wrapped">
            <select value={draft.rt_wrap_kind} onChange={(e) => set('rt_wrap_kind', e.target.value)}>
              {RETRY_WRAPPABLE.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          <Field label="wrapped config" hint="the wrapped node's config as JSON, e.g. {&quot;command&quot;: &quot;…&quot;} for cli">
            <textarea
              rows={4}
              style={{ fontFamily: 'var(--font-mono)' }}
              value={draft.rt_wrap_config}
              onChange={(e) => set('rt_wrap_config', e.target.value)}
            />
          </Field>
          <Field label="attempts" hint="1 to 10 tries before the node fails">
            <input type="text" inputMode="numeric" value={draft.rt_attempts} onChange={(e) => set('rt_attempts', e.target.value)} />
          </Field>
          <Field label="backoff (ms)" hint="wait before the second try, 0 to 60000">
            <input type="text" inputMode="numeric" value={draft.rt_backoff_ms} onChange={(e) => set('rt_backoff_ms', e.target.value)} />
          </Field>
          <Field label="factor" hint="each wait is this many times the last, 1 to 10">
            <input type="text" inputMode="numeric" value={draft.rt_factor} onChange={(e) => set('rt_factor', e.target.value)} />
          </Field>
          <Field label="timeout (s)" hint="seconds per attempt, 1 to 3600; blank = the wrapped node's own">
            <input type="text" inputMode="numeric" value={draft.timeout_secs} onChange={(e) => set('timeout_secs', e.target.value)} />
          </Field>
        </>
      )}

      {node.kind === 'mapfilter' && (
        <>
          <Field label="mode">
            <select value={draft.mf_mode} onChange={(e) => set('mf_mode', e.target.value)}>
              <option>map</option>
              <option>filter</option>
            </select>
          </Field>
          <Field
            label="expression"
            hint={
              draft.mf_mode === 'filter'
                ? 'contains:X · not-contains:X · eq:X · nonempty · regex:RE'
                : 'template; {item} is each element'
            }
          >
            <input
              type="text"
              style={{ fontFamily: 'var(--font-mono)' }}
              value={draft.mf_expr}
              onChange={(e) => set('mf_expr', e.target.value)}
            />
          </Field>
        </>
      )}

      {node.kind === 'webhook' && <WebhookFields node={node} draft={draft} types={types} set={set} />}

      {node.kind === 'parse-json' && (
        <Field
          label="output type"
          hint="any, string, number, bool, a list, or a type from the Types card; invalid JSON, or JSON that does not fit, fails the node"
        >
          <select value={draft.json_type} onChange={(e) => set('json_type', e.target.value)}>
            {['any', 'string', 'number', 'bool', 'list<string>', 'list<number>', 'list<bool>'].map((t) => (
              <option key={t}>{t}</option>
            ))}
            {types.flatMap((t) => [
              <option key={t.name}>{t.name}</option>,
              <option key={`list<${t.name}>`}>{`list<${t.name}>`}</option>,
            ])}
          </select>
        </Field>
      )}

      {node.kind === 'output' && (
        <>
          <Field label="target">
            <select value={draft.target} onChange={(e) => set('target', e.target.value)}>
              {OUTPUT_TARGETS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          {draft.target === 'log' && (
            <Field label="log name" hint="blank = default">
              <input type="text" value={draft.log} onChange={(e) => set('log', e.target.value)} />
            </Field>
          )}
          {draft.target === 'task' && (
            <Field label="project" hint="id or name; the input becomes the task's description">
              <input type="text" value={draft.project} onChange={(e) => set('project', e.target.value)} />
            </Field>
          )}
          {draft.target === 'inbox' && (
            <>
              <Field label="task id" hint="an inbox item names the task it came from">
                <input
                  type="text"
                  inputMode="numeric"
                  value={draft.task_id}
                  onChange={(e) => set('task_id', e.target.value)}
                />
              </Field>
              <Field label="kind">
                <select value={draft.kind} onChange={(e) => set('kind', e.target.value)}>
                  {INBOX_KINDS.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {draft.target === 'board' && (
            <Field label="title" hint="pushed onto the live session's whiteboard">
              <input type="text" value={draft.title} onChange={(e) => set('title', e.target.value)} />
            </Field>
          )}
        </>
      )}

      {isShape && (
        <p className="wf-field-hint muted">
          {node.kind === 'break' ? 'Splits' : 'Builds'} a <b>{String(node.config.struct ?? '?')}</b>. Its pins come
          from the type; edit the type in the Types card.
        </p>
      )}
      {!isShape && node.kind !== 'agent' && node.kind !== 'parse-json' && node.kind !== 'webhook' && node.kind !== 'task-event' && node.kind !== 'file-watch' && node.kind !== 'variable' && node.kind !== 'mapfilter' && node.kind !== 'foreach' && node.kind !== 'parallel' && node.kind !== 'join' && node.kind !== 'retry' && node.kind !== 'delay' && node.kind !== 'gate' && node.kind !== 'notify' && node.kind !== 'board' && node.kind !== 'git' && node.kind !== 'file' && node.kind !== 'memory' && node.kind !== 'verify' && node.kind !== 'comment' && node.kind !== 'trycatch' && <PinsEditor pins={declaredPins} types={types} onChange={setDeclaredPins} />}
    </>
  )

  // A built-in's fields are inspectable but not editable.
  const fieldsEl = readOnly ? (
    <fieldset disabled className="wf-readonly-fields">
      {fields}
    </fieldset>
  ) : (
    fields
  )

  const actions = (
    <>
      {formError && <p className="error wf-inspector-error">{formError}</p>}
      <div className="wf-inspector-actions">
        <button
          type="button"
          onClick={save}
          disabled={readOnly}
          title={readOnlyTitle(readOnly)}
          aria-label={readOnly ? 'Save disabled: built-in workflow' : undefined}
        >
          save
        </button>
        <button
          type="button"
          className="danger"
          onClick={remove}
          disabled={readOnly}
          title={readOnlyTitle(readOnly)}
          aria-label={readOnly ? 'Delete disabled: built-in workflow' : undefined}
        >
          delete node
        </button>
        {expanded && (
          <button type="button" className="wf-modal-collapse" onClick={onCollapse}>
            collapse
          </button>
        )}
      </div>
    </>
  )

  if (expanded) {
    return createPortal(
      <div className="create-task-backdrop wf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCollapse()}>
        <div className="wf-modal" role="dialog" aria-modal="true" aria-label={`Edit ${info.label} node`}>
          <div className="wf-modal-head">
            <b>
              <KindIcon kind={node.kind} /> {info.label}
            </b>
            <span className="muted">#{node.id}</span>
            <button type="button" className="wf-icon-btn" aria-label="Collapse editor" onClick={onCollapse}>
              ⤡
            </button>
          </div>
          <div className="wf-modal-body">
            <div className="wf-modal-side">
              {fieldsEl}
              <div className="wf-modal-pins">
                <span className="wf-field-label">pins</span>
                {[...pins.inputs.map((p) => ({ p, dir: 'in' })), ...pins.outputs.map((p) => ({ p, dir: 'out' }))].map(
                  ({ p, dir }) => (
                    <div key={`${dir}-${p.label}`} className="wf-pin-cell">
                      <span
                        className={`wf-pin wf-pin-${p.type}`}
                        style={typedMode ? { ['--pin' as string]: `var(${pinColorVar(p.type)})` } : undefined}
                        aria-hidden="true"
                      />
                      {p.label} <span className="muted">{dir} · {p.type}</span>
                    </div>
                  ),
                )}
              </div>
            </div>
            <div className="wf-modal-main">
              {big ? (
                <>
                  <span className="wf-field-label">{big.label}</span>
                  <textarea
                    className="wf-modal-editor"
                    autoFocus
                    spellCheck={false}
                    aria-label={big.label}
                    value={draft[big.key]}
                    readOnly={readOnly}
                    onChange={(e) => set(big.key, e.target.value)}
                  />
                </>
              ) : (
                <p className="muted">This node has no long text to edit; use the fields on the left.</p>
              )}
            </div>
          </div>
          <div className="wf-modal-foot">{actions}</div>
        </div>
      </div>,
      document.body,
    )
  }

  return (
    <div className="wf-inspector wf-float nowheel nopan nodrag" style={style}>
      <div className="wf-inspector-head">
        <b>
          <KindIcon kind={node.kind} /> {info.label}
        </b>
        <span className="muted">#{node.id}</span>
        <span className="wf-head-btns">
          <button type="button" className="wf-icon-btn" aria-label="Expand editor" onClick={onExpand}>
            ⤢
          </button>
          <button type="button" className="wf-icon-btn" aria-label="Close editor" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>
      {fieldsEl}
      {actions}
    </div>
  )
}

/** Positions the node editor beside its node (the side with more room, kept
 *  inside the viewport) and draws a dashed wire back to it; follows pan, zoom
 *  and drag because it reads the canvas store. Narrow tiers dock it instead
 *  (CSS). Renders inside <ReactFlow>. */
function NodeFloat({
  node,
  ...rest
}: { node: WorkflowNode } & Omit<React.ComponentProps<typeof NodeInspector>, 'node' | 'style'>) {
  const transform = useStore((s) => s.transform)
  const width = useStore((s) => s.width)
  const height = useStore((s) => s.height)
  const internal = useStore((s) => s.nodeLookup.get(String(node.id)))
  const zoom = transform[2]
  const w = (internal?.measured.width ?? 210) * zoom
  const h = (internal?.measured.height ?? 80) * zoom
  const pos = internal?.internals.positionAbsolute ?? { x: node.x, y: node.y }
  const place = placePanel(
    { left: pos.x * zoom + transform[0], top: pos.y * zoom + transform[1], width: w, height: h },
    { width, height },
  )
  return (
    <>
      <svg className="wf-float-wire" width={width} height={height} aria-hidden="true">
        <line x1={place.from.x} y1={place.from.y} x2={place.to.x} y2={place.to.y} />
      </svg>
      <NodeInspector
        node={node}
        {...rest}
        style={{ left: place.left, top: place.top, width: PANEL_W, minHeight: PANEL_H }}
      />
    </>
  )
}

type PinMenuState = { x: number; y: number; nodeId: number; side: PinSide; pin: string; ty: string }

/** The right-click / long-press menu on a pin: Break or Make for a struct pin,
 *  Disconnect when it is wired. Opaque panel, Esc / click-away closes, arrow
 *  keys move between items. */
function PinMenu({
  menu,
  types,
  edges,
  nodes,
  onShape,
  onDisconnect,
  onClose,
}: {
  menu: PinMenuState
  types: WorkflowType[]
  edges: WorkflowView['edges']
  nodes: WorkflowNode[]
  onShape: (m: PinMenuState) => void
  onDisconnect: (m: PinMenuState) => void
  onClose: () => void
}) {
  const plan = shapePlan(menu.side, menu.ty, types)
  const node = nodes.find((n) => n.id === menu.nodeId)
  const wired =
    !!node &&
    edges.some((e) =>
      menu.side === 'out'
        ? e.from_node === node.id && effectivePin(node, 'out', e.from_pin, types) === menu.pin
        : e.to_node === node.id && effectivePin(node, 'in', e.to_pin, types) === menu.pin,
    )
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = Array.from(ref.current?.querySelectorAll('button') ?? [])
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      }
    }
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', away)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', away)
    }
  }, [onClose])
  return createPortal(
    <div ref={ref} className="wf-pin-menu" role="menu" aria-label={`${menu.pin} pin`} style={{ left: menu.x, top: menu.y }}>
      <div className="wf-pin-menu-head">
        {menu.pin} <span className="muted">{menu.ty}</span>
      </div>
      {plan && (
        <button type="button" role="menuitem" onClick={() => onShape(menu)}>
          {plan.label}
        </button>
      )}
      {wired && (
        <button type="button" role="menuitem" onClick={() => onDisconnect(menu)}>
          Disconnect
        </button>
      )}
      {!plan && !wired && <span className="wf-pin-menu-empty muted">Nothing to do on a {menu.ty} pin.</span>}
    </div>,
    document.body,
  )
}

type Selection = { kind: 'node'; id: number } | { kind: 'edge'; id: number } | null

/**
 * The workflow builder: a palette of the six node kinds down the left, the
 * graph on a React Flow canvas, and an inspector for whatever is selected.
 * Every gesture is one request — a palette drop creates a node, a node drag
 * ends in a PATCH of x/y, a connection creates an edge — and a refusal from
 * the store (cycle, validation, conflict) is shown inline instead of being
 * swallowed. The server's graph is the only state: after each change the
 * parent refetches and the canvas re-derives from it.
 */
export function WorkflowCanvas({
  view,
  run,
  onChanged,
  readOnly = false,
}: {
  /** A built-in: nothing on the canvas edits the graph (naru task 2103). */
  readOnly?: boolean
  view: WorkflowView
  /** The run whose steps are painted on the nodes, if one is shown. */
  run: WorkflowRun | null
  onChanged: () => void
}) {
  const workflowId = view.workflow.id
  // The background dots follow the theme (naru task 1784).
  const [, setThemeTick] = useState(0)
  useEffect(() => onThemeChange(() => setThemeTick((n) => n + 1)), [])
  const dotColor = `rgba(${cssVar('--cyan-rgb', '0, 229, 255')}, 0.12)`
  const [error, setError] = useState<string | null>(null)
  // A wire refused by the pin types: shown in the same slot for four seconds.
  const [refusal, setRefusal] = useState<string | null>(null)
  useEffect(() => {
    if (refusal === null) return
    const t = window.setTimeout(() => setRefusal(null), 4000)
    return () => window.clearTimeout(t)
  }, [refusal])
  const [typesOpen, setTypesOpen] = useState(false)
  const [drag, setDrag] = useState<DragFrom>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: number; side: PinSide; pin: string; ty: string } | null>(null)
  const types = view.workflow.types
  const [selection, setSelection] = useState<Selection>(null)
  // Expanded belongs to one selection: picking anything else folds it away.
  const [expandedSel, setExpandedSel] = useState<Selection>(null)
  const expanded = expandedSel !== null && expandedSel === selection
  const setExpanded = (on: boolean) => setExpandedSel(on ? selection : null)
  // Esc folds the expanded editor back into the floating panel.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedSel(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])
  const { data: scripts } = useFetch(() => listScripts(), 'workflow-scripts')
  const { data: workflows } = useFetch(() => listWorkflows(), 'workflow-subworkflows')
  const { data: library } = useFetch(() => listLibrary(), 'workflow-agents')
  const agents = library ? library.filter((i) => i.kind === 'agent') : null
  const rf = useRef<ReactFlowInstance<CardNode, Edge> | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>([])

  const statuses = useMemo(() => stepStatusByNode(run), [run])

  // The shown run's gate approvals (naru task 1993): polled while it runs so
  // a waiting gate shows its Approve / Reject buttons on the card.
  const runId = run?.id ?? null
  const { data: gates, refetch: refetchGates } = useFetch(
    () => (runId === null ? Promise.resolve([] as WorkflowGate[]) : listWorkflowGates(runId)),
    `workflow-gates-${runId ?? 'none'}-${run?.status ?? ''}`,
    { pollMs: run?.status === 'running' ? 2000 : undefined },
  )
  const gatesByNode = useMemo(() => gateByNode(gates), [gates])
  const [gateBusy, setGateBusy] = useState<number | null>(null)
  const [gateError, setGateError] = useState<string | null>(null)
  function decideGate(gate: WorkflowGate, decision: 'approved' | 'rejected') {
    setGateBusy(gate.id)
    setGateError(null)
    decideWorkflowGate(gate.id, decision).then(
      () => {
        setGateBusy(null)
        void refetchGates()
      },
      (err: unknown) => {
        setGateBusy(null)
        // A 409 means someone else decided first: show the final state.
        setGateError(err instanceof Error ? err.message : String(err))
        void refetchGates()
      },
    )
  }

  function openPinMenu(at: { x: number; y: number }, nodeId: number, side: PinSide, pin: string, ty: string) {
    if (readOnly) return
    setMenu({ ...at, nodeId, side, pin, ty })
  }

  // The graph the server holds is the truth: re-derive the card nodes from it
  // whenever it or the shown run changes. Selection is deliberately not a
  // dependency (it is read through a ref): a position rebuild on a click would
  // snap a just-dragged node back until its PATCH has been refetched.
  const selectionRef = useRef(selection)
  useEffect(() => {
    selectionRef.current = selection
  }, [selection])
  useEffect(() => {
    const sel = selectionRef.current
    setNodes(
      view.nodes.map((n) => ({
        id: String(n.id),
        type: 'card' as const,
        position: { x: n.x, y: n.y },
        ...(n.kind === 'comment' ? { zIndex: -1, style: { width: COMMENT_W, height: COMMENT_H } } : {}),
        selected: sel?.kind === 'node' && sel.id === n.id,
        data: {
          node: n,
          status: statuses.get(n.id),
          types,
          drag: null,
          onPinMenu: openPinMenu,
          gate: gatesByNode.get(n.id),
          gateBusy,
          gateError,
          onDecide: decideGate,
        },
      })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.nodes, statuses, types, setNodes, gatesByNode, gateBusy, gateError])

  // A wire in flight dims the pins it cannot land on, in place (no rebuild,
  // so no node snaps back).
  useEffect(() => {
    setNodes((prev) => prev.map((n) => (n.data.drag === drag ? n : { ...n, data: { ...n.data, drag } })))
  }, [drag, setNodes])

  // A selection change only flips the `selected` flags, leaving every position
  // (including one mid-drag) as the canvas holds it.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        const s = selection?.kind === 'node' && String(selection.id) === n.id
        return n.selected === s ? n : { ...n, selected: s }
      }),
    )
  }, [selection, setNodes])

  const edges: Edge[] = useMemo(
    () =>
      view.edges.map((e) => {
        const from = view.nodes.find((n) => n.id === e.from_node)
        const to = view.nodes.find((n) => n.id === e.to_node)
        const fromPin = from ? effectivePin(from, 'out', e.from_pin, types) : null
        const toPin = to ? effectivePin(to, 'in', e.to_pin, types) : null
        // A break/make has typed handles only; elsewhere a null pin is the
        // node's flow handle.
        const typedFrom = e.from_pin !== null || from?.kind === 'break' || from?.kind === 'make'
        const typedTo = e.to_pin !== null || to?.kind === 'break' || to?.kind === 'make'
        return {
        id: String(e.id),
        source: String(e.from_node),
        target: String(e.to_node),
        sourceHandle: typedFrom && fromPin ? pinHandleId('out', fromPin) : (e.branch ?? undefined),
        targetHandle: typedTo && toPin ? pinHandleId('in', toPin) : undefined,
        label: e.branch ?? undefined,
        className: `${edgeLabelClass(e.branch)}${
          selection?.kind === 'edge' && selection.id === e.id ? ' selected' : ''
        }`,
        selected: selection?.kind === 'edge' && selection.id === e.id,
        }
      }),
    [view.edges, view.nodes, types, selection],
  )

  const showError = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err))
  }, [])
  const changed = useCallback(() => {
    setError(null)
    onChanged()
  }, [onChanged])

  const addNode = useCallback(
    (kind: WorkflowNodeKind, pos?: { x: number; y: number }) => {
      const info = kindInfo(kind)
      // A click (no drop point) lands a little in from the top-left of what is
      // on screen, staggered so a run of clicks does not stack exactly.
      const vp = rf.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 }
      const stagger = (view.nodes.length % 5) * 40
      const at = pos ?? {
        x: (80 - vp.x) / vp.zoom + stagger,
        y: (80 - vp.y) / vp.zoom + stagger,
      }
      createWorkflowNode(workflowId, {
        kind,
        title: info.title,
        config: defaultConfig(kind, scripts?.[0]?.name, agents?.[0]?.name),
        x: Math.round(at.x),
        y: Math.round(at.y),
      }).then((created) => {
        changed()
        setSelection({ kind: 'node', id: created.id })
      }, showError)
    },
    [view.nodes.length, workflowId, scripts, agents, changed, showError],
  )

  function onPaneDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(NODE_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function onPaneDrop(e: React.DragEvent) {
    if (readOnly) return
    const kind = decodeKindDrag(e.dataTransfer.getData(NODE_DRAG_MIME))
    const inst = rf.current
    if (kind === null || !inst) return
    e.preventDefault()
    const p = inst.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    addNode(kind, { x: p.x - 80, y: p.y - 24 })
  }

  function onConnect(c: Connection) {
    if (readOnly || c.source === c.target) return // self-edges are rejected server-side
    const source = view.nodes.find((n) => String(n.id) === c.source)
    const target = view.nodes.find((n) => String(n.id) === c.target)
    if (!source || !target) return
    const fromPin = pinOfHandle('out', c.sourceHandle)
    const toPin = pinOfHandle('in', c.targetHandle)
    // Typed pins only wire to a matching type; say why in words.
    const why = refusalReason(source, fromPin, target, toPin, types)
    if (why !== null) {
      setRefusal(why)
      return
    }
    createWorkflowEdge(workflowId, {
      from_node: Number(c.source),
      to_node: Number(c.target),
      branch: fromPin ? undefined : branchForHandle(source.kind, c.sourceHandle),
      ...(fromPin ? { from_pin: fromPin } : {}),
      ...(toPin ? { to_pin: toPin } : {}),
    }).then(changed, showError)
  }

  function onConnectStart(
    _e: unknown,
    p: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null },
  ) {
    const n = view.nodes.find((x) => String(x.id) === p.nodeId)
    if (!n || !p.handleType) return
    const side: PinSide = p.handleType === 'source' ? 'out' : 'in'
    const ty = pinType(n, side, pinOfHandle(side, p.handleId), types)
    setDrag(ty === null ? null : { side, ty })
  }

  /** Break (on a struct output) / Make (on a struct input): a new node for
   *  the struct, wired to the pin, placed beside its node and selected. */
  function shapeFromPin(m: NonNullable<typeof menu>) {
    const node = view.nodes.find((n) => n.id === m.nodeId)
    const plan = shapePlan(m.side, m.ty, types)
    setMenu(null)
    if (!node || !plan) return
    const brk = plan.kind === 'break'
    createWorkflowNode(workflowId, {
      kind: plan.kind,
      title: plan.title,
      config: { struct: plan.struct },
      x: Math.round(node.x + (brk ? 300 : -280)),
      y: Math.round(node.y),
    }).then(
      (created) =>
        createWorkflowEdge(
          workflowId,
          brk
            ? { from_node: node.id, to_node: created.id, from_pin: m.pin, to_pin: 'value' }
            : { from_node: created.id, to_node: node.id, from_pin: 'value', to_pin: m.pin },
        ).then(() => {
          changed()
          setSelection({ kind: 'node', id: created.id })
        }, showError),
      showError,
    )
  }

  /** Deletes every wire on one pin. */
  function disconnectPin(m: NonNullable<typeof menu>) {
    const node = view.nodes.find((n) => n.id === m.nodeId)
    setMenu(null)
    if (!node) return
    const wired = view.edges.filter((e) =>
      m.side === 'out'
        ? e.from_node === node.id && effectivePin(node, 'out', e.from_pin, types) === m.pin
        : e.to_node === node.id && effectivePin(node, 'in', e.to_pin, types) === m.pin,
    )
    Promise.all(wired.map((e) => deleteWorkflowEdge(e.id))).then(changed, showError)
  }

  function onNodeDragStop(_e: unknown, node: CardNode) {
    const n = view.nodes.find((x) => String(x.id) === node.id)
    const x = Math.round(node.position.x)
    const y = Math.round(node.position.y)
    // A click on the card also fires dragStop; only a real move PATCHes.
    if (n && n.x === x && n.y === y) return
    updateWorkflowNode(Number(node.id), { x, y }).then(changed, showError)
  }

  /** Lays the graph out left-to-right in ranked layers and PATCHes each node
   *  whose position actually moved. */
  function autoLayout() {
    const measured = new Map<number, { w: number; h: number }>()
    for (const n of rf.current?.getNodes() ?? []) {
      const w = n.measured?.width
      const h = n.measured?.height
      if (w && h) measured.set(Number(n.id), { w, h })
    }
    const boxes = view.nodes.map((n) => ({ id: n.id, ...(measured.get(n.id) ?? { w: 180, h: 64 }) }))
    const positions = layoutNodes(
      boxes,
      view.edges.map((e) => ({ from: e.from_node, to: e.to_node })),
      'horizontal',
    )
    const moves = view.nodes
      .map((n) => ({ n, p: positions.get(n.id)! }))
      .filter(({ n, p }) => n.x !== Math.round(p.x) || n.y !== Math.round(p.y))
    Promise.all(
      moves.map(({ n, p }) =>
        updateWorkflowNode(n.id, { x: Math.round(p.x), y: Math.round(p.y) }),
      ),
    ).then(changed, showError)
  }

  // Collapsed palette groups: per-browser, all open by default.
  const [collapsed, setCollapsed] = useState(loadPaletteCollapsed)
  const toggleGroup = (name: string) => {
    const next = collapsed.includes(name)
      ? collapsed.filter((n) => n !== name)
      : [...collapsed, name]
    setCollapsed(next)
    savePaletteCollapsed(next)
  }

  // Pan/zoom is browser-local view state, keyed by workflow (boardView.ts):
  // loaded once per mount (the parent remounts per workflow), saved on every
  // move end.
  const [defaultViewport] = useState<Viewport>(() => {
    const saved = loadBoardView(workflowId)
    return saved ? { x: saved.tx, y: saved.ty, zoom: saved.scale } : { x: 0, y: 0, zoom: 1 }
  })

  const selectedNode =
    selection?.kind === 'node' ? view.nodes.find((n) => n.id === selection.id) : undefined
  const selectedEdge =
    selection?.kind === 'edge' ? view.edges.find((e) => e.id === selection.id) : undefined
  const title = (id: number) => view.nodes.find((n) => n.id === id)?.title ?? `#${id}`

  return (
    <div className="workflow-canvas">
      <div className="wf-palette">
        <div className="wf-palette-title">NODES</div>
        {PALETTE_GROUPS.map((g) => {
          const open = !collapsed.includes(g.name)
          return (
            <div key={g.name} className="wf-palette-group">
              <button
                type="button"
                className="wf-palette-group-head"
                aria-expanded={open}
                onClick={() => toggleGroup(g.name)}
              >
                <span aria-hidden="true">{open ? '▾' : '▸'}</span> {g.name}
              </button>
              {open &&
                g.kinds.map(kindInfo).map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    className={`wf-palette-item wf-kind-${k.kind}`}
                    draggable={!readOnly}
                    disabled={readOnly}
                    title={readOnly ? BUILTIN_TITLE : `Drag onto the canvas, or click to add a ${k.label}`}
                    aria-label={readOnly ? `Add ${k.label} disabled: built-in workflow` : undefined}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(NODE_DRAG_MIME, k.kind)
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={() => addNode(k.kind)}
                  >
                    <span aria-hidden="true"><KindIcon kind={k.kind} /></span> {k.label}
                  </button>
                ))}
            </div>
          )
        })}
      </div>
      <div
        className="wf-viewport"
        onDragEnter={onPaneDragOver}
        onDragOver={onPaneDragOver}
        onDrop={onPaneDrop}
      >
        <ReactFlow
          colorMode="dark"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={(inst) => {
            rf.current = inst
          }}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={(_e, node) => setSelection({ kind: 'node', id: Number(node.id) })}
          onEdgeClick={(_e, edge) => setSelection({ kind: 'edge', id: Number(edge.id) })}
          onPaneClick={() => setSelection(null)}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={() => setDrag(null)}
          defaultViewport={defaultViewport}
          onMoveEnd={(_e, vp) => saveBoardView(workflowId, { tx: vp.x, ty: vp.y, scale: vp.zoom })}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          zoomOnDoubleClick={false}
          // Deletion stays behind the explicit controls in the inspector,
          // never a stray keypress — matching the rest of the app.
          deleteKeyCode={null}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          nodesFocusable={false}
          edgesFocusable={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} color={dotColor} />
          <Controls showInteractive={false} position="top-right" />
          <Panel position="top-left" className="wf-controls">
            <button
              type="button"
              onClick={autoLayout}
              disabled={readOnly}
              title={readOnly ? BUILTIN_TITLE : 'Arrange the nodes left to right by flow'}
            >
              auto layout
            </button>
            <button
              type="button"
              onClick={() => setTypesOpen((o) => !o)}
              aria-pressed={typesOpen}
              disabled={readOnly}
              title={readOnly ? BUILTIN_TITLE : 'Define the struct types your pins can carry'}
            >
              types
            </button>
            {(refusal ?? error) && (
              <span className="error wf-error" role="status">
                {refusal ?? error}
              </span>
            )}
          </Panel>
          {selectedNode && (
            <NodeFloat
              key={inspectorKey(selectedNode)}
              node={selectedNode}
              types={types}
              scripts={scripts ?? []}
              workflows={workflows ?? []}
              agents={agents}
              readOnly={readOnly}
              onSaved={changed}
              onError={setError}
              onDeleted={() => {
                setSelection(null)
                changed()
              }}
              expanded={expanded}
              onExpand={() => setExpanded(true)}
              onCollapse={() => setExpanded(false)}
              onClose={() => setSelection(null)}
            />
          )}
        </ReactFlow>
        <div className="wf-hint muted">
          <SpeakIcon /> &ldquo;Naru, run {view.workflow.name}&rdquo; · or call it from a skill
        </div>
        {typesOpen && (
          <WorkflowTypesCard
            workflowId={workflowId}
            types={types}
            nodes={view.nodes}
            onChanged={changed}
            onClose={() => setTypesOpen(false)}
          />
        )}
        {menu && <PinMenu menu={menu} types={types} edges={view.edges} nodes={view.nodes} onShape={shapeFromPin} onDisconnect={disconnectPin} onClose={() => setMenu(null)} />}
        {selectedEdge && (
          <div className="wf-inspector">
            <div className="wf-inspector-head">
              <b>edge</b>
              <span className="muted">#{selectedEdge.id}</span>
            </div>
            <p>
              {title(selectedEdge.from_node)}
              {selectedEdge.from_pin && <span className="muted"> · {selectedEdge.from_pin}</span>} →{' '}
              {title(selectedEdge.to_node)}
              {selectedEdge.to_pin && <span className="muted"> · {selectedEdge.to_pin}</span>}
              {selectedEdge.branch && <span className="muted"> · when {selectedEdge.branch}</span>}
            </p>
            <div className="wf-inspector-actions">
              <button
                type="button"
                className="danger"
                disabled={readOnly}
                title={readOnlyTitle(readOnly)}
                aria-label={readOnly ? 'Delete edge disabled: built-in workflow' : undefined}
                onClick={() =>
                  deleteWorkflowEdge(selectedEdge.id).then(() => {
                    setSelection(null)
                    changed()
                  }, showError)
                }
              >
                delete edge
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
