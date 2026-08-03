/**
 * The sticky Build Image bar, with the reason the button is disabled.
 *
 * Same `.action-footer` treatment as the Basic tab for visual parity.
 *
 * The hint text is derived from the gates in priority order, so an operator with
 * several problems is told about one at a time rather than all at once — which is
 * the opposite of how the banners above behave, and intentional: the footer has
 * one line to work with.
 *
 * Extracted verbatim from AdvancedPage in FE-7d.
 */
export function AdvancedFooter({
  canBuild,
  busy,
  empty,
  tooLarge,
  invalid,
  blockedByPlaceholders,
  onBuild,
}: {
  canBuild: boolean
  busy: boolean
  empty: boolean
  tooLarge: boolean
  invalid: boolean
  blockedByPlaceholders: boolean
  onBuild: () => void
}) {
  return (
    <footer className="action-footer">
      <div className="flex flex-wrap items-center gap-3 px-6 py-3">
        <button
          className="rounded-md px-5 py-2.5 font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: 'var(--metrics-gradient)' }}
          disabled={!canBuild}
          onClick={onBuild}
        >
          {busy ? 'Starting…' : 'Build Image'}
        </button>
        {empty && (
          <span className="text-sm text-[var(--muted-color)]">
            Paste template YAML to build.
          </span>
        )}
        {!empty && invalid && (
          <span className="text-sm" style={{ color: 'var(--danger)' }}>
            Fix the YAML syntax error to build.
          </span>
        )}
        {!empty && !invalid && tooLarge && (
          <span className="text-sm" style={{ color: 'var(--danger)' }}>
            YAML exceeds 200 KB — trim before building.
          </span>
        )}
        {!empty && !invalid && !tooLarge && blockedByPlaceholders && (
          <span className="text-sm" style={{ color: 'var(--warning)' }}>
            Resolve placeholders or acknowledge the override to build.
          </span>
        )}
      </div>
    </footer>
  )
}
