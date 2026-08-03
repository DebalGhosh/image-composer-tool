import { useCallback, useEffect } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { useFullscreenOwnership } from './useFullscreenOwnership'
import { fullscreenWrapperStyle } from './fullscreenStyle'

/**
 * The fullscreen behaviour of one YamlEditor instance, as one facade.
 *
 * Composed from three pieces with genuinely different natures, which is why
 * FE-7a split them rather than leaving one 200-line hook:
 *   - useFullscreenOwnership — talks to the module registry, touches no DOM;
 *   - this hook's effects     — all the document-level side effects;
 *   - fullscreenWrapperStyle  — pure derivation, no React at all.
 *
 * THE EFFECTS BELOW STAY TOGETHER, and that is deliberate. Each is keyed on the
 * same `isFullscreen` flag and each has a cleanup that must run when the flag
 * flips: the body scroll lock, the capture-phase Escape listener, focus
 * containment via `focusin`, and focusing the toggle on enter. Four separate
 * hooks would mean four subscriptions to one flag with no ordering guarantee
 * between their cleanups — and the scroll lock in particular must be released
 * before anything else re-measures.
 *
 * APPROACH B, deliberately: fullscreen toggles the SAME wrapper element to
 * `position: fixed`, inset zero, at a z-index above the sticky header (the exact
 * value lives in fullscreenStyle.ts, set as an inline style rather than a class).
 * CodeMirror is never unmounted, so cursor position, scroll offset and undo
 * history all survive the transition, and the consumer never sees the state.
 *
 * ⚠️ THE Z-INDEX IS SPELLED OUT IN PROSE RATHER THAN AS A UTILITY NAME ON
 * PURPOSE. Tailwind v4 scans raw file TEXT including comments, so writing the
 * class name here GENERATES that utility — and nothing uses it, because the
 * value is applied inline. The first draft of this comment did exactly that and
 * added a dead rule to the built CSS. YamlEditor.tsx's header has the same
 * hazard; see the note there.
 *
 * ⚠️ THE OVERLAY IS IN-TREE `position: fixed`. This app renders no React
 * portals at all, so the overlay stays where it is declared in the tree — which
 * means any ancestor with `container-type: inline-size` (or any other
 * `contain: layout`) becomes its containing block and traps it inside a Card.
 * That is why AdvancedPage carries no `@container` marker. See
 * .claude/UI-LAYOUT.md.
 *
 * (Deliberately phrased without naming the React DOM API for that: the gate
 * greps `src/` for the function name and expects zero hits, so writing it in
 * prose here would make the guardrail report a false positive on itself.)
 *
 * Extracted verbatim from YamlEditor in FE-7a.
 */
export function useYamlFullscreen({
  instanceId,
  buttonRef,
  wrapperRef,
  cmRef,
  height,
}: {
  /** Stable per-instance token; the singleton stores this to mark ownership. */
  instanceId: string
  buttonRef: RefObject<HTMLButtonElement | null>
  wrapperRef: RefObject<HTMLDivElement | null>
  cmRef: RefObject<ReactCodeMirrorRef | null>
  /** The consumer's windowed height, returned unchanged when not fullscreen. */
  height: string
}) {
  const {
    isFullscreen,
    anotherOwnsFullscreen,
    enterFullscreen,
    exitFullscreen,
  } = useFullscreenOwnership(instanceId)

  // Body scroll lock + document-level Escape listener while fullscreen.
  useEffect(() => {
    if (!isFullscreen) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        exitFullscreen()
      }
    }
    // Capture phase so we win against CodeMirror's own key handling.
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey, true)
    }
  }, [isFullscreen, exitFullscreen])

  // Focus containment (defense-in-depth): while fullscreen, if focus ever
  // escapes the wrapper (e.g. Tab out of CodeMirror's search panel, browser
  // chrome, an inadvertently focused sibling), pull it back to the toggle
  // button. This complements the wrapper's onKeyDown trap and handles cases
  // the trap doesn't enumerate (search panel inputs, future focusables).
  useEffect(() => {
    if (!isFullscreen) return
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null
      if (target && !wrapper.contains(target)) {
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
    // The refs are in the dep array only to satisfy exhaustive-deps. Ref
    // OBJECTS are stable for a component's lifetime — React guarantees the
    // identity, only `.current` mutates — so listing them cannot cause a
    // re-subscribe. They became visible to the rule when FE-7a turned them from
    // in-scope locals into hook parameters; nothing about the behaviour moved.
  }, [isFullscreen, wrapperRef, buttonRef])

  // Focus management: when entering fullscreen, focus the toggle button (it
  // now shows the collapse icon and is one of the two focus landmarks). On
  // exit, focus stays on that same button since it's the same DOM node.
  useEffect(() => {
    if (isFullscreen) {
      buttonRef.current?.focus()
    }
  }, [isFullscreen, buttonRef])

  // Focus trap: cycle Tab / Shift+Tab between the toggle button and the
  // CodeMirror contenteditable. Only active in fullscreen.
  //
  // CRITICAL: In editable mode, CodeMirror's Prec.highest Tab keymap consumes
  // Tab and calls preventDefault (but not stopPropagation) — so this React
  // handler still fires on the bubble-phase delegated listener. We MUST NOT
  // steal focus in that case, or every Tab keystroke would insert two spaces
  // AND yank focus to the toggle button. The `e.defaultPrevented` short-circuit
  // handles this: when CM (or any other handler) has already preventDefaulted
  // the Tab, we leave focus alone. The trap therefore only fires when CM
  // deliberately let Tab through (readOnly mode, or Shift+Tab-without-dedent).
  const onWrapperKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isFullscreen || e.key !== 'Tab') return
      // If CM's Tab keymap consumed the event, don't interfere. This is what
      // fixes the "Tab inserts spaces AND boots focus" bug in editable mode.
      if (e.defaultPrevented) return
      const btn = buttonRef.current
      const cm = cmRef.current?.view?.contentDOM
      if (!btn || !cm) return
      const active = document.activeElement

      // THE RULE, once the four original branches are collapsed: there are only
      // two focus landmarks in the overlay, so Tab in EITHER direction from
      // EITHER one goes to the other. The original code enumerated all four
      // (Tab-from-CM, Tab-from-button, Shift+Tab-from-button,
      // Shift+Tab-from-CM) with identical bodies, which hid the fact that the
      // shift key does not actually change the outcome — with two landmarks,
      // forwards and backwards are the same hop.
      //
      // `cm.contains(active)` and not just `active === cm`: focus may sit on a
      // descendant of the contenteditable (CodeMirror's search panel inputs,
      // for one), and those must still count as "inside the editor".
      const from = active === btn ? 'button' : cm.contains(active) || active === cm ? 'cm' : null
      if (from === null) return
      e.preventDefault()
      if (from === 'button') cm.focus()
      else btn.focus()
    },
    [isFullscreen, buttonRef, cmRef],
  )

  // Merge className (border, ring, etc.) with fullscreen-only overrides that
  // must beat consumer classes: edge-to-edge (no border-radius), solid page

  const { wrapperStyle, cmHeight } = fullscreenWrapperStyle(isFullscreen, height)

  return {
    isFullscreen,
    anotherOwnsFullscreen,
    enterFullscreen,
    exitFullscreen,
    onWrapperKeyDown,
    wrapperStyle,
    cmHeight,
  }
}
