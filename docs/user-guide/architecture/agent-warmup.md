# Agent warmup — end-to-end context for a fresh clone

## Purpose

This document is the single-file starting point for a coding agent (or a
new engineer) that just cloned the fork and needs to be productive within
minutes. It's not a tutorial and it does not re-explain concepts the reader
already knows — every mention of a function name, file path, environment
variable, or port is verifiable in the current tree. Read it end-to-end
once; then jump to the deeper docs cross-referenced at the bottom.

The fork ships a three-container web application (frontend, main backend,
`ict-pkgsvc`) that lets a user compose an ICT image template in a browser
and dispatch the actual build to a Jenkins worker farm. The end product is
a signed image plus an SBOM, uploaded to Intel's Artifactory. Every stage
of that pipeline lives in a different place; this doc lays out where each
stage lives and how the stages connect.

## Repos to clone

The fork touches seven Git repositories plus one local, non-clonable
scratch directory. All of them live side-by-side under
`/home/debalgho/ICT-triage/` in this workspace; a fresh clone anywhere
else works the same way as long as the sibling relationship is preserved
(a couple of scripts and cocoon workflows reference sibling paths).

| Repo | Branch | Role | Required |
|---|---|---|---|
| `DebalGhosh/image-composer-tool` | `fork-main` | The fork — every UI, backend, and pkgsvc change lives here. `origin` remote points at the upstream `open-edge-platform/image-composer-tool` for parity checks; the `fork` remote is where changes actually get pushed. | Yes |
| `intel-innersource/libraries.devops.jenkins.cac` | `ict/experimental` | Jenkins Configuration-as-Code. Contains the ICT-QA templatized job family (`cac/gen/lin/core-os/ict-qa-templatized/`) and the meta-pipeline that bakes the `ict-builder` container image (`cac/gen/lin/core-os/ict-builder/`). | Yes, when touching the farm |
| `intel-sandbox/ICT-pipeline-helpers` | `feat/worker-seed` | External Groovy shared library carrying the actual pipeline bodies (`ictBuild`, `ictSeed`, `ictSchedulerParallel`, `ictWorkerSeed`). The Jenkinsfiles in `libraries.devops.jenkins.cac` are thin loader stubs that call `library(retriever: modernSCM(…))` against this repo. Not present in this workspace by default. | Optional |
| `intel-innersource/applications.automation.smart-software-factory.ui` | `main` | Reference UI project. The `PackageSearchDialog` overlay's slide-in mechanic is inspired by its `DialogWrapper` component (`src/components/dialogWrapper/`). | Optional (reference only) |
| `intel-sandbox/yocto.meta-intel.qa-automation` | `main` | Sibling Yocto farm. Kept for parity — the ICT templatized-pipeline shape mirrors the meta-intel one. | Optional |
| `intel-sandbox/yocto.meta-intel.templatized-pipeline-helpers` | `improvement/yamlBased` | Shared library for the Yocto farm; parallel to `ICT-pipeline-helpers`. | Optional |
| `intel-sandbox/yocto.community.qa-automation` | `main` | Sibling community-Yocto farm. | Optional |
| `intel-sandbox/ICT.qa-automation` | generated | Not cloned directly. Materialised by `ict-qa-workspace/populate-ict-qa-automation.sh` in this workspace. Treat `ict-qa-workspace/` as a local staging area, not a remote. | Generated |

Copy-pasteable minimal setup (the essential three):

    mkdir -p ~/ICT-triage && cd ~/ICT-triage
    git clone https://github.com/DebalGhosh/image-composer-tool.git
    cd image-composer-tool
    git remote add origin https://github.com/open-edge-platform/image-composer-tool.git
    git fetch --all
    git worktree add ../image-composer-tool-next -b fork-next
    git worktree add ../image-composer-tool-next-b -b fork-next-b
    cd ..
    git clone -b ict/experimental \
      https://github.com/intel-innersource/libraries.devops.jenkins.cac.git

