import { useRef } from 'react'
import type { Partition } from '@/types/partition'
import {
  applyDividerDrag,
  dragConstraints,
  deltaMiBOf,
} from '../model/drag'

/**
 * Pointer plumbing for dragging the dividers on the disk bar.
 *
 * Deliberately thin: all the arithmetic lives in model/drag.ts, which is pure
 * and directly tested. What is left here is the part that genuinely needs the
 * DOM — measuring the bar, capturing the pointer, and the window-level listener
 * lifecycle.
 *
 * Two details that are easy to lose in a move and are preserved exactly:
 *
 *   1. Constraints and the bar rect are snapshotted ONCE on pointerdown. They
 *      must not be recomputed per tick, because the drag mutates `parts` and a
 *      fresh read would measure against sizes the drag itself just wrote —
 *      giving compounding, accelerating movement.
 *   2. Listeners go on `window`, not the element, so the drag survives the
 *      pointer leaving the bar. `setPointerCapture` is additionally attempted
 *      and allowed to throw: jsdom and some browsers reject it, and the window
 *      listeners are what actually carry the drag.
 */

export interface PartitionDragParams {
  parts: Partition[]
  diskMiB: number
  usedMiB: number
  onChange: (next: Partition[]) => void
}

export interface PartitionDrag {
  /** Attach to the disk bar; used to translate pointer pixels into MiB. */
  barRef: React.RefObject<HTMLDivElement | null>
  /** Start a drag on the divider between partitions `i` and `i+1`. */
  beginDividerDrag: (i: number, ev: React.PointerEvent<HTMLDivElement>) => void
}

export function usePartitionDrag({
  parts,
  diskMiB,
  usedMiB,
  onChange,
}: PartitionDragParams): PartitionDrag {
  const barRef = useRef<HTMLDivElement>(null)

  // Read the live values through a ref so the handler installed on pointerdown
  // is not closing over a stale render's props for the duration of the drag.
  const latest = useRef({ parts, diskMiB, usedMiB, onChange })
  latest.current = { parts, diskMiB, usedMiB, onChange }

  const beginDividerDrag = (
    i: number,
    ev: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!barRef.current) return
    ev.preventDefault()

    const barRect = barRef.current.getBoundingClientRect()
    const startX = ev.clientX
    // Snapshot ONCE — see the note in this module's header.
    const start = latest.current
    const constraints = dragConstraints(start.parts, i, start.diskMiB)

    // Capture the pointer so moves outside the bar still arrive. Browsers (and
    // jsdom) may reject; the window listeners below are the real mechanism.
    const target = ev.currentTarget
    try {
      target.setPointerCapture(ev.pointerId)
    } catch {
      /* browsers may reject in tests */
    }

    const onMove = (e: PointerEvent) => {
      const deltaMiB = deltaMiBOf(e.clientX - startX, barRect.width, start.diskMiB)
      // `start.parts` on purpose: every tick computes from the sizes as they
      // were when the drag began, so the result depends only on total pointer
      // displacement and not on the path taken.
      const next = applyDividerDrag({
        parts: start.parts,
        index: i,
        constraints,
        deltaMiB,
        diskMiB: start.diskMiB,
        usedMiB: start.usedMiB,
      })
      latest.current.onChange(next)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return { barRef, beginDividerDrag }
}
