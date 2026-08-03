import { useCallback, useEffect, useRef } from 'react'
import type { ImperativePanelHandle } from 'react-resizable-panels'

/**
 * Imperative width animation for a react-resizable-panels pane.
 *
 * WHY THIS EXISTS
 *
 * The same requestAnimationFrame + easeOutCubic + cancel-in-flight logic existed
 * THREE times: `InteractivePage` and `BuildImagePage` each had a byte-identical
 * `animatePanel` callback, and `BasicPage` had the same arithmetic inlined
 * directly in an effect. InteractivePage even carried a standing
 * `TODO(v2): dedupe with BasicPage`. The library does not animate size changes on
 * its own, so this drives `handle.resize()` frame by frame.
 *
 * ⚠️ THE THREE COPIES WERE NOT IDENTICAL IN ONE RESPECT, and the difference is
 * preserved here rather than smoothed over:
 *
 *   - The two named copies, when the pane is already within 0.5% of the target,
 *     SNAP: they call `handle.resize(to)` and return. That matters when
 *     collapsing — a pane sitting at 0.3% must land exactly on 0, or a sliver
 *     stays visible.
 *   - BasicPage's inlined version instead RETURNS WITHOUT RESIZING in that case,
 *     leaving the pane where it is.
 *
 * `snapWhenClose` selects between them, PER CALL rather than per hook instance.
 * That matters: InteractivePage drives the same pane from two places — a manual
 * toggle chevron (snaps) and a `complete`-flip auto-open effect (does not) — and
 * they must share ONE in-flight frame so a flip mid-toggle cannot leave two rAF
 * loops driving one handle from different `from` values. Before this hook they
 * shared a single local `rafRef` for exactly that reason. A per-instance option
 * would have forced two instances and silently broken the mutual cancellation.
 *
 * Not a boolean FLAG ARGUMENT in the Clean Code sense — it does not select
 * between two different jobs, it parameterises one job's boundary condition, and
 * it travels in an options object rather than as a bare positional boolean.
 */

export interface AnimateOptions {
  /**
   * When |current - target| < 0.5, jump straight to the target instead of
   * animating. Default true, reproducing InteractivePage's toggle and
   * BuildImagePage. Pass false for BasicPage's auto-open effect and
   * InteractivePage's, which leave the pane untouched in that case.
   */
  snapWhenClose?: boolean
}

export interface PanelAnimation {
  /** Attach to the `<Panel ref=…>` whose width should animate. */
  panelRef: React.RefObject<ImperativePanelHandle | null>
  /** Animate the pane to `toPercent` over `ms`, cancelling any in-flight run. */
  animateTo: (toPercent: number, ms: number, opts?: AnimateOptions) => void
  /** Cancel an in-flight animation. Called automatically on unmount. */
  cancel: () => void
}

/** easeOutCubic — fast start, gentle settle. Matches the "drop-in" feel. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export function usePanelAnimation(): PanelAnimation {
  const panelRef = useRef<ImperativePanelHandle | null>(null)
  const rafRef = useRef<number | null>(null)

  const cancel = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const animateTo = useCallback(
    (toPercent: number, ms: number, opts: AnimateOptions = {}) => {
      const { snapWhenClose = true } = opts
      const handle = panelRef.current
      if (!handle) return

      const from = handle.getSize()
      if (Math.abs(from - toPercent) < 0.5) {
        // Already there. Snap (or not) per the caller's contract — see the
        // note in this module's header.
        if (snapWhenClose) handle.resize(toPercent)
        return
      }

      const start = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ms)
        handle.resize(from + (toPercent - from) * easeOutCubic(t))
        rafRef.current = t < 1 ? requestAnimationFrame(step) : null
      }

      // Cancel any in-flight animation first: fast successive flips must not
      // fight each other, each driving the same handle from a stale `from`.
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(step)
    },
    [],
  )

  // Clean up an in-flight frame on unmount so a callback cannot fire against a
  // handle whose panel has gone.
  useEffect(() => cancel, [cancel])

  return { panelRef, animateTo, cancel }
}
