// Pure logic for the Blueprint-style workflow editor (naru task 1980): which
// data pins a node card shows, and where the floating edit panel sits beside
// its node. The data model has no pin types, so the pins are derived from the
// node kind (docs/workflows.md "The editor's look"). Flow pins are the React
// Flow handles and are not described here.

import type { WorkflowNodeKind } from './types/WorkflowNodeKind'

export type PinType = 'string' | 'result' | 'model' | 'bool' | 'number' | 'any'

export interface Pin {
  label: string
  type: PinType
}

export interface NodePins {
  inputs: Pin[]
  outputs: Pin[]
}

/** A prompt reading a `local:` model still takes a model pin; the label is
 *  the only thing that would differ, so the kind alone decides. */
export function pinsFor(kind: WorkflowNodeKind): NodePins {
  switch (kind) {
    case 'trigger':
    case 'schedule':
      return { inputs: [], outputs: [{ label: 'event', type: 'string' }] }
    case 'task-event':
      // The server declares the `task` pin (the change as JSON text).
      return { inputs: [], outputs: [{ label: 'task', type: 'string' }] }
    case 'file-watch':
      // The server declares the `event` pin (the change as JSON text).
      return { inputs: [], outputs: [{ label: 'event', type: 'string' }] }
    case 'webhook':
      // The server declares the typed `body` pin; this is the untyped fallback.
      return { inputs: [], outputs: [{ label: 'body', type: 'any' }] }
    case 'prompt':
      return {
        inputs: [
          { label: 'input', type: 'string' },
          { label: 'model', type: 'model' },
        ],
        outputs: [{ label: 'result', type: 'result' }],
      }
    case 'agent':
      // The server declares the typed pins (`result` carries the node's
      // result type); these are the fallback for a node without them.
      return {
        inputs: [{ label: 'input', type: 'string' }],
        outputs: [
          { label: 'result', type: 'result' },
          { label: 'status', type: 'string' },
        ],
      }
    case 'comment':
      return { inputs: [], outputs: [] }
    case 'verify':
      return {
        inputs: [{ label: 'input', type: 'string' }],
        outputs: [
          { label: 'pass', type: 'bool' },
          { label: 'evidence', type: 'string' },
          { label: 'exit_code', type: 'number' },
        ],
      }
    case 'memory':
      return {
        inputs: [{ label: 'input', type: 'string' }],
        outputs: [
          { label: 'result', type: 'string' },
          { label: 'id', type: 'string' },
        ],
      }
    case 'file':
      return {
        inputs: [{ label: 'input', type: 'string' }],
        outputs: [
          { label: 'result', type: 'string' },
          { label: 'path', type: 'string' },
        ],
      }
    case 'git':
      // The server declares the typed pins; these are the fallback.
      return {
        inputs: [{ label: 'input', type: 'string' }],
        outputs: [
          { label: 'result', type: 'string' },
          { label: 'ok', type: 'bool' },
          { label: 'status', type: 'string' },
        ],
      }
    case 'cli':
    case 'script':
      return {
        inputs: [{ label: 'input', type: 'string' }],
        outputs: [{ label: 'result', type: 'result' }],
      }
    case 'branch':
      // true/false are flow handles with their own labels.
      return { inputs: [{ label: 'input', type: 'string' }], outputs: [] }
    case 'decide':
    case 'switch':
      return { inputs: [{ label: 'input', type: 'string' }], outputs: [] }
    case 'output':
      return { inputs: [{ label: 'result', type: 'result' }], outputs: [] }
    // Fallback mirroring the pins the server declares for the kind.
    case 'parse-json':
      return {
        inputs: [{ label: 'text', type: 'string' }],
        outputs: [{ label: 'value', type: 'any' }],
      }
    case 'variable':
      return {
        inputs: [{ label: 'value', type: 'any' }],
        outputs: [{ label: 'value', type: 'any' }],
      }
    case 'mapfilter':
      return {
        inputs: [{ label: 'list', type: 'any' }],
        outputs: [{ label: 'list', type: 'any' }],
      }
    case 'foreach':
      return {
        inputs: [{ label: 'list', type: 'any' }],
        outputs: [{ label: 'results', type: 'any' }],
      }
    case 'parallel':
      return {
        inputs: [{ label: 'in', type: 'any' }],
        outputs: [{ label: 'out', type: 'any' }],
      }
    case 'join':
      return {
        inputs: [{ label: 'in', type: 'any' }],
        outputs: [{ label: 'all', type: 'any' }],
      }
    case 'delay':
      return {
        inputs: [{ label: 'in', type: 'any' }],
        outputs: [{ label: 'out', type: 'any' }],
      }
    case 'task':
    case 'http':
    case 'notify':
    case 'board':
    case 'subworkflow':
      return {
        inputs: [{ label: 'in', type: 'any' }],
        outputs: [{ label: 'out', type: 'any' }],
      }
    case 'gate':
      // approved/rejected are flow handles with their own labels.
      return { inputs: [{ label: 'in', type: 'any' }], outputs: [] }
    case 'trycatch':
      // ok/caught are flow handles with their own labels.
      return { inputs: [{ label: 'input', type: 'any' }], outputs: [] }
    case 'retry':
      return {
        inputs: [{ label: 'input', type: 'any' }],
        outputs: [{ label: 'output', type: 'any' }],
      }
    case 'break':
    case 'make':
      // Typed pins: derived from the struct by workflowTypes.pinsOf.
      return { inputs: [], outputs: [] }
  }
}

