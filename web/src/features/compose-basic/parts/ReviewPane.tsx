import { MenuIcon } from './MenuIcon'
import { ReviewEmptyStates } from './ReviewEmptyStates'
import { ReviewSummaryGrid } from './ReviewSummaryGrid'
import type { ComposeResponse } from '@/api/types'

/**
 * The right pane's live review of the resolved template.
 *
 * ⚠️ THIS COMPONENT MUST NOT CARRY AN `@container` MARKER. The `@max-pane-*`
 * utilities inside it resolve against the PANE, which BasicPage marks — one of
 * exactly three such markers app-wide. Adding one here would make this element
 * the reference box, break the SummaryPanel key-column breakpoint, and create a
 * stacking context that traps the YAML drawer's fullscreen overlay. See
 * .claude/UI-LAYOUT.md.
 *
 * The bordered surface deliberately reuses Select.tsx's `controlBaseStyle` recipe
 * (--input-background + --border-color + rounded-md) so the review reads as the
 * same family as the cascade dropdowns across the divider. The nested
 * SummaryPanels paint --page-background, which is darker than --input-background
 * in light mode and lighter in dark — that inversion is what keeps them legible
 * as distinct tables in both themes. Do not "simplify" either to one token.
 *
 * Extracted verbatim from BasicPage in FE-7c.
 */
export function ReviewPane({
  review,
  reviewLoading,
  reviewError,
  complete,
  onOpenYaml,
}: {
  review: ComposeResponse | null
  reviewLoading: boolean
  reviewError: string | null
  complete: boolean
  /** Opens the template-YAML drawer. */
  onOpenYaml: () => void
}) {
  return (
    <>
      {/* Bordered surface for the whole review section, matching the
          cascade dropdowns across the divider: same --input-background
          + --border-color + rounded-md recipe that Select.tsx's
          `controlBaseStyle` applies to every control in "Choose Image
          Configuration". The nested SummaryPanels paint themselves
          --page-background, which is darker than --input-background in
          the light theme and lighter in dark, so they stay legible as
          distinct tables against this container in both. */}
      <div
        className="flex min-h-0 flex-1 flex-col rounded-md border p-4"
        style={{
          background: 'var(--input-background)',
          borderColor: 'var(--border-color)',
        }}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <h2
            className="text-sm font-semibold uppercase tracking-wide whitespace-nowrap"
            style={{ color: 'var(--muted-color)' }}
          >
            Image Configuration Review
          </h2>
          {/* Hamburger → template-YAML drawer. Styled after
              YamlEditor's fullscreen toggle (26×26, bordered, JS hover)
              so the two YAML affordances feel related. */}
          <button
            type="button"
            onClick={() => onOpenYaml()}
            disabled={!complete}
            aria-label="View template YAML"
            // haspopup="dialog", not aria-expanded: the drawer is a
            // modal dialog, not a disclosure region this button owns.
            aria-haspopup="dialog"
            title="View template YAML"
            style={{
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 4,
              border: '1px solid var(--border-color)',
              background: 'var(--input-background)',
              color: 'var(--muted-color)',
              cursor: complete ? 'pointer' : 'not-allowed',
              opacity: complete ? 1 : 0.5,
              padding: 0,
              lineHeight: 0,
              transition: 'color 160ms ease, background-color 160ms ease',
            }}
            onMouseEnter={(e) => {
              if (!complete) return
              e.currentTarget.style.color = 'var(--font-color)'
              e.currentTarget.style.background =
                'color-mix(in srgb, var(--classic-blue) 8%, var(--input-background))'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--muted-color)'
              e.currentTarget.style.background = 'var(--input-background)'
            }}
          >
            <MenuIcon />
          </button>
        </div>
        <p
          className="mb-4 text-xs whitespace-nowrap overflow-hidden text-ellipsis"
          style={{
            color: 'var(--muted-color)',
            opacity: complete ? 1 : 0.5,
            transition: 'opacity 260ms ease 120ms',
          }}
        >
          {complete
            ? 'Resolved from your selection. ☰ opens the template YAML.'
            : 'Complete the form to review'}
        </p>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          style={{
            opacity: complete ? 1 : 0,
            pointerEvents: complete ? 'auto' : 'none',
            transition: 'opacity 320ms ease 120ms',
          }}
          /* Note: intentionally NOT using `transform: translateX(...)` here.
             A permanent `transform` value on the style attribute establishes
             a containing block for fixed-position descendants (CSS spec),
             which would trap the YamlEditor's fullscreen overlay inside
             this pane instead of covering the viewport. The 8px horizontal
             slide was cosmetic; the pane's own width animation (0 → 45 %)
             already carries most of the "drop-in" feel. */
        >
          {review && <ReviewSummaryGrid review={review} />}
          {!review && (
            <ReviewEmptyStates
              reviewLoading={reviewLoading}
              reviewError={reviewError}
            />
          )}
        </div>
      </div>
    </>
  )
}
