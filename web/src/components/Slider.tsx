import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { fieldLabelClass, fieldLabelStyle } from './Select'

/* ------------------------------------------------------------------------- *
 * <Slider> — themed, fully-controlled range input with an editable numeric
 * readout.
 *
 * Uses `accent-color: var(--classic-blue)` so the built-in track fill and
 * thumb inherit the app's brand blue on modern browsers, with WebKit/Moz
 * overrides below to tighten track height (~6 px) and thumb size (~16 px)
 * and to paint a focus ring on the thumb.
 *
 * The readout sitting next to the slider is an <input type="number">, so
 * the user can also type a value directly. The typing UX is the tricky
 * part: naive `parseFloat + clamp` on every keystroke would rewrite "12"
 * to "1" the moment the user typed the first digit. Instead we keep a
 * decoupled `draft` string while the field is focused and commit-clamp
 * only on blur/Enter. See `commitDraft()`.
 * ------------------------------------------------------------------------- */

interface SliderProps {
  label?: string
  id?: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  /** Custom display formatter. Wins over `unit`. */
  format?: (v: number) => string
  /** Simple unit suffix, used when `format` not provided. */
  unit?: string
  /** Small helper text under the slider. */
  hint?: string
  ariaLabelledBy?: string
}

// Scoped CSS for the range input. Injected once at module scope via a
// <style> tag on first render — cheaper than a separate stylesheet and
// avoids leaking into other native ranges on the page.
const sliderCss = `
.ict-slider-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  border-radius: 9999px;
  background: var(--border-color);
  accent-color: var(--classic-blue);
  outline: none;
  cursor: pointer;
  transition: opacity 120ms ease;
}
.ict-slider-range:disabled { opacity: 0.55; cursor: not-allowed; }
.ict-slider-range::-webkit-slider-runnable-track {
  height: 6px; border-radius: 9999px; background: transparent;
}
.ict-slider-range::-moz-range-track {
  height: 6px; border-radius: 9999px; background: var(--border-color);
}
.ict-slider-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 16px; height: 16px; border-radius: 9999px;
  background: var(--classic-blue);
  border: 2px solid var(--input-background);
  margin-top: -5px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.25);
  /* Smooth grow/shrink on hover and focus. Transition both scale and
   * the outer halo box-shadow together so the transform and the ring
   * land at the same time. */
  transition:
    box-shadow 180ms cubic-bezier(0.22, 0.7, 0.32, 1),
    transform  180ms cubic-bezier(0.22, 0.7, 0.32, 1);
}
.ict-slider-range::-moz-range-thumb {
  width: 16px; height: 16px; border-radius: 9999px;
  background: var(--classic-blue);
  border: 2px solid var(--input-background);
  box-shadow: 0 1px 2px rgba(0,0,0,0.25);
  transition:
    box-shadow 180ms cubic-bezier(0.22, 0.7, 0.32, 1),
    transform  180ms cubic-bezier(0.22, 0.7, 0.32, 1);
}
/* Hover on the range input propagates through the shadow tree to the
 * thumb pseudo. Grow ~30% and add a softer halo — smaller than the
 * :focus-visible ring so mouse hover stays visually distinct from
 * keyboard focus. */
.ict-slider-range:hover:not(:disabled)::-webkit-slider-thumb {
  transform: scale(1.35);
  box-shadow: 0 0 0 4px rgba(0, 113, 197, 0.16), 0 1px 2px rgba(0,0,0,0.25);
}
.ict-slider-range:hover:not(:disabled)::-moz-range-thumb {
  transform: scale(1.35);
  box-shadow: 0 0 0 4px rgba(0, 113, 197, 0.16), 0 1px 2px rgba(0,0,0,0.25);
}
/* Active (mouse-down / drag) — a hair larger still, with a brighter
 * halo, so the "grabbed" state is unmistakable. */
.ict-slider-range:active:not(:disabled)::-webkit-slider-thumb {
  transform: scale(1.5);
  box-shadow: 0 0 0 5px rgba(0, 113, 197, 0.28), 0 2px 4px rgba(0,0,0,0.3);
}
.ict-slider-range:active:not(:disabled)::-moz-range-thumb {
  transform: scale(1.5);
  box-shadow: 0 0 0 5px rgba(0, 113, 197, 0.28), 0 2px 4px rgba(0,0,0,0.3);
}
.ict-slider-range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px rgba(0, 113, 197, 0.28);
  transform: scale(1.35);
}
.ict-slider-range:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 4px rgba(0, 113, 197, 0.28);
  transform: scale(1.35);
}
/* Hide the native number-input spinner arrows — the slider itself is the
 * spinner, and the arrows crowd the small readout box.
 */
.ict-slider-readout::-webkit-outer-spin-button,
.ict-slider-readout::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.ict-slider-readout { -moz-appearance: textfield; }
`

