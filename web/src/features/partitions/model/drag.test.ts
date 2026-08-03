import { describe, it, expect } from 'vitest'
import {
  dragConstraints,
  deltaMiBOf,
  resolveLeftSize,
  applyDividerDrag,
} from './drag'
import { ROLE_PRESETS } from './roles'
import type { Partition, PartitionRole } from '@/types/partition'

/**
 * Characterisation tests for the divider-drag arithmetic — the subtlest logic in
 * the partition editor, and previously untestable because it lived inside a
 * `pointermove` closure.
 */

function p(id: string, sizeMiB: number, role: PartitionRole = 'custom', fill = false): Partition {
  return {
    id,
    name: id,
    role,
    sizeMiB,
    ...(fill ? { fillRemaining: true } : {}),
    type: 'linux',
    fsType: 'ext4',
    mountPoint: 'none',
    flags: [],
  }
}

const DISK = 8192 // 8 GiB

describe('deltaMiBOf', () => {
  it('converts pixels to MiB using the bar width', () => {
    // 800px bar over an 8192 MiB disk => 10.24 MiB per px.
    expect(deltaMiBOf(100, 800, DISK)).toBe(1024)
    expect(deltaMiBOf(-100, 800, DISK)).toBe(-1024)
    expect(deltaMiBOf(0, 800, DISK)).toBe(0)
  })

  it('rounds to whole MiB', () => {
    // 1px on an 800px/8192MiB bar = 10.24 -> 10
    expect(deltaMiBOf(1, 800, DISK)).toBe(10)
  })
})

describe('dragConstraints', () => {
  it('reads each side’s preset min/max', () => {
    const parts = [p('efi', 100, 'efi'), p('root', 4096, 'root')]
    const c = dragConstraints(parts, 0, DISK)
    expect(c.leftMin).toBe(ROLE_PRESETS.efi.minMiB) // 100
    expect(c.leftMax).toBe(ROLE_PRESETS.efi.maxMiB) // 1024
    expect(c.rightMin).toBe(ROLE_PRESETS.root.minMiB) // 1024
    // root has maxMiB null -> falls back to the whole disk
    expect(c.rightMax).toBe(DISK)
  })

  it('falls back to [1, disk] for a custom partition with no preset', () => {
    const parts = [p('a', 500), p('b', 500)]
    const c = dragConstraints(parts, 0, DISK)
    expect(c.leftMin).toBe(1)
    expect(c.leftMax).toBe(DISK)
  })

  it('totals only the partitions NOT being dragged', () => {
    const parts = [p('a', 100), p('b', 200), p('c', 300), p('d', 400)]
    // dragging the divider between index 1 and 2 -> others = a + d = 500
    expect(dragConstraints(parts, 1, DISK).others).toBe(500)
  })

  it('excludes a fill-remaining row from others', () => {
    const parts = [p('a', 100), p('b', 200), p('c', 300), p('fill', 9999, 'root', true)]
    expect(dragConstraints(parts, 1, DISK).others).toBe(100)
  })

  it('detects that the right neighbour is the fill row', () => {
    const parts = [p('a', 100), p('fill', 1, 'root', true)]
    expect(dragConstraints(parts, 0, DISK).rightIsFill).toBe(true)
    const fixed = [p('a', 100), p('b', 100)]
    expect(dragConstraints(fixed, 0, DISK).rightIsFill).toBe(false)
  })
})

