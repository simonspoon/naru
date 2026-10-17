// Pure logic for typed workflow pins (naru task 1981, docs/workflows.md
// "Typed pins"): the type grammar, which pins a node has, when a wire is
// allowed, the colour a pin takes, and the Break / Make plans a pin's context
// menu offers. A type is a string — `string`, `number`, `bool`, `any`,
// `list<T>` or the name of a struct the workflow defines. Untyped = `any`.
// The server (`core::wftypes`) stays the authority; these checks exist so the
// canvas can refuse a wire with a reason before the round trip.

import type { WorkflowNode } from './types/WorkflowNode'
import type { WorkflowType } from './types/WorkflowType'
import type { WorkflowTypeField } from './types/WorkflowTypeField'

export const PRIMITIVES = ['any', 'string', 'number', 'bool'] as const
/** Names a struct may not take (`core::wftypes::RESERVED`). */
export const RESERVED = ['string', 'number', 'bool', 'any', 'list'] as const
/** The one pin on a struct-valued side of a break (in) or make (out). */
export const VALUE_PIN = 'value'

export type PinSide = 'in' | 'out'

export interface PinInfo {
  name: string
  ty: string
}

export interface NodePinSet {
  inputs: PinInfo[]
  outputs: PinInfo[]
}

/** `list<T>` -> `T`, else null. */
export function listElem(ty: string): string | null {
  return ty.startsWith('list<') && ty.endsWith('>') ? ty.slice(5, -1) : null
}

/** The type a `list<…>` chain finally wraps. */
export function baseOf(ty: string): string {
  const e = listElem(ty)
  return e === null ? ty : baseOf(e)
}

export function isList(ty: string): boolean {
  return listElem(ty) !== null
}

export const listOf = (ty: string) => `list<${ty}>`

/** Whether `ty` is exactly a defined struct (not a list of one). */
export function isStruct(ty: string, types: readonly WorkflowType[]): boolean {
  return types.some((t) => t.name === ty)
}

export function fieldsOf(ty: string, types: readonly WorkflowType[]): WorkflowTypeField[] {
  return types.find((t) => t.name === ty)?.fields ?? []
}

/** Two pins may be wired iff either is `any` or they are the same type. */
export function typesMatch(a: string, b: string): boolean {
  return a === 'any' || b === 'any' || a === b
}

/** Every type a picker offers, primitives first then the defined structs. */
export function typeChoices(types: readonly WorkflowType[]): string[] {
  return [...PRIMITIVES, ...types.map((t) => t.name)]
}

/** The theme variable a type's pin is drawn with. Primitives keep one colour
 *  each; a struct hashes its name onto a fixed palette so it stays the same
 *  colour across reloads. A list takes its element's colour (the canvas
 *  draws it as a ring). */
export function pinColorVar(ty: string): string {
  const base = baseOf(ty)
  switch (base) {
    case 'string':
      return '--cyan'
    case 'number':
      return '--amber'
    case 'bool':
      return '--red'
    case 'any':
      return '--muted'
  }
  const palette = ['--violet', '--magenta', '--green', '--cyan']
  let h = 0
  for (const c of base) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

function declared(node: WorkflowNode, side: PinSide): PinInfo[] {
  const pins = node.config.pins as { in?: unknown; out?: unknown } | undefined
  const raw = side === 'in' ? pins?.in : pins?.out
  if (!Array.isArray(raw)) return []
  return raw.flatMap((p) => {
    const o = p as { name?: unknown; ty?: unknown }
    return typeof o.name === 'string' ? [{ name: o.name, ty: typeof o.ty === 'string' ? o.ty : 'any' }] : []
  })
}

export function structOf(node: WorkflowNode): string {
  const s = node.config.struct
  return typeof s === 'string' ? s : ''
}

/** The typed pins a node shows. A break has one struct input and an output
 *  per field; a make the reverse; any other node shows what its
 *  `config.pins` declares (none = it is untyped). */
export function pinsOf(node: WorkflowNode, types: readonly WorkflowType[]): NodePinSet {
  if (node.kind === 'break') {
    const s = structOf(node)
    return {
      inputs: [{ name: VALUE_PIN, ty: s }],
      outputs: fieldsOf(s, types).map((f) => ({ name: f.name, ty: f.ty })),
    }
  }
  if (node.kind === 'make') {
    const s = structOf(node)
    return {
      inputs: fieldsOf(s, types).map((f) => ({ name: f.name, ty: f.ty })),
      outputs: [{ name: VALUE_PIN, ty: s }],
    }
  }
  return { inputs: declared(node, 'in'), outputs: declared(node, 'out') }
}

/** The type of one pin; a null `pin` is the node's default (first declared,
 *  else `any`). Null when the node has no such pin. */
export function pinType(
  node: WorkflowNode,
  side: PinSide,
  pin: string | null | undefined,
  types: readonly WorkflowType[],
): string | null {
  const set = pinsOf(node, types)
  const list = side === 'in' ? set.inputs : set.outputs
  if (!pin) {
    if (node.kind === 'break' || node.kind === 'make') return list.length === 1 ? list[0].ty : null
    return list[0]?.ty ?? 'any'
  }
  return list.find((p) => p.name === pin)?.ty ?? null
}

/** Why a wire `from.fromPin -> to.toPin` may not be made, in words naming
 *  both types — or null when it may. */
export function refusalReason(
  from: WorkflowNode,
  fromPin: string | null | undefined,
  to: WorkflowNode,
  toPin: string | null | undefined,
  types: readonly WorkflowType[],
): string | null {
  const a = pinType(from, 'out', fromPin, types)
  const b = pinType(to, 'in', toPin, types)
  if (a === null || b === null) return `Can't connect: that pin does not exist on ${a === null ? from.title : to.title}`
  return typesMatch(a, b) ? null : `Can't connect ${a} to ${b}: the pin types do not match`
}

export interface ShapePlan {
  /** The node kind the menu action creates. */
  kind: 'break' | 'make'
  struct: string
  title: string
  /** The menu label. */
  label: string
}

/** What a right-click on a pin offers: Break on a struct output, Make on a
 *  struct input; null for anything else. */
export function shapePlan(
  side: PinSide,
  ty: string,
  types: readonly WorkflowType[],
): ShapePlan | null {
  if (!isStruct(ty, types)) return null
  return side === 'out'
    ? { kind: 'break', struct: ty, title: `Break ${ty}`, label: 'Break into fields' }
    : { kind: 'make', struct: ty, title: `Make ${ty}`, label: 'Make from fields' }
}

/** A struct's usage in a graph: the pins (and break/make nodes) whose type
 *  names it, as "Node · pin" strings — what blocks deleting it. */
export function typeUsages(
  name: string,
  nodes: readonly WorkflowNode[],
  types: readonly WorkflowType[],
): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if ((n.kind === 'break' || n.kind === 'make') && structOf(n) === name) out.push(n.title)
    else {
      const set = pinsOf(n, types)
      for (const p of [...set.inputs, ...set.outputs]) {
        if (baseOf(p.ty) === name) out.push(`${n.title} · ${p.name}`)
      }
    }
  }
  for (const t of types) {
    if (t.name === name) continue
    for (const f of t.fields) if (baseOf(f.ty) === name) out.push(`type ${t.name} · ${f.name}`)
  }
  return out
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/

