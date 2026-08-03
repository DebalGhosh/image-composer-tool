/**
 * Shown when the server has no record of the selected buildId.
 *
 * Almost always a localStorage history row that outlived a backend restart:
 * `ict.buildHistory.v1` is persisted, the backend's build tracker is in-memory.
 * Distinct from `failed` — the build did not fail, we simply cannot fetch its
 * state any more, so the pane says exactly that instead of rendering a stepper
 * plus "Waiting for build output…" and implying a live build.
 *
 * The history row keeps whatever status was last written locally. No lying, no
 * spurious failures.
 *
 * Extracted verbatim from BuildView's early return. Presentational, no props.
 */
export function UnavailableNotice() {
  return (
    <div
      className="flex-none rounded-md border p-6 text-sm"
      style={{
        borderColor: 'var(--border-color)',
        background: 'var(--section-background)',
        color: 'var(--font-color)',
      }}
    >
      <div className="mb-2 font-semibold">
        Build details are no longer available on the server.
      </div>
      <div style={{ color: 'var(--muted-color)' }}>
        This row is only in local history. The backend was likely
        restarted since the build ran — logs and artifacts for it are
        no longer served. You can still delete it from the list or
        open the Jenkins link if one was captured.
      </div>
    </div>
  )
}
