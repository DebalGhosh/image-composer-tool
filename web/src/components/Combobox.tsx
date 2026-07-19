import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

/**
 * ComboboxItem — one option in a Combobox.
 *
 * `value` is the underlying selection payload (matches `onChange`).
 * `label` is the visible text.
 * `disabled` skips over the item during keyboard nav and greys it out.
 */
export interface ComboboxItem {
  value: string
  label: ReactNode
  disabled?: boolean
}

interface ComboboxProps {
  /** Currently-selected value (empty string means unset). */
  value: string
  /** Full option list including a leading placeholder if desired. */
  items: ComboboxItem[]
  /** Placeholder text rendered on the button when value is empty. */
  placeholder: string
  /** Fired when the user picks a different value. */
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  /** DOM id for aria-labelledby association. */
  id?: string
  /** Optional aria-label if there is no visible label element to reference. */
  ariaLabel?: string
  /** Optional aria-labelledby id (a visible <label>/<span> pointing at the button). */
  ariaLabelledBy?: string
}

/**
 * Accessible listbox combobox — replaces the native <select> so we can style
 * the menu, transition the caret, and animate options. Not a headless-UI port;
 * everything is inline, ~4 event handlers, ~120 lines of markup + logic.
 *
 * Keyboard model (matches WAI-ARIA 1.2 combobox-with-listbox pattern):
 *   Enter / Space         → open menu, or select highlighted item and close
 *   ArrowDown / ArrowUp   → move highlight (opens the menu if closed)
 *   Home / End            → jump to first / last option
 *   Escape                → close without selecting
 *   Tab                   → close without selecting, native focus advance
 *   A–Z, 0–9              → typeahead: jump to first item whose label starts
 *                            with the pressed key(s) within 500 ms
 *
 * The menu is portal-free (renders in-flow just below the button). Absolute
 * positioning is enough for our layouts; if we ever get clipped by an
 * `overflow: hidden` container we'll upgrade to a portal.
 */
