import type { Partition } from '@/types/partition'
import { Collapsible } from '@/components/layout/Collapsible'
import {
  TextInput,
  fieldLabelClass,
  fieldLabelStyle,
} from '@/components/controls/Select'

/**
 * The collapsible advanced block: partition label, type string and GPT type
 * UUID.
 */
export function PartitionRowAdvanced({
  partition,
  expanded,
  onChange,
}: {
  partition: Partition
  expanded: boolean
  onChange: (patch: Partial<Partition>) => void
}) {
  return (
    <Collapsible open={expanded} className="mt-3">
      <div className="@max-pane-2col:grid-cols-1 grid grid-cols-3 gap-3">
        <div>
          <label className={fieldLabelClass} style={fieldLabelStyle}>
            Filesystem label
          </label>
          <TextInput
            value={partition.fsLabel ?? ''}
            onChange={(e) =>
              onChange({ fsLabel: e.target.value || undefined })
            }
            placeholder="(optional)"
          />
        </div>
        <div>
          <label className={fieldLabelClass} style={fieldLabelStyle}>
            Mount options
          </label>
          <TextInput
            value={partition.mountOptions ?? ''}
            onChange={(e) =>
              onChange({ mountOptions: e.target.value || undefined })
            }
            placeholder="defaults,noatime"
          />
        </div>
        <div>
          <label className={fieldLabelClass} style={fieldLabelStyle}>
            Type UUID
            <span className="ml-1 text-[10px] font-normal opacity-60">
              (derived)
            </span>
          </label>
          {/* break-all because a GPT type UUID is 36 unbroken chars and CSS
           * only breaks after its hyphens — in a third-of-a-pane column
           * that's still wider than the box. title so the full value stays
           * readable and selectable when it wraps to three lines. */}
          <div
            className="rounded-md border px-3 py-2.5 font-mono text-[11px] break-all"
            title={partition.typeUUID ?? undefined}
            style={{
              background: 'var(--input-background)',
              borderColor: 'var(--border-color)',
              color: 'var(--muted-color)',
            }}
          >
            {partition.typeUUID ?? '—'}
          </div>
        </div>
      </div>
    </Collapsible>
  )
}
