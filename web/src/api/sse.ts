/**
 * Adapter over the browser's EventSource, plus the build URLs that were being
 * hand-built at call sites.
 *
 * WHY THIS EXISTS
 *
 * `BuildView` constructed `new EventSource(...)` inline and, for artifact
 * downloads, assembled `/api/v1/builds/${buildId}/artifacts/${name}` as a
 * string literal — bypassing `api/client.ts`'s `BASE`. Two definitions of where
 * the API lives means changing `BASE` (a deployment behind a path prefix, say)
 * silently breaks artifact links only, and nothing type-checks the difference.
 *
 * ⚠️ THIS IS A MOVE, NOT A FIX. `artifactUrl` below reproduces the previous
 * string EXACTLY, including `encodeURIComponent` on the name and no encoding of
 * the buildId. Changing what the URL resolves to would be a behaviour change,
 * which this refactor does not do — `api/sse.artifactUrl` is asserted against
 * the literal it replaces in sse.test.ts.
 */

import { API_BASE } from '@/api/client'

/** SSE event names the backend emits on the build log stream. */
export type BuildStreamEvent = 'log' | 'phase' | 'complete' | 'error'

/**
 * Open the build's log stream.
 *
 * A thin factory rather than a wrapper class: the caller still owns the
 * EventSource and its listeners, because the listener set is genuinely
 * BuildView's business (it routes `log`, `phase` and `complete` into three
 * different pieces of state and distinguishes a never-opened 404 from a
 * mid-stream transport hiccup). Wrapping that would have moved the complexity,
 * not removed it.
 */
export function openBuildStream(buildId: string): EventSource {
  return new EventSource(buildLogsUrl(buildId))
}

/** SSE log-stream URL for a build. Mirrors `api.logsUrl`. */
export function buildLogsUrl(buildId: string): string {
  return `${API_BASE}/builds/${buildId}/logs`
}

/**
 * Local proxy download URL for one artifact of a build.
 *
 * Used only as a FALLBACK: when the backend supplies `artifact.url` (a
 * Jenkins-hosted or Artifactory link) that wins. This path is for artifacts the
 * backend serves itself.
 *
 * `encodeURIComponent` on the name, matching the original literal — artifact
 * names carry dots and can carry spaces or '+'. buildId is a server-generated
 * UUID and is interpolated raw, exactly as before.
 */
export function artifactUrl(buildId: string, artifactName: string): string {
  return `${API_BASE}/builds/${buildId}/artifacts/${encodeURIComponent(artifactName)}`
}
