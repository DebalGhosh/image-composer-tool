/**
 * The highlighted link to the build's Artifactory *directory*.
 *
 * Rendered only on the FALLBACK path — when the backend could not scrape the
 * published disk image out of artifactory-upload.sh's per-file echoes (PUBLISH
 * skipped, echo format drifted, or the build died before Phase 6). When the
 * scrape succeeds, ArtifactTable already carries the image's full file URL and
 * this directory-level row would be strictly less useful, so the parent
 * suppresses it via `hasPublishedImage`.
 *
 * Takes the URL as a plain string rather than the whole `details` object: the
 * parent has already narrowed it past both optional hops, which is also why
 * this component needs no non-null assertion where the original had one.
 *
 * Extracted verbatim from BuildView, via ArtifactsCard.
 */
export function ArtifactoryDirectoryRow({
  artifactoryUrl,
  copyPath,
}: {
  artifactoryUrl: string
  copyPath: (path: string) => void
}) {
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-3 rounded-md border p-3 text-xs"
      style={{
        borderColor:
          'color-mix(in srgb, var(--classic-blue) 45%, var(--border-color))',
        background:
          'color-mix(in srgb, var(--classic-blue) 6%, var(--section-background))',
      }}
    >
      <span
        className="font-semibold uppercase tracking-wider"
        style={{ color: 'var(--muted-color)' }}
      >
        Artifactory
      </span>
      <a
        className="flex-1 truncate font-mono text-[11px] underline"
        style={{ color: 'var(--classic-blue)' }}
        href={artifactoryUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={artifactoryUrl}
      >
        {artifactoryUrl}
      </a>
      <div className="flex items-center gap-1">
        <button
          className="cursor-pointer rounded border px-2 py-1 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          style={{
            borderColor: 'var(--border-color)',
            color: 'var(--muted-color)',
          }}
          title="Copy Artifactory URL to clipboard"
          // The original re-tested `details.jenkins &&` here. That guard was
          // for TypeScript's benefit inside the non-null assertion, not a
          // runtime condition — the enclosing JSX already required the URL to
          // be present. With the URL passed in as a narrowed string, both the
          // guard and the assertion are gone and behaviour is unchanged.
          onClick={() => copyPath(artifactoryUrl)}
        >
          Copy
        </button>
        <a
          className="cursor-pointer rounded border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          style={{
            borderColor: 'var(--classic-blue)',
            color: 'var(--classic-blue)',
          }}
          href={artifactoryUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the Artifactory directory in a new tab"
        >
          Open ↗
        </a>
      </div>
    </div>
  )
}
