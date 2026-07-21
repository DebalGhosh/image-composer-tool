import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { controlBase, controlBaseStyle } from './Select'

/**
 * MultiComboboxOption — one row in a MultiCombobox.
 *
 * `value` is the underlying token stored in `values[]`, `label` is the visible
 * text. `description` renders as a muted second line beneath the label in the
 * default row renderer. `disabled` greys the row and blocks toggle.
 */
export interface MultiComboboxOption {
  value: string
  label: string
  disabled?: boolean
  description?: string
}

/**
 * Passed to a custom `renderOption`. Currently just carries the active query
 * so callers can substring-highlight matches — kept as an object so we can
 * add richer match indices later (e.g. from MiniSearch) without breaking the
 * public shape.
 */
export interface MultiComboboxMatchInfo {
  query: string
}

interface MultiComboboxProps {
  id?: string
  ariaLabel?: string
  ariaLabelledBy?: string
  /** Controlled selection. */
  values: string[]
  onChange: (values: string[]) => void
  options: MultiComboboxOption[]
  placeholder?: string
  disabled?: boolean
  /** Optional grouping — options with the same returned key cluster under a sticky header. */
  groupBy?: (opt: MultiComboboxOption) => string
  /** When set, the parent owns filtering — we surface `options` unchanged. */
  onSearchChange?: (q: string) => void
  /** Controlled search text; if unset we manage it internally. */
  searchValue?: string
  /** Optional custom row body — receives the option and current query. */
  renderOption?: (opt: MultiComboboxOption, matchInfo: MultiComboboxMatchInfo) => ReactNode
  className?: string
}

/** How many chips fit on the trigger before we collapse to "+N more". */
const MAX_VISIBLE_CHIPS = 3

/**
 * Multi-select variant of Combobox. Follows the WAI-ARIA 1.2
 * combobox-with-listbox pattern for multi-select: the trigger carries
 * role=combobox and aria-haspopup=listbox, the ul below carries role=listbox
 * and aria-multiselectable, and selection is toggled without closing.
 *
 * Filtering is client-side by default (substring match on `label`); parents
 * that need custom scoring pass `onSearchChange` + `searchValue` and drive
 * `options` themselves (e.g. PackageSearchCombobox with MiniSearch).
 */
