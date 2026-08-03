import { describe, it, expect } from 'vitest'
import { API_BASE } from '@/api/client'
import { artifactUrl, buildLogsUrl } from '@/api/sse'

/**
 * Characterisation tests for the api/sse Adapter.
 *
 * The whole point of this module is that it is a MOVE, not a fix: BuildView used
 * to hand-write `/api/v1/builds/${buildId}/artifacts/${encodeURIComponent(name)}`
 * as a string literal, bypassing the client's BASE. These tests assert the new
 * function reproduces that literal EXACTLY, so the refactor is provably
 * behaviour-preserving. Routing it through the client is the move; changing what
 * it resolves to would be a fix, and belongs in a separate change.
 */

/** The literal BuildView.tsx used before FE-1, reproduced verbatim. */
function legacyArtifactUrl(buildId: string, name: string): string {
  return `/api/v1/builds/${buildId}/artifacts/${encodeURIComponent(name)}`
}

const BUILD_ID = '7a87747f-3d48-465b-82b3-755ef76a45b4'

describe('API_BASE', () => {
  it('is the single definition of the API prefix', () => {
    expect(API_BASE).toBe('/api/v1')
  })
})

describe('artifactUrl — byte-identical to the literal it replaced', () => {
  it('matches for ordinary artifact names', () => {
    for (const name of [
      'image-composer-tool.log',
      'UPLOAD-MANIFEST.txt',
      'debian13-x86_64-desktop-virtualization-13.0.iso',
      'minimal-os-image-debian-13.0.img',
      'vmlinuz-6.12.100+deb13-amd64',
    ]) {
      expect(artifactUrl(BUILD_ID, name)).toBe(legacyArtifactUrl(BUILD_ID, name))
    }
  })

  it('matches for names needing percent-encoding', () => {
    // '+' must become %2B or the server sees a space; '/' must become %2F or the
    // path gains a segment. Both are why encodeURIComponent is here.
    for (const name of [
      'my file v2.raw.gz',
      'name+with+plus.img',
      'nested/path.txt',
      'q?uery=1&x=2',
      'hash#frag',
      '100%.log',
      'ünïcode.iso',
    ]) {
      expect(artifactUrl(BUILD_ID, name)).toBe(legacyArtifactUrl(BUILD_ID, name))
    }
  })

  it('encodes the specific characters that would otherwise change the path', () => {
    expect(artifactUrl(BUILD_ID, 'a+b')).toContain('%2B')
    expect(artifactUrl(BUILD_ID, 'a/b')).toContain('%2F')
    expect(artifactUrl(BUILD_ID, 'a b')).toContain('%20')
    expect(artifactUrl(BUILD_ID, 'a?b')).toContain('%3F')
  })

  it('leaves the buildId un-encoded, exactly as before', () => {
    // buildId is a server-generated UUID: hex and hyphens, nothing to encode.
    // Asserted so nobody "tidies up" by encoding it and changing every URL.
    expect(artifactUrl(BUILD_ID, 'x')).toContain(`/builds/${BUILD_ID}/`)
  })

  it('is built from API_BASE rather than a second literal', () => {
    expect(artifactUrl(BUILD_ID, 'x').startsWith(`${API_BASE}/builds/`)).toBe(true)
  })

  it('handles an empty artifact name without throwing', () => {
    expect(artifactUrl(BUILD_ID, '')).toBe(`${API_BASE}/builds/${BUILD_ID}/artifacts/`)
  })
})

describe('buildLogsUrl', () => {
  it('mirrors api.logsUrl so the SSE stream and the client agree', () => {
    expect(buildLogsUrl(BUILD_ID)).toBe(`${API_BASE}/builds/${BUILD_ID}/logs`)
  })

  it('is byte-identical to api.logsUrl — two functions, one URL', async () => {
    // Both exist: api.logsUrl for callers already holding the client, and this
    // one so api/sse has no import cycle back into the component layer. They
    // must not drift.
    const { api } = await import('./client')
    for (const id of [BUILD_ID, 'abc', '']) {
      expect(buildLogsUrl(id)).toBe(api.logsUrl(id))
    }
  })
})
