import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import type { PackageDetails } from '@/api/types'

/**
 * The detail pane's record for the focused row, with a session cache and a
 * hover prefetch.
 *
 * Three-tier resolution, cheapest first:
 *   1. The search response is already enriched for most packages — use it, no
 *      round trip at all.
 *   2. Otherwise consult the session cache (populated by focus AND by hover
 *      prefetch), so arrowing back to a row is instant.
 *   3. Only then fetch the single-record endpoint, which is O(1) on pkgsvc's
 *      side.
 *
 * `detailRec` is set to the base entry FIRST and then upgraded when a fetch
 * resolves. That ordering matters: the pane renders what is known immediately
 * rather than flashing empty while the request is in flight.
 *
 * Extracted from PackageSearchDialog; behaviour unchanged.
 */
export function usePackageDetails(focusedEntry: PackageDetails | undefined) {
  // Session-lived cache. A ref, not state — writing to it must not re-render,
  // and it is cleared on unmount by virtue of being per-instance.
  const cacheRef = useRef<Map<string, PackageDetails>>(new Map())
  const [detailRec, setDetailRec] = useState<PackageDetails | undefined>()

  useEffect(() => {
    if (!focusedEntry || focusedEntry.name === '') {
      setDetailRec(undefined)
      return
    }
    // In-page enriched shape already has the fields we need.
    // Nevertheless, if certain enriched fields (homepage, popularity,
    // provides) are missing AND we haven't yet fetched them, kick off
    // a details fetch. The single-record endpoint is O(1) on pkgsvc's
    // side.
    const hasEnriched =
      focusedEntry.homepage !== undefined ||
      focusedEntry.popularity !== undefined ||
      (focusedEntry.provides && typeof focusedEntry.provides === 'object')
    setDetailRec(focusedEntry)
    if (hasEnriched || focusedEntry.section === '(user-added)') return
    const cached = cacheRef.current.get(focusedEntry.name)
    if (cached) {
      setDetailRec(cached)
      return
    }
    // Fire a fetch — swallow errors, keep the base entry visible.
    let cancelled = false
    api
      .packageDetails(focusedEntry.os, focusedEntry.arch, focusedEntry.name)
      .then((rec) => {
        if (cancelled) return
        cacheRef.current.set(focusedEntry.name, rec)
        setDetailRec(rec)
      })
      .catch(() => {
        /* detail unavailable — pane still renders what we have. */
      })
    return () => {
      cancelled = true
    }
    // Keyed on the IDENTITY fields, not the object: the entry is recreated on
    // every render of the visible list, so depending on it would refetch
    // constantly. No lint suppression is needed here — the exhaustive-deps rule
    // accepts member expressions — and the original carried none either.
  }, [focusedEntry?.name, focusedEntry?.os, focusedEntry?.arch])

  /** Prefetch on hover — cheap warmup so keyboard nav feels instant. */
  const prefetchDetails = useCallback((entry: PackageDetails) => {
    if (entry.section === '(user-added)') return
    if (cacheRef.current.has(entry.name)) return
    // Fire-and-forget; the effect above reads the cache on focus.
    api.packageDetails(entry.os, entry.arch, entry.name).then(
      (rec) => cacheRef.current.set(entry.name, rec),
      () => {},
    )
  }, [])

  /** Drop the cache — called when the dialog closes. */
  const clearCache = useCallback(() => cacheRef.current.clear(), [])

  return { detailRec, prefetchDetails, clearCache }
}
