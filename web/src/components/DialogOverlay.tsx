/**
 * DialogOverlay — the "dim + slide-in" modal primitive.
 *
 * Mechanic ported (with focus-trap and Esc-close bolted on) from the
 * Intel Smart Software Factory UI project's DialogWrapper component
 * (`applications.automation.smart-software-factory.ui/src/components/
 * dialogWrapper/dialogWrapper.tsx` + `dialogWrapper.module.scss`). The
 * SSF version wraps everything in a fixed `.mask` div at
 * `rgba(36,37,40,0.8)` with an inner `.dialogContainer` that transitions
 * `max-height` and `opacity` when a `.visible` class is toggled one tick
 * after the `visible` prop flips true. We keep the class-toggle-after-
 * mount pattern verbatim — that's what produces the smooth entry — but
 * we soften the backdrop (`rgba(0,0,0,0.55)` + a light `backdrop-filter:
 * blur(4px)`) so the dimming pairs with the frosted-glass surfaces
 * already in use elsewhere (see `BasicPage.tsx`'s sticky action-footer).
 *
 * SSF's version does not include Esc-to-close, backdrop-click-to-close,
 * focus trap, or body-scroll lock. We adopt them here — the patterns are
 * copied from `YamlEditor.tsx` (document-level capture-phase keydown for
 * Escape, `focusin`-based containment, Tab / Shift+Tab handler on the
 * panel).
 *
 * Portal-free by convention — the project's `Combobox.tsx` and
 * `MultiCombobox.tsx` both call out "no portal" as a shared choice, and
 * the SSF `DialogWrapper` is also just rendered in-place. The dialog is
 * `position: fixed`, so z-index alone lifts it above every other
 * surface.
 *
 * The panel background / border / shadow are all driven by the
 * project's existing CSS variables (see `index.css`), so the dialog
 * automatically follows the light/dark theme toggle at `document.body.
 * classList` change without any extra JS.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

export interface DialogOverlayProps {
  /** Whether the dialog should be visible. Toggling from true→false
   *  waits for the exit transition to finish before unmount. */
  open: boolean
  /** Called when the user requests dismissal (Escape, backdrop click,
   *  or an in-panel close button that calls this itself). */
  onClose: () => void
  /** Optional title for the panel's header + a11y label. */
  title?: ReactNode
  /** DOM id of an element whose text names the dialog. Overrides
   *  `title` for a11y when both are present. */
  ariaLabelledBy?: string
  /**
   * Approximate viewport share the panel should target. `wide` is the
   * default and what PackageSearchDialog wants (search palette wants
   * horizontal room for the detail pane). `medium` is a reasonable
   * default for future confirm-style dialogs.
   */
  size?: 'medium' | 'wide'
  /** Panel body. Anything inside `<DialogOverlay>` renders inside the
   *  animated container; the mask, header slot, and close X sit
   *  outside. */
  children: ReactNode
  /** Extra classes appended to the panel (rare — most styling comes
   *  from the built-in --section-background / --border-color set). */
  className?: string
}

// One-frame delay before adding the `.visible` class so the transition
// interpolates from the initial (opacity:0, scale:0.98, translateY:8px)
// state. SSF uses `setTimeout(0)`; requestAnimationFrame is subtly
// smoother because it aligns with the paint cycle.
function scheduleEntry(cb: () => void): () => void {
  const raf = requestAnimationFrame(() => cb())
  return () => cancelAnimationFrame(raf)
}

