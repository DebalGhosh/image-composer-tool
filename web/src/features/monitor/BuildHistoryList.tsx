/**
 * BuildHistoryList — left-pane list rendering for the Build Image tab.
 *
 * Each row: worker/build-# chip, status pill, started-at, Jenkins-link
 * button (if available), delete button. Clicking anywhere on the row
 * body (but not on Jenkins-link or delete buttons) selects it and
 * expands the right pane. The currently-selected row gets a highlight
 * ring so it's obvious which one you're looking at.
 *
 * Empty state: instructs the user to dispatch a build from another tab.
 *
 * All state lives in localStorage via useBuildHistory; this component
 * just renders + wires callbacks. Deletion is instant and irreversible
 * from the user's perspective (no undo) — local browser state, cheap
 * to lose.
 */

import { useEffect, useState } from 'react'
import type { BuildHistoryEntry, BuildHistoryStatus } from '@/lib/buildHistory'

interface BuildHistoryListProps {
  entries: BuildHistoryEntry[]
  selectedBuildId: string | null
  onSelect: (buildId: string) => void
  onDelete: (buildId: string) => void
  onClearAll?: () => void
  /**
   * Async cancel for a running build. The row disables its stop button
   * (spinner) while the promise is pending; on rejection the promise's
   * error is surfaced via the caller's usual toast path.
   */
  onCancel?: (buildId: string) => Promise<void>
}

