/**
 * The sticky Build Image action bar.
 *
 * Anchored at the bottom of the viewport regardless of pane scroll position, and
 * blurs the content behind it so the seam reads as intentional in either theme
 * (the `.action-footer` class in index.css owns that).
 *
 * Disabled until the cascade is complete AND no dispatch is in flight — a second
 * click would queue a duplicate Jenkins job.
 *
 * Extracted verbatim from BasicPage in FE-7c.
 */
export function BuildFooter({
  complete,
  busy,
  onBuild,
}: {
  complete: boolean
  busy: boolean
  onBuild: () => void
}) {
  return (
    <footer className="action-footer">
      <div className="flex items-center gap-3 px-6 py-3">
        <button
          className="rounded-md px-5 py-2.5 font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: 'var(--metrics-gradient)' }}
          disabled={!complete || busy}
          onClick={onBuild}
        >
          {busy ? 'Starting…' : 'Build Image'}
        </button>
        {!complete && (
          <span className="text-sm text-[var(--muted-color)]">
            Complete all selections to build.
          </span>
        )}
      </div>
    </footer>
  )
}
