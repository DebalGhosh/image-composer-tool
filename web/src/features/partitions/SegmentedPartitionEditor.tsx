import { useEffect, useMemo, useRef } from 'react'
import type { Partition, PartitionRole } from '@/types/partition'
import { rootTypeFor, type Arch } from './model/roles'
import {
  diskMiBOf,
  allocationOf,
  fillRemainingMiBOf,
  renderMiBOf as renderMiBFor,
  disabledRolesOf,
  appendPartition,
  buildPartitionForRole,
  swapPartitions,
} from './model/geometry'
import { usePartitionDrag } from './hooks/usePartitionDrag'
import { useFlipReorder } from './hooks/useFlipReorder'
import { RolePicker } from './parts/RolePicker'
import { DiskBar } from './parts/DiskBar'
import { PartitionRowList } from './parts/PartitionRowList'
import { SegmentedPartitionStyles } from './parts/SegmentedPartitionStyles'

/* ------------------------------------------------------------------------- *
 * Re-exports
 *
 * `Arch` and the role presets now live in ./model/roles; `Partition` and
 * `PartitionRole` in @/types/partition. Re-exported here so every existing
 * importer of this module is unaffected by the split.
 * ------------------------------------------------------------------------- */

export type { Arch, RolePreset } from './model/roles'
export type { Partition, PartitionRole } from '@/types/partition'

export interface SegmentedPartitionEditorProps {
  value: Partition[]
  diskSizeGiB: number
  arch: Arch
  partitionTableType: 'gpt' | 'mbr'
  onChange: (parts: Partition[]) => void
}

export function SegmentedPartitionEditor({
  value,
  diskSizeGiB,
  arch,
  partitionTableType,
  onChange,
}: SegmentedPartitionEditorProps) {
  const diskMiB = diskMiBOf(diskSizeGiB)

  /* ---------- Sum-of-sizes & over-allocation banner ---------- */
  const { usedMiB, overMiB, hasFill } = useMemo(
    () => allocationOf(value, diskMiB),
    [value, diskMiB],
  )

  /* ---------- Fill-remaining bookkeeping ----------
   * The last partition may set fillRemaining=true; its rendered size on the
   * bar equals diskMiB - sum(others). If diskMiB < sum(others), rendered
   * width clamps to 0 and the over-allocation banner takes over.
   */
  const fillRemainingMiB = fillRemainingMiBOf(diskMiB, usedMiB)

  /** Compute the size a partition should render on the bar. */
  const renderMiBOf = (p: Partition) => renderMiBFor(p, fillRemainingMiB)

  /* ---------- Add / delete / mutate helpers ---------- */

  const disabledRoles = useMemo(
    () => disabledRolesOf(value, partitionTableType),
    [value, partitionTableType],
  )

  const addPartition = (role: PartitionRole) => {
    // The row itself is built in model/geometry (pure in role + parts + arch);
    // appendPartition then preserves the fill-remaining invariant.
    onChange(appendPartition(value, buildPartitionForRole(role, value, arch)))
  }

  const removeAt = (idx: number) => {
    const next = value.filter((_, i) => i !== idx)
    onChange(next)
  }

  const updateAt = (idx: number, patch: Partial<Partition>) => {
    const next = value.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    onChange(next)
  }

  const swap = (a: number, b: number) => {
    // swapPartitions returns the SAME reference for an out-of-range index, which
    // is how we detect and skip the no-op without re-deriving the bounds check.
    const next = swapPartitions(value, a, b)
    if (next === value) return
    onChange(next)
  }

  /** Toggle fillRemaining on a partition (only allowed on the last row). */
  const setFillRemaining = (idx: number, on: boolean) => {
    if (idx !== value.length - 1) return
    updateAt(idx, { fillRemaining: on })
  }

  /* ---------- Divider drag ---------- */
  // Pointer plumbing + arithmetic live in hooks/usePartitionDrag and
  // model/drag. Constraints are snapshotted on pointerdown; see that module.
  const { barRef, beginDividerDrag } = usePartitionDrag({
    parts: value,
    diskMiB,
    usedMiB,
    onChange,
  })

  /* ---------- Arch drift: keep root type/typeUUID in sync ---------- */
  const lastArch = useRef(arch)
  useEffect(() => {
    if (lastArch.current === arch) return
    lastArch.current = arch
    let dirty = false
    const next = value.map((p) => {
      if (p.role !== 'root') return p
      const ov = rootTypeFor(arch)
      if (p.type === ov.type && p.typeUUID === ov.typeUUID) return p
      dirty = true
      return { ...p, type: ov.type, typeUUID: ov.typeUUID }
    })
    if (dirty) onChange(next)
  }, [arch, value, onChange])

  /* ---------- FLIP animation on reorder ---------- */
  // See hooks/useFlipReorder: the capture happens in the click handler, never in
  // an effect, so only a real reorder animates.
  const currentIds = value.map((p) => p.id)
  const { rowRefs, captureThenReorder } = useFlipReorder(currentIds)

  /** Reorder with a FLIP slide. */
  const swapWithFlip = (a: number, b: number) => captureThenReorder(() => swap(a, b))

  /* ---------- Rendering ---------- */

  return (
    <div className="flex flex-col gap-4">
      <RolePicker
        onAdd={addPartition}
        disabled={disabledRoles}
        mbrLimit={partitionTableType === 'mbr' && value.length >= 4}
      />

      {overMiB > 0 && (
        <div
          role="alert"
          className="rounded-md border px-3 py-2 text-sm font-medium"
          style={{
            background:
              'color-mix(in srgb, var(--danger) 12%, var(--section-background))',
            borderColor:
              'color-mix(in srgb, var(--danger) 50%, transparent)',
            color: 'var(--danger-fg, var(--danger))',
          }}
        >
          Over-allocated by {overMiB.toLocaleString()} MiB — shrink a partition
          or grow the disk.
        </div>
      )}

      <DiskBar
        ref={barRef}
        parts={value}
        diskMiB={diskMiB}
        renderMiBOf={renderMiBOf}
        onDividerDown={beginDividerDrag}
        hasFill={hasFill}
      />

      <PartitionRowList
        parts={value}
        diskMiB={diskMiB}
        usedMiB={usedMiB}
        rowRefs={rowRefs}
        onUpdate={updateAt}
        onRemove={removeAt}
        onMove={swapWithFlip}
        onToggleFill={setFillRemaining}
      />

      <SegmentedPartitionStyles />
    </div>
  )
}

/* ------------------------------------------------------------------------- *
 * Sub-components
 * ------------------------------------------------------------------------- */

