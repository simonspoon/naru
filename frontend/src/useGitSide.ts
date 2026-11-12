import { useCallback, useEffect, useState } from 'react'
import { SIDE_OPEN_KEY, parseSideOpen } from './gitPanel'

/** Container width (rem) from which the Git side panel sits inline; below it
 * (a narrow Custom-layout pane, or any phone) it is a drawer. */
export const SIDE_INLINE_REM = 60

const readOpen = (): boolean => {
  try {
    return parseSideOpen(localStorage.getItem(SIDE_OPEN_KEY))
  } catch {
    return true
  }
}

/**
 * The Git tab's side-panel mode and open state (naru task 2737). The shell's
 * own width decides inline vs drawer (a viewport media query cannot see a
 * pane's width). Inline: open flag remembered in localStorage, default open.
 * Drawer: closed by default and never remembered.
 */
export function useGitSide() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  // A guess for the first paint, before the observer reports the real width.
  const [inline, setInline] = useState(() => window.innerWidth >= SIDE_INLINE_REM * 16)
  const [inlineOpen, setInlineOpen] = useState(readOpen)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(() => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setInline(el.clientWidth >= SIDE_INLINE_REM * rem)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])

  const open = inline ? inlineOpen : drawerOpen
  const toggle = useCallback(() => {
    if (inline) {
      const next = !inlineOpen
      setInlineOpen(next)
      try {
        localStorage.setItem(SIDE_OPEN_KEY, String(next))
      } catch {
        // private mode: the flag just is not remembered
      }
    } else {
      setDrawerOpen((v) => !v)
    }
  }, [inline, inlineOpen])
  /** Close the drawer (a no-op inline, where the panel stays). */
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  return { shellRef: setEl, inline, open, toggle, closeDrawer }
}
