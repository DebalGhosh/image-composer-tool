import { useEffect, useRef, useState } from 'react'

/**
 * The Cmd/Ctrl+K shortcut that opens the expanded package-search dialog.
 *
 * ⚠️ THE `offsetParent === null` GUARD IS LOAD-BEARING AND MUST NOT BE
 * "SIMPLIFIED".
 *
 * All four pages are mounted SIMULTANEOUSLY — App.tsx hides the inactive ones
 * with `hidden={view !== '…'}` rather than unmounting them, because the composer
 * drafts live in the store and tab switches must not discard them. The listener
 * here is on `document`, so a Cmd+K pressed while the Builds tab is showing
 * still reaches this handler on the hidden Interactive page.
 *
 * `hidden=""` sets `display: none` per the HTML spec, and an element inside a
 * `display: none` subtree has a null `offsetParent`. That is the check that
 * decides whether this tab may claim the shortcut. Remove it and Cmd+K opens the
 * package dialog from every tab; replace the mounting model with conditional
 * rendering and the guard becomes meaningless (see .claude/UI-LAYOUT.md and the
 * refactor brief's guardrail on the four-page mount).
 *
 * Extracted verbatim from InteractivePage; the ref must be attached to the
 * page's outermost element so it participates in that hidden subtree.
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Global Cmd/Ctrl+K trigger. Document-level so the shortcut works
  // regardless of what has keyboard focus inside the Interactive tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'k') return
      if (rootRef.current === null) return
      // If our root's offsetParent is null the whole subtree is hidden
      // via display:none — the browser routes keyboard events to the
      // active document element, so we only claim the shortcut when
      // our tab is on screen.
      if (rootRef.current.offsetParent === null) return
      e.preventDefault()
      setOpen(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return { open, setOpen, rootRef }
}
