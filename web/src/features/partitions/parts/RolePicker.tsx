import type { PartitionRole } from '@/types/partition'
import { ROLE_PRESETS, CUSTOM_COLOR } from '../model/roles'
import { RoleChip } from './RoleChip'

export function RolePicker({
  onAdd,
  disabled,
  mbrLimit,
}: {
  onAdd: (r: PartitionRole) => void
  disabled: Set<PartitionRole>
  mbrLimit: boolean
}) {
  const roles: PartitionRole[] = [
    'efi',
    'bios-boot',
    'swap',
    'root',
    'verity',
    'userdata',
    'custom',
  ]
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className="mr-1 text-sm font-semibold"
        style={{ color: 'var(--title-text)' }}
      >
        + Add partition:
      </span>
      {roles.map((r) => {
        const preset = r === 'custom' ? null : ROLE_PRESETS[r]
        const color = preset?.color ?? CUSTOM_COLOR
        const isDisabled = disabled.has(r)
        const label = preset?.label ?? 'Custom'
        const tip =
          mbrLimit && isDisabled
            ? 'MBR only supports 4 primary partitions'
            : isDisabled
              ? `Only one ${r === 'efi' ? 'EFI' : 'BIOS-Boot'} partition allowed`
              : `Add ${label}`
        return (
          <RoleChip
            key={r}
            role={r}
            label={label}
            color={color}
            disabled={isDisabled}
            tooltip={tip}
            onAdd={onAdd}
          />
        )
      })}
    </div>
  )
}

/**
 * A single role-picker chip. Split into its own component so we can own
 * a per-chip hover state (for the styled tooltip) without polluting the
 * RolePicker parent's state.
 *
 * Interaction:
 *   - Hover: chip scales to 1.06 with a fill-tint bump, and a small
 *     tooltip fades in above the chip after 40 ms (short delay avoids
 *     tooltip flicker on quick horizontal mouse-over).
 *   - Focus (keyboard): tooltip fades in too so keyboard users see the
 *     same guidance.
 *   - Disabled: still shows the tooltip (with the "why disabled" text),
 *     but the chip doesn't scale — no false-inviting motion.
 */
