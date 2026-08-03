import { useEffect, useRef, useState } from 'react'

/**
 * Native fullscreen for the build-log terminal.
 *
 * NATIVE `requestFullscreen`, not a CSS overlay, and that choice matters: the
 * browser promotes the element into the top layer, which is above every stacking
 * context in the page. That is why the terminal is unaffected by the
 * `container-type: inline-size` containment discussed in .claude/UI-LAYOUT.md,
 * while the YAML editor's in-tree `position: fixed` overlay is not.
 *
 * `isFullscreen` is derived from the `fullscreenchange` EVENT rather than set
 * optimistically in the toggle, so it stays correct when the user leaves
 * fullscreen by pressing Escape — which the browser handles without telling the
 * toggle.
 *
 * Extracted verbatim from BuildView.
 */
export function useTerminalFullscreen() {
  const terminalWrapRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === terminalWrapRef.current)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = () => {
    const el = terminalWrapRef.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      // Safari uses the webkit-prefixed variant. Fall back if the standard
      // API is missing; catch so we don't crash on unsupported browsers.
      const req =
        el.requestFullscreen ??
        (
          el as HTMLElement & {
            webkitRequestFullscreen?: () => Promise<void>
          }
        ).webkitRequestFullscreen
      req?.call(el)?.catch(() => {})
    }
  }

  return { terminalWrapRef, isFullscreen, toggleFullscreen }
}
