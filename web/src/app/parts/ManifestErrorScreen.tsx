/**
 * Shown when the combination manifest fails to load.
 *
 * A dead end without the retry: nothing else in the app works without a manifest
 * — no cascade, no seed list, no build — so the screen offers the one action that
 * can recover. The undismissable toast raised alongside it (see
 * hooks/useManifestLoader) is acceptable precisely because this button exists.
 *
 * The port in the hint is deliberately concrete: an operator running this locally
 * needs to know what to go and check.
 *
 * Extracted verbatim from App in FE-7d.
 */
export function ManifestErrorScreen({
  error,
  onRetry,
}: {
  error: string | null
  onRetry: () => void
}) {
  return (
    <div className="m-6 text-sm" style={{ color: 'var(--muted-color)' }}>
      <p>Failed to load configuration: {error}</p>
      <p className="mt-1">Is the API server running on :8080?</p>
      <button
        className="mt-3 rounded border px-3 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
        style={{
          borderColor: 'var(--classic-blue)',
          color: 'var(--classic-blue)',
        }}
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  )
}
