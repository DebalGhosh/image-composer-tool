import { useEffect, useRef, useState } from 'react'
import type { PartitionRole } from '@/types/partition'

export function RoleChip({
  role,
  label,
  color,
  disabled,
  tooltip,
  onAdd,
}: {
  role: PartitionRole
  label: string
  color: string
  disabled: boolean
  tooltip: string
  onAdd: (r: PartitionRole) => void
}) {
  const [showTip, setShowTip] = useState(false)
  const showTimer = useRef<number | null>(null)
  const openTip = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current)
    showTimer.current = window.setTimeout(() => setShowTip(true), 40)
  }
  const closeTip = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current)
    setShowTip(false)
  }
  useEffect(
    () => () => {
      if (showTimer.current !== null) window.clearTimeout(showTimer.current)
    },
    [],
  )

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAdd(role)}
        onMouseEnter={openTip}
        onMouseLeave={closeTip}
        onFocus={openTip}
        onBlur={closeTip}
        // `title` attribute intentionally omitted — we render our own
        // styled tooltip below. Duplicating both would show two
        // tooltips staggered by the browser's built-in 1s delay.
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--classic-blue)] disabled:cursor-not-allowed disabled:opacity-50"
        style={{
          background: disabled
            ? 'var(--input-background)'
            : showTip
              ? // Hover-brightened tint — deeper toward role's identity color.
                `color-mix(in srgb, ${color} 22%, var(--section-background))`
              : `color-mix(in srgb, ${color} 12%, var(--section-background))`,
          borderColor: `color-mix(in srgb, ${color} 55%, var(--border-color))`,
          color: 'var(--font-color)',
          // Scale up on hover for a bit of grow-lift. Disabled chips opt
          // out entirely — no false motion.
          transform: !disabled && showTip ? 'scale(1.06)' : 'scale(1)',
          transition:
            'transform 160ms cubic-bezier(0.22, 0.7, 0.32, 1), background-color 160ms ease, border-color 160ms ease',
        }}
      >
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: color }}
        />
        {label}
      </button>
      {/* Tooltip: absolute-positioned above the chip, fades + slides in.
       *  `pointer-events: none` so the tooltip never eats a subsequent
       *  click. Contains a tiny caret pointing down at the chip. */}
      <span
        role="tooltip"
        aria-hidden={!showTip}
        className="pointer-events-none absolute left-1/2 bottom-full mb-1.5 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium shadow-md"
        style={{
          background: 'var(--font-color)',
          color: 'var(--section-background)',
          opacity: showTip ? 1 : 0,
          transform: showTip
            ? 'translate(-50%, 0)'
            : 'translate(-50%, 4px)',
          transition:
            'opacity 140ms ease, transform 160ms cubic-bezier(0.22, 0.7, 0.32, 1)',
          zIndex: 20,
        }}
      >
        {tooltip}
        {/* Down-pointing caret. Rotate a square 45° and clip half. */}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -3,
            width: 6,
            height: 6,
            background: 'var(--font-color)',
            transform: 'translateX(-50%) rotate(45deg)',
          }}
        />
      </span>
    </div>
  )
}