The worktree pattern matters. One `.git` directory, shared metadata,
per-worktree branch state — so you can hold three concurrent branches
open (typically `fork-main`, `fork-next`, `fork-next-b`) with independent
working copies without ever running `git stash`. Every commit lands on
whichever worktree you `cd` into; the other trees see the commit the
moment they `git checkout`.

## Directory layout

Under `/home/debalgho/ICT-triage/`:

    ICT-triage/
      image-composer-tool/               # fork-main; primary tree
      image-composer-tool-next/          # fork-next; worktree
      image-composer-tool-next-b/        # fork-next-b; worktree (usually runs the dev server)
      libraries.devops.jenkins.cac/      # branch ict/experimental
      applications.automation.smart-software-factory.ui/
      yocto.meta-intel.qa-automation/
      yocto.meta-intel.templatized-pipeline-helpers/
      yocto.community.qa-automation/
      ict-qa-workspace/                  # local scratchpad, NOT a git repo
      failure-logs/                      # captured build failures for post-mortem
      parameters/                        # cocoon input YAMLs
      blocks/                            # Python "blocks" cocoon engine
      bin/                               # shims (apt-get, curl, go, sudo, tar, …)
      main.yaml                          # cocoon workflow entrypoint
      SESSION_HANDOFF.md, CHECKPOINT.md  # session state left by prior agents

The three `image-composer-tool*` trees are git worktrees of the same
repository. They share `.git/`; each holds one of the four owned
branches (`main`, `fork-main`, `fork-next`, `fork-next-b`). The `fork/`
remote on GitHub carries the same four branches; they're kept converged
by the release process — commits land on `fork-main` first, then
fast-forward propagates.

`ict-qa-workspace/` is not clonable. Its `populate-ict-qa-automation.sh`
generates a working tree in `repos/` that pushes orphan branches into
`intel-sandbox/ICT.qa-automation`. Treat it as generated output.

## End-to-end request flow

### Build dispatch flow

A user click on the Interactive tab's Build Image button traces this
path from browser to signed image:

    Browser
      │  Interactive tab → Build Image click
      ▼
    Frontend (nginx in prod, Vite in dev)
      │  POST /api/v1/jenkins/dispatch  body={yaml: "..."}
      ▼
    Main backend (Go, image-composer-tool serve on :8080)
      │  1. Validate YAML, register in-memory build with a UUID
      │     (internal/api/builds.go, buildTracker).
      │  2. jenkinsClient.listWorkers → pickWorker (free-first, random
      │     fallback) over ict-farm/workers (internal/api/jenkins.go).
      │  3. Jenkins buildWithParameters(TEMPLATE_YAML=<...>) via
      │     REST call to $JENKINS_URL.
      │  4. runJenkinsBuild goroutine tails progressiveText into
      │     build.logLines using the broadcast-wake pattern in
      │     internal/api/builds.go's appendLog.
      ▼                                     ▲
    Jenkins controller                      │
      │  Queue item → build number          │  SSE stream back:
      │  Queues a worker-N job.             │  log lines +
      ▼                                     │  phase events +
    Worker (worker-01 … worker-N)           │  final complete/error
      │  Loads ictHelpers library, calls    │  event when b.done closes.
      │  ictBuild(variant, worker: true,    │  Frontend BuildView subscribes
      │           dockerMode: true).        │  to /api/v1/builds/{id}/logs.
      │  Pulls ict-builder image from
      │  amr-registry.caas.intel.com/esc-devops/abi/plat/gen/lin/core-os/ict-builder.
      │  Runs entrypoint.sh, which writes
      │  its current stage marker into
      │  /tmp/.entrypoint_stage:
      │    startup → validate-config → flock → clone →
      │    materialise-inputs → go-build → ict-build →
      │    stage-artefacts → handoff.
      ▼
    ict-builder container (per-build, ephemeral)
      │  sudo image-composer-tool build <template.yml>
      │  cmd/image-composer-tool/build.go orchestrates
      │  (see "ICT build engine" below).
      ▼
    Artifactory
      https://af01p-png.devtools.intel.com/artifactory/core-os-yocto-png-local/
        <jobName>/<datetime>/<image + SBOM>

