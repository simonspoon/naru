import type { StatProps } from '../../templateSpec'

/** One number with a label: the `.cc-kpi` tile, optionally toned. */
export function Stat({ label, value, sub, tone }: StatProps) {
  return (
    <div className={`cc-kpi tpl-stat${tone && tone !== 'neutral' ? ` tpl-tone-${tone}` : ''}`}>
      <div className="cc-kpi-value">{value}</div>
      <div className="cc-kpi-label">{label}</div>
      {sub && <div className="cc-kpi-sub">{sub}</div>}
    </div>
  )
}
