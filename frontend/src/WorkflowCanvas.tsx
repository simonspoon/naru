import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useNodesState,
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
  deleteWorkflowNode,
  listScripts,
  updateWorkflowNode,
} from './api'
import { loadBoardView, saveBoardView } from './boardView'
import { layoutNodes } from './layout'
import { useFetch } from './useFetch'
import {
  BRANCH_OPS,
  INBOX_KINDS,
  NODE_DRAG_MIME,
  NODE_KINDS,
  OUTPUT_TARGETS,
  PROMPT_MODELS,
  TRIGGER_MODES,
  branchForHandle,
  buildConfig,
  decodeKindDrag,
  defaultConfig,
  draftFromConfig,
  hasInput,
  hasOutput,
  inspectorKey,
  kindInfo,
  missingValueRows,
  summarize,
  type ConfigDraft,
} from './workflowConfig'
import { stepClass, stepStatusByNode } from './workflowRun'
import type { Script } from './types/Script'
import type { WorkflowNode } from './types/WorkflowNode'
import type { WorkflowNodeKind } from './types/WorkflowNodeKind'
import type { WorkflowRun } from './types/WorkflowRun'
import type { WorkflowStepStatus } from './types/WorkflowStepStatus'
import type { WorkflowView } from './types/WorkflowView'
import { KindIcon, SpeakIcon } from './components/WorkflowIcon'

type CardData = { node: WorkflowNode; status: WorkflowStepStatus | undefined }
type CardNode = Node<CardData, 'card'>

/** One node as a card: icon, bold title, a muted one-line summary, handles for
 *  the connections it may take, and the last run's step state as a ring. A
 *  branch offers two labelled source handles so the edge's `true`/`false` is
 *  decided by where the line is dragged from. */
function NodeCard({ data, selected }: NodeProps<CardNode>) {
  const { node, status } = data
  return (
    <div
      className={`wf-node wf-kind-${node.kind}${selected ? ' selected' : ''} ${stepClass(status)}`}
      title={status ? `last run: ${status}` : undefined}
    >
      {hasInput(node.kind) && <Handle type="target" position={Position.Left} />}
      <div className="wf-node-head">
        <span className="wf-node-icon" aria-hidden="true">
          <KindIcon kind={node.kind} />
        </span>
        <b className="wf-node-title">{node.title}</b>
      </div>
      {status && <span className="wf-node-step">{status}</span>}
      <div className="wf-node-sum">{summarize(node.kind, node.config)}</div>
      {node.kind === 'branch' ? (
        <>
          <Handle
            id="true"
            type="source"
            position={Position.Right}
            className="wf-handle-true"
            style={{ top: '30%' }}
          />
          <span className="wf-branch-label wf-branch-true" style={{ top: '30%' }}>
            true
          </span>
          <Handle
            id="false"
            type="source"
            position={Position.Right}
            className="wf-handle-false"
            style={{ top: '70%' }}
          />
          <span className="wf-branch-label wf-branch-false" style={{ top: '70%' }}>
            false
          </span>
        </>
      ) : (
        hasOutput(node.kind) && <Handle type="source" position={Position.Right} />
      )}
    </div>
  )
}