// A generous CSS selector for "focusable elements" — used by the focus
// trap to find the first + last tabbable child of the panel. Order
// matches WICG's `focusable` proposal.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function DialogOverlay({
  open,
  onClose,
  title,
  ariaLabelledBy,
  size = 'wide',
  children,
  className,
}: DialogOverlayProps) {
  // `mounted` gates whether we render the DOM tree at all. It flips true
  // on open, and back to false only AFTER the exit transition ends —
  // otherwise the panel disappears instantly rather than animating out.
  const [mounted, setMounted] = useState<boolean>(open)
  // `entered` drives the `.visible` class that starts the transition.
  // It goes true one animation-frame after mount, and back to false
  // when `open` flips to false; the panel's `transitionEnd` then
  // clears `mounted`.
  const [entered, setEntered] = useState<boolean>(false)
  const maskRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // The trigger that opened the dialog — we restore focus to it on
  // close. Captured on the FIRST render where `open` becomes true so
  // subsequent re-renders don't clobber it.
  const returnFocusRef = useRef<Element | null>(null)

  // Mount / unmount + entry / exit orchestration.
  useEffect(() => {
    if (open) {
      // Remember what to restore focus to when we close.
      returnFocusRef.current = document.activeElement
      setMounted(true)
      // Schedule the class-toggle so the transition interpolates.
      return scheduleEntry(() => setEntered(true))
    }
    // Closing: kick off exit. `mounted` stays true until the
    // transitionEnd handler runs; if `open` re-flips true before then,
    // the effect above wins (React runs cleanup then the new effect).
    setEntered(false)
    return undefined
  }, [open])

  // Escape-to-close (document-level, capture phase so we win against
  // any nested inputs). Same shape as YamlEditor's fullscreen handler.
  useEffect(() => {
    if (!mounted) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [mounted, onClose])

  // Body scroll lock — restore on unmount.
  useEffect(() => {
    if (!mounted) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [mounted])

  // Focus containment. When the panel is mounted:
  //   1. Auto-focus a child marked `data-autofocus` (the search input,
  //      for PackageSearchDialog), or the first focusable child.
  //   2. If focus ever escapes the panel (Tab into browser chrome, an
  //      inadvertently focused sibling), yank it back.
  useEffect(() => {
    if (!mounted || !entered) return
    const panel = panelRef.current
    if (!panel) return

    const autoFocus =
      panel.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
    // Focus late enough that the transition has begun — otherwise
    // Safari can occasionally skip the focus ring paint.
    const raf = requestAnimationFrame(() => autoFocus?.focus())

    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Node | null
      if (t && !panel.contains(t)) {
        autoFocus?.focus()
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [mounted, entered])

  // Tab / Shift+Tab trap — cycles focus among focusable descendants of
  // the panel. This complements the `focusin` net above by keeping the
  // ring inside the panel even when the browser would normally advance.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((el) => !el.hasAttribute('data-focus-trap-ignore'))
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }, [])

  // Mask click closes — but panel clicks must not bubble here.
  const onMaskMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === maskRef.current) {
        onClose()
      }
    },
    [onClose],
  )

  // transitionEnd on the panel: when the exit transition finishes, we
  // finally unmount. Also fires on entry — we ignore that case by
  // checking `entered`.
  const onTransitionEnd = useCallback(
    (e: React.TransitionEvent<HTMLDivElement>) => {
      if (e.target !== panelRef.current) return
      if (!entered) {
        setMounted(false)
        // Restore focus to whatever opened the dialog. Guard against
        // the trigger being unmounted since we captured it.
        const el = returnFocusRef.current
        if (el && el instanceof HTMLElement) el.focus()
      }
    },
    [entered],
  )

  if (!mounted) return null

  const maskStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // rgba(0,0,0,0.55) reads well against both light and dark themes;
    // the +4px blur pairs the dim with a slight frosted-glass depth
    // that matches BasicPage.tsx's sticky action-footer backdrop.
    background: 'rgba(0, 0, 0, 0.55)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    // Mask itself fades in/out; the panel does the scale + translate.
    opacity: entered ? 1 : 0,
    transition: 'opacity 220ms cubic-bezier(0.22, 0.7, 0.32, 1)',
    padding: '4vh 4vw',
    // Overflow so a small viewport can still scroll past the panel.
    overflowY: 'auto',
  }

  const panelStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    maxWidth: size === 'wide' ? '1200px' : '640px',
    // A generous but bounded height so the dialog never exceeds the
    // viewport; internal columns handle their own scroll.
    maxHeight: '92vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--section-background)',
    border: '1px solid var(--border-color)',
    borderRadius: '12px',
    boxShadow: 'var(--options-shadow)',
    color: 'var(--font-color)',
    overflow: 'hidden',
    // Entry transition — matches the easing YamlEditor uses for its
    // fullscreen entry. 220ms feels crisp without being twitchy.
    transform: entered ? 'scale(1) translateY(0)' : 'scale(0.98) translateY(8px)',
    opacity: entered ? 1 : 0,
    transition:
      'transform 220ms cubic-bezier(0.22, 0.7, 0.32, 1), ' +
      'opacity 220ms cubic-bezier(0.22, 0.7, 0.32, 1)',
  }

  return (
    <div
      ref={maskRef}
      style={maskStyle}
      onMouseDown={onMaskMouseDown}
      role="presentation"
    >
      <div
        ref={panelRef}
        className={className}
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        onKeyDown={onKeyDown}
        onTransitionEnd={onTransitionEnd}
      >
        {title !== undefined && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 18px',
              borderBottom: '1px solid var(--border-color)',
              flex: 'none',
            }}
          >
            <div
              id={ariaLabelledBy ?? 'dialog-title'}
              style={{
                fontSize: '13px',
                fontWeight: 600,
                letterSpacing: '0.02em',
                textTransform: 'uppercase',
                color: 'var(--muted-color)',
              }}
            >
              {title}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              style={{
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--muted-color)',
                borderRadius: 6,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background =
                  'color-mix(in srgb, var(--muted-color) 12%, transparent)'
                e.currentTarget.style.color = 'var(--font-color)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--muted-color)'
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M5 5l10 10M15 5L5 15"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
