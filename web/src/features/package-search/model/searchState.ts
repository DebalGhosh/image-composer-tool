/**
 * The package-search dialog's state machine.
 *
 * Replaces NINE interdependent `useState` calls whose transitions were spread
 * across a fetch effect, a reset effect, six keyboard branches and four click
 * handlers. The interdependence is the reason: a completed fetch has to set
 * entries, clear loading, reset the focus index AND decide `indexMissing` as one
 * atomic step, and expressing that as four separate setters made the invariant
 * ("focus is always a valid index into the current results") impossible to see
 * in one place.
 *
 * Pure — no React, no fetch, no DOM. The reducer is a plain function so every
 * transition is directly testable, which none of them were before.
 */
import type { PackageDetails } from '@/api/types'

export interface SearchState {
  query: string
  entries: PackageDetails[]
  loading: boolean
  /** True when the server returned an empty unfiltered index — a setup problem. */
  indexMissing: boolean
  selectedSections: string[]
  /** Index into the VISIBLE row list, not into `entries`. */
  focusIdx: number
  /** True when the detail pane has keyboard focus instead of the list. */
  detailFocused: boolean
}

export const initialSearchState: SearchState = {
  query: '',
  entries: [],
  loading: false,
  indexMissing: false,
  selectedSections: [],
  focusIdx: 0,
  detailFocused: false,
}

/** How many rows PageUp / PageDown jump. */
export const PAGE_JUMP = 10

export type SearchAction =
  | { type: 'queryChanged'; query: string }
  | { type: 'fetchStarted' }
  | { type: 'fetchSucceeded'; entries: PackageDetails[]; indexMissing: boolean }
  | { type: 'fetchFailed' }
  | { type: 'fetchSkipped' }
  | { type: 'sectionToggled'; section: string }
  | { type: 'sectionsCleared' }
  | { type: 'focusSet'; index: number }
  | { type: 'focusMoved'; delta: number; wrap: boolean; visibleCount: number }
  | { type: 'focusFirst' }
  | { type: 'focusLast'; visibleCount: number }
  | { type: 'detailFocused'; focused: boolean }
  | { type: 'dialogClosed' }

/**
 * Fetch-lifecycle transitions. Split from the main reducer because a single
 * 13-case switch exceeds the complexity ceiling — and because these four are the
 * only actions that touch `entries` / `loading`, which makes them a genuine
 * cluster rather than an arbitrary division.
 *
 * Returns null when the action is not one of its own, so the caller can fall
 * through without this function needing a `default` that fabricates state.
 */
function reduceFetch(state: SearchState, action: SearchAction): SearchState | null {
  switch (action.type) {
    case 'fetchStarted':
      return { ...state, loading: true }

    case 'fetchSucceeded':
      // One atomic step: entries, loading, focus and indexMissing together.
      // Splitting these was what allowed focusIdx to briefly point past the end
      // of a shorter new result set.
      return {
        ...state,
        entries: action.entries,
        loading: false,
        focusIdx: 0,
        indexMissing: action.indexMissing,
      }

    case 'fetchFailed':
      // Entries deliberately UNTOUCHED — a transient blip keeps the previous
      // results visible rather than blank-slating the user.
      return { ...state, loading: false }

    case 'fetchSkipped':
      // No OS selected: clear results but do not enter the loading state.
      return { ...state, entries: [] }

    default:
      return null
  }
}

/** Focus-index transitions — the four keyboard movement shapes. */
function reduceFocus(state: SearchState, action: SearchAction): SearchState | null {
  switch (action.type) {
    case 'focusSet':
      return { ...state, focusIdx: action.index }

    case 'focusMoved': {
      const n = action.visibleCount
      if (n === 0) return { ...state, focusIdx: 0 }
      if (action.wrap) {
        // Arrow keys WRAP: past the end returns to the top. Modular arithmetic
        // with + n so a negative delta cannot produce a negative index.
        return { ...state, focusIdx: (state.focusIdx + action.delta + n) % n }
      }
      // Page keys CLAMP: PageDown at the bottom stays put rather than wrapping
      // to the top, which would be disorienting for a large jump.
      return {
        ...state,
        focusIdx: Math.min(n - 1, Math.max(0, state.focusIdx + action.delta)),
      }
    }

    case 'focusFirst':
      return { ...state, focusIdx: 0 }

    case 'focusLast':
      return { ...state, focusIdx: Math.max(0, action.visibleCount - 1) }

    default:
      return null
  }
}

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  const fetched = reduceFetch(state, action)
  if (fetched) return fetched
  const focused = reduceFocus(state, action)
  if (focused) return focused

  switch (action.type) {
    case 'queryChanged':
      // Focus is NOT reset here. It resets when the fetch RESOLVES, so the
      // highlighted row does not jump around under the user's fingers while
      // they are still typing and the old results are still on screen.
      return { ...state, query: action.query }

    case 'sectionToggled': {
      const has = state.selectedSections.includes(action.section)
      return {
        ...state,
        selectedSections: has
          ? state.selectedSections.filter((s) => s !== action.section)
          : [...state.selectedSections, action.section],
      }
    }

    case 'sectionsCleared':
      return { ...state, selectedSections: [] }

    case 'detailFocused':
      return { ...state, detailFocused: action.focused }

    case 'dialogClosed':
      // Reset so a fresh open lands on a clean slate. `entries` and
      // `indexMissing` are KEPT: the next open re-fetches anyway, and holding
      // the previous page means the list is not empty for the first 200ms.
      return {
        ...state,
        query: '',
        selectedSections: [],
        focusIdx: 0,
        detailFocused: false,
      }

    default:
      return state
  }
}
