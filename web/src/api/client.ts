// Typed API client for the ICT web UI backend.

import type {
  Manifest,
  ComposeRequest,
  ComposeResponse,
  BuildAccepted,
} from './types'

const BASE = '/api/v1'

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
    throw new Error(msg)
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

  startBuild: (req: ComposeRequest) =>
    jsonFetch<BuildAccepted>('/builds', {
      method: 'POST',
      body: JSON.stringify({ compose: req }),
    }),

  // Cancel an in-flight build. The endpoint arrives with Story 3; until then the
  // backend returns 404 and the caller surfaces that as a cancel failure.
  cancelBuild: (buildId: string) =>
    jsonFetch<void>(`/builds/${buildId}/cancel`, { method: 'POST' }),

  // SSE log stream URL for a build.
  logsUrl: (buildId: string) => `${BASE}/builds/${buildId}/logs`,
}
