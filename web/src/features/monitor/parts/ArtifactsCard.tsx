import { Card } from '@/components/layout/Card'
import { ArtifactoryDirectoryRow } from './ArtifactoryDirectoryRow'
import { ArtifactTable } from './ArtifactTable'
import type { Artifact, BuildDetails } from '@/api/types'

{/*
 * ARTIFACTS — appears only when there's something to link at.
 *
 * Normal case: exactly ONE row, the disk image's direct Artifactory
 * URL. The multi-GB image is never a Jenkins artifact (the pipeline
 * archives only UPLOAD-MANIFEST.txt + image-composer-tool.log), so the
 * backend scrapes it out of artifactory-upload.sh's per-file echoes and
 * composes the URL. That row supersedes the highlighted Artifactory
 * *directory* row, which is therefore hidden — see hasPublishedImage.
 *
 * Fallback (PUBLISH skipped / echo format drifted / build died before
 * Phase 6): the Jenkins-archived list plus the directory row, exactly
 * as this card rendered before.
 */}

/**
 * `hasPublishedImage` is derived here rather than passed in: it is a pure
 * function of `artifacts` and nothing outside this card reads it.
 *
 * Rendered by the parent only when there is something to link at, so this
 * component does not repeat that outer test.
 */
export function ArtifactsCard({
  artifacts,
  details,
  buildId,
  copyPath,
}: {
  artifacts: Artifact[]
  details: BuildDetails | null
  buildId: string
  copyPath: (path: string) => void
}) {
  // True once the backend resolved the published disk image out of the
  // PUBLISH stage's upload echoes. That single row already carries the full
  // Artifactory file URL, which makes the highlighted *directory* row above
  // it redundant — so it's suppressed. On the fallback path (no scrapable
  // upload) this stays false and the directory row renders as before.
  const hasPublishedImage = artifacts.some((a) => a.source === 'artifactory')

  return (
    <Card title="Artifacts" titleStyle="section" className="flex-none">
      {details?.jenkins?.artifactoryUrl && !hasPublishedImage && (
        <ArtifactoryDirectoryRow
          artifactoryUrl={details.jenkins.artifactoryUrl}
          copyPath={copyPath}
        />
      )}

      {artifacts.length > 0 && (
        <ArtifactTable
          artifacts={artifacts}
          buildId={buildId}
          copyPath={copyPath}
        />
      )}
    </Card>
  )
}
