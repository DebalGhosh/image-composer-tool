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
  // 'legacy' (default) preserves the 9-field shape the inline combobox
  // consumes; 'full' asks the microservice for its enriched
  // PackageDetails shape (homepage, popcon, provides sub-object, etc.),
  // which the expanded PackageSearchDialog reads directly without a
  // second round-trip.
  fields?: 'legacy' | 'full'
}

// PackageEntry is the byte-identical 9-field legacy shape the frontend
// has consumed since day one. New callers requesting `fields=full` get
// PackageDetails — which is a strict superset — so mixing the two in a
// response array (as `PackageEntry | PackageDetails`) is safe.
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

// PackageDetails is the enriched shape ict-pkgsvc returns for
// `fields=full` searches and for the single-record lookup at
// GET /api/v1/packages/{os}/{arch}/{name}. Every field beyond the
// PackageEntry set is optional because AppStream/popcon coverage is
// partial upstream — a package with no popcon signal still renders
// correctly, its popularity block is just absent.
//
// `provides` is intentionally re-typed here (not extending
// PackageEntry.provides) because the enriched shape splits it into
// kind-buckets rather than a flat string list.
export interface PackageDetails {
  // Identity (mirrors PackageEntry base).
  name: string
  version: string
  description: string
  arch: string
  section: string
  repository: string
  os: string
  type: string
  // Enriched fields (all optional — pkgsvc only sets what upstream
  // metadata carried).
  release?: string
  component?: string
  summary?: string
  homepage?: string
  installedSize?: number
  multiArch?: string
  tags?: string[]
  categories?: string[]
  keywords?: string[]
  tasks?: string[]
  provides?: {
    binary?: string[]
    library?: string[]
    mimetype?: string[]
    dbus?: string[]
    python?: string[]
    font?: string[]
    firmware?: string[]
  }
  screenshots?: string[]
  depends?: string[]
  recommends?: string[]
  suggests?: string[]
  popularity?: {
    inst: number
    vote: number
    old?: number
    recent: number
  }
  sourceUrl?: string
  lastSeen?: string
}

// Response for a legacy-shape search — every element is a PackageEntry.
// Historical callers (inline PackageSearchCombobox) rely on this narrow
// type, so it stays the default.
export interface PackageSearchResponse {
  query: string
  total: number
  packages: PackageEntry[]
}

// Response for `fields=full` — every element is a fully enriched
// PackageDetails. The client provides an overloaded api.searchPackages
// so `fields: 'full'` narrows to this shape without a cast at call
// sites, while default calls keep returning PackageSearchResponse.
export interface PackageSearchResponseFull {
  query: string
  total: number
  packages: PackageDetails[]
}