export function BuildHistoryList({
  entries,
  selectedBuildId,
  onSelect,
  onDelete,
  onClearAll,
  onCancel,
}: BuildHistoryListProps) {
  // Re-render so formatRelative() re-reads the clock. Without this the
  // timestamps are frozen at whatever they said when the list last rendered
  // for some other reason — a row dispatched two minutes ago kept claiming
  // "2m ago" indefinitely.
  //
  // One timer here in the parent, not one per row: N rows would otherwise
  // mean N intervals all doing the same job.
  //
  // 30s, because formatRelative switches from seconds to minutes at 60s —
  // sampling faster than that boundary means no row is ever visibly stale,
  // and the cost is one setState per half-minute while the tab is open.
  const [, setNow] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setNow((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  return (
    // Distinct surface for the whole history pane (per user request
    // 2026-08-02). --section-background is the card token: white against the
    // page's #f4f5f5 in light, and DELIBERATELY darker than the page in dark
    // (#242528 on #2e2f32 — see the note at index.css:67), so the pane reads
    // as a separate surface in both themes rather than only one.
    //
    // The right border is on this element, not the Panel, so it hugs the list
    // and sits just inside the 8px drag handle. The parent Panel sets
    // `overflow: hidden` (BuildImagePage.tsx:166), which clips the border when
    // the pane animates to 0% width on collapse — no stray 1px line left
    // behind against the divider.
    <div
      className="flex h-full flex-col"
      style={{
        background: 'var(--section-background)',
        borderRight: '1px solid var(--border-color)',
      }}
    >
      <header
        className="flex flex-none items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--border-color)' }}
      >
        <h2
          className="text-sm font-semibold uppercase tracking-wide"
          style={{ color: 'var(--muted-color)' }}
        >
          Build history
        </h2>
        <span className="text-xs" style={{ color: 'var(--muted-color)' }}>
          {entries.length}
        </span>
      </header>

      {entries.length === 0 ? (
        <div className="flex flex-1 items-start justify-center overflow-hidden p-6">
          <div
            className="rounded-md border border-dashed p-6 text-center text-xs leading-relaxed"
            style={{
              borderColor: 'var(--border-color)',
              color: 'var(--muted-color)',
            }}
          >
            No builds yet in this session. Dispatch one from
            <br />
            the Basic, Advanced, or Interactive tab.
          </div>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-3">
          {entries.map((e) => (
            <HistoryRow
              key={e.buildId}
              entry={e}
              selected={e.buildId === selectedBuildId}
              onSelect={() => onSelect(e.buildId)}
              onDelete={() => onDelete(e.buildId)}
              onCancel={
                onCancel ? () => onCancel(e.buildId) : undefined
              }
            />
          ))}
        </ul>
      )}

      {entries.length > 0 && onClearAll && (
        <footer
          className="flex-none px-3 py-2"
          style={{ borderTop: '1px solid var(--border-color)' }}
        >
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Clear all ${entries.length} history entries?`)) {
                onClearAll()
              }
            }}
            className="w-full cursor-pointer rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            style={{
              borderColor: 'var(--border-color)',
              color: 'var(--muted-color)',
            }}
          >
            Clear all
          </button>
        </footer>
      )}
    </div>
  )
}

function HistoryRow({
  entry,
  selected,
  onSelect,
  onDelete,
  onCancel,
}: {
  entry: BuildHistoryEntry
  selected: boolean
  onSelect: () => void
  onDelete: () => void
  onCancel?: () => Promise<void>
}) {
  const jenkinsLink = entry.jenkinsBuildUrl ?? entry.jenkinsJobUrl
  const [cancelling, setCancelling] = useState(false)
  // Cancel is offered on any RUNNING row. We deliberately don't gate on
  // buildNo — that field is populated by BuildView's pollDetails, and
  // if the user hasn't opened the row in the right pane yet the poll
  // never fires so buildNo stays null indefinitely even though the
  // backend already has RawBuildURL. The backend returns a specific
  // CANCEL_TOO_EARLY 409 when the queue item hasn't resolved yet,
  // which the caller's toast surfaces cleanly.
  const canCancel = !!onCancel && entry.status === 'running'
  return (
    // Rest / hover / selected all live in `.history-row` (index.css) rather
    // than here. They have to: the background used to be an inline style,
    // which outranks any `hover:` utility, so the row could never have a
    // hover state no matter what classes it carried.
    //
    // overflow-hidden stays — it's what keeps the border from leaving a
    // stray 1px line against the divider while the pane animates to 0%
    // width (see the note on the wrapper above).
    //
    // focus-visible, not focus: keyboard users get a ring, a mouse click
    // doesn't leave one behind. Same treatment as Combobox / Select.
    <li
      className="history-row mb-2 cursor-pointer overflow-hidden rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--classic-blue)]"
      data-selected={selected}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <div className="px-3 py-2">
        {/* Row 1: worker/build-# chip and status pill */}
        <div className="mb-1 flex items-center gap-2">
          {/* Opaque plate, same reason as StatusBadge: mixed into
              transparent this chip fell to 3.58:1 on a selected row.
              --chip-worker-fg, not --classic-blue: the accent is too dark
              for a tinted plate in dark mode (3.95:1). See index.css. */}
          <span
            className="truncate rounded-full px-2 py-0.5 font-mono text-[10px]"
            style={{
              background:
                'color-mix(in srgb, var(--chip-worker-fg) var(--chip-tint), var(--section-background))',
              color: 'var(--chip-worker-fg)',
            }}
            title={
              entry.worker
                ? entry.worker +
                  (entry.buildNo ? ' · #' + entry.buildNo : '')
                : 'Waiting for Jenkins queue item to resolve'
            }
          >
            {entry.worker
              ? entry.worker + (entry.buildNo ? ' · #' + entry.buildNo : '')
              : 'queued…'}
          </span>
          <StatusBadge status={entry.status} />
          {/* Right-cluster: Stop (running only) + Delete. Both are
              icon-only, same shape / hit-area — muted colour by default,
              danger accent on hover. Stop swaps to a small spinner while
              the cancel request is pending. */}
          {canCancel && (
            <button
              type="button"
              onClick={async (e) => {
                e.stopPropagation()
                if (cancelling || !onCancel) return
                setCancelling(true)
                try {
                  await onCancel()
                } catch {
                  // caller surfaces the error via toast; we just re-enable
                } finally {
                  setCancelling(false)
                }
              }}
              disabled={cancelling}
              className="ml-auto inline-flex cursor-pointer items-center justify-center rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-60 hover:text-[var(--danger)] hover:bg-black/5 dark:hover:bg-white/10"
              style={{ color: 'var(--muted-color)' }}
              title="Stop the Jenkins build for this row"
              aria-label="Stop build"
            >
              {cancelling ? (
                <svg
                  className="h-3.5 w-3.5 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeOpacity="0.25"
                  />
                  <path
                    d="M12 3a9 9 0 0 1 9 9"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className={
              (canCancel ? '' : 'ml-auto ') +
              'inline-flex cursor-pointer items-center justify-center rounded p-1 transition-colors hover:bg-black/5 dark:hover:bg-white/10'
            }
            style={{ color: 'var(--muted-color)' }}
            title="Remove from history"
            aria-label="Remove from history"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Row 2: started-at (relative) + Jenkins link */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px]" style={{ color: 'var(--muted-color)' }}>
            {formatRelative(entry.startedAt)}
          </span>
          {jenkinsLink && (
            <a
              href={jenkinsLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="cursor-pointer text-[11px] underline"
              // --chip-worker-fg rather than --classic-blue: this link sits
              // directly on the row (no plate to lift it), and the row
              // surface now brightens on hover/selection. On Tine-1 that
              // bottomed out at 3.95:1 on a hovered+selected row; the
              // lighter accent holds 6.6:1 in the worst state.
              style={{ color: 'var(--chip-worker-fg)' }}
              title="Open the Jenkins pipeline-explorer logs for this build"
            >
              logs ↗
            </a>
          )}
        </div>
      </div>
    </li>
  )
}

/**
 * Status chip.
 *
 * Two things here are deliberate and easy to undo by accident:
 *
 * 1. The plate mixes the foreground into `var(--section-background)`, NOT
 *    into `transparent`. A `%, transparent` mix is a TRANSLUCENT fill, so the
 *    plate floats up with whatever the row is painting underneath — hover or
 *    select a row and every chip on it loses contrast (Done fell from 5.2:1
 *    to 4.47:1, the worker chip below to 3.58:1). An opaque mix makes the
 *    chip render identically in all three row states.
 *
 * 2. The foreground is `--chip-*-fg`, not `--warning` / `--success` /
 *    `--danger`. Those stay as they are because they're also solid fills
 *    (Header's build-indicator dot) and 1px borders (toasts), where the
 *    per-theme lightness a small-bold-text-on-a-plate needs would be wrong.
 *    See the token block in index.css for the measured ratios.
 *
 * The tint strength is `--chip-tint` (14% light / 16% dark) rather than a
 * literal, because one shared value can't serve both: 16% in light mode
 * drops Done to 4.46:1.
 *
 * Record<BuildHistoryStatus, ...> is load-bearing: it makes the compiler
 * reject a new status that forgets to add a chip style.
 */
function StatusBadge({ status }: { status: BuildHistoryStatus }) {
  const styles: Record<BuildHistoryStatus, { fg: string; label: string }> = {
    idle: { fg: 'var(--chip-idle-fg)', label: 'Idle' },
    running: { fg: 'var(--chip-running-fg)', label: 'Running' },
    success: { fg: 'var(--chip-success-fg)', label: 'Done' },
    failed: { fg: 'var(--chip-failed-fg)', label: 'Failed' },
    cancelled: { fg: 'var(--chip-idle-fg)', label: 'Cancelled' },
  }
  const s = styles[status]
  return (
    <span
      className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
      style={{
        background: `color-mix(in srgb, ${s.fg} var(--chip-tint), var(--section-background))`,
        color: s.fg,
      }}
    >
      {s.label}
    </span>
  )
}

/**
 * Human-friendly relative time. Not internationalised — the app doesn't
 * ship translations. Falls back to a locale date for anything ≥1 day.
 */
function formatRelative(epochMs: number): string {
  const now = Date.now()
  const diff = now - epochMs
  if (diff < 0) return 'just now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return s + 's ago'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ago'
  return new Date(epochMs).toLocaleString()
}