export function Combobox({
  value,
  items,
  placeholder,
  onChange,
  disabled,
  className,
  id,
  ariaLabel,
  ariaLabelledBy,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState<number>(() => {
    const i = items.findIndex((x) => x.value === value)
    return i >= 0 ? i : 0
  })
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const buttonId = useId()
  const listId = useId()
  const typeaheadRef = useRef<{ buffer: string; lastAt: number }>({ buffer: '', lastAt: 0 })

  // Keep activeIdx synced with the selected value when the menu is closed —
  // opening should always start highlighted on the current selection.
  useEffect(() => {
    if (!open) {
      const i = items.findIndex((x) => x.value === value)
      if (i >= 0) setActiveIdx(i)
    }
  }, [items, value, open])

  // Close on outside-click. Attached only while open to avoid a per-click
  // handler on the whole document during idle.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Scroll the highlighted option into view while navigating with the
  // keyboard. useLayoutEffect so the scroll happens before the browser paints
  // the highlighted row.
  useLayoutEffect(() => {
    if (!open) return
    const el = listRef.current?.children.item(activeIdx) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  const selected = useMemo(() => items.find((x) => x.value === value) ?? null, [items, value])

  /* Next / previous enabled index — skips disabled options both directions. */
  const nextEnabled = useCallback(
    (from: number, dir: 1 | -1): number => {
      const n = items.length
      if (n === 0) return -1
      let i = from
      for (let step = 0; step < n; step++) {
        i = (i + dir + n) % n
        if (!items[i].disabled) return i
      }
      return from
    },
    [items],
  )

  const pick = (idx: number) => {
    const item = items[idx]
    if (!item || item.disabled) return
    onChange(item.value)
    setOpen(false)
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (open) pick(activeIdx)
        else setOpen(true)
        break
      case 'ArrowDown':
        e.preventDefault()
        if (!open) setOpen(true)
        else setActiveIdx((i) => nextEnabled(i, 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        if (!open) setOpen(true)
        else setActiveIdx((i) => nextEnabled(i, -1))
        break
      case 'Home':
        if (open) {
          e.preventDefault()
          setActiveIdx(nextEnabled(-1, 1))
        }
        break
      case 'End':
        if (open) {
          e.preventDefault()
          setActiveIdx(nextEnabled(items.length, -1))
        }
        break
      case 'Escape':
        if (open) {
          e.preventDefault()
          setOpen(false)
        }
        break
      case 'Tab':
        if (open) setOpen(false)
        break
      default: {
        // Type-ahead: single-char keys (letters + digits) jump to the first
        // matching label. Multi-char sequences within 500ms combine.
        if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return
        const now = performance.now()
        const buf =
          now - typeaheadRef.current.lastAt < 500
            ? typeaheadRef.current.buffer + e.key.toLowerCase()
            : e.key.toLowerCase()
        typeaheadRef.current = { buffer: buf, lastAt: now }
        const match = items.findIndex(
          (x) => !x.disabled && labelStartsWith(x.label, buf),
        )
        if (match >= 0) {
          e.preventDefault()
          if (open) setActiveIdx(match)
          else onChange(items[match].value)
        }
      }
    }
  }

  const btnStyle: CSSProperties = {
    background: 'var(--input-background)',
    borderColor: 'var(--border-color)',
    color: 'var(--font-color)',
  }

  return (
    <div ref={rootRef} className={'relative ' + (className ?? '')}>
      <button
        id={id ?? buttonId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKey}
        data-open={open || undefined}
        className={
          'group flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2.5 text-left text-sm leading-6 transition-colors ' +
          'focus:outline-none focus:ring-2 focus:ring-[var(--classic-blue)] dark:focus:ring-[var(--tine-1)] ' +
          'disabled:cursor-not-allowed disabled:opacity-60'
        }
        style={btnStyle}
      >
        <span
          className={'truncate ' + (selected ? '' : 'opacity-60')}
          style={{ color: 'var(--font-color)' }}
        >
          {selected ? selected.label : placeholder}
        </span>
        <Caret open={open} />
      </button>

      {/* Menu — always mounted (so the transition plays both directions),
          collapsed when closed via scaleY + opacity. */}
      <ul
        id={listId}
        role="listbox"
        aria-activedescendant={
          open && items[activeIdx] ? `${listId}-opt-${activeIdx}` : undefined
        }
        ref={listRef}
        className={
          'combobox-menu absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-auto rounded-md border py-1 shadow-lg ' +
          (open ? 'combobox-menu--open' : 'combobox-menu--closed')
        }
        style={{
          background: 'var(--section-background)',
          borderColor: 'var(--border-color)',
          boxShadow: 'var(--options-shadow)',
        }}
      >
        {items.map((item, i) => {
          const isSelected = item.value === value
          const isActive = open && i === activeIdx
          return (
            <li
              id={`${listId}-opt-${i}`}
              key={item.value + ':' + i}
              role="option"
              aria-selected={isSelected}
              aria-disabled={item.disabled || undefined}
              onMouseEnter={() => !item.disabled && setActiveIdx(i)}
              onMouseDown={(e) => {
                // mousedown, not click: click fires after our outside-click
                // handler wipes `open`. mousedown pre-empts blur.
                e.preventDefault()
                pick(i)
              }}
              className={
                'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition-colors ' +
                (item.disabled ? 'opacity-40 cursor-not-allowed ' : '')
              }
              style={{
                background: isActive
                  ? 'color-mix(in srgb, var(--classic-blue) 14%, var(--section-background))'
                  : isSelected
                    ? 'color-mix(in srgb, var(--classic-blue) 7%, var(--section-background))'
                    : 'transparent',
                color: 'var(--font-color)',
              }}
            >
              {/* Left check for the currently-selected value. Reserves 12px
                  even when hidden so text doesn't jiggle when selection moves.
                  Uses --font-color so the tick reads as dark on light and
                  near-white on the dark section background. */}
              <span
                aria-hidden
                className="inline-block w-3 shrink-0 text-center"
                style={{
                  color: 'var(--font-color)',
                  opacity: isSelected ? 1 : 0,
                  transition: 'opacity 140ms ease',
                }}
              >
                ✓
              </span>
              <span className="truncate">{item.label}</span>
            </li>
          )
        })}
        {items.length === 0 && (
          <li className="px-3 py-2 text-xs italic" style={{ color: 'var(--muted-color)' }}>
            No options
          </li>
        )}
      </ul>

      <style>{`
        .combobox-menu {
          transform-origin: top;
          transition:
            opacity 160ms ease,
            transform 180ms cubic-bezier(0.22, 0.7, 0.32, 1),
            visibility 0s;
        }
        .combobox-menu--closed {
          opacity: 0;
          transform: scaleY(0.92) translateY(-4px);
          pointer-events: none;
          visibility: hidden;
          transition-delay: 0s, 0s, 180ms;
        }
        .combobox-menu--open {
          opacity: 1;
          transform: scaleY(1) translateY(0);
          visibility: visible;
        }
        .combobox-menu li {
          animation: combobox-opt-in 220ms cubic-bezier(0.22, 0.7, 0.32, 1) backwards;
        }
        .combobox-menu--closed li {
          animation: none;
        }
        @keyframes combobox-opt-in {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

/**
 * Caret glyph. Rotates 180° on aria-expanded via a CSS transition on the
 * enclosing button's [data-open] attribute (see className below).
 */
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4 shrink-0"
      aria-hidden
      style={{
        color: 'currentColor',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 200ms cubic-bezier(0.22, 0.7, 0.32, 1)',
      }}
    >
      <path
        d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z"
        fill="currentColor"
      />
    </svg>
  )
}

/**
 * True when the option label starts with the given lowercase prefix. Labels
 * can be arbitrary ReactNode, so we only match plain-string labels — typeahead
 * on JSX-rich rows silently no-ops, which is fine (they can still be picked
 * with arrows).
 */
function labelStartsWith(label: ReactNode, prefix: string): boolean {
  if (typeof label !== 'string') return false
  return label.toLowerCase().startsWith(prefix)
}
