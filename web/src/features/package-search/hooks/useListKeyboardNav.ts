import { useCallback } from 'react'
import type { PackageDetails } from '@/api/types'
import type { SearchAction } from '../model/searchState'
import { PAGE_JUMP } from '../model/searchState'
import { toggleValue } from '../model/format'
import { pushRecent } from '../model/recents'

/**
 * Keyboard navigation for the result list and the detail pane.
 *
 * Extracted from PackageSearchDialog, whose handler alone reached complexity 16.
 * The key map, verbatim:
 *
 *   Cmd/Ctrl+Enter  toggle the focused row, then close
 *   Enter           toggle the focused row, stay open
 *   Escape          close
 *   Arrow Up/Down   move focus, WRAPPING at both ends
 *   PageUp/Down     jump 10, CLAMPING at the ends
 *   Home / End      first / last row
 *   ArrowRight      focus the detail pane, but ONLY when the caret is already at
 *                   the end of the input — otherwise the browser's own caret
 *                   movement wins, which is what a text field should do
 *   ArrowLeft       (in the detail pane) return focus to the list
 *
 * Escape is deliberately NOT preventDefault'd on the detail pane: it also reaches
 * DialogOverlay's document-level listener, which is what closes the dialog.
 */
/**
 * The six pure focus-movement keys, as data.
 *
 * Arrow keys WRAP (past the end returns to the top); Page keys CLAMP (a 10-row
 * jump that wrapped would be disorienting). Home/End are absolute. Returns null
 * for anything else so the caller falls through to the non-movement keys.
 */
function movementFor(key: string, visibleCount: number): SearchAction | null {
  switch (key) {
    case 'ArrowDown':
      return { type: 'focusMoved', delta: 1, wrap: true, visibleCount }
    case 'ArrowUp':
      return { type: 'focusMoved', delta: -1, wrap: true, visibleCount }
    case 'PageDown':
      return { type: 'focusMoved', delta: PAGE_JUMP, wrap: false, visibleCount }
    case 'PageUp':
      return { type: 'focusMoved', delta: -PAGE_JUMP, wrap: false, visibleCount }
    case 'Home':
      return { type: 'focusFirst' }
    case 'End':
      return { type: 'focusLast', visibleCount }
    default:
      return null
  }
}

export interface ListKeyboardNavParams {
  focusedEntry: PackageDetails | undefined
  values: string[]
  onChange: (next: string[]) => void
  onClose: () => void
  searchQuery: string
  visibleCount: number
  dispatch: React.Dispatch<SearchAction>
  setRecents: (next: string[]) => void
}

export function useListKeyboardNav({
  focusedEntry,
  values,
  onChange,
  onClose,
  searchQuery,
  visibleCount,
  dispatch,
  setRecents,
}: ListKeyboardNavParams) {
const onInputKeyDown = useCallback(
  (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Cmd/Ctrl+Enter closes after applying the current toggle.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (focusedEntry) {
        onChange(toggleValue(values, focusedEntry.name))
        pushRecent(searchQuery)
      }
      onClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (focusedEntry) {
        onChange(toggleValue(values, focusedEntry.name))
        const nextRecents = pushRecent(searchQuery)
        setRecents(nextRecents)
      }
      return
    }
    // Six movement keys as a TABLE rather than six branches. Same behaviour,
    // and it keeps this handler under the complexity ceiling — the key map is
    // now data, so adding a key does not add a branch.
    const move = movementFor(e.key, visibleCount)
    if (move) {
      e.preventDefault()
      dispatch(move)
      return
    }
    if (e.key === 'ArrowRight') {
      // If the caret isn't at the end of the input, let the browser
      // handle it — otherwise focus the detail pane.
      const input = e.currentTarget
      if (
        input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length
      ) {
        e.preventDefault()
        dispatch({ type: 'detailFocused', focused: true })
      }
      return
    }
  },
  [focusedEntry, values, onChange, onClose, searchQuery, visibleCount],
)

// If focus is on the detail pane, ArrowLeft returns to the list.
const onDetailKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
  if (e.key === 'ArrowLeft' || e.key === 'Escape') {
    // Escape reaches DialogOverlay's document-level listener too, but
    // we want ArrowLeft/Left specifically to return focus, not close.
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      dispatch({ type: 'detailFocused', focused: false })
    }
  }
}, [])

  return { onInputKeyDown, onDetailKeyDown }
}
