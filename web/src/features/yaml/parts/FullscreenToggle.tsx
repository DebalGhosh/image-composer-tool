import type { RefObject } from 'react'
import { CollapseIcon, ExpandIcon } from './FullscreenIcons'

/**
 * The expand / collapse button that floats over the editor's top-right corner.
 *
 * ⚠️ THE INLINE STYLE OBJECT MOVED HERE WITH THE JSX, INTACT. It carries four
 * `var(--…)` theme tokens (border-color, input-background, muted-color, and
 * font-color via the hover handlers). Leaving it behind in the parent would
 * strand all four: the button would render unstyled in BOTH themes and `tsc`
 * would not notice. Inline rather than Tailwind because the absolute offsets
 * shift between windowed (6px) and fullscreen (8/12px).
 *
 * Hover colour is set imperatively on the element rather than via a CSS class
 * because there is no stylesheet rule for this button — the whole appearance
 * lives in the style object above.
 *
 * The parent renders this only when no OTHER editor owns fullscreen, so two
 * overlays can never coexist. The check stays in the parent because it is the
 * one holding the registry subscription.
 *
 * Extracted from YamlEditor in FE-7a.
 */
export function FullscreenToggle({
  isFullscreen,
  buttonRef,
  onEnter,
  onExit,
}: {
  isFullscreen: boolean
  buttonRef: RefObject<HTMLButtonElement | null>
  onEnter: () => void
  onExit: () => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => (isFullscreen ? onExit() : onEnter())}
      aria-label={isFullscreen ? 'Exit fullscreen' : 'Expand editor to fullscreen'}
      aria-pressed={isFullscreen}
      title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Expand editor'}
      style={{
        position: 'absolute',
        top: isFullscreen ? 8 : 6,
        right: isFullscreen ? 12 : 6,
        zIndex: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 4,
        border: '1px solid var(--border-color)',
        background: 'var(--input-background)',
        color: 'var(--muted-color)',
        cursor: 'pointer',
        padding: 0,
        lineHeight: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'var(--font-color)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'var(--muted-color)'
      }}
    >
      {isFullscreen ? <CollapseIcon /> : <ExpandIcon />}
    </button>
  )
}
