import type { CalloutProps } from '../../templateSpec'

/** A toned note with a left edge. `bad` is announced as an alert, the rest as
 * a status. */
export function Callout({ tone, title, text }: CalloutProps) {
  return (
    <div className={`tpl-callout tpl-tone-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      {title && <div className="tpl-callout-title">{title}</div>}
      <div className="tpl-callout-text">{text}</div>
    </div>
  )
}
