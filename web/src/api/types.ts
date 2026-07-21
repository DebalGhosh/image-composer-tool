// Types mirroring api/v1/openapi-template-builder.yaml (hand-written for the
// Basic slice; can be replaced with openapi-typescript codegen later).

export interface Option {
  id: string
  displayName: string
}

export interface Target {
  id: string
  displayName: string
  os: string
  arch: string
}

export interface Combination {
  vertical: string
  sku?: string
  platform: string
  os: string
  // Optional kernel variant (e.g. "standard" | "rt"). Present only when a
  // vertical/platform/OS offers a real-time template variant; the UI gates the
  // kernel selector on its presence rather than hardcoding RT support.
  kernel?: string
  imageType: string
  template: string
}

export interface Manifest {
  combinations: Combination[]
  verticals: Option[]
  skus: Option[]
  platforms: Option[]
  targets: Target[]
}

export interface ComposeRequest {
  vertical: string
  sku?: string
  platform: string
  os: string
  kernel?: string
  imageType: string
}

export interface ComposeSummary {
  // Selection echo
  vertical: string
  sku: string
  platform: string
  os: string
  imageType: string
  // Template-derived
  imageName: string
  imageVersion: string
  description: string
  architecture: string
  kernelVersion: string
  packageCount: number
  diskSize: string
  partitionCount: number
  partitionTable: string
  hostname: string
}

export interface ComposeResponse {
  template: string
  yaml: string
  summary: ComposeSummary
}

export interface BuildAccepted {
  buildId: string
  status: string
  logsUrl: string
}

export interface Artifact {
  name: string
  type: 'image' | 'sbom'
  // Path is the local on-disk path for local builds; for Jenkins-dispatched
  // builds it's the artifact's job-relative path (display-only). URL is set
  // for Jenkins artifacts and points at their direct download endpoint --
  // when present, the UI prefers `url` over the proxy path.
  path?: string
  url?: string
}

// Jenkins-run metadata surfaced in BuildDetails for dispatched builds.
export interface JenkinsBuildInfo {
  worker: string
  jobUrl: string
  buildUrl: string
  buildNumber: number
  queueUrl?: string
  // Artifactory upload directory the PUBLISH stage echoed via:
  //   Artefacts published to: https://af01p-png.…/artifactory/…/<worker>/<datetime>/
  // Undefined until PUBLISH runs (mid-build).
  artifactoryUrl?: string
}

// Reproducibility/troubleshooting metadata for a build: the exact command that
// ran, the resolved template (+ a download URL), and either the per-build
// directories (local path) or the Jenkins-run metadata (dispatched path).
export interface BuildDetails {
  buildId: string
  status: string
  command: string
  template: string
  templateUrl: string
  workDir?: string
  cacheDir?: string
  summary?: ComposeSummary
  jenkins?: JenkinsBuildInfo
}

export interface BuildComplete {
  status: 'success' | 'failed'
  artifacts?: Artifact[]
  message?: string
}

export interface PackageSearchRequest {
  os: string
  arch?: string
  q?: string
  limit?: number
}

export interface PackageEntry {
  name: string
  version: string
  description: string
  arch: string
  section: string
  repository: string
  os: string
  type: string
  provides?: string[]
}

export interface PackageSearchResponse {
  query: string
  total: number
  packages: PackageEntry[]
}
