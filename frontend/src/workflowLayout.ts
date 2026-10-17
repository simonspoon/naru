// Pure logic for the Blueprint-style workflow editor (naru task 1980): which
// data pins a node card shows, and where the floating edit panel sits beside
// its node. The data model has no pin types, so the pins are derived from the
// node kind (docs/workflows.md "The editor's look"). Flow pins are the React
// Flow handles and are not described here.

import type { WorkflowNodeKind } from './types/WorkflowNodeKind'

export type PinType = 'string' | 'result' | 'model' | 'bool'

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
      return { inputs: [], outputs: [{ label: 'event', type: 'string' }] }
    case 'prompt':
      return {
        inputs: [
          { label: 'input', type: 'string' },
          { label: 'model', type: 'model' },
        ],
        outputs: [{ label: 'result', type: 'result' }],
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
      return { inputs: [{ label: 'input', type: 'string' }], outputs: [] }
    case 'output':
      return { inputs: [{ label: 'result', type: 'result' }], outputs: [] }
  }
}

/** The theme colour variable a kind's header is tinted with. */
export function kindColorVar(kind: WorkflowNodeKind): string {
  switch (kind) {
    case 'trigger':
      return '--red'
    case 'output':
      return '--green'
    case 'branch':
    case 'decide':
      return '--violet'
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
