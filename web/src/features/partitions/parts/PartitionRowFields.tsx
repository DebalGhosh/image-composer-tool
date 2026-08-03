import type { Partition } from '@/types/partition'
import { Combobox } from '@/components/controls/Combobox'
import {
  TextInput,
  fieldLabelClass,
  fieldLabelStyle,
} from '@/components/controls/Select'
import { FS_TYPE_OPTIONS, MOUNT_POINT_PRESETS } from '../model/roles'
import { formatSize } from '../model/size'
import { EditableSize } from './EditableSize'
import { FlagChips } from './FlagChips'

/**
 * The row's main 4-column grid: size slider, filesystem type, mount point and
 * GPT flags.
 *
 * ⚠️ The grid uses `@max-pane-4col:` / `@max-pane-2col:` CONTAINER queries, not
 * viewport breakpoints. See .claude/UI-LAYOUT.md: content lives in
 * percentage-sized resizable panes, so a viewport breakpoint measures the wrong
 * box and is anti-correlated with the width that matters over part of its range.
 * Do not "modernise" these to md:/lg:.
 */
export function PartitionRowFields({
  partition,
  roleMin,
  sliderMax,
  sliderDisabled,
  otherMode,
  setOtherMode,
  onChange,
}: {
  partition: Partition
  roleMin: number
  sliderMax: number
  sliderDisabled: boolean
  otherMode: boolean
  setOtherMode: (on: boolean) => void
  onChange: (patch: Partial<Partition>) => void
}) {
  return (
    <>
    {/* Main grid: size slider | fsType | mountPoint | flags.
     *
     * Widest-first with container queries. The viewport-keyed version this
     * replaces (2 columns at the `md` breakpoint, 4 at `lg`) was the worst
     * offender in the app: those fire on the VIEWPORT, so at 1280px with
     * this pane at its minSize={35} it forced four ~69px columns — each
     * holding a Combobox whose px-3 chrome plus caret is already 48px.
     * Unreadable, not merely truncated. These thresholds measure the
     * partition row itself. */}
    <div className="@max-pane-4col:grid-cols-2 @max-pane-2col:grid-cols-1 grid grid-cols-4 gap-3">
      {/* Size slider */}
      <div>
        <label
          className={fieldLabelClass}
          style={fieldLabelStyle}
          htmlFor={`p-${partition.id}-size`}
        >
          Size
          {sliderDisabled ? (
            <span className="ml-2 font-normal opacity-70">
              (fills remaining)
            </span>
          ) : (
            <EditableSize
              valueMiB={partition.sizeMiB}
              min={roleMin}
              max={sliderMax}
              onChange={(miB) => onChange({ sizeMiB: miB })}
            />
          )}
        </label>
        <input
          id={`p-${partition.id}-size`}
          type="range"
          min={roleMin}
          max={Math.max(roleMin, sliderMax)}
          step={1}
          disabled={sliderDisabled}
          value={Math.min(sliderMax, Math.max(roleMin, partition.sizeMiB))}
          onChange={(e) => onChange({ sizeMiB: Number(e.target.value) })}
          className="w-full accent-[var(--classic-blue)]"
          style={{
            accentColor: 'var(--classic-blue)',
          }}
        />
        <div className="mt-1 flex justify-between text-[11px] opacity-60">
          <span>{formatSize(roleMin)}</span>
          <span>{formatSize(sliderMax)}</span>
        </div>
      </div>

      {/* Filesystem type */}
      <div>
        <label className={fieldLabelClass} style={fieldLabelStyle}>
          Filesystem
        </label>
        <Combobox
          value={partition.fsType}
          items={FS_TYPE_OPTIONS}
          placeholder="—"
          onChange={(v) => onChange({ fsType: v })}
        />
      </div>

      {/* Mount point */}
      <div>
        <label className={fieldLabelClass} style={fieldLabelStyle}>
          Mount point
        </label>
        <Combobox
          value={otherMode ? '__other__' : partition.mountPoint}
          items={MOUNT_POINT_PRESETS}
          placeholder="—"
          onChange={(v) => {
            if (v === '__other__') {
              setOtherMode(true)
              // Keep whatever the user had, or start with a helpful stub.
              if (!partition.mountPoint || partition.mountPoint === 'none') {
                onChange({ mountPoint: '/mnt/custom' })
              }
            } else {
              setOtherMode(false)
              onChange({ mountPoint: v })
            }
          }}
        />
        {otherMode && (
          <TextInput
            className="mt-2 !text-sm"
            value={partition.mountPoint}
            onChange={(e) => onChange({ mountPoint: e.target.value })}
            placeholder="/mnt/custom"
          />
        )}
      </div>

      {/* Flags */}
      <div>
        <label className={fieldLabelClass} style={fieldLabelStyle}>
          Flags
        </label>
        <FlagChips
          value={partition.flags}
          onChange={(next) => onChange({ flags: next })}
        />
      </div>
    </div>

    </>
  )
}
