import type { Partition } from '@/types/partition'
import { PartitionRow } from './PartitionRow'

/**
 * The vertical list of partition rows, and the ref-wrapping divs the FLIP
 * animation measures.
 *
 * Extracted from SegmentedPartitionEditor to bring its function body under the
 * 150-line limit. The wrapper div stays HERE rather than inside PartitionRow
 * because useFlipReorder measures it: the ref must be on a node whose position
 * changes on reorder, and PartitionRow's own root carries padding and a border
 * that would make the measured top differ from the row's layout box.
 */
export function PartitionRowList({
  parts,
  diskMiB,
  usedMiB,
  rowRefs,
  onUpdate,
  onRemove,
  onMove,
  onToggleFill,
}: {
  parts: Partition[]
  diskMiB: number
  usedMiB: number
  rowRefs: React.RefObject<Record<string, HTMLDivElement | null>>
  onUpdate: (idx: number, patch: Partial<Partition>) => void
  onRemove: (idx: number) => void
  onMove: (a: number, b: number) => void
  onToggleFill: (idx: number, on: boolean) => void
}) {
  return (
  <div className="flex flex-col gap-3">
    {parts.map((p, idx) => (
      // Key by partition id ONLY (not id+idx) so React reconciles by
      // identity across reorders — rows keep their DOM nodes across a
      // swap, which is what makes the FLIP animation below possible.
      // The ref-wrapping div lets us measure each row's position
      // before and after `value` changes and animate the delta.
      <div
        key={p.id}
        ref={(el) => {
          rowRefs.current[p.id] = el
        }}
        style={{
          // Solid background so mid-animation rows never render as
          // see-through over their sibling. Deliberately no
          // `willChange: transform` here — promoting every row to
          // its own compositor layer introduced subpixel drift that
          // tripped the FLIP delta threshold on rows that weren't
          // supposed to move.
          background: 'var(--section-background)',
          borderRadius: 8,
        }}
      >
        <PartitionRow
          index={idx}
          partition={p}
          isLast={idx === parts.length - 1}
          diskMiB={diskMiB}
          usedByOthersMiB={usedMiB - (p.fillRemaining ? 0 : p.sizeMiB)}
          onChange={(patch) => onUpdate(idx, patch)}
          onDelete={() => onRemove(idx)}
          onMoveUp={idx > 0 ? () => onMove(idx, idx - 1) : undefined}
          onMoveDown={
            idx < parts.length - 1 ? () => onMove(idx, idx + 1) : undefined
          }
          onToggleFill={(on) => onToggleFill(idx, on)}
        />
      </div>
    ))}
  </div>
  )
}
