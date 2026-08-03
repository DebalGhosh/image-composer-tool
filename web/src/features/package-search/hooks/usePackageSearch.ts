import { useEffect, useReducer, useRef } from 'react'
import { api, ApiError } from '@/api/client'
import { normalizeArch, DEBOUNCE_MS, SEARCH_LIMIT } from '../packageSearchShared'
import {
  searchReducer,
  initialSearchState,
  type SearchAction,
  type SearchState,
} from '../model/searchState'

/**
 * The dialog's search state plus its debounced, abortable fetch loop.
 *
 * ⚠️ TWO STALE-RESPONSE GUARDS, BOTH REQUIRED. They are not redundant:
 *
 *   1. `AbortController` cancels the in-flight HTTP request, so rapid keystrokes
 *      stop hammering ict-pkgsvc. This is the half the inline
 *      PackageSearchCombobox lacks.
 *   2. The monotonic `fetchIdRef` drops a response whose id has been overtaken.
 *      This catches what abort cannot: a request that has ALREADY RESOLVED and
 *      whose `.then` is queued on the microtask queue when the next keystroke
 *      lands. Aborting a settled request is a no-op, so without the id a stale
 *      payload can still win.
 *
 * Removing either one reintroduces a real bug. The refactor brief calls this out
 * explicitly, and it is the reason this hook keeps both refs rather than
 * "simplifying" to one mechanism.
 */

export interface PackageSearchParams {
  open: boolean
  os: string
  arch: string
}

export interface PackageSearch {
  state: SearchState
  dispatch: React.Dispatch<SearchAction>
}

export function usePackageSearch({ open, os, arch }: PackageSearchParams): PackageSearch {
  const [state, dispatch] = useReducer(searchReducer, initialSearchState)

  // Stale-response guard #2 — see the module header.
  const fetchIdRef = useRef(0)
  // Stale-response guard #1.
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    if (!os) {
      dispatch({ type: 'fetchSkipped' })
      return
    }
    const q = state.query.trim()
    const id = ++fetchIdRef.current
    dispatch({ type: 'fetchStarted' })
    const handle = window.setTimeout(() => {
      // Cancel any prior in-flight fetch; the last-wins policy makes
      // rapid keystrokes stop hammering the microservice.
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      api
        .searchPackagesFull({ os, arch: normalizeArch(arch), q, limit: SEARCH_LIMIT })
        .then((res) => {
          if (id !== fetchIdRef.current) return
          dispatch({
            type: 'fetchSucceeded',
            entries: res.packages ?? [],
            indexMissing:
              res.total === 0 && q === '' && (res.packages?.length ?? 0) === 0,
          })
        })
        .catch((err) => {
          if (id !== fetchIdRef.current) return
          // The AbortController surface throws either DOMException named
          // AbortError or an ApiError; either way we drop silently.
          if (err instanceof DOMException && err.name === 'AbortError') return
          if (err instanceof ApiError && err.status === 0) return
          // Non-abort failures: keep the last entries visible so the
          // user isn't blank-slated on a transient blip; just log.
          // eslint-disable-next-line no-console
          console.warn('[PackageSearchDialog] search failed:', err)
          dispatch({ type: 'fetchFailed' })
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [open, state.query, os, arch])

  // Reset on close so a fresh open lands on a clean slate.
  useEffect(() => {
    if (!open) dispatch({ type: 'dialogClosed' })
  }, [open])

  return { state, dispatch }
}
