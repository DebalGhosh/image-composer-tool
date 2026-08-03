import { artifactUrl } from '@/api/sse'
import { formatBytes } from '../model/bytes'
import type { Artifact } from '@/api/types'

/**
 * The four-column artifact table: Name, Type, Path, Actions.
 *
 * Two per-row derivations carry rationale worth keeping:
 *   - `href` prefers the artifact's own URL (Artifactory / Jenkins-hosted) and
 *     falls back to the local proxy path.
 *   - `key` is name+index because Jenkins artifacts may repeat filenames across
 *     nested relative paths, so the name alone is not unique.
 *
 * Size is known only for published (Artifactory) artifacts and is surfaced as a
 * ROW TOOLTIP rather than a fifth column, deliberately: the four-column layout
 * is unchanged from before the publish-scraper landed.
 *
 * Extracted verbatim from BuildView, via ArtifactsCard.
 */
export function ArtifactTable({
  artifacts,
  buildId,
  copyPath,
}: {
  artifacts: Artifact[]
  buildId: string
  copyPath: (path: string) => void
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr
          className="text-left text-[11px] font-semibold uppercase tracking-wider"
          style={{
            background:
              'color-mix(in srgb, var(--classic-blue) 8%, var(--section-background))',
            color: 'var(--muted-color)',
          }}
        >
          <th className="px-3 py-2">Name</th>
          <th className="px-3 py-2">Type</th>
          <th className="px-3 py-2">Path</th>
          <th className="px-3 py-2 text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {artifacts.map((a, i) => {
          // Prefer a Jenkins-hosted URL when the artifact carries one; fall
          // back to the local proxy path otherwise. `key` uses name+index
          // because Jenkins artifacts may repeat filenames across nested
          // relative paths.
          const href = a.url ?? artifactUrl(buildId, a.name)
          const display = a.path ?? a.url ?? a.name
          // Size is only known for published (Artifactory) artifacts;
          // surfaced as a row tooltip rather than a new column so the
          // 4-column layout is untouched.
          const rowTitle = a.size
            ? `${a.name} — ${formatBytes(a.size)}`
            : a.name
          return (
            <tr
              key={a.name + ':' + i}
              className="border-b"
              style={{ borderColor: 'var(--border-color)' }}
              title={rowTitle}
            >
              <td className="px-3 py-2 font-mono text-xs">
                {a.url ? (
                  <a
                    className="underline"
                    style={{ color: 'var(--classic-blue)' }}
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {a.name}
                  </a>
                ) : (
                  a.name
                )}
              </td>
              <td
                className="px-3 py-2 text-[11px] uppercase tracking-wide"
                style={{ color: 'var(--muted-color)' }}
              >
                {a.type}
              </td>
              <td
                className="break-all px-3 py-2 font-mono text-xs"
                style={{ color: 'var(--muted-color)' }}
              >
                {display}
              </td>
              <td className="px-3 py-2 text-right">
                <div className="flex items-center justify-end gap-1">
                  <button
                    className="cursor-pointer rounded border px-2 py-1 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                    style={{
                      borderColor: 'var(--border-color)',
                      color: 'var(--muted-color)',
                    }}
                    title={
                      a.url
                        ? 'Copy download URL to clipboard'
                        : 'Copy path to clipboard'
                    }
                    // Prefer the URL over `display`: the PATH column
                    // now shows the Artifactory repo-relative path,
                    // which isn't independently fetchable. The full
                    // URL is what the operator pastes into curl / a
                    // browser / a downstream job.
                    onClick={() => copyPath(a.url ?? display)}
                  >
                    Copy
                  </button>
                  <a
                    className="cursor-pointer rounded border px-2 py-1 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                    style={{
                      borderColor: 'var(--border-color)',
                      color: 'var(--muted-color)',
                    }}
                    title="Download artifact"
                    href={href}
                    download={a.name}
                    target={a.url ? '_blank' : undefined}
                    rel={a.url ? 'noopener noreferrer' : undefined}
                  >
                    Download
                  </a>
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
