import { useId, type CSSProperties } from 'react'
import { fieldLabelClass, fieldLabelStyle } from './Select'

/* ------------------------------------------------------------------------- *
 * <Slider> — themed, fully-controlled range input with a numeric readout.
 *
 * Uses `accent-color: var(--classic-blue)` so the built-in track fill and
 * thumb inherit the app's brand blue on modern browsers, with WebKit/Moz
 * overrides below to tighten track height (~6 px) and thumb size (~16 px)
 * and to paint a focus ring on the thumb.
 *
 * No internal state — the parent owns `value`. No portal, no side-effects.
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
  transition: box-shadow 120ms ease, transform 120ms ease;
}
.ict-slider-range::-moz-range-thumb {
  width: 16px; height: 16px; border-radius: 9999px;
  background: var(--classic-blue);
  border: 2px solid var(--input-background);
  box-shadow: 0 1px 2px rgba(0,0,0,0.25);
  transition: box-shadow 120ms ease, transform 120ms ease;
}
.ict-slider-range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px rgba(0, 113, 197, 0.28);
  transform: scale(1.05);
}
.ict-slider-range:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 4px rgba(0, 113, 197, 0.28);
  transform: scale(1.05);
}
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

const readoutStyle: CSSProperties = {
  background: 'var(--section-background)',
  borderColor: 'var(--border-color)',
  color: 'var(--font-color)',
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

  const readout = format ? format(value) : `${value}${unit ? ' ' + unit : ''}`

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
        <span
          className="inline-block min-w-[64px] rounded-md border px-2 py-1 text-center font-mono text-xs"
          style={readoutStyle}
          aria-hidden="true"
        >
          {readout}
        </span>
      </div>
      {hint && (
        <p id={hintId} className="mt-1 text-xs" style={{ color: 'var(--muted-color)' }}>
          {hint}
        </p>
      )}
    </div>
  )
}
