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

interface BuildProgressProps {
  // Current phase id (one of PHASES.id).
  phase: string
  // Install-phase counter, when available (0/0 otherwise).
  install: { done: number; total: number }
  // Whether the build failed — the active step is shown in red.
  failed?: boolean
}

const PHASES: { id: string; label: string; short: string }[] = [
  { id: 'dispatching', label: 'Dispatching', short: 'Dispatch' },
  { id: 'preparing', label: 'Preparing', short: 'Prepare' },
  { id: 'packages', label: 'Resolving & downloading packages', short: 'Packages' },
  { id: 'installing', label: 'Installing packages', short: 'Install' },
  { id: 'generating', label: 'Generating image', short: 'Generate' },
  { id: 'publishing', label: 'Publishing artifacts', short: 'Publish' },
  { id: 'done', label: 'Done', short: 'Done' },
]

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
    >
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {PHASES.map((p, i) => {
          const done = i < currentIdx
          const active = i === currentIdx && phase !== 'done'
          const complete = phase === 'done' && i === PHASES.length - 1
          const isFailed = failed && i === currentIdx

          // Circle background: red on failure, green when complete, blue
          // when active (with pulse), muted when future.
          const circleStyle: React.CSSProperties = isFailed
            ? { background: 'var(--danger)', color: '#fff' }
            : done || complete
              ? { background: 'var(--success, #16a34a)', color: '#fff' }
              : active
                ? { background: 'var(--classic-blue)', color: '#fff' }
                : {
                    background:
                      'color-mix(in srgb, var(--muted-color) 20%, var(--section-background))',
                    color: 'var(--muted-color)',
                  }

          const labelStyle: React.CSSProperties = active
            ? { color: 'var(--font-color)', fontWeight: 600 }
            : done || complete
              ? { color: 'var(--font-color)' }
              : { color: 'var(--muted-color)' }

          const connectorStyle: React.CSSProperties = {
            background: done
              ? 'var(--success, #16a34a)'
              : 'color-mix(in srgb, var(--muted-color) 30%, transparent)',
          }

          return (
            <li key={p.id} className="flex items-center">
              <div className="flex items-center gap-1.5">
                <span
                  className={
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ' +
                    (active ? 'animate-pulse' : '')
                  }
                  style={circleStyle}
                  aria-hidden="true"
                >
                  {isFailed ? '✕' : done || complete ? '✓' : i + 1}
                </span>
                <span className="text-[11px]" style={labelStyle}>
                  {/* Full label on md+, short label on small screens */}
                  <span className="hidden md:inline">{p.label}</span>
                  <span className="md:hidden">{p.short}</span>
                  {/* Live counter during the install phase */}
                  {active && p.id === 'installing' && install.total > 0 && (
                    <span
                      className="ml-1 font-normal"
                      style={{ color: 'var(--muted-color)' }}
                    >
                      ({install.done}/{install.total})
                    </span>
                  )}
                </span>
              </div>
              {i < PHASES.length - 1 && (
                <span
                  className="mx-1.5 hidden h-px w-4 sm:inline-block lg:w-6"
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
