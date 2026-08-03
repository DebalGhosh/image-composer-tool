import type { CSSProperties } from 'react'

/**
 * The wrapper's inline style and CodeMirror's height, derived from one flag.
 *
 * Pure — no React, no DOM. Kept as inline style rather than Tailwind classes
 * because these values must BEAT whatever `className` the consumer passed
 * (border, rounded, height utilities), and an inline style wins that contest
 * without an `!important` arms race.
 */
export function fullscreenWrapperStyle(
  isFullscreen: boolean,
  height: string,
): { wrapperStyle: CSSProperties; cmHeight: string } {
  // (which is z-40).
  const wrapperStyle: CSSProperties = isFullscreen
    ? {
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 60,
        background: 'var(--page-background)',
        borderRadius: 0,
        borderWidth: 0,
        margin: 0,
        // Small breathing room around CM for the toolbar and edges.
        padding: '40px 12px 12px 12px',
        boxSizing: 'border-box',
        overflow: 'hidden',
        animation:
          'yaml-editor-fs-in 200ms cubic-bezier(0.22, 0.7, 0.32, 1) both',
        // Own stacking context so the button stays above CM.
        display: 'block',
      }
    : {
        // Establish a positioning context so the absolute-positioned expand
        // button anchors to this wrapper (not to some ancestor). Kept minimal
        // so consumer className border/rounded/height utilities still apply.
        position: 'relative',
      }

  // In fullscreen, hand CodeMirror an explicit viewport-relative height that
  // subtracts our wrapper padding — it re-layouts without unmounting.
  const cmHeight = isFullscreen ? 'calc(100vh - 52px)' : height

  return { wrapperStyle, cmHeight }
}
