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
 * Two variants share all of the above machinery:
 *   - `center` (default) — the original scale + fade modal.
 *   - `drawer-right` — a full-height panel pinned to the right edge that
 *     slides in horizontally. Used by BasicPage's template-YAML drawer.
 *     CRITICAL: the slide animates `right`, NOT `transform`. A transform
 *     on the panel would establish a containing block for
 *     fixed-position descendants (CSS spec), trapping the YamlEditor
 *     fullscreen overlay inside the 720px drawer instead of letting it
 *     cover the viewport. `BasicPage.tsx` and `LiveYamlPreview.tsx` both
 *     carry the same warning for the same reason. `position: relative`
 *     offsets create no containing block, so `right` is safe.
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
  /**
   * Panel placement + entry animation.
   *  - `center` (default): the original centred scale + fade modal.
   *    `size` controls its max-width.
   *  - `drawer-right`: full-height panel pinned to the right edge,
   *    sliding in horizontally. `size` is ignored (the drawer sets its
   *    own width).
   */
  variant?: 'center' | 'drawer-right'
  /**
   * Whether the document-level Escape listener is installed. Defaults to
   * true.
   *
   * Set false when a descendant owns Escape for its own dismissable
   * layer. The concrete case: `YamlEditor`'s fullscreen mode registers
   * its OWN capture-phase Escape handler, but only on entering
   * fullscreen — ours is registered on mount and therefore runs first
   * and `stopPropagation()`s, so Escape would tear down this whole
   * dialog instead of just leaving fullscreen. BasicPage passes
   * `closeOnEscape={!useYamlFullscreenActive()}` so the innermost layer
   * always wins.
   */
  closeOnEscape?: boolean
  /** Panel body. Anything inside `<DialogOverlay>` renders inside the
   *  animated container; the mask, header slot, and close X sit
   *  outside. */
  children: ReactNode
  /** Extra classes appended to the panel (rare — most styling comes
   *  from the built-in --section-background / --border-color set). */
  className?: string
}

// Delay before adding the `.visible` class so the transition interpolates
// from the initial (opacity:0, scale:0.98, translateY:8px) state — or, for
// the drawer, from `right: -720px`.
//
// DOUBLE requestAnimationFrame, not single. A single rAF is not enough: the
// `setEntered(true)` it schedules is a default-priority React 19 update
// dispatched through Scheduler's MessageChannel, and that task can run
// BEFORE the frame's style recalculation. When it does, `right: 0px` is
// recalculated in the same pass that first computes `right: -720px`, so
// there is no committed "from" value to interpolate and the transition
// never runs at all — the panel simply appears at its final position.
//
// Measured on the drawer (6 trials per variant, watching for a `transitionrun`
// event on `right`): single rAF fired 5/6 — i.e. it silently dropped the
// animation one time in six, and dropped it far more often under load, which
// is why raising DRAWER_SLIDE_MS from 260 to 400 to 560 changed nothing about
// the entry. Double rAF fired 6/6. The second frame guarantees the closed
// state has been through a full style-recalc-and-paint cycle first.
//
// A forced reflow (`void panel.offsetWidth`) was also tried and measured no
// better than single rAF (5/6) — the read happens before React has committed
// the closed style, so there is nothing to flush.
function scheduleEntry(cb: () => void): () => void {
  let inner = 0
  const outer = requestAnimationFrame(() => {
    inner = requestAnimationFrame(() => cb())
  })
  return () => {
    cancelAnimationFrame(outer)
    if (inner) cancelAnimationFrame(inner)
  }
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

// Drawer width. `min()` with 100vw so narrow viewports get a full-bleed
// sheet rather than a panel hanging off-screen. Referenced twice (width +
// the closed `right` offset), so it lives in one constant.
const DRAWER_WIDTH = 'min(720px, 100vw)'

// Drawer slide duration, both directions. Much longer than the centred
// modal's 220ms because the drawer travels its full 720px width where the
// modal only scales 2%. Shared by the panel's `right` transition and the
// mask's fade: if the mask finished first, the drawer would spend the tail of
// its exit sliding across undimmed content.
const DRAWER_SLIDE_MS = 560

// Easing for the slide — deliberately NOT the house
// `cubic-bezier(0.22, 0.7, 0.32, 1)` used everywhere else in this codebase.
//
// That curve is steeply front-loaded (initial slope ~3.2; it covers 56% of the
// distance in the first 20% of the time). On a 2% scale or a colour fade you
// read that as "crisp", but across 720px of travel it reads as a lunge that
// then crawls to a stop — which is exactly the "too hasty" the user reported
// at 400ms, and raising the duration alone doesn't fix it (at 600ms the house
// curve still throws ~288px out in the first 80ms).
//
// This is easeOutQuad: initial slope 1.84 rather than 3.2, 50% of the travel
// at 28% of the time rather than 17%. The motion starts at a believable speed
// and decelerates over a long tail, so the panel feels carried rather than
// flung. Local to the drawer — the centred variant keeps the house easing.
const DRAWER_EASE = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)'

