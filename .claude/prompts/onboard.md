# Onboarding prompt — DebalGhosh fork of image-composer-tool

Paste this into the first user message of a new Claude Code session
when you want the agent to pick up work on this fork. Trim any block
that doesn't apply to the task at hand (e.g. skip the Jenkins block
for a pure frontend PR).

Everything the prompt references is verifiable in the current tree
under `/home/debalgho/ICT-triage/image-composer-tool/` (and its
`fork-next` / `fork-next-b` sibling worktrees).

---

## Block 1 — Role and posture

You are joining the DebalGhosh fork of `image-composer-tool`
(`https://github.com/DebalGhosh/image-composer-tool`) as a coding
agent. The fork adds a browser-based image-composer web UI that
dispatches ICT image builds to a Jenkins worker farm and streams the
build logs back over Server-Sent Events. The upstream at
`open-edge-platform/image-composer-tool` is the ICT CLI itself and
has no web-UI or Jenkins-dispatch code; every UI / backend / pkgsvc
change lives on the fork.

Before you change anything:

1. Read `docs/user-guide/architecture/agent-warmup.md`. It's the
   single-file overview of the whole pipeline (repos, directory
   layout, request flows, ports, credentials, migration state).
2. Skim `docs/user-guide/architecture/backend.md`,
   `docs/user-guide/architecture/frontend.md`, and
   `docs/user-guide/architecture/ict-pkgsvc.md` for depth on whichever
   component your task touches.
3. Check `git log --oneline -10` to see what's landed most recently.
4. Never push to `fork/main` or any other `fork/*` branch without
   an explicit user ask in the current turn. Show the intended push
   command and wait for confirmation.
5. Do not modify code in the upstream `open-edge-platform/` remote's
   view. All edits go to the `fork` remote.

## Block 2 — Workspace layout

The user's workspace lives at `/home/debalgho/ICT-triage/`. Seven git
repos plus three git worktrees of the primary fork:

| Directory | Repo / role | Branch |
|---|---|---|
| `image-composer-tool/` | Primary tree, `DebalGhosh/image-composer-tool` (remote `fork`) with upstream at `open-edge-platform/image-composer-tool` (remote `origin`). | `fork-main` |
| `image-composer-tool-next/` | Git worktree, same repo, sibling branch. | `fork-next` |
| `image-composer-tool-next-b/` | Git worktree, same repo. Usually hosts the running dev server. | `fork-next-b` |
| `libraries.devops.jenkins.cac/` | `intel-innersource/libraries.devops.jenkins.cac`. Jenkins Configuration-as-Code; carries the ICT-QA templatized job family + the `ict-builder` container recipe. | `ict/experimental` |
| `applications.automation.smart-software-factory.ui/` | `intel-innersource/applications.automation.smart-software-factory.ui`. Reference UI. Read-only inspiration for the `PackageSearchDialog` slide-in mechanic. | `main` |
| `yocto.meta-intel.qa-automation/` + `yocto.meta-intel.templatized-pipeline-helpers/` + `yocto.community.qa-automation/` | Sibling Yocto farms. Kept for parity. | `main` |
| `ict-qa-workspace/` | Local scratchpad, not a git repo. Generates `intel-sandbox/ICT.qa-automation`. | n/a |

The three `image-composer-tool*` directories are `git worktree add`
siblings of a single clone — `.git` is shared, per-worktree branch
state is independent. Commits land wherever you `cd` into; the others
see them the moment they `git checkout` or read the shared object
store.

Four fork-owned branches, all kept converged: `fork-main`,
`fork-next`, `fork-next-b`, plus a local `main` aligned with
`fork-main`. Fork remote carries the same four; fast-forward
propagates.

## Block 3 — ICT CLI feature surface

The `image-composer-tool` binary is a Cobra CLI at
`cmd/image-composer-tool/`. Root-level global flags (apply to every
subcommand): `--config <path>`, `--log-level debug|info|warn|error`,
`--verbose/-v`, `--log-file <path>`. Every subcommand loads
`image-composer-tool.yml` at the repo root (via
`config.FindConfigFile()`) which defines `workers`, `config_dir`,
`cache_dir`, `work_dir`, `temp_dir`, `logging.{level,file}`, and the
`ai:` block (Ollama/OpenAI settings for the `ai` subcommand).

The ten subcommands:

