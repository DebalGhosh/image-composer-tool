import { useCallback, useEffect, useState } from 'react'
import {
  getFullscreenOwner,
  setFullscreenOwner,
  subscribeFullscreen,
} from '../fullscreenRegistry'

/**
 * Who owns fullscreen, and this instance's claim on it.
 *
 * The ownership half of the fullscreen story: it talks only to the module-level
 * registry and holds the `isFullscreen` flag. It performs no DOM work at all —
 * no scroll lock, no listeners, no focus. That separation is what makes it
 * readable: everything here is about a token, and everything in
 * useFullscreenFocusEffects is about the document.
 *
 * `bump` exists to re-render on registry changes so a SECOND editor can hide
 * its expand button the moment a first one goes fullscreen. It is a counter and
 * not the owner value itself because the owner is read synchronously below —
 * subscribing is only about scheduling the re-render.
 */
export function useFullscreenOwnership(instanceId: string) {
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Re-render on singleton changes so we can hide the button when another
  // instance owns fullscreen.
  const [, bump] = useState(0)
  useEffect(
    () => subscribeFullscreen(() => bump((n) => n + 1)),
    [],
  )
  const owner = getFullscreenOwner()
  const anotherOwnsFullscreen = owner !== null && owner !== instanceId

  const enterFullscreen = useCallback(() => {
    // Guard: refuse if another instance already owns fullscreen. In practice
    // the button is hidden on other instances, but this belt-and-braces
    // check prevents races if the button flickers.
    const current = getFullscreenOwner()
    if (current !== null && current !== instanceId) {
      return
    }
    setFullscreenOwner(instanceId)
    setIsFullscreen(true)
  }, [instanceId])

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false)
    if (getFullscreenOwner() === instanceId) {
      setFullscreenOwner(null)
    }
  }, [instanceId])

  // Release the singleton if this instance unmounts while owning it (e.g.
  // LiveYamlPreview remounts on `beat` change).
  useEffect(
    () => () => {
      if (getFullscreenOwner() === instanceId) {
        setFullscreenOwner(null)
      }
    },
    [instanceId],
  )

  return { isFullscreen, setIsFullscreen, anotherOwnsFullscreen, enterFullscreen, exitFullscreen }
}
