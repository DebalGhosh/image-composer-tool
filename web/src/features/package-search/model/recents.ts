/**
 * Recent-search persistence. Pure apart from localStorage.
 *
 * ⚠️ The KEY and the CAP are a storage contract. `ict.packagesearch.recents` is
 * one of four localStorage schemas the app owns (alongside `ict.store`,
 * `ict.theme` and `ict.buildHistory.v1`); renaming it silently discards every
 * user's history with no error anywhere.
 *
 * Extracted verbatim from PackageSearchDialog.tsx.
 */

export const RECENTS_KEY = 'ict.packagesearch.recents'
export const RECENTS_CAP = 10

/**
 * Read the recents list.
 *
 * Every failure mode collapses to `[]` rather than throwing: a corrupt blob, a
 * non-array payload, or localStorage being unavailable in private browsing. The
 * per-element `typeof x === 'string'` filter means a partially-corrupted array
 * yields its usable entries instead of nothing.
 */
export function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENTS_CAP)
      : []
  } catch {
    return []
  }
}

/**
 * Record a search, most-recent-first, and return the new list.
 *
 * Two behaviours worth keeping:
 *   - Queries shorter than 2 characters are NOT recorded (one-char noise), and
 *     the function returns the unchanged list rather than an empty one.
 *   - An existing entry is REMOVED before being re-prepended, so repeating a
 *     search promotes it instead of duplicating it.
 *
 * A write failure (quota, private mode) is swallowed, but the returned list is
 * still the intended next state — the UI stays consistent for the session even
 * when persistence is impossible.
 */
export function pushRecent(q: string): string[] {
  const trimmed = q.trim()
  if (trimmed.length < 2) return loadRecents() // don't cache one-char noise
  const current = loadRecents().filter((r) => r !== trimmed)
  const next = [trimmed, ...current].slice(0, RECENTS_CAP)
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    /* quota exceeded, private-browsing edge — silent-degrade */
  }
  return next
}
