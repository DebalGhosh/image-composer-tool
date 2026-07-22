// Browser-local build history for the Build Image page.
//
// The Build Image tab renders a two-pane split (mirror of Interactive's
// layout, sliding in from the LEFT). The left pane is a history list;
// the right pane is the currently-selected build's details + log. The
// URL carries only ?view=builds — build history is entirely local to
// the browser profile, deliberately not shareable via URL.
//
// Storage contract:
//   * localStorage key: `ict.buildHistory.v1`
//   * value: JSON-serialised array of BuildHistoryEntry, newest-first
//   * cap: 50 entries FIFO — 51st push evicts entry[50]
//
// localStorage was chosen over sessionStorage so the history survives
// tab-close / browser-restart. Trade-off: history is now shared across
// tabs of the same origin in the same profile — two tabs open on the
// Build Image page will see each other's dispatches on next mutation.
// That's the intended UX ("close and come back later, see my past
// builds"); if a user wants an isolated history they can use a private
// window.
//
// FIFO is applied on write. If localStorage.setItem throws (quota
// exceeded — unlikely with 50-entry cap but possible if the browser
// budgets us tightly), we swallow the error and log a console.warn.
// Losing a history-append is preferable to crashing the tab.
//
// The hook exposes:
//   entries       — live snapshot, updates on any mutation via the hook
//   addEntry      — prepend a new entry
//   updateEntry   — merge a patch into the entry with matching buildId;
//                   silently no-ops if buildId is not in history
//   deleteEntry   — remove by buildId
//   clearAll      — nuke everything (there's no user-facing button yet,
//                   but exposed for the delete-all future affordance)
//   selectedBuildId + setSelectedBuildId — which row is expanded in
//                   the right pane. Also localStorage-persisted.
//
// Live-update discipline: mutations use functional setState so
// concurrent Jenkins polling from BuildView (fires every 5s) doesn't
// clobber a user-initiated deleteEntry that just landed in the same
// tick.

import { useCallback, useEffect, useState } from 'react'

const KEY_ENTRIES = 'ict.buildHistory.v1'
const KEY_SELECTED = 'ict.buildHistory.selected.v1'
const MAX_ENTRIES = 50

export type BuildHistoryStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'

export interface BuildHistoryEntry {
  /** Internal build ID from the backend tracker. Primary key. */
  buildId: string
  /** Jenkins worker name, e.g. "worker-07". Null until the queue item resolves. */
  worker: string | null
  /** Jenkins build number. Null until the queue item resolves. */
  buildNo: number | null
  /** Epoch millis when the build was created via addEntry. */
  startedAt: number
  /** Last-known status. Updated by BuildView as it polls. */
  status: BuildHistoryStatus
  /** Deep link to the specific Jenkins build, or null if not yet assigned. */
  jenkinsBuildUrl: string | null
  /** Deep link to the parent Jenkins job (always known — set at addEntry). */
  jenkinsJobUrl: string | null
}

function readEntries(): BuildHistoryEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY_ENTRIES)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Defensive filter: drop entries missing the primary key. Prevents
    // a partially-corrupted localStorage payload from crashing render.
    return parsed.filter(
      (e): e is BuildHistoryEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as BuildHistoryEntry).buildId === 'string',
    )
  } catch {
    return []
  }
}

function writeEntries(entries: BuildHistoryEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY_ENTRIES, JSON.stringify(entries))
  } catch (e) {
    // Quota exceeded or storage disabled (private-browsing edge cases).
    // Silent-degrade rather than crash the tab.
    console.warn('[buildHistory] localStorage.setItem failed:', e)
  }
}

function readSelected(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(KEY_SELECTED)
  } catch {
    return null
  }
}

function writeSelected(id: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (id === null) window.localStorage.removeItem(KEY_SELECTED)
    else window.localStorage.setItem(KEY_SELECTED, id)
  } catch (e) {
    console.warn('[buildHistory] localStorage.setItem(selected) failed:', e)
  }
}

/**
 * useBuildHistory — localStorage-backed history list for the Build
 * Image tab. Single-hook consumer expected (mounted at App level via
 * BuildImagePage). If multiple instances mount (they won't in this
 * app), they'll see divergent local state until the next mutation
 * writes to localStorage — acceptable.
 */
export function useBuildHistory() {
  // Seed synchronously so first render has correct state and there's no
  // flash of empty history on cold load.
  const [entries, setEntries] = useState<BuildHistoryEntry[]>(() => readEntries())
  const [selectedBuildId, setSelectedBuildIdState] = useState<string | null>(
    () => readSelected(),
  )

  // Persist entries on every change.
  useEffect(() => {
    writeEntries(entries)
  }, [entries])

  // Persist selection on every change.
  useEffect(() => {
    writeSelected(selectedBuildId)
  }, [selectedBuildId])

  const addEntry = useCallback((entry: BuildHistoryEntry) => {
    setEntries((prev) => {
      // De-dupe by buildId — if the same buildId is added again (e.g. a
      // user retriggers Build Image with a buildId that got re-issued),
      // we replace the old row with the fresh one at the top.
      const filtered = prev.filter((e) => e.buildId !== entry.buildId)
      const next = [entry, ...filtered]
      return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next
    })
  }, [])

  const updateEntry = useCallback(
    (buildId: string, patch: Partial<BuildHistoryEntry>) => {
      setEntries((prev) => {
        const idx = prev.findIndex((e) => e.buildId === buildId)
        if (idx === -1) return prev // silently no-op — build isn't in history
        const merged = { ...prev[idx], ...patch, buildId } // never let patch overwrite the PK
        const next = prev.slice()
        next[idx] = merged
        return next
      })
    },
    [],
  )

  const deleteEntry = useCallback(
    (buildId: string) => {
      setEntries((prev) => prev.filter((e) => e.buildId !== buildId))
      setSelectedBuildIdState((prev) => (prev === buildId ? null : prev))
    },
    [],
  )

  const clearAll = useCallback(() => {
    setEntries([])
    setSelectedBuildIdState(null)
  }, [])

  const setSelectedBuildId = useCallback((id: string | null) => {
    setSelectedBuildIdState(id)
  }, [])

  return {
    entries,
    addEntry,
    updateEntry,
    deleteEntry,
    clearAll,
    selectedBuildId,
    setSelectedBuildId,
  }
}