export function MultiCombobox({
  id,
  ariaLabel,
  ariaLabelledBy,
  values,
  onChange,
  options,
  placeholder = 'Select…',
  disabled,
  groupBy,
  onSearchChange,
  searchValue,
  renderOption,
  className,
}: MultiComboboxProps) {
  const [open, setOpen] = useState(false)
  const [internalSearch, setInternalSearch] = useState('')
  const searchControlled = searchValue !== undefined
  const search = searchControlled ? searchValue ?? '' : internalSearch
  const setSearch = useCallback(
    (q: string) => {
      if (!searchControlled) setInternalSearch(q)
      onSearchChange?.(q)
    },
    [searchControlled, onSearchChange],
  )

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const triggerId = useId()
  const listId = useId()

  const valueSet = useMemo(() => new Set(values), [values])

  // When the parent owns filtering, do NOT filter again — `options` is already
  // the desired set. Otherwise substring-match on label (case-insensitive).
  const filtered = useMemo(() => {
    if (onSearchChange) return options
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, search, onSearchChange])

  // Flatten to a "rows" array of header + option entries. activeIdx indexes
  // this array; keyboard nav only lands on option rows.
  type Row =
    | { kind: 'header'; label: string }
    | { kind: 'opt'; opt: MultiComboboxOption }
  const rows = useMemo<Row[]>(() => {
    if (!groupBy) return filtered.map((opt) => ({ kind: 'opt', opt }))
    const buckets = new Map<string, MultiComboboxOption[]>()
    filtered.forEach((o) => {
      const g = groupBy(o)
      const arr = buckets.get(g)
      if (arr) arr.push(o)
      else buckets.set(g, [o])
    })
    const out: Row[] = []
    buckets.forEach((arr, g) => {
      out.push({ kind: 'header', label: g })
      arr.forEach((o) => out.push({ kind: 'opt', opt: o }))
    })
    return out
  }, [filtered, groupBy])

  // Indices of navigable (enabled option) rows — headers and disabled rows are skipped.
  const navRowIndices = useMemo(
    () =>
      rows
        .map((r, i) => (r.kind === 'opt' && !r.opt.disabled ? i : -1))
        .filter((i) => i >= 0),
    [rows],
  )

  const [activeIdx, setActiveIdx] = useState(0)

  // When the option list shifts under us (filter change, first open), snap the
  // highlight to the first enabled row so keyboard nav starts sensibly.
  useEffect(() => {
    if (!open) return
    if (navRowIndices.length === 0) return
    if (!navRowIndices.includes(activeIdx)) setActiveIdx(navRowIndices[0])
  }, [open, navRowIndices, activeIdx])

  // Outside-click closes the menu. Only bound while open to keep idle cheap.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Keep the active row scrolled into view during keyboard nav.
  useLayoutEffect(() => {
    if (!open) return
    const el = listRef.current?.children.item(activeIdx) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  // Focus the search input whenever the menu opens (WAI-ARIA convention:
  // typing lands in the filter box, listbox stays annotated via activedescendant).
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const stepActive = useCallback(
    (dir: 1 | -1) => {
      if (navRowIndices.length === 0) return
      const pos = navRowIndices.indexOf(activeIdx)
      const next =
        pos < 0
          ? dir === 1
            ? 0
            : navRowIndices.length - 1
          : (pos + dir + navRowIndices.length) % navRowIndices.length
      setActiveIdx(navRowIndices[next])
    },
    [navRowIndices, activeIdx],
  )

  const toggleValue = useCallback(
    (v: string) => {
      if (valueSet.has(v)) onChange(values.filter((x) => x !== v))
      else onChange([...values, v])
    },
    [valueSet, values, onChange],
  )

  const removeValue = useCallback(
    (v: string) => onChange(values.filter((x) => x !== v)),
    [values, onChange],
  )

  const toggleActive = () => {
    const row = rows[activeIdx]
    if (!row || row.kind !== 'opt' || row.opt.disabled) return
    toggleValue(row.opt.value)
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'Enter':
      case ' ':
        // Both keys toggle the highlighted option without closing the menu
        // (multi-select). Trade-off: users cannot type a space in the search
        // field — package labels don't contain spaces, so this is acceptable.
        e.preventDefault()
        toggleActive()
        break
      case 'ArrowDown':
        e.preventDefault()
        stepActive(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        stepActive(-1)
        break
      case 'Home':
        if (navRowIndices.length > 0) {
          e.preventDefault()
          setActiveIdx(navRowIndices[0])
        }
        break
      case 'End':
        if (navRowIndices.length > 0) {
          e.preventDefault()
          setActiveIdx(navRowIndices[navRowIndices.length - 1])
        }
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
      case 'Backspace':
        if (search === '' && values.length > 0) {
          e.preventDefault()
          removeValue(values[values.length - 1])
        }
        break
    }
  }

  const onTriggerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || open) return
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(true)
      return
    }
    // Any printable single-char key opens the menu and seeds the search.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      setSearch(e.key)
      setOpen(true)
    }
  }

  const onTriggerClick = () => {
    if (disabled) return
    setOpen((v) => !v)
  }

  // Every selected value renders as a chip; the trigger grows vertically to
  // fit them. Previously we capped at MAX_VISIBLE_CHIPS with "+N more" but a
  // large package selection (typical templates have 30-50 packages) made the
  // hidden portion effectively invisible unless the operator opened the
  // dropdown. Wrapping keeps everything scannable at the cost of a taller
  // trigger button. Kept the constant for potential future compact modes.
  void MAX_VISIBLE_CHIPS
  const chipsToShow = values
  const labelFor = (v: string): string => options.find((o) => o.value === v)?.label ?? v

  return (
    <div ref={rootRef} className={'relative ' + (className ?? '')}>
      {/* Trigger — a div (not a button) so real <button> chip-remove children
          remain valid HTML. role=combobox keeps AT semantics correct. */}
      <div
        id={id ?? triggerId}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-disabled={disabled || undefined}
        data-open={open || undefined}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKey}
        className={
          controlBase +
          ' flex cursor-pointer items-center justify-between gap-2 text-left' +
          (disabled ? ' cursor-not-allowed opacity-60' : '')
        }
        style={controlBaseStyle}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {values.length === 0 && (
            <span className="truncate opacity-60" style={{ color: 'var(--font-color)' }}>
              {placeholder}
            </span>
          )}
          {chipsToShow.map((v) => (
            <Chip key={v} label={labelFor(v)} disabled={disabled} onRemove={() => removeValue(v)} />
          ))}
        </div>
        <Caret open={open} />
      </div>

      {/* Menu — always mounted so the scaleY+opacity transition plays both directions. */}
      <div
        className={
          'multi-combobox-menu absolute left-0 right-0 z-30 mt-1 flex max-h-80 flex-col overflow-hidden rounded-md border shadow-lg ' +
          (open ? 'multi-combobox-menu--open' : 'multi-combobox-menu--closed')
        }
        style={{
          background: 'var(--section-background)',
          borderColor: 'var(--border-color)',
          boxShadow: 'var(--options-shadow)',
        }}
      >
        <div className="border-b p-2" style={{ borderColor: 'var(--border-color)' }}>
          <input
            ref={inputRef}
            type="text"
            role="searchbox"
            aria-controls={listId}
            aria-autocomplete="list"
            value={search}
            placeholder="Search…"
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKey}
            className="block w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--classic-blue)] dark:focus:ring-[var(--tine-1)]"
            style={{
              background: 'var(--input-background)',
              borderColor: 'var(--border-color)',
              color: 'var(--font-color)',
            }}
          />
        </div>
        <ul
          id={listId}
          role="listbox"
          aria-multiselectable
          aria-activedescendant={
            open && rows[activeIdx]?.kind === 'opt' ? `${listId}-opt-${activeIdx}` : undefined
          }
          ref={listRef}
          className="flex-1 overflow-auto py-1"
        >
          {rows.map((row, i) => {
            if (row.kind === 'header') {
              return (
                <li
                  key={`h-${i}-${row.label}`}
                  role="presentation"
                  className="sticky top-0 z-10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide"
                  style={{
                    background: 'var(--section-background)',
                    color: 'var(--muted-color)',
                    borderBottom: '1px solid var(--border-color)',
                  }}
                >
                  {row.label}
                </li>
              )
            }
            const opt = row.opt
            const selected = valueSet.has(opt.value)
            const active = open && i === activeIdx
            const isDisabled = !!opt.disabled
            const body = renderOption
              ? renderOption(opt, { query: search })
              : <DefaultOptionBody label={opt.label} description={opt.description} />
            return (
              <li
                id={`${listId}-opt-${i}`}
                key={opt.value + ':' + i}
                role="option"
                aria-selected={selected}
                aria-disabled={isDisabled || undefined}
                onMouseEnter={() => !isDisabled && setActiveIdx(i)}
                onMouseDown={(e) => {
                  // mousedown pre-empts the input's blur; toggle then keep the
                  // menu open so the user can pick multiple in a row.
                  e.preventDefault()
                  if (isDisabled) return
                  toggleValue(opt.value)
                  inputRef.current?.focus()
                }}
                className={
                  'flex cursor-pointer items-start gap-2 px-3 py-2 text-sm transition-colors ' +
                  (isDisabled ? 'cursor-not-allowed opacity-40 ' : '')
                }
                style={{
                  background: active
                    ? 'color-mix(in srgb, var(--classic-blue) 14%, var(--section-background))'
                    : selected
                      ? 'color-mix(in srgb, var(--classic-blue) 7%, var(--section-background))'
                      : 'transparent',
                  color: 'var(--font-color)',
                }}
              >
                <span
                  aria-hidden
                  className="mt-0.5 inline-block w-3 shrink-0 text-center"
                  style={{
                    color: 'var(--font-color)',
                    opacity: selected ? 1 : 0,
                    transition: 'opacity 140ms ease',
                  }}
                >
                  ✓
                </span>
                <span className="min-w-0 flex-1">{body}</span>
              </li>
            )
          })}
          {rows.length === 0 && (
            <li className="px-3 py-2 text-xs italic" style={{ color: 'var(--muted-color)' }}>
              No options
            </li>
          )}
        </ul>
      </div>

      <style>{`
        .multi-combobox-menu {
          transform-origin: top;
          transition:
            opacity 160ms ease,
            transform 180ms cubic-bezier(0.22, 0.7, 0.32, 1),
            visibility 0s;
        }
        .multi-combobox-menu--closed {
          opacity: 0;
          transform: scaleY(0.92) translateY(-4px);
          pointer-events: none;
          visibility: hidden;
          transition-delay: 0s, 0s, 180ms;
        }
        .multi-combobox-menu--open {
          opacity: 1;
          transform: scaleY(1) translateY(0);
          visibility: visible;
        }
      `}</style>
    </div>
  )
}