export function DialogOverlay({
  open,
  onClose,
  title,
  ariaLabelledBy,
  size = 'wide',
  variant = 'center',
  closeOnEscape = true,
  children,
  className,
}: DialogOverlayProps) {
  const isDrawer = variant === 'drawer-right'
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
  //
  // Skipped entirely when `closeOnEscape` is false so the key reaches a
  // descendant layer's own handler (see the prop docs).
  useEffect(() => {
    if (!mounted || !closeOnEscape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [mounted, closeOnEscape, onClose])

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
    //
    // `preventScroll` is REQUIRED, not a nicety, and specifically for the
    // drawer. This fires one frame into the slide, when the panel is still
    // at `right: -720px` — so the element being focused is off-screen inside
    // the mask's scrollable overflow. `focus()` scrolls ancestors to reveal
    // its target, and `overflow: hidden` boxes (unlike `overflow: clip`) are
    // still programmatically scrollable, so the mask gets `scrollLeft ≈ 720`.
    // On-screen position is `layoutRight(t) - scrollLeft(t)`, and the browser
    // re-clamps scrollLeft every frame as the overflow shrinks — pinning the
    // panel at the viewport edge for the whole slide.
    //
    // Measured without it: `scrollLeft` 0→720 on the first frame, snapping
    // the panel's visual left from 1279 straight to 559 (its final resting
    // position), then ~540ms of no visible movement while `right` interpolated
    // underneath. With it: `scrollLeft` stays 0 and visual left actually
    // tracks 1279→1239→1199→1159. That instant 720px jump was the "jarring"
    // entry, and it is exactly why no duration or easing value ever helped.
    //
    // Entry-only by construction, which matches the reported asymmetry: the
    // exit path runs only this effect's cleanup, and the sole focus() during
    // exit is the return-focus at `onTransitionEnd` below, which fires after
    // the slide and targets the trigger outside the mask.
    const raf = requestAnimationFrame(() =>
      autoFocus?.focus({ preventScroll: true }),
    )

    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Node | null
      if (t && !panel.contains(t)) {
        // Same reasoning as above: a focus yanked back mid-slide must not
        // scroll the mask.
        autoFocus?.focus({ preventScroll: true })
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
    // A descendant that owns its own focus trap has already handled this.
    // React handlers bubble inner→outer, and a nested trap focuses
    // synchronously — so by the time we run, `document.activeElement` is
    // already the element IT chose, and re-running our cycle here would
    // override it. Concretely: YamlEditor's fullscreen trap (inside
    // BasicPage's drawer) moves focus to its own toggle button, which
    // happens to be `last` in our list, so we'd bounce focus straight back
    // to the close X sitting hidden behind the fullscreen overlay.
    // YamlEditor.tsx guards its handler the same way and for the same
    // reason.
    if (e.defaultPrevented) return
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
    // rgba(0,0,0,0.55) reads well against both light and dark themes;
    // the +4px blur pairs the dim with a slight frosted-glass depth
    // that matches BasicPage.tsx's sticky action-footer backdrop.
    //
    // The blur is a `filter`-family property, which ALSO establishes a
    // containing block for fixed descendants — harmless here because the
    // mask is already the full viewport, so "trapped to the mask" and
    // "covering the viewport" are the same rectangle. It must not be
    // pushed down onto the drawer panel.
    background: 'rgba(0, 0, 0, 0.55)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    // Mask itself fades in/out; the panel does the scale (centred) or the
    // horizontal slide (drawer). The drawer's fade is stretched to match its
    // slower slide so dim and travel stay in lockstep.
    opacity: entered ? 1 : 0,
    transition: isDrawer
      ? `opacity ${DRAWER_SLIDE_MS}ms ${DRAWER_EASE}`
      : 'opacity 220ms cubic-bezier(0.22, 0.7, 0.32, 1)',
    ...(isDrawer
      ? {
          // Stretch full-height and pin the panel to the trailing edge.
          alignItems: 'stretch',
          justifyContent: 'flex-end',
          padding: 0,
          // Not overflowY:auto — the panel sits at right:-720px for one
          // frame on entry and again through the exit, which would otherwise
          // compute overflow-x to `auto` and flash a horizontal scrollbar
          // mid-slide.
          //
          // `clip` rather than `hidden`: a `hidden` box is still a scroll
          // CONTAINER, just without visible scrollbars, so anything that
          // scrolls programmatically — notably `focus()` revealing an
          // off-screen descendant — can shift it and cancel the slide (see
          // the preventScroll note in the focus effect). `clip` creates no
          // scroll container at all, so that class of bug cannot recur here
          // even if a future caller focuses something itself. The two are
          // otherwise visually identical for this box.
          //
          // Safe on the containing-block axis: `overflow` is not in the
          // transform/filter/perspective/will-change/contain family, so it
          // does NOT trap YamlEditor's fixed fullscreen overlay.
          overflow: 'clip',
        }
      : {
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4vh 4vw',
          // Overflow so a small viewport can still scroll past the panel.
          overflowY: 'auto',
        }),
  }

  const panelStyle: CSSProperties = isDrawer
    ? {
        position: 'relative',
        // `right` is what animates. NOT transform — see the header note.
        right: entered ? '0px' : `calc(-1 * ${DRAWER_WIDTH})`,
        width: DRAWER_WIDTH,
        maxWidth: 'none',
        height: '100vh',
        maxHeight: 'none',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--section-background)',
        // Leading edge only — the other three sides meet the viewport.
        borderLeft: '1px solid var(--border-color)',
        borderRadius: 0,
        boxShadow: 'var(--options-shadow)',
        color: 'var(--font-color)',
        overflow: 'hidden',
        // Duration + easing live in DRAWER_SLIDE_MS / DRAWER_EASE — see the
        // notes there for why this curve isn't the house one.
        //
        // The slide is the ONLY transition here — deliberately no opacity
        // fade. A solid drawer sliding in shouldn't be translucent en
        // route, and more importantly `onTransitionEnd` is what triggers
        // unmount: a second, shorter opacity transition would fire first
        // and cut the slide off partway.
        transition: `right ${DRAWER_SLIDE_MS}ms ${DRAWER_EASE}`,
      }
    : {
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
        transform: entered
          ? 'scale(1) translateY(0)'
          : 'scale(0.98) translateY(8px)',
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
