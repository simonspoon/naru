import type { ReactNode } from 'react'
import type { PanelProps } from '../../templateSpec'

/** A `.cc-panel` section: optional heading and hint, then its children.
 * `children` here is already-rendered nodes (see `renderTemplate`). */
export function Panel({ title, hint, children }: Pick<PanelProps, 'title' | 'hint'> & { children?: ReactNode }) {
  return (
    <section className="cc-panel">
      {title && <h2>{title}</h2>}
      {hint && <p className="cc-hint muted">{hint}</p>}
      {children}
    </section>
  )
}
