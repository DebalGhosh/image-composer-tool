// Typed API client for the ICT web UI backend.

import type {
  Manifest,
  ComposeRequest,
  ComposeResponse,
  BuildAccepted,
  BuildDetails,
  PackageDetails,
  PackageSearchRequest,
  PackageSearchResponse,
  PackageSearchResponseFull,
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

// buildPackagesQuery centralizes the (os, arch, q, limit) → URLSearchParams
// dance so searchPackages and searchPackagesFull stay in lockstep. Arch
// defaults to amd64 to match the microservice's own default.
function buildPackagesQuery(req: PackageSearchRequest): URLSearchParams {
  const arch = req.arch && req.arch.length > 0 ? req.arch : 'amd64'
  const params = new URLSearchParams({ os: req.os, arch })
  if (req.q && req.q.length > 0) params.set('q', req.q)
  if (req.limit !== undefined && req.limit !== null)
    params.set('limit', String(req.limit))
  return params
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
  // default 50 when omitted). Returns the legacy 9-field shape; callers that
  // need the enriched metadata (homepage, popcon, provides sub-object, etc.)
  // use searchPackagesFull below instead.
  searchPackages: (req: PackageSearchRequest) => {
    return jsonFetch<PackageSearchResponse>(
      `/packages?${buildPackagesQuery(req).toString()}`,
    )
  },

  // Same query surface as searchPackages, but asks the microservice for the
  // enriched shape (`fields=full`). Used by the PackageSearchDialog so its
  // detail pane can render homepage / popcon / provides / etc. from the
  // list-fetch response, avoiding a second round-trip on every keystroke.
  searchPackagesFull: (req: PackageSearchRequest) => {
    const params = buildPackagesQuery(req)
    params.set('fields', 'full')
    return jsonFetch<PackageSearchResponseFull>(`/packages?${params.toString()}`)
  },

  // Single-record lookup by (os, arch, name) — hit when the dialog wants the
  // full metadata for the currently-highlighted row (prefetch on hover /
  // focus). Falls through to a 404 when the backend has no pkgsvc wired
  // (PKGSVC_URL empty on the main backend); the dialog treats that as
  // "detail pane unavailable" and keeps working from list-response data.
  packageDetails: (os: string, arch: string, name: string) => {
    const enc = encodeURIComponent
    return jsonFetch<PackageDetails>(
      `/packages/${enc(os)}/${enc(arch)}/${enc(name)}`,
    )
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
