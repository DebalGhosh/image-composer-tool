import { useEffect, useRef, useState } from 'react'
import { formatSize, parseSize } from '../model/size'

export function EditableSize({
  valueMiB,
  min,
  max,
  onChange,
}: {
  valueMiB: number
  min: number
  max: number
  onChange: (miB: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const displayed = formatSize(valueMiB)
  // Keep the draft in lockstep with the value while NOT editing so slider
  // drags always reflect in the field. Once the user focuses, the draft
  // stops tracking so their in-flight edits aren't clobbered by parent
  // re-renders from adjacent slider movement.
  useEffect(() => {
    if (!editing) setDraft(displayed)
  }, [displayed, editing])

  // Debounced push while typing. 400 ms after the last keystroke, if the
  // draft parses cleanly, push a clamped MiB value upstream so the
  // partition bar / YAML preview / other cards update without waiting on
  // Enter / blur. On blur / Enter we do a final canonical commit that
  // rewrites the displayed draft ("4096" → "4 GiB").
  const debounceRef = useRef<number | null>(null)
  const cancelDebounce = () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }
  useEffect(() => cancelDebounce, [])

  const scheduleDebouncedPush = (nextDraft: string) => {
    cancelDebounce()
    debounceRef.current = window.setTimeout(() => {
      const parsed = parseSize(nextDraft)
      if (parsed === null) return
      const clamped = Math.min(max, Math.max(min, parsed))
      if (clamped !== valueMiB) onChange(clamped)
    }, 400)
  }

  const commit = () => {
    cancelDebounce()
    const parsed = parseSize(draft)
    if (parsed !== null) {
      const clamped = Math.min(max, Math.max(min, parsed))
      if (clamped !== valueMiB) onChange(clamped)
      setDraft(formatSize(clamped))
    } else {
      // Roll back an unparseable / empty entry to the last good value.
      setDraft(formatSize(valueMiB))
    }
    setEditing(false)
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="text"
      value={editing ? draft : displayed}
      // Size scales to content so the field visually replaces the span
      // exactly, no wider or narrower.
      size={Math.max(1, (editing ? draft : displayed).length)}
      aria-label={`Size (editable) — currently ${displayed}`}
      // Bare-cursor styling: no border, no bg, no ring. The label's own
      // opacity-70 keeps the color muted-matching-the-original.
      className="ml-2 cursor-text border-0 bg-transparent p-0 text-inherit font-normal opacity-70 outline-none focus:opacity-100"
      onFocus={(e) => {
        setDraft(displayed)
        setEditing(true)
        // Select all so first keystroke replaces the value (matches the
        // slider's numeric-readout affordance in Slider.tsx).
        e.currentTarget.select()
      }}
      onChange={(e) => {
        setDraft(e.target.value)
        scheduleDebouncedPush(e.target.value)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
          inputRef.current?.blur()
        } else if (e.key === 'Escape') {
          cancelDebounce()
          setDraft(displayed)
          setEditing(false)
          inputRef.current?.blur()
        }
      }}
    />
  )
}

/** Compact human-readable size — MiB, GiB, TiB — for labels on the bar and
 *  slider bounds. Uses 1024-based units to match how ICT reports sizes. */
