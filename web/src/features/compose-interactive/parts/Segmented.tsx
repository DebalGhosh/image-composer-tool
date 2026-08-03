import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fieldLabelClass, fieldLabelStyle } from '@/components/controls/Select'

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<T>) {
  // Sliding-pill indicator. Rather than paint each button's background on
  // its own and transition color, we render a single absolutely-positioned
  // <span> and animate its transform + width from the previous option's
  // box to the newly-selected option's box on every value change.
  //
  // On first paint the indicator should JUMP to its initial position (no
  // 0→X slide from the origin) — `enteredRef` gates the transition on
  // subsequent updates only.
  const groupRef = useRef<HTMLDivElement | null>(null)
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicator, setIndicator] = useState<{
    x: number
    w: number
    ready: boolean
  }>({ x: 0, w: 0, ready: false })
  const enteredRef = useRef(false)

  useLayoutEffect(() => {
    const group = groupRef.current
    const btn = buttonRefs.current[value]
    if (!group || !btn) return
    const groupRect = group.getBoundingClientRect()
    const btnRect = btn.getBoundingClientRect()
    setIndicator({
      x: btnRect.left - groupRect.left,
      w: btnRect.width,
      ready: true,
    })
    // Delay flipping to "animated" state by one frame so the initial jump
    // to position paints instantly. Subsequent value changes see
    // enteredRef === true and animate.
    if (!enteredRef.current) {
      requestAnimationFrame(() => {
        enteredRef.current = true
      })
    }
  }, [value, options])

  // Recompute on resize — the pill needs to stay aligned to the button
  // even as flex-wrap reflows or the panel width changes.
  useEffect(() => {
    if (!groupRef.current) return
    const ro = new ResizeObserver(() => {
      const group = groupRef.current
      const btn = buttonRefs.current[value]
      if (!group || !btn) return
      const groupRect = group.getBoundingClientRect()
      const btnRect = btn.getBoundingClientRect()
      setIndicator((prev) => ({
        ...prev,
        x: btnRect.left - groupRect.left,
        w: btnRect.width,
      }))
    })
    ro.observe(groupRef.current)
    return () => ro.disconnect()
  }, [value])

  return (
    <div className="mb-4">
      <span className={fieldLabelClass} style={fieldLabelStyle}>
        {label}
      </span>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={label}
        className="relative inline-flex flex-wrap gap-1 rounded-md border p-1"
        style={{
          borderColor: 'var(--border-color)',
          background: 'var(--input-background)',
        }}
      >
        {/* Sliding indicator. z-0 so it sits behind the button labels;
         *  the buttons have transparent backgrounds and their text sits on
         *  top via z-10. `visibility: hidden` until the first measurement
         *  lands avoids a one-frame flash of the pill in the top-left. */}
        <span
          aria-hidden
          className="absolute top-1 bottom-1 rounded pointer-events-none"
          style={{
            left: 0,
            width: indicator.w,
            transform: `translateX(${indicator.x}px)`,
            background: 'var(--classic-blue)',
            transition: enteredRef.current
              ? 'transform 220ms cubic-bezier(0.22, 0.7, 0.32, 1), width 220ms cubic-bezier(0.22, 0.7, 0.32, 1)'
              : 'none',
            visibility: indicator.ready ? 'visible' : 'hidden',
            zIndex: 0,
          }}
        />
        {options.map((o) => {
          const on = value === o.value
          return (
            <button
              key={o.value}
              ref={(el) => {
                buttonRefs.current[o.value] = el
              }}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.value)}
              // focus-visible (not focus) so the ring only shows on keyboard
              // navigation. On mouse click the sliding pill IS the affordance
              // — a competing focus-ring flashed on top of it as a "black-
              // bordered box" during the 220ms slide.
              className="relative z-10 cursor-pointer rounded px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--classic-blue)]"
              style={{
                background: 'transparent',
                // Only the label colour transitions per-button — the pill
                // itself slides beneath as one element.
                color: on ? 'white' : 'var(--font-color)',
                transition: 'color 220ms ease',
              }}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------- *
 * UserBlock — optional user account, toggled off by default.
 * ------------------------------------------------------------------------- */

