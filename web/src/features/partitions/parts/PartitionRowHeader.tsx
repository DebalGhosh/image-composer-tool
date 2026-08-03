import type { Partition } from '@/types/partition'
import { IconButton } from '@/components/icons/IconButton'
import type { RolePreset } from '../model/roles'
import { TextInput } from '@/components/controls/Select'

/**
 * The row's header strip: ordinal, role chip, name field, reorder and delete.
 *
 * Split out of PartitionRow, which was 301 lines and complexity 20 — over both
 * the max-lines-per-function (150) and complexity (15) ceilings.
 */
export function PartitionRowHeader({
  index,
  partition,
  preset,
  color,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  index: number
  partition: Partition
  preset: RolePreset | null
  color: string
  onChange: (patch: Partial<Partition>) => void
  onDelete: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  return (
    <>
    {/* Header row: index, role chip, name, reorder, delete */}
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-xs font-semibold"
        style={{
          background: 'color-mix(in srgb, var(--font-color) 10%, transparent)',
          color: 'var(--font-color)',
        }}
      >
        {index + 1}
      </span>
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold"
        style={{
          background: `color-mix(in srgb, ${color} 18%, var(--section-background))`,
          color: 'var(--font-color)',
          border: `1px solid color-mix(in srgb, ${color} 50%, var(--border-color))`,
        }}
      >
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: color }}
        />
        {preset?.label ?? 'Custom'}
      </span>

      <TextInput
        value={partition.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="Name (optional)"
        aria-label={`Partition ${index + 1} name`}
        className="!w-auto flex-1 !py-1.5 !text-sm"
      />

      <div className="ml-auto flex items-center gap-1">
        <IconButton
          label="Move up"
          onClick={onMoveUp}
          disabled={!onMoveUp}
        >
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden fill="currentColor">
            <path d="M10 5l-5 6h10z" />
          </svg>
        </IconButton>
        <IconButton
          label="Move down"
          onClick={onMoveDown}
          disabled={!onMoveDown}
        >
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden fill="currentColor">
            <path d="M10 15l5-6H5z" />
          </svg>
        </IconButton>
        <IconButton
          label={`Delete partition ${index + 1}`}
          onClick={onDelete}
          danger
        >
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden fill="currentColor">
            <path d="M7 3h6l1 2h3v2H3V5h3zM5 8h10l-1 9H6z" />
          </svg>
        </IconButton>
      </div>
    </div>

    </>
  )
}