let styleInjected = false
function ensureStyle() {
  if (styleInjected || typeof document === 'undefined') return
  const el = document.createElement('style')
  el.setAttribute('data-ict-slider', '')
  el.textContent = sliderCss
  document.head.appendChild(el)
  styleInjected = true
}

const readoutBoxStyle: CSSProperties = {
  background: 'var(--input-background)',
  borderColor: 'var(--border-color)',
  color: 'var(--font-color)',
}

// Snap `n` to the nearest valid slider step within [min, max]. Used when the
// user commits a typed value so it maps 1:1 to a reachable slider position.
function snap(n: number, min: number, max: number, step: number): number {
  if (Number.isNaN(n)) return min
  const clamped = Math.min(max, Math.max(min, n))
  const stepped = Math.round((clamped - min) / step) * step + min
  return Math.min(max, Math.max(min, stepped))
}

export function Slider({
  label,
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  format,
  unit,
  hint,
  ariaLabelledBy,
}: SliderProps) {
  ensureStyle()
  const autoId = useId()
  const inputId = id ?? `slider-${autoId}`
  const labelId = label ? inputId + '-label' : undefined
  const hintId = hint ? inputId + '-hint' : undefined

  // While the readout is focused we keep an unclamped string draft so
  // partial input ("", "1" on the way to "12") doesn't get rewritten out
  // from under the user. Outside the focused window, the visible value
  // tracks `value` prop exactly — so slider drags update the readout in
  // real time.
  //
  // Debounced auto-commit: 400 ms after the last keystroke we push a
  // clamped-but-not-snapped value upstream so downstream widgets (YAML
  // preview, other cards) update without waiting on Enter/blur. On blur
  // or Enter we do a final snap-to-step commit and also update the
  // displayed draft so the user sees the canonical value.
  const [draft, setDraft] = useState<string>('')
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [value, editing])

  const readout = format ? format(value) : `${value}${unit ? ' ' + unit : ''}`

  // Debounced push while typing. Clamp only — no snap-to-step yet, or a
  // step of 1 GiB and a typed "13" would replace the visible field with
  // "13" mid-word.
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
      const parsed = Number(nextDraft.trim())
      if (!nextDraft.trim() || Number.isNaN(parsed)) return
      const clamped = Math.min(max, Math.max(min, parsed))
      if (clamped !== value) onChange(clamped)
    }, 400)
  }

  const commitDraft = () => {
    cancelDebounce()
    const parsed = Number(draft.trim())
    if (draft.trim() === '' || Number.isNaN(parsed)) {
      setDraft(String(value)) // roll back invalid entries to the last good value
    } else {
      const snapped = snap(parsed, min, max, step)
      if (snapped !== value) onChange(snapped)
      setDraft(String(snapped))
    }
    setEditing(false)
  }

  return (
    <div className="mb-4">
      {label && (
        <label id={labelId} htmlFor={inputId} className={fieldLabelClass} style={fieldLabelStyle}>
          {label}
        </label>
      )}
      <div className="flex items-center gap-3">
        <input
          id={inputId}
          type="range"
          className="ict-slider-range flex-1"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-labelledby={ariaLabelledBy ?? labelId}
          aria-describedby={hintId}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={readout}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <div
          className="inline-flex min-w-[92px] items-center gap-1 rounded-md border px-2 py-1 font-mono text-xs focus-within:ring-2 focus-within:ring-[var(--classic-blue)]"
          style={readoutBoxStyle}
        >
          <input
            aria-label={label ? `${label} (numeric)` : 'value'}
            type="number"
            inputMode="numeric"
            className="ict-slider-readout w-full bg-transparent text-right outline-none disabled:cursor-not-allowed"
            style={{ color: 'inherit' }}
            value={editing ? draft : String(value)}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onFocus={() => {
              setDraft(String(value))
              setEditing(true)
            }}
            onChange={(e) => {
              setDraft(e.target.value)
              scheduleDebouncedPush(e.target.value)
            }}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitDraft()
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                cancelDebounce()
                setDraft(String(value))
                setEditing(false)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
          {unit && !format && (
            <span
              className="select-none whitespace-nowrap opacity-70"
              aria-hidden
            >
              {unit}
            </span>
          )}
        </div>
      </div>
      {hint && (
        <p id={hintId} className="mt-1 text-xs" style={{ color: 'var(--muted-color)' }}>
          {hint}
        </p>
      )}
    </div>
  )
}