describe('resolveLeftSize', () => {
  it('applies the delta when nothing binds', () => {
    const parts = [p('a', 1000), p('b', 1000)]
    const c = dragConstraints(parts, 0, DISK)
    expect(resolveLeftSize({ parts, index: 0, constraints: c, deltaMiB: 500, diskMiB: DISK, usedMiB: 2000 })).toBe(1500)
    expect(resolveLeftSize({ parts, index: 0, constraints: c, deltaMiB: -500, diskMiB: DISK, usedMiB: 2000 })).toBe(500)
  })

  it('clamps to the left preset’s min and max', () => {
    const parts = [p('efi', 500, 'efi'), p('root', 2000, 'root')]
    const c = dragConstraints(parts, 0, DISK)
    // efi is [100, 1024]
    expect(resolveLeftSize({ parts, index: 0, constraints: c, deltaMiB: -9999, diskMiB: DISK, usedMiB: 2500 })).toBe(100)
    expect(resolveLeftSize({ parts, index: 0, constraints: c, deltaMiB: 9999, diskMiB: DISK, usedMiB: 2500 })).toBe(1024)
  })

  it('leaves room for the right partition’s minimum', () => {
    // left custom [1, disk], right root min 1024. usedMiB = 8192 (disk full).
    const parts = [p('a', 4096), p('root', 4096, 'root')]
    const c = dragConstraints(parts, 0, DISK)
    // maxLeftForDisk = 8192 - (8192-4096-4096) - 1024 = 7168
    expect(resolveLeftSize({ parts, index: 0, constraints: c, deltaMiB: 9999, diskMiB: DISK, usedMiB: 8192 })).toBe(7168)
  })

  it('leaves room for the FILL row’s minimum when the right side fills', () => {
    // others = 0, right is root (min 1024) filling.
    const parts = [p('a', 1000), p('fill', 1, 'root', true)]
    const c = dragConstraints(parts, 0, DISK)
    // maxLeftForDisk = max(leftMin, 8192 - 0 - 1024) = 7168
    expect(resolveLeftSize({ parts, index: 0, constraints: c, deltaMiB: 99999, diskMiB: DISK, usedMiB: 1000 })).toBe(7168)
  })

  it('accounts for other partitions when the right side fills', () => {
    // a=1000 (dragged), other=2000, fill root min 1024
    const parts = [p('a', 1000), p('fill', 1, 'root', true), p('other', 2000)]
    const c = dragConstraints(parts, 0, DISK)
    expect(c.others).toBe(2000)
    // 8192 - 2000 - 1024 = 5168
    expect(resolveLeftSize({ parts, index: 0, constraints: c, deltaMiB: 99999, diskMiB: DISK, usedMiB: 3000 })).toBe(5168)
  })

  it('never returns below the left minimum even when the disk cap is smaller', () => {
    // Over-allocated disk: the cap arithmetic can go below leftMin, and the
    // Math.max(leftMin, ...) guard is what stops the partition collapsing.
    const parts = [p('efi', 100, 'efi'), p('root', 9000, 'root')]
    const c = dragConstraints(parts, 0, DISK)
    expect(resolveLeftSize({ parts, index: 0, constraints: c, deltaMiB: 0, diskMiB: DISK, usedMiB: 9100 })).toBeGreaterThanOrEqual(c.leftMin)
  })
})