The Artifactory URL is echoed by the PUBLISH stage of `ictBuild`. The
main backend's `runJenkinsBuild` captures it from the tailed log via
`captureArtifactoryURL` (`internal/api/jenkins.go`) and stores it on the
build record's `Jenkins.ArtifactoryURL`. The frontend surfaces it in the
Build Details panel and as a prominent hyperlink on success.

### Package search flow

The Interactive tab's Packages field (and its expanded `Cmd+K` dialog)
resolve through a separate, parallel side-flow:

    Browser (Interactive tab, Packages field or Cmd+K dialog)
      │  GET /api/v1/packages?q=&os=&arch=&fields=(legacy|full)
      ▼
    Main backend
      │  internal/api/handlers_packages.go — handleSearchPackages
      │  When Config.PkgsvcURL is set:
      │    httputil.NewSingleHostReverseProxy → PKGSVC_URL/search
      │    with fields=legacy forced unless the caller opts into full.
      │  When empty: falls back to the embedded shard scan (32 records).
      ▼
    ict-pkgsvc (Go, /search on :9090)
      │  Bleve v2 in-process index. Fresh corpus via periodic refresh:
      │    dists/<suite>/InRelease SHA256 check →
      │    Packages.xz (main+universe) parse →
      │    dep11 AppStream overlay (keywords, categories, provides) →
      │    popcon by_inst merge (popularity signal) →
      │    Bleve ingest → atomic swap under RWMutex.

Details lookups (the dialog's right-hand pane) route through
`/api/v1/packages/{os}/{arch}/{name}` → pkgsvc `/package/{os}/{arch}/{name}`
via `handlePackageDetails`. That proxy 404s cleanly when `PKGSVC_URL` is
empty; the dialog treats that as "detail pane unavailable" and keeps
working from the list-response data.

## Files to open first

If a fresh agent has 20 minutes to read code before making a change,
these are the paths that give the fastest mental model. Read in order.

### Frontend
- `web/src/App.tsx` — tab shell, view enum, top-level state wiring.
- `web/src/components/Header.tsx` — the four tabs (Basic, Advanced,
  Interactive, Monitor Builds).
- `web/src/components/InteractivePage.tsx` — form-driven CoreV1
  composer; hosts both package-search surfaces.
- `web/src/components/PackageSearchDialog.tsx` — expanded palette
  dialog; a good example of the project's ARIA + keyboard-nav idioms.
- `web/src/api/client.ts` — every API call the frontend makes.

### Main backend
- `cmd/image-composer-tool/serve.go` — flags, env-var surface, wires
  Config into `api.New`.
- `internal/api/router.go` — every HTTP route in one place.
- `internal/api/jenkins.go` — Jenkins REST client, worker picking,
  `runJenkinsBuild` goroutine, cancel path.
- `internal/api/handlers_packages.go` — the reverse-proxy + embed
  fallback for /packages.

### ict-pkgsvc
- `cmd/ict-pkgsvc/main.go` — env-var config, orchestrator wiring,
  healthcheck subcommand.
- `internal/pkgsvc/handler/search.go` — every microservice endpoint.
- `internal/pkgsvc/crawler/orchestrator.go` — refresh loop, atomic
  index swap.
- `internal/pkgsvc/index/bleve.go` — analyzer chain, boost table,
  popcon tiebreak.

### ICT build engine (the CLI that a worker actually invokes)
- `cmd/image-composer-tool/build.go` — top-level `build` subcommand
  flow: LoadAndMergeTemplate → InitProvider → PreProcess → BuildImage
  → PostProcess.
- `internal/config/config.go` — the `ImageTemplate` struct (image,
  target, disk, systemConfig, packageRepositories, configurations,
  extends).
- `internal/config/merge.go` — `LoadAndMergeTemplate`, extends chain
  resolution, defaults folding.
- `internal/image/imageos/imageos.go` — the 2400-line heavy hitter
  (mount, chroot, package install, UKI, SBOM, bootloader, sign,
  convert). If a build fails inside the worker, the trace usually
  points here.

### Jenkins CAC (sibling repo)
- `libraries.devops.jenkins.cac/cac/gen/lin/core-os/ict-qa-templatized/ict.yaml`
  — 59-row build matrix, `defaults:` block that every worker inherits.
- `libraries.devops.jenkins.cac/cac/gen/lin/core-os/ict-qa-templatized/workers/worker/Jenkinsfile_abi.build`
  — the worker template job body (invokes
  `ictBuild(variant: env.JOB_BASE_NAME, worker: true, dockerMode:
  true)`).
- `libraries.devops.jenkins.cac/cac/gen/lin/core-os/ict-builder/entrypoint.sh`
  — the ict-builder container's own orchestration (the stage markers
  that appear in the SSE log).

