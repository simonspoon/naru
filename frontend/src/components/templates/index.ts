import { createElement, type ReactNode } from 'react'
import { normalizeSpec, type TemplateSpec } from '../../templateSpec'
import { Callout } from './Callout'
import { Card } from './Card'
import { ListDetail } from './ListDetail'
import { Panel } from './Panel'
import { Stat } from './Stat'
import { Table } from './Table'
import './templates.css'

export { Callout, Card, ListDetail, Panel, Stat, Table }
export type { TemplateSpec } from '../../templateSpec'

export interface RenderOptions {
  /** Called with a card's link target when it is opened. */
  onAction?: (href: string) => void
}

function build(spec: TemplateSpec, opts: RenderOptions, key?: number): ReactNode {
  switch (spec.type) {
    case 'card': {
      return createElement(Card, { ...spec, key, onOpen: opts.onAction })
    }
    case 'table': {
      return createElement(Table, { ...spec, key })
    }
    case 'stat': {
      return createElement(Stat, { ...spec, key })
    }
    case 'callout': {
      return createElement(Callout, { ...spec, key })
    }
    case 'list-detail': {
      return createElement(ListDetail, { ...spec, key })
    }
    case 'panel': {
      const kids = spec.children ?? []
      const out: ReactNode[] = []
      // Consecutive stats share one `.cc-kpis` grid.
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].type !== 'stat') {
          out.push(build(kids[i], opts, i))
          continue
        }
        const start = i
        const run: ReactNode[] = []
        while (i < kids.length && kids[i].type === 'stat') run.push(build(kids[i], opts, i++))
        i--
        out.push(createElement('div', { className: 'cc-kpis tpl-kpis', key: start }, run))
      }
      return createElement(Panel, { title: spec.title, hint: spec.hint, key }, out)
    }
  }
}

/** Render untrusted JSON as a template. An invalid or unknown spec renders a
 * muted "Unsupported block" callout; this never throws. */
export function renderTemplate(raw: unknown, opts: RenderOptions = {}): ReactNode {
  const n = normalizeSpec(raw)
  if (!n.ok) {
    return createElement(Callout, { tone: 'neutral', title: 'Unsupported block', text: n.reason })
  }
  return build(n.spec, opts)
}