describe('applyDividerDrag — conservation', () => {
  it('moves size from right to left, keeping the pair total constant', () => {
    const parts = [p('a', 2000), p('b', 2000)]
    const c = dragConstraints(parts, 0, DISK)
    const out = applyDividerDrag({ parts, index: 0, constraints: c, deltaMiB: 500, diskMiB: DISK, usedMiB: 4000 })
    expect(out[0].sizeMiB).toBe(2500)
    expect(out[1].sizeMiB).toBe(1500)
    expect(out[0].sizeMiB + out[1].sizeMiB).toBe(4000)
  })

  it('moves size from left to right', () => {
    const parts = [p('a', 2000), p('b', 2000)]
    const c = dragConstraints(parts, 0, DISK)
    const out = applyDividerDrag({ parts, index: 0, constraints: c, deltaMiB: -500, diskMiB: DISK, usedMiB: 4000 })
    expect(out[0].sizeMiB).toBe(1500)
    expect(out[1].sizeMiB).toBe(2500)
  })

  it('BACKS OFF the left partition when the right cannot absorb the delta', () => {
    // right is root, min 1024. Pushing left by 1500 would take root to 500.
    // root clamps at 1024, absorbing only 976 — so left gains only 976.
    const parts = [p('a', 2000), p('root', 2000, 'root')]
    const c = dragConstraints(parts, 0, DISK)
    const out = applyDividerDrag({ parts, index: 0, constraints: c, deltaMiB: 1500, diskMiB: DISK, usedMiB: 4000 })
    expect(out[1].sizeMiB).toBe(1024)
    expect(out[0].sizeMiB).toBe(2976) // 2000 + (2000-1024)
    // Conservation still holds — this is the point of the back-off.
    expect(out[0].sizeMiB + out[1].sizeMiB).toBe(4000)
  })

  it('backs off symmetrically when the right hits its MAX', () => {
    // right is efi, max 1024. Shrinking left by 500 would grow efi to 1400,
    // which clamps to 1024 — so efi absorbs only 124 of the 500.
    //   absorbed = rightInitial - newRight = 900 - 1024 = -124   (NEGATIVE:
    //   the right side GREW, so `absorbed` is signed, not a magnitude)
    //   effectiveLeft = leftInitial + absorbed = 2000 - 124 = 1876
    const parts = [p('a', 2000), p('efi', 900, 'efi')]
    const c = dragConstraints(parts, 0, DISK)
    const out = applyDividerDrag({ parts, index: 0, constraints: c, deltaMiB: -500, diskMiB: DISK, usedMiB: 2900 })
    expect(out[1].sizeMiB).toBe(1024) // clamped at efi max
    expect(out[0].sizeMiB).toBe(1876)
    // Conservation: the pair total is unchanged at 2900, so the left partition
    // gave up exactly what the right one took.
    expect(out[0].sizeMiB + out[1].sizeMiB).toBe(2900)
  })

  it('leaves untouched partitions byte-identical', () => {
    const parts = [p('a', 1000), p('b', 1000), p('c', 1000)]
    const c = dragConstraints(parts, 0, DISK)
    const out = applyDividerDrag({ parts, index: 0, constraints: c, deltaMiB: 100, diskMiB: DISK, usedMiB: 3000 })
    expect(out[2]).toBe(parts[2]) // same reference, not a copy
  })

  it('does not mutate the input', () => {
    const parts = [p('a', 1000), p('b', 1000)]
    const snap = JSON.parse(JSON.stringify(parts))
    applyDividerDrag({ parts, index: 0, constraints: dragConstraints(parts, 0, DISK), deltaMiB: 300, diskMiB: DISK, usedMiB: 2000 })
    expect(parts).toEqual(snap)
  })
})

describe('applyDividerDrag — fill-remaining right neighbour', () => {
  it('changes ONLY the left partition, letting the fill row re-derive', () => {
    const parts = [p('a', 1000), p('fill', 1, 'root', true)]
    const c = dragConstraints(parts, 0, DISK)
    const out = applyDividerDrag({ parts, index: 0, constraints: c, deltaMiB: 500, diskMiB: DISK, usedMiB: 1000 })
    expect(out[0].sizeMiB).toBe(1500)
    // The fill row's stored size is untouched — its width is computed.
    expect(out[1].sizeMiB).toBe(1)
    expect(out[1].fillRemaining).toBe(true)
  })

  it('returns a FRESH array every tick even when the value is unchanged', () => {
    // Load-bearing: the original fired onChange unconditionally on every
    // pointermove, and the consumer's handler is a store write. Suppressing
    // identical-value calls would change how often the draft updates.
    const parts = [p('a', 1000), p('fill', 1, 'root', true)]
    const c = dragConstraints(parts, 0, DISK)
    const out = applyDividerDrag({ parts, index: 0, constraints: c, deltaMiB: 0, diskMiB: DISK, usedMiB: 1000 })
    expect(out).not.toBe(parts)
    expect(out[0].sizeMiB).toBe(1000)
  })
})