/** The theme colour variable a kind's header is tinted with. */
export function kindColorVar(kind: WorkflowNodeKind): string {
  switch (kind) {
    case 'trigger':
    case 'schedule':
    case 'webhook':
    case 'task-event':
    case 'file-watch':
      return '--red'
    case 'output':
      return '--green'
    case 'branch':
    case 'decide':
      return '--violet'
    case 'agent':
      return '--magenta'
    case 'comment':
      return '--muted'
    case 'switch':
    case 'task':
    case 'http':
    case 'notify':
    case 'board':
    case 'git':
    case 'file':
    case 'memory':
    case 'verify':
      return '--green'
    case 'parse-json':
    case 'variable':
    case 'mapfilter':
    case 'foreach':
      return '--amber'
    case 'parallel':
    case 'join':
    case 'retry':
    case 'delay':
    case 'gate':
    case 'trycatch':
    case 'subworkflow':
      return '--amber'
    default:
      return '--cyan'
  }
}

export const PANEL_W = 340
export const PANEL_H = 330
export const PANEL_GAP = 16
const EDGE_MARGIN = 8

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface Placement {
  side: 'left' | 'right'
  left: number
  top: number
  /** Where the dashed wire runs from (the panel's near edge) to (the node's). */
  from: { x: number; y: number }
  to: { x: number; y: number }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Places a panel beside `node` (a rect in viewport pixels) on the side with
 *  more room, vertically centred on it, kept fully inside the viewport. */
export function placePanel(
  node: Rect,
  viewport: { width: number; height: number },
  panel: { width: number; height: number } = { width: PANEL_W, height: PANEL_H },
): Placement {
  const roomRight = viewport.width - (node.left + node.width)
  const roomLeft = node.left
  const side: 'left' | 'right' = roomRight >= roomLeft ? 'right' : 'left'
  const rawLeft =
    side === 'right' ? node.left + node.width + PANEL_GAP : node.left - PANEL_GAP - panel.width
  const left = clamp(rawLeft, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.width - panel.width - EDGE_MARGIN))
  const rawTop = node.top + node.height / 2 - panel.height / 2
  const top = clamp(rawTop, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.height - panel.height - EDGE_MARGIN))
  const nodeY = node.top + node.height / 2
  return {
    side,
    left,
    top,
    from: { x: side === 'right' ? left : left + panel.width, y: clamp(nodeY, top, top + panel.height) },
    to: { x: side === 'right' ? node.left + node.width : node.left, y: nodeY },
  }
}
