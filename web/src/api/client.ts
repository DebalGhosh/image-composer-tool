// Typed API client for the ICT web UI backend.

import type {
  Manifest,
  ComposeRequest,
  ComposeResponse,
  BuildAccepted,
  BuildDetails,
  PackageSearchRequest,
  PackageSearchResponse,
} from './types'

const BASE = '/api/v1'

// ApiError carries the HTTP status alongside the human-readable message so
// callers can distinguish "build not on server" (404) from network failures
// or 5xx transients — the BuildView pane treats 404 as a permanent
// "gone from server" state and renders an explanatory empty state instead
// of masquerading it as a build failure.
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error?.message) msg = body.error.message
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  getManifest: () => jsonFetch<Manifest>('/manifest'),

  compose: (req: ComposeRequest) =>
    jsonFetch<ComposeResponse>('/templates/compose', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  // Merged-form compose: same request/response shape as compose(), but the
  // server returns the fully-merged YAML (base template + package overlays)
  // instead of the raw base. Used by the Advanced tab's package picker.
  composeMerged: (req: ComposeRequest) =>
    jsonFetch<ComposeResponse>('/templates/compose?form=merged', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  // Package search across the OS's configured repositories. `arch` defaults to
  // amd64; empty `q` returns a name-sorted listing (server caps at `limit`,
  // default 50 when omitted).
  searchPackages: (req: PackageSearchRequest) => {
    const arch = req.arch && req.arch.length > 0 ? req.arch : 'amd64'
    const params = new URLSearchParams({ os: req.os, arch })
    if (req.q && req.q.length > 0) params.set('q', req.q)
    if (req.limit !== undefined && req.limit !== null)
      params.set('limit', String(req.limit))
    return jsonFetch<PackageSearchResponse>(`/packages?${params.toString()}`)
  },

  // Fan a build out to a random idle worker in the Jenkins farm. Server picks
  // the worker (free-first, random fallback), triggers via buildWithParameters
  // with just TEMPLATE_YAML overridden, and returns a buildId keyed off the
  // same tracker used by the local-build path -- so /builds/{id}/logs and
  // /builds/{id}/details work transparently for dispatched builds too.
  dispatchJenkins: (yaml: string) =>
    jsonFetch<BuildAccepted>('/jenkins/dispatch', {
      method: 'POST',
      body: JSON.stringify({ yaml }),
    }),

  // Cancel an in-flight build. The endpoint arrives with Story 3; until then the
  // backend returns 404 and the caller surfaces that as a cancel failure.
  cancelBuild: (buildId: string) =>
    jsonFetch<void>(`/builds/${buildId}/cancel`, { method: 'POST' }),

  // Build command + resolved paths for the troubleshoot panel.
  buildDetails: (buildId: string) =>
    jsonFetch<BuildDetails>(`/builds/${buildId}/details`),

  // SSE log stream URL for a build.
  logsUrl: (buildId: string) => `${BASE}/builds/${buildId}/logs`,

  // Download URL for the exact template that was built.
  templateUrl: (buildId: string) => `${BASE}/builds/${buildId}/template`,
}
