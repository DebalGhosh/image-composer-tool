import { useLayoutEffect, useRef } from 'react'

/**
 * FLIP animation for reordered rows.
 *
 * When a partition swaps places (via the up/down buttons), the rows should slide
 * to their new positions rather than snap. Classic FLIP:
 *
 *   1. Before the value change, capture each row's top offset by id.
 *   2. React commits the reorder — DOM nodes stay put (rows are keyed by id),
 *      only their DOM order changes, so they naturally paint at the new
 *      positions.
 *   3. In useLayoutEffect (after DOM update, before paint), read each row's new
 *      offset and set `transform: translateY(oldTop - newTop)` inline. That
 *      places each row visually where it USED to be.
 *   4. Force a reflow, then clear the transform on the same frame with a CSS
 *      transition — rows glide from old to new.
 *
 * Rows carry `background: var(--section-background)` so they are opaque during
 * the transition; the parent stacking context is a plain flex column, so
 * overlapping mid-animation rows stack cleanly by DOM order (later rows paint on
 * top). No transparency, no ghosting.
 *
 * ⚠️ THE CAPTURE HAPPENS IN THE CLICK HANDLER, NOT IN AN EFFECT, and that is the
 * whole design. `pendingFlipRef` is populated ONLY by `captureThenReorder`, so
 * the layout effect below no-ops for every render triggered by something else —
 * typing a size, dragging the disk slider, the Card's expand animation, a
 * viewport resize. Each of those was a real source of baseline contamination
 * that made rows ghost. Only a real click animates.
 */
export function useFlipReorder(ids: string[]) {
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // Positions captured synchronously in the user-triggered move handler,
  // consumed by the useLayoutEffect right after React commits the swap.
  const pendingFlipRef = useRef<Map<string, number> | null>(null)

  /**
   * Snapshot every row's current DOM top RIGHT BEFORE the state update, then run
   * `reorder`. Capturing here rather than in a mount-time effect avoids every
   * source of baseline contamination listed above.
   */
  const captureThenReorder = (reorder: () => void) => {
    const snap = new Map<string, number>()
    for (const id of ids) {
      const el = rowRefs.current[id]
      if (el) snap.set(id, el.getBoundingClientRect().top)
    }
    pendingFlipRef.current = snap
    reorder()
  }

  useLayoutEffect(() => {
    const oldOffsets = pendingFlipRef.current
    // If there's no pending FLIP request, this render was triggered by
    // something OTHER than a user-clicked reorder (typing, size drag,
    // add/remove partition, Card expand tail). Do nothing.
    if (!oldOffsets) return
    pendingFlipRef.current = null

    // 1 px threshold filters subpixel reflow jitter — non-moving rows
    // can shift 0.6-0.9 px between renders due to font-metric rounding.
    const MIN_DELTA = 1
    for (const [id, oldTop] of oldOffsets) {
      const el = rowRefs.current[id]
      if (!el) continue
      const newTop = el.getBoundingClientRect().top
      const dy = oldTop - newTop
      if (Math.abs(dy) < MIN_DELTA) continue
      el.style.transition = 'none'
      el.style.transform = `translateY(${dy}px)`
      // Force a synchronous style flush so the browser paints the
      // first-frame transform before we schedule the transition.
      void el.offsetHeight
      el.style.transition = 'transform 260ms cubic-bezier(0.22, 0.7, 0.32, 1)'
      el.style.transform = 'translateY(0)'
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join('|')])

  return { rowRefs, captureThenReorder }
}