/** The first thing wrong with a draft type list, or null (mirrors
 *  `wftypes::validate_types`; the server answers the rest). */
export function validateTypeDraft(types: readonly WorkflowType[]): string | null {
  const seen = new Set<string>()
  for (const t of types) {
    if (!IDENT.test(t.name) || t.name.includes('<') || (RESERVED as readonly string[]).includes(t.name.toLowerCase()))
      return `"${t.name}" is not a valid type name (letters, digits and _, not string/number/bool/any/list)`
    if (seen.has(t.name.toLowerCase())) return `type ${t.name} is defined twice`
    seen.add(t.name.toLowerCase())
    const fields = new Set<string>()
    for (const f of t.fields) {
      if (!IDENT.test(f.name)) return `${t.name}: "${f.name}" is not a valid field name`
      if (fields.has(f.name)) return `${t.name}: field ${f.name} is defined twice`
      fields.add(f.name)
      const b = baseOf(f.ty)
      if (!(PRIMITIVES as readonly string[]).includes(b) && !types.some((o) => o.name === b))
        return `${t.name}.${f.name} has unknown type ${f.ty}`
      if (b === t.name) return `type ${t.name} cannot contain itself`
    }
  }
  return null
}

/** Pins as the config stores them: empty sides are dropped, and a node with
 *  no pins at all has no `pins` key. */
export function pinsConfig(pins: NodePinSet): { in?: PinInfo[]; out?: PinInfo[] } | undefined {
  const out: { in?: PinInfo[]; out?: PinInfo[] } = {}
  if (pins.inputs.length > 0) out.in = pins.inputs.map((p) => ({ name: p.name.trim(), ty: p.ty }))
  if (pins.outputs.length > 0) out.out = pins.outputs.map((p) => ({ name: p.name.trim(), ty: p.ty }))
  return out.in || out.out ? out : undefined
}

/** The pin an edge end really names: an explicit pin, else the node's default
 *  (its first pin, or a break/make's single `value`). Null for an untyped
 *  node's default, which has no name. */
export function effectivePin(
  node: WorkflowNode,
  side: PinSide,
  pin: string | null | undefined,
  types: readonly WorkflowType[],
): string | null {
  if (pin) return pin
  const set = pinsOf(node, types)
  const list = side === 'in' ? set.inputs : set.outputs
  if (node.kind === 'break' || node.kind === 'make') return list.length === 1 ? list[0].name : null
  return list[0]?.name ?? null
}

/** React Flow handle ids for a typed pin. */
export const pinHandleId = (side: PinSide, name: string) => `${side}:${name}`

/** The pin name inside a typed handle id, or null for any other handle
 *  (a flow handle, a branch label). */
export function pinOfHandle(side: PinSide, handle: string | null | undefined): string | null {
  return handle && handle.startsWith(`${side}:`) ? handle.slice(side.length + 1) : null
}
