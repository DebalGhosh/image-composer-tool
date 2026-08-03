import { useState, type CSSProperties } from 'react'
import type { Partition } from '@/types/partition'
import { CUSTOM_COLOR, MOUNT_POINT_PRESETS, presetFor } from '../model/roles'
import { PartitionRowHeader } from './PartitionRowHeader'
import { PartitionRowFields } from './PartitionRowFields'
import { PartitionRowFillToggle } from './PartitionRowFillToggle'
import { PartitionRowAdvanced } from './PartitionRowAdvanced'

/**
 * One partition row. A thin composition of four sub-parts — the row was 301
 * lines with complexity 20, over both the max-lines-per-function (150) and
 * complexity (15) ceilings.
 *
 * The derived slider bounds and mount-point mode stay HERE rather than moving
 * into a sub-part: several sections read them, and threading them through would
 * have re-derived the same arithmetic in two places.
 */

interface PartitionRowProps {
  index: number
  partition: Partition
  isLast: boolean
  diskMiB: number
  usedByOthersMiB: number
  onChange: (patch: Partial<Partition>) => void
  onDelete: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  onToggleFill: (on: boolean) => void
}

export function PartitionRow({
  index,
  partition,
  isLast,
  diskMiB,
  usedByOthersMiB,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  onToggleFill,
}: PartitionRowProps) {
  const [expanded, setExpanded] = useState(false)
  const preset = presetFor(partition.role)
  const color = preset?.color ?? CUSTOM_COLOR

  // For the slider, upper bound is min(role.max, diskMiB - usedByOthersMiB).
  const roleMin = preset?.minMiB ?? 1
  const roleMax = preset?.maxMiB ?? diskMiB
  const roomLeft = Math.max(roleMin, diskMiB - usedByOthersMiB)
  const sliderMax = Math.min(roleMax, roomLeft)
  const sliderDisabled = partition.fillRemaining === true

  // Mount point: if the current value isn't one of our presets, we're in
  // "Other…" mode with a free-form text input beside the picker.
  const isPresetMount = MOUNT_POINT_PRESETS.some(
    (o) => o.value === partition.mountPoint && o.value !== '__other__',
  )
  const [otherMode, setOtherMode] = useState<boolean>(!isPresetMount)

  const rowStyle: CSSProperties = {
    background: 'var(--section-background)',
    borderColor: 'var(--border-color)',
    color: 'var(--font-color)',
  }

  return (
    <div className="rounded-lg border p-4" style={rowStyle}>
      <PartitionRowHeader
        index={index}
        partition={partition}
        preset={preset}
        color={color}
        onChange={onChange}
        onDelete={onDelete}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
      />
      <PartitionRowFields
        partition={partition}
        roleMin={roleMin}
        sliderMax={sliderMax}
        sliderDisabled={sliderDisabled}
        otherMode={otherMode}
        setOtherMode={setOtherMode}
        onChange={onChange}
      />
      <PartitionRowFillToggle
        partition={partition}
        preset={preset}
        isLast={isLast}
        expanded={expanded}
        setExpanded={setExpanded}
        onToggleFill={onToggleFill}
      />
      <PartitionRowAdvanced
        partition={partition}
        expanded={expanded}
        onChange={onChange}
      />
    </div>
  )
}
