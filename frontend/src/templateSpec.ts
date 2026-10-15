// Pure logic for the reusable UI templates (naru task 1932,
// components/templates/): the JSON spec shapes, validation that never throws,
// numeric-column detection, the sort key and arrow-key selection. No React, so
// it is unit-tested (templateSpec.test.ts).

export type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad'
export type Cell = string | number | boolean | null

export interface CardProps {
  title: string
  body?: string
  meta?: string[]
  tone?: Tone
  edge?: 'cyan' | 'violet'
  href?: string
}
export interface TableColumn {
  key: string
  label: string
  numeric?: boolean
  sortable?: boolean
}
export interface TableProps {
  columns: TableColumn[]
  rows: Record<string, Cell>[]
  rowKey?: string
  hrefKey?: string
  initialSort?: { key: string; dir?: 'asc' | 'desc' }
  empty?: string
}
export interface PanelProps {
  title?: string
  hint?: string
  children?: TemplateSpec[]
}
export interface StatProps {
  label: string
  value: string | number
  sub?: string
  tone?: Tone
}
export interface CalloutProps {
  tone: Tone
  title?: string
  text: string
}
export interface ListDetailItem {
  id: string
  title: string
  meta?: string[]
  group?: string
}
export interface ListDetailProps {
  items: ListDetailItem[]
  details: Record<string, { title?: string; body: string }>
  selectedId?: string
  emptyList?: string
  emptyDetail?: string
}

export type TemplateSpec =
  | ({ type: 'card' } & CardProps)
  | ({ type: 'table' } & TableProps)
  | ({ type: 'panel' } & PanelProps)
  | ({ type: 'stat' } & StatProps)
  | ({ type: 'callout' } & CalloutProps)
  | ({ type: 'list-detail' } & ListDetailProps)

export const TEMPLATE_TYPES = ['card', 'table', 'panel', 'stat', 'callout', 'list-detail'] as const
export const TONES: Tone[] = ['neutral', 'info', 'good', 'warn', 'bad']
const MAX_DEPTH = 4

export type Normalized = { ok: true; spec: TemplateSpec } | { ok: false; reason: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const strOr = (v: unknown): string | undefined => (isStr(v) ? v : undefined)
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter(isStr) : undefined

export function toTone(v: unknown, fallback: Tone = 'neutral'): Tone {
  return TONES.includes(v as Tone) ? (v as Tone) : fallback
}

/** A link target is only ever an in-app hash route or an http(s) URL; anything
 * else (`javascript:`, `data:`, protocol-relative) is dropped. */
export function safeHref(v: unknown): string | undefined {
  if (!isStr(v)) return undefined
  if (v.startsWith('#/')) return v
  return /^https?:\/\//i.test(v) ? v : undefined
}

function normalizeCell(v: unknown): Cell {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null
}

/** Validate untrusted JSON into a `TemplateSpec`. Never throws; an unknown
 * type or a missing required field is `{ok:false}` with a reason. */
export function normalizeSpec(raw: unknown, depth = 0): Normalized {
  if (!isObj(raw)) return { ok: false, reason: 'spec is not an object' }
  const type = raw.type
  switch (type) {
    case 'card':
      if (!isStr(raw.title)) return { ok: false, reason: 'card needs a title' }
      return {
        ok: true,
        spec: {
          type,
          title: raw.title,
          body: strOr(raw.body),
          meta: strList(raw.meta),
          tone: raw.tone === undefined ? undefined : toTone(raw.tone),
          edge: raw.edge === 'cyan' || raw.edge === 'violet' ? raw.edge : undefined,
          href: safeHref(raw.href),
        },
      }
    case 'table': {
      if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows))
        return { ok: false, reason: 'table needs columns and rows' }
      const columns: TableColumn[] = raw.columns.filter(isObj).filter((c) => isStr(c.key) && isStr(c.label)).map((c) => ({
        key: c.key as string,
        label: c.label as string,
        numeric: c.numeric === true ? true : undefined,
        sortable: c.sortable === true ? true : undefined,
      }))
      if (columns.length === 0) return { ok: false, reason: 'table has no valid columns' }
      const rows = raw.rows.filter(isObj).map((r) => {
        const out: Record<string, Cell> = {}
        for (const [k, v] of Object.entries(r)) out[k] = normalizeCell(v)
        return out
      })
      const is = isObj(raw.initialSort) && isStr(raw.initialSort.key) ? raw.initialSort : null
      return {
        ok: true,
        spec: {
          type,
          columns,
          rows,
          rowKey: strOr(raw.rowKey),
          hrefKey: strOr(raw.hrefKey),
          initialSort: is ? { key: is.key as string, dir: is.dir === 'asc' ? 'asc' : 'desc' } : undefined,
          empty: strOr(raw.empty),
        },
      }
    }
    case 'panel': {
      if (raw.children !== undefined && !Array.isArray(raw.children))
        return { ok: false, reason: 'panel children must be a list' }
      if (depth >= MAX_DEPTH) return { ok: false, reason: 'panel nested too deeply' }
      const children: TemplateSpec[] = []
      for (const c of (raw.children as unknown[] | undefined) ?? []) {
        const n = normalizeSpec(c, depth + 1)
        // An invalid child degrades to a callout in place, not a failed panel.
        children.push(
          n.ok ? n.spec : { type: 'callout', tone: 'neutral', title: 'Unsupported block', text: n.reason },
        )
      }
      return { ok: true, spec: { type, title: strOr(raw.title), hint: strOr(raw.hint), children } }
    }
    case 'stat':
      if (!isStr(raw.label) || (!isStr(raw.value) && typeof raw.value !== 'number'))
        return { ok: false, reason: 'stat needs a label and a value' }
      return {
        ok: true,
        spec: {
          type,
          label: raw.label,
          value: raw.value,
          sub: strOr(raw.sub),
          tone: raw.tone === undefined ? undefined : toTone(raw.tone),
        },
      }
    case 'callout':
      if (!isStr(raw.text)) return { ok: false, reason: 'callout needs text' }
      return { ok: true, spec: { type, tone: toTone(raw.tone, 'info'), title: strOr(raw.title), text: raw.text } }
    case 'list-detail': {
      if (!Array.isArray(raw.items) || !isObj(raw.details))
        return { ok: false, reason: 'list-detail needs items and details' }
      const items: ListDetailItem[] = raw.items
        .filter(isObj)
        .filter((i) => isStr(i.id) && isStr(i.title))
        .map((i) => ({ id: i.id as string, title: i.title as string, meta: strList(i.meta), group: strOr(i.group) }))
      const details: ListDetailProps['details'] = {}
      for (const [id, d] of Object.entries(raw.details)) {
        if (isObj(d) && isStr(d.body)) details[id] = { title: strOr(d.title), body: d.body }
      }
      return {
        ok: true,
        spec: {
          type,
          items,
          details,
          selectedId: strOr(raw.selectedId),
          emptyList: strOr(raw.emptyList),
          emptyDetail: strOr(raw.emptyDetail),
        },
      }
    }
    default:
      return { ok: false, reason: `unknown block type ${JSON.stringify(String(type)).slice(0, 60)}` }
  }
}

