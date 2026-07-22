// URL <-> app-state sync for the top-level view.
//
// The URL carries the current tab and nothing else. Build history is entirely
// browser-local (see lib/buildHistory.ts — localStorage) and deliberately NOT
// in the URL — dispatches are local to the browser profile, not shareable
// across users or machines.
//
//   ?view={basic|advanced|interactive|builds}      current top-level tab
//
// Design notes:
//
//   - We use `history.replaceState` for programmatic updates so tab-switching
//     doesn't spam the browser history stack. `pushUrlState` is kept for
//     callers that DO want a walkable entry (nothing uses it right now, but
//     it's a stable escape hatch).
//
//   - `popstate` re-parses the URL on browser back/forward and applies it to
//     the app state via a callback. Prevents the URL and the UI from
//     desyncing when the user hits Back.

export type View = 'basic' | 'advanced' | 'interactive' | 'builds'

export interface UrlState {
  view: View
}

const VALID_VIEWS: readonly View[] = [
  'basic',
  'advanced',
  'interactive',
  'builds',
] as const

function isView(v: string | null): v is View {
  return v !== null && (VALID_VIEWS as readonly string[]).includes(v)
}

/**
 * Parse the current window.location.search into an UrlState. Unknown or
 * malformed values fall back to defaults.
 */
export function readUrlState(): UrlState {
  if (typeof window === 'undefined') {
    return { view: 'basic' }
  }
  const p = new URLSearchParams(window.location.search)
  const viewParam = p.get('view')
  const view: View = isView(viewParam) ? viewParam : 'basic'
  return { view }
}

/**
 * Encode an UrlState into a search string suitable for
 * `history.replaceState`. The default view (basic) is omitted so a URL
 * sitting on the Basic tab reads as clean `/` rather than `/?view=basic`.
 */
export function serializeUrlState(state: UrlState): string {
  const p = new URLSearchParams()
  if (state.view !== 'basic') p.set('view', state.view)
  const qs = p.toString()
  return qs.length > 0 ? '?' + qs : window.location.pathname
}

/**
 * Replace the current URL to match `state`. Uses replaceState so tab flips
 * don't fill the history stack.
 */
export function replaceUrlState(state: UrlState): void {
  if (typeof window === 'undefined') return
  const next = serializeUrlState(state)
  const current = window.location.search || window.location.pathname
  if (next === current) return // no-op guard: avoids polluting popstate
  window.history.replaceState(null, '', next)
}

/**
 * Push a new history entry. Kept as an escape hatch — no caller uses it
 * today, but retained so if we later add "share this tab" behaviour we
 * have a stable, tested API to reach for.
 */
export function pushUrlState(state: UrlState): void {
  if (typeof window === 'undefined') return
  window.history.pushState(null, '', serializeUrlState(state))
}
