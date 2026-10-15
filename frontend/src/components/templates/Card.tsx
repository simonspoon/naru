import type { CardProps } from '../../templateSpec'

/** A tinted card (`.card-list li` look): title, wrapped body, mono meta line.
 * `tone` and `edge` are an edge colour, never a recolour of the fill. */
export function Card({
  title,
  body,
  meta,
  tone,
  edge,
  href,
  onOpen,
}: CardProps & { onOpen?: (href: string) => void }) {
  const cls = ['tpl-card', tone && tone !== 'neutral' ? `tpl-tone-${tone}` : '', edge ? `tpl-edge-${edge}` : '']
  return (
    <ul className="card-list tpl-card-list">
      <li className={cls.filter(Boolean).join(' ')}>
        <div className="tpl-card-title">
          {href ? (
            <a href={href} onClick={() => onOpen?.(href)}>
              {title}
            </a>
          ) : (
            title
          )}
        </div>
        {body && <div className="tpl-card-body">{body}</div>}
        {meta && meta.length > 0 && <div className="tpl-meta">{meta.join(' · ')}</div>}
      </li>
    </ul>
  )
}
