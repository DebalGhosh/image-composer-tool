/**
 * Divider-drag arithmetic: given a pointer delta, what should the two adjacent
 * partitions become? Pure — no DOM, no pointer events.
 *
 * Separated from the pointer plumbing (hooks/usePartitionDrag) because this is
 * the subtlest logic in the editor and was previously buried inside a
 * `pointermove` closure, where it could not be tested at all. Three interacting
 * constraints have to hold simultaneously:
 *
 *   1. Each partition's own preset min/max.
 *   2. The disk total — dragging must never over-allocate.
 *   3. Conservation — what the left partition gains, the right one loses…
 *      EXCEPT when the right partition is the fill-remaining row, which absorbs
 *      silently because its width is derived, not stored.
 *
 * Extracted verbatim; the expressions below are unchanged from the original.
 */
import type { Partition } from '@/types/partition'
import { clamp } from './size'
import { presetFor } from './roles'

/**
 * Everything the drag needs that does not change between pointermove ticks.
 * Computed once on pointerdown — recomputing per tick was measurably wasteful
 * and, worse, would read a `value` that the drag itself is mutating.
 */
export interface DragConstraints {
  leftInitial: number
  rightInitial: number
  rightIsFill: boolean
  leftMin: number
  leftMax: number
  rightMin: number
  rightMax: number
  /** Total of every partition OTHER than the two being dragged. */
  others: number
}

/**
 * Snapshot the constraints for a drag on the divider between `i` and `i+1`.
 *
 * A `custom` partition has no preset, so it falls back to [1, diskMiB] — the
 * widest legal range. That is why `presetFor` returning null is a supported
 * answer rather than an error.
 */
/** Total of every partition except the pair at `i` / `i+1`, fill rows excluded. */
function othersTotal(parts: Partition[], i: number): number {
  let others = 0
  for (let k = 0; k < parts.length; k++) {
    if (k === i || k === i + 1) continue
    if (!parts[k].fillRemaining) others += parts[k].sizeMiB
  }
  return others
}

/** A role's [min, max], falling back to the widest legal range for `custom`. */
function boundsFor(part: Partition, diskMiB: number): { min: number; max: number } {
  const preset = presetFor(part.role)
  return { min: preset?.minMiB ?? 1, max: preset?.maxMiB ?? diskMiB }
}

export function dragConstraints(
  parts: Partition[],
  i: number,
  diskMiB: number,
): DragConstraints {
  const left = boundsFor(parts[i], diskMiB)
  const right = boundsFor(parts[i + 1], diskMiB)
  return {
    leftInitial: parts[i].sizeMiB,
    rightInitial: parts[i + 1]?.sizeMiB ?? 0,
    rightIsFill: parts[i + 1]?.fillRemaining === true,
    leftMin: left.min,
    leftMax: left.max,
    rightMin: right.min,
    rightMax: right.max,
    others: othersTotal(parts, i),
  }
}

/** Pointer pixels -> whole MiB, given the bar's on-screen width. */
export function deltaMiBOf(deltaPx: number, barWidthPx: number, diskMiB: number): number {
  const pxPerMiB = barWidthPx / diskMiB
  return Math.round(deltaPx / pxPerMiB)
}

/**
 * The left partition's new size after clamping to its preset AND to the disk.
 *
 * The disk cap differs by case:
 *   - right is fill: leave room for the fill row's own minimum, so it cannot be
 *     squeezed below it.
 *   - otherwise: leave room for at least 1 MiB on the right, computed from the
 *     total MINUS the pair being dragged (they are about to be replaced).
 */
export function resolveLeftSize(req: DragRequest): number {
  const { constraints: c, deltaMiB, diskMiB, usedMiB } = req
  let newLeft = clamp(c.leftInitial + deltaMiB, c.leftMin, c.leftMax)
  const maxLeftForDisk = c.rightIsFill
    ? Math.max(c.leftMin, diskMiB - c.others - c.rightMin)
    : diskMiB - (usedMiB - c.leftInitial - c.rightInitial) - Math.max(c.rightMin, 1)
  newLeft = Math.min(newLeft, Math.max(c.leftMin, maxLeftForDisk))
  return newLeft
}

/**
 * One drag tick's inputs.
 *
 * A parameter object rather than six positionals — house style past 4-5 params
 * (AGENTS.md), and here it also removes a real hazard: `diskMiB` and `usedMiB`
 * are both plain numbers in the same units, so a transposed pair would compile
 * silently and mis-clamp every drag.
 */
export interface DragRequest {
  parts: Partition[]
  /** Index of the LEFT partition of the dragged divider. */
  index: number
  constraints: DragConstraints
  deltaMiB: number
  diskMiB: number
  usedMiB: number
}

/**
 * Apply a drag delta, returning the next partitions array.
 *
 * When the right partition cannot absorb the whole delta (it hit its own min or
 * max), the left partition BACKS OFF to only what was actually absorbed —
 * `effectiveLeft`. Without that, the two sizes would sum to more than the space
 * available and the bar would drift out of sync with the numbers.
 *
 * ⚠️ NO no-op short-circuit here, deliberately. The original fired `onChange`
 * on EVERY pointermove tick even when the computed size was unchanged, and the
 * consumer's handler is `patchDisk({ partitions })` — a store write, not a pure
 * setter. Suppressing identical-value calls would change how often the draft
 * updates, which is a behaviour change rather than a move. Returning a fresh
 * array every tick is the existing contract.
 */
export function applyDividerDrag(req: DragRequest): Partition[] {
  const { parts, index: i, constraints: c } = req
  const newLeft = resolveLeftSize(req)

  if (c.rightIsFill) {
    // Right just absorbs — only the left partition changes; the fill width
    // recomputes from the remainder on the next render.
    return parts.map((p, k) => (k === i ? { ...p, sizeMiB: newLeft } : p))
  }

  // Right takes the equal-and-opposite change, clamped to its own range.
  const newRight = clamp(
    c.rightInitial - (newLeft - c.leftInitial),
    c.rightMin,
    c.rightMax,
  )
  // If the right partition could not absorb the full delta, back off left.
  const absorbed = c.rightInitial - newRight
  const effectiveLeft = c.leftInitial + absorbed

  // Apply both in one pass so the render stays consistent.
  return parts.map((p, k) => {
    if (k === i) return { ...p, sizeMiB: effectiveLeft }
    if (k === i + 1) return { ...p, sizeMiB: newRight }
    return p
  })
}
