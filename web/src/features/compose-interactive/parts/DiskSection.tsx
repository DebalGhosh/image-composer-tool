import { Card } from '@/components/layout/Card'
import { Slider } from '@/components/controls/Slider'
import { fieldLabelClass, fieldLabelStyle } from '@/components/controls/Select'
import { SegmentedPartitionEditor, type Arch } from '@/features/partitions'
import type { InteractiveDraft } from '@/store'

/**
 * Disk size + the segmented partition editor.
 *
 * ⚠️ NO @container here. The single marker for this pane lives on the scroll
 * wrapper in InteractivePage; adding one to this Card would make it a stacking
 * context and the partition editor's Combobox dropdowns would paint behind the
 * next Card. See .claude/UI-LAYOUT.md.
 */
export function DiskSection({
  disk,
  arch,
  onPatch,
}: {
  disk: InteractiveDraft['disk']
  arch: Arch
  onPatch: (p: Partial<InteractiveDraft['disk']>) => void
}) {
  return (
            <Card
              title="Disk & partitions"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              <Slider
                label="Total disk size"
                value={disk.sizeGiB}
                onChange={(v) => onPatch({ sizeGiB: v })}
                min={2}
                max={256}
                step={1}
                unit="GiB"
              />
              <div className="mb-4">
                <span className={fieldLabelClass} style={fieldLabelStyle}>
                  Partition table
                </span>
                <div role="radiogroup" className="flex gap-4 text-sm">
                  {(['gpt', 'mbr'] as const).map((t) => (
                    <label
                      key={t}
                      className="inline-flex cursor-pointer items-center gap-2"
                    >
                      <input
                        type="radio"
                        name="partition-table"
                        checked={disk.partitionTableType === t}
                        onChange={() => onPatch({ partitionTableType: t })}
                        className="h-4 w-4 accent-[var(--classic-blue)]"
                      />
                      <span style={{ color: 'var(--font-color)' }}>
                        {t.toUpperCase()}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              {/* `value` needs no cast: the store's draft and the editor now
                  share one Partition type. The `as Partition[]` that used to sit
                  here bridged two structurally different declarations. */}
              <SegmentedPartitionEditor
                value={disk.partitions}
                diskSizeGiB={disk.sizeGiB}
                arch={arch}
                partitionTableType={disk.partitionTableType}
                onChange={(parts) => onPatch({ partitions: parts })}
              />
            </Card>
  )
}