## Ports, env vars, credentials

### Ports (defaults, not the current live-server state)

| Layer | Container-internal | Host-published |
|---|---|---|
| Frontend nginx | 8080 | 5173 (compose). Per-worktree convention: 5173 / 5174 / 5175. |
| Main backend | 8080 | not published in compose. Per-worktree convention: 8080 / 8081 / 8082. |
| ict-pkgsvc | 9090 | not published in prod; dev often publishes 9090 direct. |
| Vite dev server | 5173 | Proxies `/api` → `VITE_API_TARGET` (default `http://localhost:8080`). |

The per-worktree offset (5173/5174/5175, 8080/8081/8082) is a convention,
not a compose config. Use `docker-compose` overrides or `--port`/`--host`
flags to actually run three sibling stacks; the base `docker-compose.yml`
ships one stack.

### Env vars

Grouped by concern; each has a home in one of the deeper docs.

Frontend nginx template:

- `BACKEND_URL` — envsubst'd into `docker/nginx/default.conf.template`
  at container start. Default `backend:8080`. See `frontend.md`.

Main backend:

- `JENKINS_URL`, `JENKINS_USER`, `JENKINS_TOKEN`, `JENKINS_WORKERS_PATH`
  — Jenkins dispatch. Missing any means `/api/v1/jenkins/dispatch`
  returns 503. See `backend.md`.
- `PKGSVC_URL` — retargets `/api/v1/packages*` to a running
  microservice; empty falls back to the embedded shards.

ict-pkgsvc:

- `PKGSVC_LISTEN_ADDR`, `PKGSVC_CACHE_DIR`, `PKGSVC_INDEX_DIR`,
  `PKGSVC_REFRESH_INTERVAL`, `PKGSVC_SOURCES`, `PKGSVC_UBUNTU_MIRROR`,
  `PKGSVC_DEBIAN_MIRROR`, `PKGSVC_CRAWLER_ENABLED`, `PKGSVC_ADMIN_TOKEN`.
  See `ict-pkgsvc.md`.