/** A numeric column is flagged `numeric`, or has at least one cell and every
 * non-null cell is a number. */
export function isNumericColumn(col: TableColumn, rows: Record<string, Cell>[]): boolean {
  if (col.numeric !== undefined) return col.numeric
  const cells = rows.map((r) => r[col.key]).filter((c) => c !== null && c !== undefined)
  return cells.length > 0 && cells.every((c) => typeof c === 'number')
}

/** The value `DataTable` sorts a cell by: numbers by value (blank lowest),
 * everything else case-insensitively as text. */
export function cellSortKey(cell: Cell | undefined, numeric: boolean): number | string {
  if (numeric) return typeof cell === 'number' && Number.isFinite(cell) ? cell : -Infinity
  return cell === null || cell === undefined ? '' : String(cell).toLowerCase()
}

/** Display text of a cell: blank for null, never "null". */
export function cellText(cell: Cell | undefined): string {
  return cell === null || cell === undefined ? '' : String(cell)
}

/** Arrow-key selection: the id `delta` steps from `current` in `ids`, clamped
 * at both ends; no current selection enters at the first (down) or last (up). */
export function moveSelection(ids: string[], current: string | null, delta: number): string | null {
  if (ids.length === 0) return null
  const at = current === null ? -1 : ids.indexOf(current)
  if (at < 0) return delta >= 0 ? ids[0] : ids[ids.length - 1]
  return ids[Math.min(ids.length - 1, Math.max(0, at + delta))]
}

/** Items grouped by `group` in first-seen order; ungrouped ones lead, unnamed. */
export function groupItems(items: ListDetailItem[]): { group: string | null; items: ListDetailItem[] }[] {
  const out: { group: string | null; items: ListDetailItem[] }[] = []
  for (const it of items) {
    const g = it.group ?? null
    let slot = out.find((s) => s.group === g)
    if (!slot) {
      slot = { group: g, items: [] }
      out.push(slot)
    }
    slot.items.push(it)
  }
  return out.sort((a, b) => Number(b.group === null) - Number(a.group === null))
}
