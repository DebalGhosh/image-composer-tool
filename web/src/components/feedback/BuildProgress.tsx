// Visual stepper showing the current image-composition phase. Phases are
// derived server-side from the build log (best-effort) and delivered via SSE
// "phase" events; see internal/api/phases.go.
//
// Adapted from upstream's BuildProgress but retuned for our Jenkins-dispatched
// flow: adds a "Dispatching" step at the front (covers the queue wait +
// docker-pull window before ICT itself starts) and a "Publishing" step at the
// back (covers the Artifactory upload, which for our images typically takes
// 1-2 minutes AFTER the ICT container reports its own completion). Colours are
// driven by our CSS variables so the stepper sits correctly in both light and
// dark themes.
//
// The terminal "Done" step is reached ONLY via the server's authoritative
// phase event, which fires alongside the `complete` event carrying the artifact
// links — see internal/api/phases.go and sse.go. So "Publishing artifacts ✓"
// and the hyperlinks in the Artifacts card appear in the same paint, and the
// stepper is never green while the upload is still streaming. BuildView keeps
// this component mounted through success so that all-green frame is actually
// rendered.
//
// Compact-labels design (per user request 2026-07-23):
//   * By default only the currently-active step shows its text label —
//     the rest collapse to just the numbered circle.
//   * As phase advances, the active step's label collapses (max-width → 0,
//     opacity → 0) while the newly-active step's label expands from 0 to its
//     natural width, giving a horizontal "sliding" effect.
//   * Circle background and connector color transition on the same 300ms
//     ease-out so the whole row shifts state as one motion.
//   * A failed step keeps its label so the user can still see WHERE the
//     build stopped without hovering; the circle turns red with an ✕.
//
// Hover reveal (per user request 2026-08-02):
//   * Hovering ANY step — already-completed or not-yet-started — slides its
//     label in using the exact same max-width/opacity/margin transition,
//     and slides it back out on leave. Labels are always in the DOM, so this
//     is purely a visibility flip; nothing mounts or unmounts on hover.
//   * Weight distinguishes the two reasons a label can be visible: the
//     active step is 600, a merely-hovered one stays 400. So bold+coloured
//     = "this is where the build is", regular+coloured = "you're pointing
//     at this".
//   * Pointer-only by design — no tabIndex/onFocus. The wrapper's
//     role="progressbar" is a "children presentational" ARIA role, so
//     assistive tech already ignores this subtree and announces only
//     aria-label/aria-valuenow; adding focusable descendants to such a role
//     would be invalid. Screen-reader users therefore lose nothing here.
//   * Because the reveal is in-flow, a long label (worst case "Resolving &
//     downloading packages") pushes its siblings right and can wrap the
//     flex-wrap <ol> onto a second line for the duration of the hover. That
//     is the accepted trade-off for matching the phase-advance motion
//     exactly rather than floating a tooltip over the row.

import { useState } from 'react'

interface BuildProgressProps {
  // Current phase id (one of PHASES.id).
  phase: string
  // Install-phase counter, when available (0/0 otherwise).
  install: { done: number; total: number }
  // Whether the build failed — the active step is shown in red.
  failed?: boolean
}

/**
 * Straight-stroke check mark for completed steps (per user request
 * 2026-08-02).
 *
 * Replaces the literal '✓' (U+2713 CHECK MARK) this used to render. That
 * glyph's curve and stroke taper are baked into the font outline, so it can't
 * be straightened with CSS — the fix has to be a drawn path.
 *
 * Two straight segments meeting at a sharp vertex. `strokeLinejoin="miter"`
 * and `strokeLinecap="butt"` are the SVG defaults but stated explicitly
 * because every other icon in this codebase uses `round` for both, and an
 * inherited or copy-pasted `round` is exactly what would re-round the corner.
 * The vertex angle is ~86°, giving a miter ratio of ~1.5 — well inside the
 * default miterLimit of 4, so the join renders as a true point rather than
 * silently falling back to bevel.
 *
 * Follows the file-local icon convention: inline SVG, `currentColor` (so it
 * picks up the circle's white `color`), `aria-hidden` (the wrapping circle is
 * already aria-hidden, and role="progressbar" makes this subtree
 * presentational anyway).
 */
function CheckIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
    </svg>
  )
}

const PHASES: { id: string; label: string }[] = [
  { id: 'dispatching', label: 'Dispatching' },
  { id: 'preparing', label: 'Preparing' },
  { id: 'packages', label: 'Resolving & downloading packages' },
  { id: 'installing', label: 'Installing packages' },
  { id: 'generating', label: 'Generating image' },
  { id: 'publishing', label: 'Publishing artifacts' },
  { id: 'done', label: 'Done' },
]

// Shared transition duration for every animating property in the stepper so
// the whole row moves as one visual event. 300ms is fast enough that the
// operator perceives it as "phase changed" rather than a decorative
// animation, but slow enough that the sliding label is legible.
const TRANSITION = 'all 300ms ease-out'

