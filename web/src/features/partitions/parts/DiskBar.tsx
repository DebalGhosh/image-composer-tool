import { useMemo } from 'react'
import type { Partition } from '@/types/partition'
import { CUSTOM_COLOR, presetFor } from '../model/roles'
import { formatSize } from '../model/size'
import { SegmentLabel } from './SegmentLabel'

interface DiskBarProps {
  parts: Partition[]
  diskMiB: number
  renderMiBOf: (p: Partition) => number
  onDividerDown: (i: number, ev: React.PointerEvent<HTMLDivElement>) => void
  hasFill: boolean
}

export const DiskBar = ({
  parts,
  diskMiB,
  renderMiBOf,
  onDividerDown,
  hasFill,
  ref,
}: DiskBarProps & { ref: React.RefObject<HTMLDivElement | null> }) => {
  // Cumulative positions in %, used both for the segment left/width and to
  // place each divider handle at the boundary.
  const positions = useMemo(() => {
    const pcts: number[] = []
    let cursor = 0
    for (const p of parts) {
      const miB = renderMiBOf(p)
      pcts.push(cursor)
      cursor += Math.max(0, miB)
    }
    pcts.push(cursor)
    return pcts.map((c) => (c / diskMiB) * 100)
  }, [parts, diskMiB, renderMiBOf])

  if (parts.length === 0) {
    return (
      <div
        className="relative w-full rounded-md border text-xs"
        style={{
          height: 72,
          borderColor: 'var(--border-color)',
          background: 'var(--input-background)',
          color: 'var(--muted-color)',
        }}
      >
        <div className="absolute inset-0 flex items-center justify-center">
          Empty disk — add a partition above.
        </div>
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className="relative w-full overflow-hidden rounded-md border"
      style={{
        height: 72,
        borderColor: 'var(--border-color)',
        background: 'var(--input-background)',
      }}
      aria-label={`Disk map, ${parts.length} partitions${hasFill ? ' (last fills remaining)' : ''}`}
    >
      {parts.map((p, i) => {
        const leftPct = positions[i]
        const widthPct = Math.max(0, positions[i + 1] - positions[i])
        const preset = presetFor(p.role)
        const color = preset?.color ?? CUSTOM_COLOR
        return (
          <div
            key={p.id + ':' + i}
            className={
              'absolute inset-y-0 flex flex-col justify-center overflow-hidden px-2 text-xs font-semibold text-white ' +
              (p.fillRemaining ? 'segpart-stripe ' : '')
            }
            style={{
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              background: color,
              borderRight:
                i < parts.length - 1
                  ? '1px solid rgba(0,0,0,0.35)'
                  : undefined,
            }}
            title={`${p.name || p.id} — ${formatSize(renderMiBOf(p))}${p.fillRemaining ? ' (fills remaining)' : ''}`}
          >
            <SegmentLabel
              name={p.name || p.id}
              size={renderMiBOf(p)}
              glyph={preset?.glyph ?? 'custom'}
              enoughRoom={widthPct >= 10}
            />
          </div>
        )
      })}
      {/* Dividers */}
      {parts.slice(0, -1).map((_p, i) => (
        <div
          key={'div-' + i}
          className="segpart-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize between partition ${i + 1} and ${i + 2}`}
          style={{ left: `${positions[i + 1]}%` }}
          onPointerDown={(ev) => onDividerDown(i, ev)}
        />
      ))}
    </div>
  )
}