**`build <template.yml>`** — chroot-based image build. Runs
`LoadAndMergeTemplate` → `InitProvider` → `PreProcess` (host-dep
install, `pkgfetcher` package download, `chrootEnv.InitChrootEnv`) →
`BuildImage` (dispatches to `rawmaker` / `initrdmaker` / `isomaker` /
`wsl2maker` per `Target.ImageType`, all of which drop into
`ImageOs.InstallImageOs` at `internal/image/imageos/imageos.go` —
~2400 LOC of mount, package install, UKI, SBOM, bootloader, sign,
convert) → `PostProcess`. Requires `sudo -E`; needs `mmdebstrap`,
`systemd-ukify`, `qemu-user-static`, `arch-test`, `binfmt-support` on
the host. Overlay mode (baseline image + additive-only package
ops) is a separate pipeline gated by `Baseline.Mode: overlay`.
Flags: `-w/--workers`, `-d/--cache-dir`, `--work-dir`, `--no-cache`
(spin up isolated scratch via `internal/cache/isolated.go`),
`--dotfile <path>`, `--system-packages-only`, `--inspect/--no-inspect`,
`--cve-check`, `--baseline-image <path>`.

**`serve`** — the web UI HTTP server. Flags: `--host`, `--port`,
`--templates-dir`, `--manifest`, `--jenkins-{url,user,token,workers-path}`,
`--packages-dir`, `--pkgsvc-url`. See
`docs/user-guide/architecture/backend.md` for the deep dive.

**`validate <template.yml>`** — schema-only parse by default; the
`--merged` flag also runs the `extends:` chain resolution + defaults
fold and reports counts (packages, users, kernel version, disk
layout).

**`inspect <image>`** — reads a built RAW image (via
`internal/image/imageinspect`'s diskfs inspector): partition table,
filesystem, bootloader, embedded SPDX SBOM. Flags: `--format
text|json|yaml`, `--pretty` (JSON), `--extract-sbom [path]`.

**`compare <img1> <img2>`** — diffs two RAW images or two SPDX SBOMs
(each arg can be a raw image whose SBOM lives at `/usr/share/sbom`
or a standalone SPDX JSON; a byte-sniff in `looksLikeJSONDocument`
picks between them). Flags: `--format text|json`, `--pretty`,
`--mode full|diff|summary|spdx`, `--hash-images`.

**`ai [query]`** — RAG-backed template generation. Indexes
`image-templates/` at boot via `internal/ai/rag`, then either
`runSearch()` (semantic-search only) or `runGenerate()` (uses
retrieved context to prompt the LLM for a new template). Providers:
Ollama (default, `localhost:11434`, `nomic-embed-text` /
`llama3.2`) or OpenAI (`OPENAI_API_KEY`). Flags: `--provider
ollama|openai`, `--templates-dir`, `--search-only`, `--output`,
`--clear-cache`, `--cache-stats`. See
`docs/architecture-decision-record/adr-template-enriched-rag.md`.

**`cache clean`** — the only `cache` subcommand. Flags:
`--packages`, `--workspace`, `--all`, `--provider-id <os-dist-arch>`,
`--dry-run`. The isolated-cache concept (`SetupIsolated` in
`internal/cache/isolated.go`) is only reachable via `build --no-cache`.

**`config init [path]`** — writes a default `image-composer-tool.yml`
with commentary.

**`completion install`** — custom sub-subcommand that generates a
shell-completion script for `$SHELL` and drops it in the appropriate
user-scoped path (or system-wide via
`IMAGE_COMPOSER_COMPLETION_SCOPE=system`). Flags: `--shell`,
`--force`.

Cobra's default `completion` command (bash/zsh/fish/powershell stdout
generator) is added by `rootCmd.InitDefaultCompletionCmd()`.

## Block 4 — Frontend ↔ backend workflow

