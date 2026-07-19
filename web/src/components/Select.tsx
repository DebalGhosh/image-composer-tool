import type {
  CSSProperties,
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import type { DropdownOption } from '../store'

/* ------------------------------------------------------------------------- *
 * Shared form-control class recipes.
 * All pages import these instead of duplicating 6-line classNames.
 * ------------------------------------------------------------------------- */

export const fieldLabelClass = 'mb-1 block text-sm font-semibold'

/** Inline style paired with fieldLabelClass so the label follows the theme. */
export const fieldLabelStyle: CSSProperties = { color: 'var(--title-text)' }

/** Base recipe: bg, border, focus ring, disabled states via CSS vars.
 *  py-2.5 (vs py-2) gives the closed control a bit more vertical breathing
 *  room, matching SSF-UI's ~44 px control height. */
export const controlBase =
  'block w-full rounded-md border px-3 py-2.5 text-sm leading-6 transition-colors ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--classic-blue)] dark:focus:ring-[var(--tine-1)] ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

/** Inline styles that resolve --input-background / --border-color etc. */
export const controlBaseStyle: CSSProperties = {
  background: 'var(--input-background)',
  borderColor: 'var(--border-color)',
  color: 'var(--font-color)',
}

/** Recipe extensions per widget type. */
export const inputControl = controlBase
export const textareaControl = controlBase + ' font-mono resize-y'
export const selectControl = controlBase + ' appearance-none pr-10 cursor-pointer'

/* Caret glyph. We recolour it by masking a solid coloured span (not by
 * baking colour into the SVG) so light/dark can swap the tint without
 * shipping two payloads. */
const CARET_MASK =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'>" +
  "<path d='M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z'/>" +
  "</svg>\")"

function Caret() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2"
      style={{
        background: 'var(--classic-blue)',
        WebkitMaskImage: CARET_MASK,
        maskImage: CARET_MASK,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
      }}
    />
  )
}

/* ------------------------------------------------------------------------- *
 * <Select> — cascading dropdown used by BasicPage.
 * Signature unchanged so existing call sites need no update.
 * ------------------------------------------------------------------------- */

interface SelectProps {
  label: string
  value: string
  options: DropdownOption[]
  placeholder: string
  disabled?: boolean
  onChange: (value: string) => void
}

export function Select({
  label,
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: SelectProps) {
  const id = `select-${label.toLowerCase().replace(/\s+/g, '-')}`
  return (
    <div className="mb-4">
      <label htmlFor={id} className={fieldLabelClass} style={fieldLabelStyle}>
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          className={selectControl}
          style={controlBaseStyle}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <Caret />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------- *
 * <NativeSelect> — same styling for pages that render custom <option>
 * children (e.g. AdvancedPage's seed picker). Accepts every native prop.
 * ------------------------------------------------------------------------- */

interface NativeSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  containerClassName?: string
}

export function NativeSelect({
  containerClassName = '',
  className = '',
  children,
  style,
  ...rest
}: NativeSelectProps) {
  return (
    <div className={'relative ' + containerClassName}>
      <select
        className={selectControl + (className ? ' ' + className : '')}
        style={{ ...controlBaseStyle, ...style }}
        {...rest}
      >
        {children}
      </select>
      <Caret />
    </div>
  )
}

export function TextInput({
  className = '',
  style,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={inputControl + (className ? ' ' + className : '')}
      style={{ ...controlBaseStyle, ...style }}
      {...rest}
    />
  )
}

export function TextArea({
  className = '',
  style,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={textareaControl + (className ? ' ' + className : '')}
      style={{ ...controlBaseStyle, ...style }}
      {...rest}
    />
  )
}
