import { useLayoutEffect, useRef } from 'react'
import type { PanelId } from '../dockLayout'
import * as dockHosts from '../lib/dockHosts'

/**
 * Where one panel is shown: a purely imperative mount point, `PtySlot`'s
 * shape. Its layout effect moves the panel's stable host container (see
 * `lib/dockHosts.ts`) into this div and parks it again on unmount, so moving a
 * panel between groups relocates DOM and never remounts what is inside it.
 */
export function DockSlot({ panel }: { panel: PanelId }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = ref.current
    if (slot === null) return
    dockHosts.attach(panel, slot)
    return () => dockHosts.release(panel, slot)
  }, [panel])
  return <div ref={ref} className="dock-slot" />
}
