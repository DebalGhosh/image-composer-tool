/**
 * Theme resolution and the <html> class that carries it.
 *
 * Split out of store.ts in FE-7b. Deliberately NOT part of the persisted store
 * blob: theme has its own localStorage key so the anti-FOUC script in
 * index.html can read it before any module loads.
 *
 * ⚠️ `ict.theme` IS HAND-DUPLICATED IN web/index.html. The inline bootstrap
 * there must apply the identical rule, earlier, to stay FOUC-free. Change both
 * or neither — and note that PERSIST_VERSION does NOT protect this key, because
 * it is written directly rather than through Zustand's persist middleware.
 */

export type Theme = 'light' | 'dark'

export const THEME_KEY = 'ict.theme'

/**
 * Resolves the theme for this page load.
 *
 * Dark is the product default: a first-time visitor lands in dark mode. The
 * OS `prefers-color-scheme` hint is deliberately NOT consulted — it used to
 * be the tiebreaker, but a default that follows the OS isn't a default, it's
 * a coin flip, and the operator-console surfaces (build log terminal, YAML
 * editor) are designed dark-first.
 *
 * Only an explicit stored `'light'` opts out. Testing for that rather than
 * for `'dark'` means an absent key, an unreadable store, and a corrupted
 * value all resolve to the default instead of silently reverting to light.
 *
 * Returning a stored value round-trips through setTheme, so a user's choice
 * still survives reloads in both directions — this changes the cold-start
 * default only.
 *
 * Twin of the inline bootstrap in index.html, which must apply the identical
 * rule earlier (before any module loads) to stay FOUC-free. Change both.
 */
function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  try {
    if (window.localStorage.getItem(THEME_KEY) === 'light') return 'light'
  } catch {
    /* localStorage may be unavailable in private modes — fall through to the
     * default, matching index.html's behaviour when the read throws. */
  }
  return 'dark'
}

export function applyThemeClass(theme: Theme) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export const initialTheme = readInitialTheme()
applyThemeClass(initialTheme)