const nodeTypes = { card: NodeCard }

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
function NodeInspector({
  node,
  scripts,
  onSaved,
  onError,
  onDeleted,
}: {
  node: WorkflowNode
  scripts: Script[]
  onSaved: () => void
  onError: (message: string | null) => void
  onDeleted: () => void
}) {
  const [title, setTitle] = useState(node.title)
  const [draft, setDraft] = useState<ConfigDraft>(() => draftFromConfig(node.kind, node.config))
  const [formError, setFormError] = useState<string | null>(null)
  const set = <K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const info = kindInfo(node.kind)

  function save() {
    const built = buildConfig(node.kind, draft)
    if (built.error !== null) {
      setFormError(built.error)
      return
    }
    setFormError(null)
    updateWorkflowNode(node.id, { title: title.trim() || node.title, config: built.config }).then(
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

  return (
    <div className="wf-inspector">
      <div className="wf-inspector-head">
        <b>
          <KindIcon kind={node.kind} /> {info.label}
        </b>
        <span className="muted">#{node.id}</span>
      </div>
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
          <Field label="phrase" hint="what a spoken request says to run it (optional)">
            <input type="text" value={draft.phrase} onChange={(e) => set('phrase', e.target.value)} />
          </Field>
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
          <Field label="prompt" hint="the node's input follows it after a blank line">
            <textarea
              rows={5}
              value={draft.prompt}
              onChange={(e) => set('prompt', e.target.value)}
            />
          </Field>
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

      {node.kind === 'cli' && (
        <>
          <Field label="command" hint="bash -c, verbatim; the input is on stdin and $NARU_INPUT">
            <textarea
              rows={4}
              value={draft.command}
              onChange={(e) => set('command', e.target.value)}
            />
          </Field>
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

      {formError && <p className="error wf-inspector-error">{formError}</p>}
      <div className="wf-inspector-actions">
        <button type="button" onClick={save}>
          save
        </button>
        <button type="button" className="danger" onClick={remove}>
          delete node
        </button>
      </div>
    </div>
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
}: {
  view: WorkflowView
  /** The run whose steps are painted on the nodes, if one is shown. */
  run: WorkflowRun | null
  onChanged: () => void
}) {
  const workflowId = view.workflow.id
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const { data: scripts } = useFetch(() => listScripts(), 'workflow-scripts')
  const rf = useRef<ReactFlowInstance<CardNode, Edge> | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>([])

  const statuses = useMemo(() => stepStatusByNode(run), [run])

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
        selected: sel?.kind === 'node' && sel.id === n.id,
        data: { node: n, status: statuses.get(n.id) },
      })),
    )
  }, [view.nodes, statuses, setNodes])

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
      view.edges.map((e) => ({
        id: String(e.id),
        source: String(e.from_node),
        target: String(e.to_node),
        sourceHandle: e.branch ?? undefined,
        label: e.branch ?? undefined,
        className: `${e.branch ? `wf-edge-${e.branch}` : ''}${
          selection?.kind === 'edge' && selection.id === e.id ? ' selected' : ''
        }`,
        selected: selection?.kind === 'edge' && selection.id === e.id,
      })),
    [view.edges, selection],
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
        config: defaultConfig(kind, scripts?.[0]?.name),
        x: Math.round(at.x),
        y: Math.round(at.y),
      }).then((created) => {
        changed()
        setSelection({ kind: 'node', id: created.id })
      }, showError)
    },
    [view.nodes.length, workflowId, scripts, changed, showError],
  )

  function onPaneDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(NODE_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function onPaneDrop(e: React.DragEvent) {
    const kind = decodeKindDrag(e.dataTransfer.getData(NODE_DRAG_MIME))
    const inst = rf.current
    if (kind === null || !inst) return
    e.preventDefault()
    const p = inst.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    addNode(kind, { x: p.x - 80, y: p.y - 24 })
  }

  function onConnect(c: Connection) {
    if (c.source === c.target) return // self-edges are rejected server-side
    const source = view.nodes.find((n) => String(n.id) === c.source)
    if (!source) return
    createWorkflowEdge(workflowId, {
      from_node: Number(c.source),
      to_node: Number(c.target),
      branch: branchForHandle(source.kind, c.sourceHandle),
    }).then(changed, showError)
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
        {NODE_KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            className={`wf-palette-item wf-kind-${k.kind}`}
            draggable
            title={`Drag onto the canvas, or click to add a ${k.label}`}
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
          defaultViewport={defaultViewport}
          onMoveEnd={(_e, vp) => saveBoardView(workflowId, { tx: vp.x, ty: vp.y, scale: vp.zoom })}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          zoomOnDoubleClick={false}
          // Deletion stays behind the explicit controls in the inspector,
          // never a stray keypress — matching the rest of the app.
          deleteKeyCode={null}
          nodesFocusable={false}
          edgesFocusable={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} color="rgba(0, 229, 255, 0.12)" />
          <Controls showInteractive={false} position="top-right" />
          <Panel position="top-left" className="wf-controls">
            <button type="button" onClick={autoLayout} title="Arrange the nodes left to right by flow">
              auto layout
            </button>
            {error && <span className="error wf-error">{error}</span>}
          </Panel>
        </ReactFlow>
        <div className="wf-hint muted">
          <SpeakIcon /> &ldquo;Naru, run {view.workflow.name}&rdquo; · or call it from a skill
        </div>
        {selectedNode && (
          <NodeInspector
            key={inspectorKey(selectedNode)}
            node={selectedNode}
            scripts={scripts ?? []}
            onSaved={changed}
            onError={setError}
            onDeleted={() => {
              setSelection(null)
              changed()
            }}
          />
        )}
        {selectedEdge && (
          <div className="wf-inspector">
            <div className="wf-inspector-head">
              <b>edge</b>
              <span className="muted">#{selectedEdge.id}</span>
            </div>
            <p>
              {title(selectedEdge.from_node)} → {title(selectedEdge.to_node)}
              {selectedEdge.branch && <span className="muted"> · when {selectedEdge.branch}</span>}
            </p>
            <div className="wf-inspector-actions">
              <button
                type="button"
                className="danger"
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