Three-container topology in `docker-compose.yml`:

    Browser
      │  Any of four tabs. Cmd/Ctrl+K opens the expanded PackageSearchDialog
      │  from the Interactive tab.
      ▼
    Frontend nginx :8080 (published 5173 in compose)
      │  In dev, Vite dev server on :5173 proxies /api to VITE_API_TARGET
      │  (default http://localhost:8080).
      │  location /api/ → http://backend:8080 with SSE-safe flags:
      │  proxy_buffering off, proxy_read_timeout 1h,
      │  chunked_transfer_encoding on, Connection "".
      ▼
    Main backend :8080  (Go)
      │  cmd/image-composer-tool/serve.go wires api.Config; routes at
      │  internal/api/router.go. Key handlers:
      │  - POST /api/v1/jenkins/dispatch → handleJenkinsDispatch
      │    (internal/api/jenkins.go)
      │  - GET  /api/v1/builds/{id}/logs → handleBuildLogs (SSE, sse.go)
      │  - GET  /api/v1/packages → handleSearchPackages
      │         (reverse-proxies to $PKGSVC_URL/search when set;
      │         falls back to embedded shards when unset)
      │  - GET  /api/v1/packages/{os}/{arch}/{name} → handlePackageDetails
      │         (reverse-proxies to $PKGSVC_URL/package/…)
      ▼
    ict-pkgsvc :9090 (Go, sidecar)
      │  Bleve v2 in-process index over Ubuntu noble + Debian trixie
      │  (~139k packages). Refresh loop pulls dists/<suite>/InRelease
      │  → Packages.xz → dep11 AppStream → popcon by_inst, ingests
      │  to a new Bleve dir, atomic-swaps *bleve.Index under RWMutex.
      │  See internal/pkgsvc/index/bleve.go for the analyzer chain
      │  (edge_ngram(2,15) on name, standard on summary/description,
      │  keyword-lowercased on tags/categories/section) and boost table
      │  (name.exact=20 down to description=1).

Four tabs registered at `web/src/App.tsx`, each gated by
`hidden={view !== 'x'}` on a wrapper div so tab-switches preserve
state:

- **Basic** — cascading dropdowns (`web/src/components/BasicPage.tsx`).
  Auto-fills single-option dropdowns; auto-opens the review card on
  first completion.
- **Advanced** — raw YAML editor with seed dropdown
  (`web/src/components/AdvancedPage.tsx`). CodeMirror wrapper at
  `web/src/components/YamlEditor.tsx` supports in-place fullscreen
  (position: fixed + focus trap + body scroll lock — no remount).
- **Interactive** — form-driven CoreV1 composer
  (`web/src/components/InteractivePage.tsx`). Hosts the compact
  `PackageSearchCombobox` and the expanded `PackageSearchDialog`
  (opened via an "Advanced search" button or `Cmd/Ctrl+K` — a
  keydown effect on the page guards against firing while another tab
  is visible by checking `rootRef.current.offsetParent`).
- **Monitor Builds** — resizable split-pane
  (`web/src/components/BuildImagePage.tsx`): history list on the
  left, SSE-driven `BuildView` on the right. The `key={activeBuildId}`
  force-remount on `<BuildView>` prevents in-flight setState from a
  previous build's SSE stream from contaminating the newly-selected
  build's pane.

## Block 5 — Jenkins farm dispatch

From click to Artifactory:

1. **Frontend** POSTs to `/api/v1/jenkins/dispatch` with `{yaml:
   "<template body>"}`.
2. **Main backend** validates YAML, registers an in-memory build
   with a UUID (`buildTracker` in `internal/api/builds.go`), calls
   `jenkinsClient.listWorkers` and `pickWorker` (free-first, random
   fallback) over `ict-farm/workers` under `$JENKINS_WORKERS_PATH`,
   then Jenkins REST `buildWithParameters(TEMPLATE_YAML=<...>)` on
   the chosen worker.
3. **Worker seeding**: the `worker-01 … worker-N` job list is
   materialised by `ictWorkerSeed()` from the external
   `intel-sandbox/ICT-pipeline-helpers` Groovy shared library on
   branch `feat/worker-seed`. The CAC repo
   (`libraries.devops.jenkins.cac`) only carries thin loader stubs.
   `WORKER_COUNT` is a Jenkins job parameter, not a hardcoded
   constant.
4. **Worker Jenkinsfile** at
   `cac/gen/lin/core-os/ict-qa-templatized/workers/worker/Jenkinsfile_abi.build`
   calls `ictBuild(variant: env.JOB_BASE_NAME, worker: true,
   dockerMode: true)` — `dockerMode: true` switches BUILD from the
   legacy Ubuntu2404 ABI base into the ephemeral `ict-builder`
   container.
5. **ict-builder image** is pulled from
   `amr-registry.caas.intel.com/esc-devops/abi/plat/gen/lin/core-os/ict-builder`
   (currently tag `20260723_1608`, pinned in
   `cac/gen/lin/core-os/ict-qa-templatized/default-parameters/docker_builder_image.txt`).
   It's baked by the meta-pipeline at
   `cac/gen/lin/core-os/ict-builder/Jenkinsfile.build`.
6. **Container entrypoint** at
   `cac/gen/lin/core-os/ict-builder/entrypoint.sh` writes stage
   markers into `/tmp/.entrypoint_stage`: `startup` →
   `validate-config` → `flock` → `clone` → `materialise-inputs` →
   `go-build` → `ict-build` → `stage-artefacts` → `handoff`. These
   drive the UI's phase stepper (`web/src/components/BuildProgress.tsx`).
7. **Inside the container**, `sudo image-composer-tool build
   <template>` runs (same CLI as block 3).
8. **PUBLISH stage** invokes
   `cac/gen/lin/core-os/ict-qa-templatized/default-parameters/artifactory-upload.sh`
   which curls to
   `https://af01p-png.devtools.intel.com/artifactory/core-os-yocto-png-local/<jobName>/<datetime>/`
   using `ART_USER` / `ART_PASS` env vars supplied by `ictBuild`.
   Headers include `X-Checksum-Sha256` and `X-Retention-Days: 365`.
9. **Main backend** captures the Artifactory URL from the tailed
   log via `captureArtifactoryURL` in `internal/api/jenkins.go` and
   stores it on the build record's `Jenkins.ArtifactoryURL`. The
   frontend surfaces it in the Build Details panel.

Credentials referenced by name in the CAC (stored in Jenkins, not in
git):

- `GitHub-Token` — every `Jenkinsfile_abi.build` loads the
  `ictHelpers` shared library via `library(retriever: modernSCM([…
  credentialsId:'GitHub-Token']))`.
- `codesigning` — `cac/gen/lin/core-os/ict-builder/Jenkinsfile.build`
  uses this for the amr-registry docker login when pushing a freshly
  baked `ict-builder`.
- `lab_bldmstr` — Linux service account, not a Jenkins credential.
  Its home
  (`/nfs/png/home/lab_bldmstr/{docker,bin,.gitconfig-coreos,.git-credentials,.netrc}`)
  is bind-mounted into every builder container per
  `default-parameters/docker_build_args.groovy`.

## Block 6 — Standing preferences and further reading

### Preferences to inherit

- **Fork-only edits.** UI, main-backend, and pkgsvc changes go to
  `DebalGhosh/image-composer-tool` (remote `fork`), never upstream
  `open-edge-platform/image-composer-tool` (remote `origin`). If the
  user asks you to open a PR against upstream, verify twice before
  proceeding.
- **Commit style.** Dense imperative subject, wrap the body at ~72
  cols, use fenced code for command examples, no emojis, no
  marketing verbs. Include a `Co-Authored-By: Claude Opus 4.7 (1M
  context) <noreply@anthropic.com>` trailer. Match the voice of
  recent commits (`0e0adf42`, `5c6df9cc`, `47ea1c55`, `0ebc6868`).
- **Never push without an explicit ask.** Show the intended `git
  push` command in a message and wait for confirmation. Never push
  to `main` on the upstream `origin` remote.
- **Never bypass git hooks or GPG signing.** On a pre-commit hook
  failure, fix the underlying issue and re-stage; do not `git
  commit --amend` around a hook.
- **Sudo policy.** Invoke `sudo` only when the user has OK'd it or
  the operation is unambiguously system-level (`apt install`, `kill`
  on a pre-existing dev server the user didn't spawn). The auto-mode
  classifier will block suspicious cases and ask for confirmation
  via `AskUserQuestion` — respect that block, don't try to work
  around it.
- **Killing pre-existing dev servers requires confirmation.** Vite
  processes (5173/5174/5175) and Go backend processes (8080/8081/8082)
  are usually the user's active triage session. Ask before killing;
  spin scratch instances on non-colliding ports (9098/9099) when you
  can.
- **Meta-intel parity.** The ICT templatized pipeline mirrors the
  Yocto one under `cac/gen/lin/core-os/meta-intel-qa-templatized/`.
  Don't diverge the shape without explaining why in the commit
  message.
- **Auto-memory.** Persistent memory lives at
  `/home/debalgho/.claude/projects/-home-debalgho-ICT-triage/memory/`.
  `MEMORY.md` is a one-line-per-entry index; each memory is its own
  file. Read the index at session start; update entries when facts
  change or add new ones for surprising discoveries.

### Docs to read (in order, for depth)

1. `docs/user-guide/architecture/agent-warmup.md` — start here.
2. `docs/user-guide/architecture/backend.md` — main Go backend deep
   dive.
3. `docs/user-guide/architecture/frontend.md` — SPA deep dive.
4. `docs/user-guide/architecture/ict-pkgsvc.md` — microservice deep
   dive.
5. `docs/user-guide/architecture/image-composer-tool-build-process.md`
   — canonical build engine walkthrough.
6. `docs/architecture-decision-record/adr-package-search-microservice.md`
   — the ADR justifying the pkgsvc split.
7. `docs/architecture-decision-record/adr-web-ui-tech-stack.md` —
   the original web-UI ADR.
8. `docs/architecture-decision-record/adr-template-enriched-rag.md`
   — the ADR behind the `ai` subcommand.
9. `docs/user-guide/get-started/web-ui-jenkins-dispatch.md` — the
   Jenkins-farm setup guide.

### Sanity commands to run before any change

    go build ./internal/... ./cmd/...
    go test ./internal/api/... ./internal/pkgsvc/...
    cd web && npm install && npm run build

Compose bring-up (when the task calls for it):

    cp .env.example .env
    # fill JENKINS_URL / JENKINS_USER / JENKINS_TOKEN;
    # optionally set PKGSVC_CRAWLER_ENABLED=true and HTTP_PROXY inside Intel.
    docker compose up -d --build
    open http://localhost:5173

That's the whole primer. Task-specific instructions from the user
follow.
