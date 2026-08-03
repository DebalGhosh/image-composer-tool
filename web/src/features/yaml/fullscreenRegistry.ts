import { useEffect, useState } from 'react'

/**
 * Cross-instance fullscreen coordinator for YamlEditor.
 *
 * Lifted out of YamlEditor.tsx in FE-7: a HOOK EXPORTED FROM A COMPONENT FILE
 * is the smell this move exists to fix. Nothing about the coordination is
 * React-specific — it is a module-level Observer with a `useSyncExternalStore`
 * shape — so it belongs in its own module and the component becomes one of its
 * subscribers rather than its owner.
 *
 * WHY A SINGLETON AND NOT A CONTEXT. Only one editor may be fullscreen at once.
 * A context provider would drag every consumer of every editor into the design
 * and force a provider into App.tsx for a rule that concerns two sibling
 * components. The module-level pair below is the smallest thing that enforces
 * it: when any editor owns fullscreen, the others hide their expand button, so
 * two `position: fixed` overlays can never coexist.
 *
 * ⚠️ MODULE STATE IS PER-BUNDLE, and that is exactly why it works here: all
 * editors live in one bundle and one document. It also means tests must reset
 * it — see releaseFullscreen() and the note on ownership below.
 */

/**
 * The instance id currently owning fullscreen, or null.
 *
 * Ownership is by React `useId()` rather than a boolean, deliberately: an editor
 * must be able to tell "I am fullscreen" from "someone ELSE is fullscreen", and
 * the second case is what hides its button. A boolean would collapse the two.
 */
let activeFullscreenOwner: string | null = null
const fullscreenListeners = new Set<() => void>()

/** Claim fullscreen for `id`, or release it entirely with null. */
export function setFullscreenOwner(id: string | null): void {
  activeFullscreenOwner = id
  fullscreenListeners.forEach((cb) => cb())
}

/** The current owner id, or null. Read by editors to spot a foreign owner. */
export function getFullscreenOwner(): string | null {
  return activeFullscreenOwner
}

/** Subscribe to ownership changes. Returns an unsubscribe function. */
export function subscribeFullscreen(cb: () => void): () => void {
  fullscreenListeners.add(cb)
  return () => {
    fullscreenListeners.delete(cb)
  }
}

/**
 * True while ANY YamlEditor on the page is in fullscreen mode.
 *
 * Read-only window onto the singleton above, for surrounding chrome that
 * has to defer to the fullscreen overlay. The concrete consumer is
 * BasicPage's template-YAML drawer: `DialogOverlay` registers its Escape
 * handler on mount and `stopPropagation()`s, so it would swallow the key
 * that should merely exit fullscreen. Passing
 * `closeOnEscape={!useYamlFullscreenActive()}` makes the innermost layer
 * win — first Escape leaves fullscreen, second closes the drawer.
 *
 * ⚠️ THE NAME IS REFERENCED IN PROSE at DialogOverlay.tsx's `closeOnEscape`
 * doc comment. Renaming it silently makes that comment a lie.
 */
export function useYamlFullscreenActive(): boolean {
  const [active, setActive] = useState(() => activeFullscreenOwner !== null)
  useEffect(
    () => subscribeFullscreen(() => setActive(activeFullscreenOwner !== null)),
    [],
  )
  return active
}
