import type { Dispatch, SetStateAction } from 'react'
import type { Partition } from '@/types/partition'
import type { RolePreset } from '../model/roles'

/**
 * The fill-remaining checkbox plus the advanced-section disclosure.
 *
 * "Fill remaining" is offered only on the LAST row, because only the final
 * partition can claim the leftover space — see model/geometry's
 * repairFillInvariant.
 */
export function PartitionRowFillToggle({
  partition,
  preset,
  isLast,
  expanded,
  setExpanded,
  onToggleFill,
}: {
  partition: Partition
  preset: RolePreset | null
  isLast: boolean
  expanded: boolean
  // Functional updater: the disclosure button toggles via setExpanded(v => !v).
  setExpanded: Dispatch<SetStateAction<boolean>>
  onToggleFill: (on: boolean) => void
}) {
  return (
    <>
    {/* Fill-remaining toggle — only offered on the last row. */}
    <div className="mt-3 flex flex-wrap items-center gap-4">
      {isLast && preset?.supportsFill && (
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={partition.fillRemaining === true}
            onChange={(e) => onToggleFill(e.target.checked)}
          />
          <span>Fill remaining disk space</span>
        </label>
      )}
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1 text-xs font-semibold hover:underline"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <svg
          viewBox="0 0 20 20"
          width="10"
          height="10"
          aria-hidden
          fill="currentColor"
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 180ms ease',
          }}
        >
          <path d="M6 4l8 6-8 6z" />
        </svg>
        Advanced
      </button>
    </div>

    </>
  )
}
