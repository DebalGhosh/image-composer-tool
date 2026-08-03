import type { Status } from '../hooks/useBuildStream'

/**
 * The failed/cancelled banner with its retry button.
 *
 * This is the surviving half of what used to be a dedicated "Build Status"
 * card. That card's information now lives in two places: the worker chip,
 * status pill and Jenkins link moved onto the corresponding history row in
 * BuildHistoryList, and the Retry affordance stayed inline here — because
 * retry needs `lastYamlRef`, which is scoped to the App-level dispatch state
 * rather than to the history entry.
 *
 * Rendered by the parent only when status is `failed` or `cancelled`, so this
 * component does not re-test that; it branches on which of the two it is to
 * pick the headline. `retrying` disables the button while the parent's dispatch
 * is in flight — the caller owns that state because a retry replaces the whole
 * build, not just this banner.
 *
 * Extracted verbatim from BuildView.
 */
export function FailureBanner({
  status,
  retrying,
  onRetry,
}: {
  status: Status
  retrying: boolean
  onRetry: () => Promise<void>
}) {
  return (
    <div
      className="flex-none rounded-md border p-3 text-xs"
      style={{
        borderColor:
          'color-mix(in srgb, var(--danger) 45%, var(--border-color))',
        background:
          'color-mix(in srgb, var(--danger) 6%, var(--section-background))',
        color: 'var(--font-color)',
      }}
    >
      <div className="flex items-center gap-3">
        <span className="font-semibold">
          {status === 'failed' ? 'Build failed.' : 'Build cancelled.'}
        </span>
        <span style={{ color: 'var(--muted-color)' }}>
          Inspect the log and retry when ready.
        </span>
        <button
          className="ml-auto cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
          style={{
            borderColor: 'var(--border-color)',
            color: 'var(--font-color)',
          }}
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? 'Starting…' : '↺ Retry'}
        </button>
      </div>
    </div>
  )
}