/** Selected-value pill with an x button. Rendered inside the trigger div. */
function Chip({
  label,
  onRemove,
  disabled,
}: {
  label: string
  onRemove: () => void
  disabled?: boolean
}) {
  return (
    <span
      className="inline-flex max-w-[12rem] items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
      style={{
        background: 'color-mix(in srgb, var(--classic-blue) 10%, var(--section-background))',
        borderColor: 'var(--border-color)',
        color: 'var(--font-color)',
      }}
    >
      <span className="truncate">{label}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Remove ${label}`}
        disabled={disabled}
        onMouseDown={(e) => {
          // Prevent the trigger div's click/mousedown handlers from firing —
          // we don't want the menu to toggle just because a chip was removed.
          e.preventDefault()
          e.stopPropagation()
        }}
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
        style={{ color: 'var(--font-color)' }}
      >
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden>
          <path
            d="M2.5 2.5l7 7m0-7l-7 7"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </span>
  )
}

function DefaultOptionBody({ label, description }: { label: string; description?: string }) {
  return (
    <span className="block">
      <span className="block truncate">{label}</span>
      {description && (
        <span className="block truncate text-xs" style={{ color: 'var(--muted-color)' }}>
          {description}
        </span>
      )}
    </span>
  )
}

/** Rotating caret glyph — 180° when open, same easing as Combobox. */
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
