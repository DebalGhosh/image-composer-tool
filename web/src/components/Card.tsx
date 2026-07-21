import { useEffect, useId, useState, type ReactNode } from 'react'

type CardVariant = 'default' | 'warning'
type CardTitleStyle = 'default' | 'section'

interface CardProps {
  /** Visual treatment. 'warning' tints the surface with --warning for caveats. */
  variant?: CardVariant
  /** Optional heading rendered in the card's header row. */
  title?: ReactNode
  /**
   * Heading typography.
   *  - `'default'` (unchanged): sentence-cased `text-sm font-semibold`.
   *    All non-Interactive callers rely on this.
   *  - `'section'`: uppercased with wider letter-spacing so the title reads
   *    as a section head instead of another body line. Used by the
   *    Interactive tab where cards form the primary form-section rhythm.
   */
  titleStyle?: CardTitleStyle
  /** Right-aligned controls (buttons, toggles) rendered next to the title. */
  actions?: ReactNode
  /** Extra classes applied to the outer <section> (spacing, width, etc.). */
  className?: string
  /**
   * When true, the header becomes a button that toggles the content
   * region. A rotating chevron is rendered on the trailing edge. Clicks on
   * `actions` are stop-propagated so their handlers keep working
   * independently of the collapse toggle.
   *
   * Collapsible cards restructure the internal padding: the header sits
   * flush at the top and the body has its own padding block, so the two
   * regions can be visually separated by a divider when open and slide
   * away cleanly when closed. Non-collapsible cards keep the historical
   * uniform `p-5` layout.
   */
  collapsible?: boolean
  /** Only meaningful with `collapsible`. Defaults to expanded (false). */
  defaultCollapsed?: boolean
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

/**
 * Chevron used on collapsible cards. Rotates 180° via CSS transform when
 * the card is open so users see a "pointing down = will collapse"
 * affordance — same easing curve as the Combobox/MultiCombobox carets.
 */
function Chevron({ open }: { open: boolean }) {
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

function TitleText({
  titleStyle,
  children,
}: {
  titleStyle: CardTitleStyle
  children: ReactNode
}) {
  if (titleStyle === 'section') {
    return (
      <h2
        className="m-0 text-xs font-semibold uppercase whitespace-nowrap"
        style={{
          color: 'var(--title-text)',
          letterSpacing: '0.08em',
        }}
      >
        {children}
      </h2>
    )
  }
  return (
    <h2
      className="m-0 text-sm font-semibold"
      style={{ color: 'var(--title-text)' }}
    >
      {children}
    </h2>
  )
}

export function Card({
  variant = 'default',
  title,
  titleStyle = 'default',
  actions,
  className = '',
  collapsible = false,
  defaultCollapsed = false,
  children,
}: CardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const contentId = useId()
  const open = !collapsible || !collapsed

  // While the height animation is running, the body must be clipped or the
  // content briefly overflows the collapsed row. Once the animation settles,
  // we release the clip so absolutely-positioned popovers (MultiCombobox
  // dropdown, Combobox menu) rendered inside the card can escape the section
  // bounds. On close we flip back to clipped immediately so the outgoing
  // content is trimmed as it slides. `animatingRef` runs slightly longer than
  // the CSS transition (240ms vs 220ms) as a paint-timing safety margin.
  const [settledOpen, setSettledOpen] = useState(open)
  useEffect(() => {
    if (open) {
      const handle = window.setTimeout(() => setSettledOpen(true), 240)
      return () => window.clearTimeout(handle)
    }
    setSettledOpen(false)
    return
  }, [open])

  // --- Collapsible layout (new) --------------------------------------------
  // The header sits flush at the top of the card so the toggle is a full-width
  // click target. Body padding lives on its own inner div so the grid-rows
  // animation can slide the whole block cleanly to zero height. When open we
  // draw a hair-line divider between header and body to reinforce the section
  // heading role.
  if (collapsible) {
    const HeaderContent = (
      <>
        {title ? (
          <TitleText titleStyle={titleStyle}>{title}</TitleText>
        ) : (
          <span />
        )}
        <div className="ml-auto flex items-center gap-2">
          {actions && (
            // Clicks on action controls (buttons, toggles) must NOT bubble to
            // the outer <button> that owns the collapse toggle — otherwise
            // hitting Reload would also collapse the card.
            <div
              className="flex items-center gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              {actions}
            </div>
          )}
          <Chevron open={open} />
        </div>
      </>
    )

    return (
      <section
        className={
          'rounded-lg border transition-colors ' +
          (className ? className : '')
        }
        style={{
          ...VARIANT_STYLES[variant],
          color: 'var(--font-color)',
          // Clip while animating, release once fully open so descendant
          // popovers (dropdowns, tooltips) can escape the section bounds.
          overflow: settledOpen ? 'visible' : 'hidden',
        }}
      >
        <button
          type="button"
          className={
            'flex w-full cursor-pointer items-center justify-between gap-3 px-5 py-3.5 text-left select-none' +
            (open ? ' border-b' : '')
          }
          style={{ borderColor: 'var(--border-color)' }}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setCollapsed((c) => !c)}
        >
          {HeaderContent}
        </button>
        {/*
         * grid-template-rows trick: `1fr` open / `0fr` closed animates
         * smoothly across any intrinsic content height without JS
         * measurement. The inner wrapper sets `min-height: 0` so the grid
         * child can shrink below its own min-content size.
         */}
        <div
          id={contentId}
          aria-hidden={!open}
          style={{
            display: 'grid',
            gridTemplateRows: open ? '1fr' : '0fr',
            transition:
              'grid-template-rows 220ms cubic-bezier(0.22, 0.7, 0.32, 1)',
          }}
        >
          <div
            style={{
              minHeight: 0,
              // Same story as the outer section: clip during the height
              // animation, release once open so absolutely-positioned
              // children can spill outside the card.
              overflow: settledOpen ? 'visible' : 'hidden',
            }}
          >
            <div className="p-5">{children}</div>
          </div>
        </div>
      </section>
    )
  }

  // --- Non-collapsible layout (unchanged) ----------------------------------
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
            <TitleText titleStyle={titleStyle}>{title}</TitleText>
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