export function BuildProgress({ phase, install, failed }: BuildProgressProps) {
  const currentIdx = Math.max(
    0,
    PHASES.findIndex((p) => p.id === phase),
  )

  // Index of the step the pointer is currently over, or null. Drives the
  // label reveal for steps that aren't the active one.
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  return (
    <div
      className="flex-none rounded-md border p-3"
      style={{
        borderColor: 'var(--border-color)',
        background: 'var(--section-background)',
      }}
      role="progressbar"
      aria-valuenow={currentIdx + 1}
      aria-valuemin={1}
      aria-valuemax={PHASES.length}
      aria-label={`Build phase: ${PHASES[currentIdx]?.label ?? 'unknown'}`}
      aria-live="polite"
    >
      <ol className="flex flex-wrap items-center gap-y-2">
        {PHASES.map((p, i) => {
          const done = i < currentIdx
          const active = i === currentIdx && phase !== 'done'
          const complete = phase === 'done' && i === PHASES.length - 1
          const isFailed = failed && i === currentIdx
          const hovered = i === hoveredIdx
          // Visible when the step is the current phase (running or failed on
          // it), the terminal Done step, or while the pointer is over it.
          // `isFailed` is spelled out rather than folded into `active`, because
          // `active` excludes the terminal phase — without it the failed step's
          // label stayed collapsed, contradicting the header comment above.
          // `complete` is included for the same reason on the success side: the
          // final frame should read "✓ Done", not seven bare circles.
          const showLabel = active || !!isFailed || hovered || complete

          // Circle colour cascade: failure > done/complete > active > future.
          // All four states use the same TRANSITION so a step going
          // future→active→done glides through blue then green.
          const circleStyle: React.CSSProperties = {
            transition: TRANSITION,
            ...(isFailed
              ? { background: 'var(--danger)', color: '#fff' }
              : done || complete
                ? { background: 'var(--success, #16a34a)', color: '#fff' }
                : active
                  ? { background: 'var(--classic-blue)', color: '#fff' }
                  : {
                      background:
                        'color-mix(in srgb, var(--muted-color) 20%, var(--section-background))',
                      color: 'var(--muted-color)',
                    }),
          }

          const labelStyle: React.CSSProperties = {
            transition: TRANSITION,
            color: isFailed
              ? 'var(--danger)'
              : active || hovered
                ? 'var(--font-color)'
                : 'var(--muted-color)',
            // Weight is what separates "this step is running" from "you're
            // just pointing at this step" — a hovered label reads at 400.
            fontWeight: active || isFailed ? 600 : 400,
            // A tall max-width upper bound so any real label fits; the
            // browser's overflow:hidden + whitespace-nowrap clip anything
            // longer. Actual reveal happens as fast as the text's intrinsic
            // width allows, which is what matters visually.
            maxWidth: showLabel ? '400px' : '0px',
            opacity: showLabel ? 1 : 0,
            marginLeft: showLabel ? '0.375rem' : '0px',
            // will-change gives the browser a hint to promote this element
            // to its own compositing layer — smoother max-width/opacity
            // animation on lower-end laptops without any measurable cost.
            willChange: 'max-width, opacity, margin-left',
          }

          const connectorStyle: React.CSSProperties = {
            background: done
              ? 'var(--success, #16a34a)'
              : 'color-mix(in srgb, var(--muted-color) 30%, transparent)',
            transition: TRANSITION,
          }

          return (
            <li
              key={p.id}
              className="flex items-center"
              // Hover reveal. On the <li> rather than the circle so the
              // label itself stays inside the hover target — anchoring to
              // the circle alone would make an expanded label flicker as
              // the pointer drifted onto the text it just revealed.
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() =>
                // Guard against a stale clear: if the pointer has already
                // moved to a neighbouring step, that step's mouseenter has
                // fired first and owns the state.
                setHoveredIdx((cur) => (cur === i ? null : cur))
              }
              style={{ cursor: 'default' }}
            >
              <span
                className={
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ' +
                  (active ? 'animate-pulse' : '')
                }
                style={circleStyle}
                aria-hidden="true"
              >
                {isFailed ? '✕' : done || complete ? <CheckIcon /> : i + 1}
              </span>
              <span
                className="inline-block overflow-hidden whitespace-nowrap text-[11px]"
                style={labelStyle}
                aria-hidden={!showLabel}
              >
                {p.label}
                {/* Live install counter — rendered inside the same label
                    element so it slides in with the label, not as a
                    separate DOM node that could pop in half a frame
                    later. */}
                {p.id === 'installing' && install.total > 0 && (
                  <span
                    className="ml-1 font-normal"
                    style={{ color: 'var(--muted-color)' }}
                  >
                    ({install.done}/{install.total})
                  </span>
                )}
              </span>
              {i < PHASES.length - 1 && (
                <span
                  className="@min-pane-2col:inline-block @min-pane-4col:w-10 mx-2 hidden h-px w-6"
                  style={connectorStyle}
                  aria-hidden="true"
                />
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
