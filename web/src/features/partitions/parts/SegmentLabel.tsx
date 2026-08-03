import { RoleGlyph } from '@/components/icons/RoleGlyph'
import { formatSize } from '../model/size'

export function SegmentLabel({
  name,
  size,
  glyph,
  enoughRoom,
}: {
  name: string
  size: number
  glyph: string
  enoughRoom: boolean
}) {
  if (!enoughRoom) {
    // Segment is too narrow for text — hide the label rather than render an
    // unreadable clipped mess.
    return null
  }
  return (
    <>
      <div className="flex items-center gap-1.5">
        <RoleGlyph name={glyph} />
        <span className="truncate">{name}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] font-normal opacity-90">
        {formatSize(size)}
      </div>
    </>
  )
}

