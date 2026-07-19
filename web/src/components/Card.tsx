import type { ReactNode } from 'react'

type CardVariant = 'default' | 'warning'

interface CardProps {
  /** Visual treatment. 'warning' tints the surface with --warning for caveats. */
  variant?: CardVariant
  /** Optional heading rendered in the card's header row. */
  title?: ReactNode
  /** Right-aligned controls (buttons, toggles) rendered next to the title. */
  actions?: ReactNode
  /** Extra classes applied to the outer <section> (spacing, width, etc.). */
  className?: string
  children: ReactNode
}

// Palette references are all CSS custom properties defined in index.css.
// The warning variant uses color-mix so the amber tint follows whichever
// --section-background is active — legible in both light and dark modes.
const VARIANT_STYLES: Record<CardVariant, React.CSSProperties> = {
  default: {
    background: 'var(--section-background)',
    borderColor: 'var(--border-color)',
    boxShadow: 'var(--options-shadow)',
  },
  warning: {
    background:
      'color-mix(in srgb, var(--warning) 8%, var(--section-background))',
    borderColor: 'color-mix(in srgb, var(--warning) 60%, transparent)',
    boxShadow: 'var(--options-shadow)',
  },
}

export function Card({
  variant = 'default',
  title,
  actions,
  className = '',
  children,
}: CardProps) {
  return (
    <section
      className={
        'rounded-lg border p-5 transition-colors ' +
        (className ? className : '')
      }
      style={{
        ...VARIANT_STYLES[variant],
        color: 'var(--font-color)',
      }}
    >
      {(title || actions) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title ? (
            <h2
              className="text-sm font-semibold"
              style={{ color: 'var(--title-text)' }}
            >
              {title}
            </h2>
          ) : (
            <span />
          )}
          {actions && (
            <div className="flex items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      {children}
    </section>
  )
}
