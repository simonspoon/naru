import { useCallback, useEffect, useRef, useState } from 'react'
import {
  activeLayout,
  closePanel,
  isVisible,
  loadStore,
  revealPanel,
  saveStore,
  updateActive,
  type DockState,
  type PanelId,
} from './dockLayout'

export type Update = (update: (s: DockState) => DockState) => void

/**
 * The dock's state: the saved-layout store (`dockLayout.ts`), persisted on
 * every change, with the active layout's state and the handful of verbs the
 * shell needs. `reveal`/`hide` are stable and functional so a live-conversation
 * effect can call them on every event without re-subscribing or re-rendering.
 */
export function useDockStore() {
  const [store, setStore] = useState(loadStore)
  useEffect(() => saveStore(store), [store])
  const state = activeLayout(store).state
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const update = useCallback<Update>((fn) => {
    setStore((s) => {
      const cur = activeLayout(s).state
      const next = fn(cur)
      return next === cur ? s : updateActive(s, next)
    })
  }, [])
  const reveal = useCallback((p: PanelId) => update((s) => revealPanel(s, p)), [update])
  const hide = useCallback((p: PanelId) => update((s) => closePanel(s, p)), [update])
  // The shell's event handlers (a hash change, a live turn) ask "is it showing
  // right now" and must read the latest, not the render they closed over.
  const visible = useCallback((p: PanelId) => isVisible(stateRef.current, p), [])
  return { store, setStore, state, update, reveal, hide, visible }
}
