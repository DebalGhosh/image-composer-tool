// Visual stepper showing the current image-composition phase. Phases are
// derived server-side from the build log (best-effort) and delivered via SSE
// "phase" events; see internal/api/phases.go.
//
// Adapted from upstream's BuildProgress but retuned for our Jenkins-dispatched
// flow: adds a "Dispatching" step at the front (covers the queue wait +
// docker-pull window before ICT itself starts) and a "Publishing" step at the
// back (covers the Artifactory upload, which for our images typically takes
// 1-2 minutes AFTER ICT reports "Done"). Colours are driven by our CSS
// variables so the stepper sits correctly in both light and dark themes.
//
// Compact-labels design (per user request 2026-07-23):
//   * Only the currently-active step shows its text label — inactive steps
//     collapse to just the numbered circle.
//   * As phase advances, the active step's label collapses (max-width → 0,
//     opacity → 0) while the newly-active step's label expands from 0 to its
//     natural width, giving a horizontal "sliding" effect.
//   * Circle background and connector color transition on the same 300ms
//     ease-out so the whole row shifts state as one motion.
//   * A failed step keeps its label so the user can still see WHERE the
//     build stopped without hovering; the circle turns red with an ✕.

interface BuildProgressProps {
  // Current phase id (one of PHASES.id).
  phase: string
  // Install-phase counter, when available (0/0 otherwise).
  install: { done: number; total: number }
  // Whether the build failed — the active step is shown in red.
  failed?: boolean
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
          // Label is visible only when the step is the current phase (running
          // OR failed on it). Everything else shows just the circle.
          const showLabel = active

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
              : active
                ? 'var(--font-color)'
                : 'var(--muted-color)',
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
            <li key={p.id} className="flex items-center">
              <span
                className={
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ' +
                  (active ? 'animate-pulse' : '')
                }
                style={circleStyle}
                aria-hidden="true"
              >
                {isFailed ? '✕' : done || complete ? '✓' : i + 1}
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
                  className="mx-2 hidden h-px w-6 sm:inline-block lg:w-10"
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