Corporate-proxy passthrough (needed for both pkgsvc's crawler and the
backend's Jenkins client inside the Intel network):

- `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`.

### Credentials (Jenkins CAC)

Referenced by name in the CAC pipelines but not stored there:

- `GitHub-Token` — every `Jenkinsfile_abi.build` in the CAC repo loads
  the `ictHelpers` (or `metaIntelHelpers`) shared library via
  `library(retriever: modernSCM([… credentialsId:'GitHub-Token']))`.
- `codesigning` — `cac/gen/lin/core-os/ict-builder/Jenkinsfile.build`
  uses this for the amr-registry docker login when it pushes a freshly
  baked `ict-builder` image.
- `lab_bldmstr` — not a Jenkins credential but a Linux service account.
  `docker_build_args.groovy` bind-mounts
  `/nfs/png/home/lab_bldmstr/{docker,bin,.gitconfig-coreos,.git-credentials,.netrc}`
  into every builder container, and the entrypoint sets
  `HOME=/home/lab_bldmstr`.

## Migration and branch model

Fork policy: UI, main-backend, and pkgsvc changes go to
`DebalGhosh/image-composer-tool`, never upstream `open-edge-platform/
image-composer-tool`. Local branches: `fork-main`, `fork-next`,
`fork-next-b`, plus a `main` that is kept aligned with `fork-main` (the
"meta-intel-parity" invariant — upstream ICT and downstream fork share
the same branch shape). Remote `fork/` on GitHub carries the same four
branches; they're all kept converged so cherry-picking between worktrees
is not required.

### Package-search microservice migration path

From `adr-package-search-microservice.md`, this is the sequence and
where we stand:

1. Ship the microservice with the pre-existing 32-package embedded
   shards as a seed corpus, plus the backend reverse-proxy behind
   `PKGSVC_URL`. Byte-identical behaviour to the pre-split era.
   Done.
2. Flip `PKGSVC_CRAWLER_ENABLED=true` and let the crawler pull live
   Ubuntu noble + Debian trixie metadata (~139k records after a full
   crawl). Done in the running compose deployment.
3. Frontend `PackageSearchDialog` uses `fields=full` so the enriched
   `PackageDetails` shape (homepage, popcon, provides sub-object,
   tags/categories/keywords) reaches the detail pane. Done.
4. Delete the `//go:embed` fallback in
   `internal/api/handlers_packages.go` so the main backend is
   pkgsvc-mandatory. Deferred — kept as the local single-binary dev
   safety net.

## Testing and verification

Three sanity commands that a fresh clone should be able to run before
making any change:

    go build ./internal/... ./cmd/...
    go test ./internal/api/... ./internal/pkgsvc/...
    cd web && npm install && npm run build

The first two must be clean; the frontend build should end with
"built in <2s". Compose bring-up:

    cp .env.example .env
    # fill in JENKINS_URL / JENKINS_USER / JENKINS_TOKEN
    # (optional) set PKGSVC_CRAWLER_ENABLED=true and HTTP_PROXY if inside
    # the Intel network
    docker compose up -d --build
    open http://localhost:5173

CaaS deployment story in one sentence: three container images
(`ict-ui-frontend`, `ict-ui-backend`, `ict-pkgsvc`), no build-time
knowledge of each other's URLs — wired at deploy time through
`BACKEND_URL` and `PKGSVC_URL`.

## Related in-tree docs

The five architecture docs shipped in commit `0e0adf42` cover each
component in more depth than the summary above:

- `docs/user-guide/architecture/backend.md` — main Go backend, every
  HTTP route, the Jenkins dispatch lifecycle, the SSE build-log stream.
- `docs/user-guide/architecture/frontend.md` — React + TypeScript SPA,
  the four tabs, the two package-search surfaces, design-token /
  theming system, Zustand slices, nginx SSE tuning.
- `docs/user-guide/architecture/ict-pkgsvc.md` — the microservice: HTTP
  surface, corpus pipeline, Bleve internals, failure modes, container
  shape.

Older architecture material that stays canonical:

- `docs/user-guide/architecture/image-composer-tool-build-process.md`
  — the ICT build engine's pipeline (Template Loading, Packages,
  Compose, Signing, Finalize).
- `docs/user-guide/architecture/image-composer-tool-templates.md` —
  template shape and the extends: chain.
- `docs/user-guide/architecture/image-composer-tool-caching.md` — how
  the cache dir and workspace interact.
- `docs/user-guide/architecture/image-composer-tool-multi-repo-support.md`
  — package repository configuration.

ADRs:

- `docs/architecture-decision-record/adr-package-search-microservice.md`
  — why the fuzzy-search catalogue was split into its own service.
- `docs/architecture-decision-record/adr-web-ui-tech-stack.md` — the
  original ADR that shipped the web UI (React + Vite + Go server).
- `docs/architecture-decision-record/adr-template-extends.md`,
  `adr-image-extension.md`, `adr-overlay-grow-resize.md` — template
  composition and overlay-mode design.

Setup guide (walks through actually wiring the fork against a real
Jenkins controller):

- `docs/user-guide/get-started/web-ui-jenkins-dispatch.md`.
