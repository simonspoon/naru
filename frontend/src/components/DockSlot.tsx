import { useLayoutEffect, useRef } from 'react'
import type { PanelId } from '../dockLayout'
import * as dockHosts from '../lib/dockHosts'

/**
 * Where one panel is shown: a purely imperative mount point, `PtySlot`'s
 * shape. Its layout effect moves the panel's stable host container (see
 * `lib/dockHosts.ts`) into this div and parks it again on unmount, so moving a
 * panel between groups relocates DOM and never remounts what is inside it.
 * Every tab of a group renders a slot; only the front one is visible.
 */
export function DockSlot({ panel, active = true }: { panel: PanelId; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = ref.current
    if (slot === null) return
    dockHosts.attach(panel, slot)
    return () => dockHosts.release(panel, slot)
  }, [panel])
  // A background tab keeps its container here, hidden in place, rather than
  // being parked elsewhere: reparenting an `<iframe>` reloads it, so parking
  // would reload the whiteboard on every tab switch.
  return <div ref={ref} className={`dock-slot${active ? '' : ' dock-slot-inactive'}`} />
}
