import { Children, isValidElement, type CSSProperties, type ReactElement, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import type { DropdownOption } from '../store'
import { Combobox, type ComboboxItem } from './Combobox'

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

/* ------------------------------------------------------------------------- *
 * <Select> — cascading dropdown used by BasicPage.
 * Now delegates to the in-house <Combobox> for a proper JS listbox with
 * rotating caret, animated menu, hover transitions, and keyboard navigation.
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
  const items: ComboboxItem[] = options.map((o) => ({ value: o.id, label: o.label }))
  return (
    <div className="mb-4">
      <label id={id + '-label'} htmlFor={id} className={fieldLabelClass} style={fieldLabelStyle}>
        {label}
      </label>
      <Combobox
        id={id}
        ariaLabelledBy={id + '-label'}
        value={value}
        items={items}
        placeholder={placeholder}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  )
}

/* ------------------------------------------------------------------------- *
 * <NativeSelect> — misnamed for backwards-compat (used to wrap a real native
 * <select>). Now also delegates to <Combobox>, but keeps its
 * `<option>`-children API so consumers (AdvancedPage's seed picker) don't
 * need to change: children are walked at render time and reshaped to items.
 * ------------------------------------------------------------------------- */

interface NativeSelectProps {
  id?: string
  value: string
  disabled?: boolean
  onChange: (e: { target: { value: string } }) => void
  children: ReactNode
  containerClassName?: string
}

export function NativeSelect({
  id,
  value,
  disabled,
  onChange,
  children,
  containerClassName = '',
}: NativeSelectProps) {
  const items: ComboboxItem[] = []
  let placeholder = ''
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    if ((child as ReactElement).type !== 'option') return
    const c = child as ReactElement<{ value?: string; children?: ReactNode; disabled?: boolean }>
    const v = c.props.value ?? ''
    const label = c.props.children
    // First <option value=""> is the placeholder text — extract it and skip
    // adding a placeholder item to the list (Combobox shows its own).
    if (v === '') {
      if (typeof label === 'string') placeholder = label
      return
    }
    items.push({ value: v, label: label as ReactNode, disabled: c.props.disabled })
  })
  return (
    <Combobox
      id={id}
      value={value}
      items={items}
      placeholder={placeholder || '-- Select --'}
      disabled={disabled}
      onChange={(v) => onChange({ target: { value: v } })}
      className={containerClassName}
    />
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
