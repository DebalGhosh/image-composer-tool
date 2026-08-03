import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ArtifactsCard } from './ArtifactsCard'
import type { Artifact, BuildDetails } from '@/api/types'

/**
 * ArtifactsCard's only logic is the SUPPRESSION RULE, and it is worth a test of
 * its own because getting it wrong is silently confusing rather than broken:
 *
 *   once the backend has scraped the published image out of the PUBLISH stage's
 *   upload echoes, that single table row carries the image's full Artifactory
 *   file URL — so the highlighted Artifactory *directory* row above it is
 *   redundant and gets hidden. On the fallback path (PUBLISH skipped, echo
 *   format drifted, build died before Phase 6) the directory row is the only
 *   pointer the operator has, so it must stay.
 *
 * `hasPublishedImage` keys off `source === 'artifactory'`, NOT off the presence
 * of a url — Jenkins-archived artifacts have urls too.
 */

const withDir = {
  command: 'ict compose …',
  template: 'seed.yaml',
  jenkins: {
    worker: 'worker-07',
    buildNumber: 18,
    buildUrl: 'https://jenkins.example.com/job/ict/18/',
    jobUrl: 'https://jenkins.example.com/job/ict/',
    artifactoryUrl: 'https://af.example.com/ict-local/images/',
  },
} as BuildDetails

const publishedImage = {
  name: 'my-image.iso',
  type: 'image',
  path: 'ict-local/images/my-image.iso',
  url: 'https://af.example.com/ict-local/images/my-image.iso',
  size: 966_002_688,
  source: 'artifactory',
} as Artifact

const jenkinsArchived = {
  name: 'UPLOAD-MANIFEST.txt',
  type: 'image',
  url: 'https://jenkins.example.com/job/ict/18/artifact/UPLOAD-MANIFEST.txt',
  source: 'jenkins',
} as Artifact

const dirRow = () => screen.queryByText('Artifactory')

describe('ArtifactsCard', () => {
  afterEach(cleanup)

  it('HIDES the directory row once a published image is present', () => {
    render(
      <ArtifactsCard
        artifacts={[publishedImage]}
        details={withDir}
        buildId="b1"
        copyPath={vi.fn()}
      />,
    )
    expect(dirRow()).toBeNull()
    // The image row supersedes it and carries the full file URL.
    expect(
      screen.getByRole('link', { name: 'my-image.iso' }).getAttribute('href'),
    ).toBe(publishedImage.url)
  })

  it('SHOWS the directory row on the fallback path (Jenkins artifacts only)', () => {
    render(
      <ArtifactsCard
        artifacts={[jenkinsArchived]}
        details={withDir}
        buildId="b1"
        copyPath={vi.fn()}
      />,
    )
    expect(dirRow()).not.toBeNull()
    expect(screen.getAllByRole('link', { name: /af\.example\.com/ }).length)
      .toBeGreaterThan(0)
  })

  it('keys the suppression on source, not on the presence of a url', () => {
    // jenkinsArchived HAS a url. If the rule tested `a.url` instead of
    // `a.source === 'artifactory'`, the directory row would wrongly vanish
    // here and the operator would lose their only pointer at Artifactory.
    render(
      <ArtifactsCard
        artifacts={[jenkinsArchived]}
        details={withDir}
        buildId="b1"
        copyPath={vi.fn()}
      />,
    )
    expect(dirRow()).not.toBeNull()
  })

  it('shows the directory row alone when there are no artifacts yet', () => {
    render(
      <ArtifactsCard
        artifacts={[]}
        details={withDir}
        buildId="b1"
        copyPath={vi.fn()}
      />,
    )
    expect(dirRow()).not.toBeNull()
    // No empty table with just headers.
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows the table alone when there is no artifactoryUrl', () => {
    const noDir = { ...withDir, jenkins: { ...withDir.jenkins! } }
    delete (noDir.jenkins as Record<string, unknown>).artifactoryUrl
    render(
      <ArtifactsCard
        artifacts={[jenkinsArchived]}
        details={noDir as BuildDetails}
        buildId="b1"
        copyPath={vi.fn()}
      />,
    )
    expect(dirRow()).toBeNull()
    expect(screen.getByRole('table')).toBeTruthy()
  })

  it('tolerates a null details (local build, no Jenkins at all)', () => {
    render(
      <ArtifactsCard
        artifacts={[jenkinsArchived]}
        details={null}
        buildId="b1"
        copyPath={vi.fn()}
      />,
    )
    expect(dirRow()).toBeNull()
    expect(screen.getByRole('table')).toBeTruthy()
  })

  it('passes copyPath through to the directory row', async () => {
    const copy = vi.fn()
    render(
      <ArtifactsCard
        artifacts={[]}
        details={withDir}
        buildId="b1"
        copyPath={copy}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(copy).toHaveBeenCalledWith(
      'https://af.example.com/ict-local/images/',
    )
  })
})
