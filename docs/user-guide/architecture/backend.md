## Overview

Two independent traffic classes hit the backend. The **build** class goes
`frontend → backend → Jenkins`; the backend never runs an image build itself.
The **package-search** class goes `frontend → backend → ict-pkgsvc`; the
backend is a thin reverse proxy with a legacy-projection query-string
rewrite. A third path — the SSE log stream — flows *back* from Jenkins to the
browser through the backend, funnelled through the in-memory build tracker
that `internal/api/builds.go` maintains.

The frontend never talks to Jenkins or pkgsvc directly. Everything is
brokered by the Go server, which keeps the Jenkins API token server-side and
gives the frontend a single origin to `fetch` against. Compose sits the
backend on an internal Docker network next to pkgsvc; the frontend
container's nginx (see `Dockerfile.frontend`) is the only piece with a
published port.

    Browser (SPA served by nginx in prod / Vite in dev)
        │
        │  fetch /api/v1/*
        ▼
    Go backend  ─── POST buildWithParameters ────────►  Jenkins worker-NN
    (:8080)     ◄── GET  logText/progressiveText ──────
        │       ─── GET  /api/json (artifacts, run) ──►
        │
        │  GET /api/v1/packages          → reverse-proxy
        │  GET /api/v1/packages/{o}/{a}/{n} → reverse-proxy
        ▼
    ict-pkgsvc (:9090, /search, /package/{os}/{arch}/{name})

    Browser  ◄── SSE event: log / phase / complete / error ── Go backend
             (served on GET /api/v1/builds/{id}/logs)

## HTTP API surface

All routes are registered on a Go 1.22 `http.ServeMux` in
`internal/api/router.go`. Method + pattern routing means each handler owns
exactly one verb-and-path pair; no third-party router is involved.

| Method | Path | Handler | File |
|---|---|---|---|
| GET  | `/api/v1/manifest`                            | `handleGetManifest`   | `handlers_read.go` |
| POST | `/api/v1/templates/compose`                   | `handleCompose`       | `handlers_read.go` |
| GET  | `/api/v1/packages`                            | `handleSearchPackages`| `handlers_packages.go` |
| GET  | `/api/v1/packages/{os}/{arch}/{name}`         | `handlePackageDetails`| `handlers_packages.go` |
| GET  | `/api/v1/builds/{id}/logs`                    | `handleBuildLogs`     | `sse.go` |
| GET  | `/api/v1/builds/{id}/artifacts`               | `handleBuildArtifacts`| `handlers_artifacts.go` |
| GET  | `/api/v1/builds/{id}/details`                 | `handleBuildDetails`  | `handlers_build_details.go` |
| GET  | `/api/v1/builds/{id}/template`                | `handleBuildTemplate` | `handlers_build_details.go` |
| POST | `/api/v1/jenkins/dispatch`                    | `handleJenkinsDispatch`| `jenkins.go` |
| POST | `/api/v1/builds/{id}/cancel`                  | `handleCancelBuild`   | `jenkins.go` |
| GET  | `/`                                           | `spaHandler`          | `router.go` (embedded SPA) |

`handleGetManifest` returns the manifest that maps every valid
(vertical, SKU, platform, OS, imageType) combination to a template file in
`image-templates/`; the frontend derives cascading dropdown options from it.

`handleCompose` accepts a `composeRequest` (vertical / SKU / platform / OS /
imageType), looks up the matching template via `manifest.findTemplate`, reads
it from disk, runs it through `config.LoadAndMergeTemplate` for a full merge,
and returns `{template, yaml, summary}`. When the request carries
`?form=merged`, the marshalled merged template is returned instead of the raw
seed YAML — that path is what the Interactive tab uses to seed its widgets
without silently dropping inherited fields.

`handleSearchPackages` is dual-mode. If `Config.PkgsvcURL` is set (see
[Package search proxy](#package-search-proxy)) it reverse-proxies to
`{pkgsvc}/search?fields=legacy`; otherwise it scans the embedded
`data/packages/*.json` shards and ranks results locally. `handlePackageDetails`
is proxy-only — with no `PkgsvcURL`, it returns `404 PKGSVC_DISABLED`.

`handleBuildLogs` is the SSE endpoint. It replays any buffered log lines,
then follows new lines push-based via the `build.wake` broadcast channel, and
finally emits a terminal `complete` or `error` event when the build's
`done` channel closes. See [Build lifecycle](#build-lifecycle-jenkins-dispatch).

`handleBuildArtifacts` returns `{buildId, status, artifacts[]}` where each
artifact carries `{name, type, path, url}` and `url` points straight at
Jenkins' `/artifact/<relPath>` — the browser downloads from Jenkins
directly, no proxy.

`handleBuildDetails` returns a `buildDetails` struct with the exact dispatch
command, the template filename, a link to `/api/v1/builds/{id}/template` for
re-download, an optional `composeSummary`, and a `jenkinsDetails` block
carrying worker / job URL / build URL / build number / Artifactory URL.
`handleBuildTemplate` serves the YAML that was dispatched (stored on
`build.TemplatePathYAML`) with a `Content-Disposition: attachment` header.

`handleJenkinsDispatch` is the write path; `handleCancelBuild` is the
graceful stop. Both are covered in the next section.

`spaHandler` at `/` is only mounted when `webui.HasRealBuild()` returns true
— i.e. a production build of the SPA is embedded via `//go:embed dist`. In
dev, the embedded `dist/` is a placeholder and the frontend is served by the
Vite dev server on port 5173, which proxies `/api/*` to `127.0.0.1:8080`.

## Build lifecycle (Jenkins dispatch)

A build starts when the frontend POSTs `{yaml: "..."}` to
`/api/v1/jenkins/dispatch`. What happens next lives in `internal/api/jenkins.go`.

1. `handleJenkinsDispatch` refuses with `503 JENKINS_DISABLED` when
   `s.jenkins == nil` (any of `JENKINS_URL` / `JENKINS_USER` / `JENKINS_TOKEN`
   was unset at startup). A missing or blank `yaml` field returns
   `400 EMPTY_YAML`. Both are pre-flight guards that don't touch Jenkins.
2. `s.jenkins.listWorkers` fetches
   `{JENKINS_URL}/job/<workersPath>/api/json?tree=jobs[name,url,color]`,
   filters to `worker-*` jobs that aren't `disabled`, and returns them. Each
   entry's `Color` field ends in `_anime` while a build runs on that worker.
3. `pickWorker` implements *free-first, random fallback*: it partitions the
   fleet into idle (`Color` doesn't end in `_anime`) and busy, prefers idle,
   and picks uniformly at random from the chosen pool via `cryptoRandIntn`.
   An empty fleet returns `503 NO_WORKERS`.
4. `s.jenkins.trigger` POSTs
   `{jobURL}/buildWithParameters` with a single form field
   `TEMPLATE_YAML=<urlencoded YAML>`. All other Jenkins parameters keep the
   worker's declared defaults, which is what makes the seeded fleet from
   `web-ui-jenkins-dispatch.md` step 2 work uniformly. The queue-item URL
   comes back in the `Location` header; anything but 201/302 with a Location
   returns `502 JENKINS_TRIGGER`.
5. A new `build` record is allocated (`uuid.NewString` for the id), attached
   to a fresh `jenkinsMeta` with the picked worker and the queue URL, and
   registered in the `buildTracker`. Four `[dispatcher]` log lines are
   appended synchronously so the operator sees *who + where* the moment the
   SSE stream opens. `context.WithTimeout(context.Background(), 6*time.Hour)`
   bounds the runner; its `cancel` is stored on the build so
   `/cancel` can trip it early.
6. `runJenkinsBuild` starts as a goroutine and the handler returns
   `202 Accepted` with `{buildId, status:"running", logsUrl}`.

Inside `runJenkinsBuild`:

- `waitForBuild` polls the queue item URL every second until Jenkins fills in
  `executable.number`, or until the queue item is cancelled, or until the
  context expires. Each new `why` reason ("Waiting for next available
  executor…") is appended to the log via the `onWait` callback. Once the
  build number arrives, `Jenkins.RawBuildURL` and `Jenkins.BuildURL` are set
  under `b.mu` — the latter is decorated with `/cloudbees-pipeline-explorer/`
  because that view surfaces per-stage timings, and Jenkins auto-redirects
  cleanly when the plugin is missing.
- The log-tail loop calls `fetchProgressiveText` every 500 ms.
  `X-Text-Size` gives the next offset; if a reverse proxy strips it, the
  code falls back to `offset + len(body)` so log lines aren't re-fetched
  and duplicated forever. `X-More-Data == "true"` means the writer is
  still open; anything else terminates the loop after draining the final
  chunk. Up to `maxConsecutiveErrs = 5` consecutive transient errors are
  tolerated before the build is marked failed — this absorbs 502s from a
  flaky reverse proxy.
- Each accumulated chunk is split on `'\n'`; the final partial line is
  carried across iterations in a `strings.Builder` so the SSE stream never
  emits a half line. Every complete line goes through
  `captureArtifactoryURL` (which sniffs the PUBLISH stage's
  `Artefacts published to: https://…` echo via a regex, sets
  `Jenkins.ArtifactoryURL` on first match, and is idempotent thereafter)
  and then `b.appendLog`.
- `appendLog` is the broadcast-wake heart of the SSE pipeline: it takes
  `b.mu`, appends the line to `b.logLines`, and atomically **closes** the
  current `b.wake` channel while installing a fresh one. Every subscriber
  blocked on `b.waitChan()` unblocks in one wake-up with zero
  per-subscriber allocation.
- Once `X-More-Data` clears, `getRun` fetches `{building, result}` and
  `listArtifacts` fetches the archived `artifacts[]`. Each `fileName` +
  `relativePath` is mapped into an `artifact{Name, Type, Path, URL}` where
  `URL = buildURL + "artifact/" + encodeRelativePath(relativePath)`.
  `encodeRelativePath` per-segment-`PathEscape`s so spaces / `#` / `?` /
  unicode filenames still resolve on Jenkins. `Type` comes from
  `classifyArtifact` in `builds.go` — filenames containing `sbom` or
  `spdx` are `"sbom"`, everything else is `"image"`.
- `build.finish` records terminal status + artifacts under `b.mu`. It's
  *idempotent for terminal states*: once the build is `cancelled` /
  `success` / `failed`, subsequent `finish` calls are no-ops. That's what
  makes `/cancel` correct against a runner goroutine that later observes
  the abort as a Jenkins `FAILURE` — the runner would otherwise overwrite
  `cancelled` back to `failed` in the UI.

The SSE handler at `internal/api/sse.go` is a separate goroutine per
subscriber. It sets `Content-Type: text/event-stream`,
`Cache-Control: no-cache`, `X-Accel-Buffering: no` (so nginx won't buffer
between the backend and browser), replays `b.snapshotLogs()`, and then
`select`s on four channels:

- `r.Context().Done()` — client disconnect.
- `b.waitChan()` — a new log line landed; drain and loop.
- A 15 s `time.Ticker` — writes `: keepalive\n\n` as an SSE comment line,
  which browsers' `EventSource` parser ignores but any intermediate
  reverse proxy sees as traffic. Keeps corporate proxies from dropping
  idle connections during long Jenkins queue waits.
- `b.done` — the build finished; drain the tail, then emit a final
  `phase: done` (so the frontend stepper's last step lights up even when
  the log's PUBLISH marker wasn't hit) followed by `complete`
  (`success`) or `error` (`failed` / `cancelled`). Cancelled builds get
  their own `error` event with `status: "cancelled"` so the frontend
  renders it distinctly from red-toast failures.

Each SSE emission also runs `detectPhase` and `installProgress` over the
current log buffer (`phases.go`) and fires a `phase` event only when the
computed values actually changed since the last emission — keeps SSE
chatter proportional to real progress, not to log volume.

`handleCancelBuild` is the graceful stop. It looks up the build, verifies
`b.Jenkins != nil` (rejects with `409 NOT_JENKINS_BUILD` otherwise), and
short-circuits with `409 CANCEL_TOO_EARLY` if `Jenkins.RawBuildURL` is
still empty (the queue item hasn't resolved). It then calls
`b.markCancelled("cancelled by user")` — which flips status to
`cancelled` and trips the runner's context — *before* firing
`stopBuild`. That ordering matters: the UI's status pill flips
immediately even if the Jenkins call is slow, and if `markCancelled`
returns `false` (the build finished between the read and the flip), we
bail with the real terminal state. `stopBuild` targets Jenkins' `/stop`
endpoint (the least forceful of `stop`/`term`/`kill` — the right choice
for a UI Stop button) and detaches its context from `r.Context()` so an
abandoned browser doesn't tear the outbound POST down.

### The build tracker

`buildTracker` (`internal/api/builds.go`) is an in-memory
`map[string]*build` guarded by a mutex. Build ids are UUIDs. There is no
persistence: a backend restart invalidates every in-flight id. The
frontend keeps a history of recent build ids in `localStorage` so it
survives a backend restart, but if the user opens `/details` for a build
id the tracker no longer knows about, the endpoint returns
`404 NOT_FOUND` and the frontend renders the "no longer available on the
server" empty state (this is the pattern exercised by
`handlers_packages_proxy_test.go`'s cousins in `api_test.go`).

`findByJenkins(worker, buildNumber)` is a secondary linear-scan index that
lets the frontend deep-link a shareable
`?worker=worker-04&buildNo=12` URL back to the internal build id on
cold-load. It's O(N) over the tracker, which is fine because N is the
dispatched-this-process count (dozens, not thousands).

## Package search proxy

`internal/api/handlers_packages.go` has two modes selected by
`Config.PkgsvcURL`.

When `PkgsvcURL` is **set**, `handleSearchPackages` calls
`proxyToPkgsvc`, which constructs an `httputil.NewSingleHostReverseProxy`
and overrides the `Director` to rewrite `/api/v1/packages` →
`{target}/search`. The caller's query string is preserved verbatim
except that `fields=legacy` is force-injected when the caller didn't set
its own `fields=` — that projection makes the pkgsvc response
byte-identical to the shape the frontend consumed pre-microservice, so
the on-wire contract stays stable. `handlePackageDetails` similarly
rewrites `/api/v1/packages/{os}/{arch}/{name}` → `{target}/package/{os}/{arch}/{name}`
and drops any incoming query so caller junk doesn't reach pkgsvc.

When `PkgsvcURL` is **unset**, `handleSearchPackages` falls back to the
embedded shard scan. `loadPackageIndex` runs at startup, reads
`internal/api/data/packages/index.yaml` (either from
`Config.PackagesDir` on disk or the `//go:embed` fallback), and loads
each per-`(os, arch)` JSON shard. The embedded seed inventory currently
carries **32 records** across two shards (`ubuntu24-amd64.json`,
`debian13-amd64.json`) — enough to keep single-binary local dev
functioning without the sidecar. Ranking is intentionally shallow:
score 0 for exact name, 1 for name-prefix, 2 for name-substring, 3 for
description-substring; ties break alphabetically. The frontend's
`MiniSearch` does any further fuzzy scoring client-side. In this
fallback mode, `handlePackageDetails` returns `404 PKGSVC_DISABLED` —
there's no equivalent single-record surface for the embed path.

**Header round-trip.** `X-Package-Index-Missing` is preserved on both
paths. `NewSingleHostReverseProxy` copies it through unchanged from
pkgsvc responses; the embed fallback sets it explicitly for
`(os, arch)` combinations that are either unknown to the inventory
(`reason=unknown`) or known-but-failed-to-load (`reason=load-failed`).

**Error handling.** `proxyToPkgsvc`'s `ErrorHandler` — invoked when the
proxy can't reach pkgsvc at all (dial timeout, connection refused,
bad gateway) — logs the failure and serves `200 OK` with an empty
`packageSearchResponse` and `X-Package-Index-Missing:
pkgsvc-unreachable;reason=proxy-error`. That deliberate 200 keeps the
frontend's fallback banner firing the same way it does for a stale
embed index. `handlePackageDetails` takes the opposite tack: unreachable
pkgsvc surfaces as `502 PKGSVC_UNREACHABLE` so the dialog's detail
pane can render its "detail unavailable" empty state without hanging.

## Configuration

Everything the server needs is threaded from
`cmd/image-composer-tool/serve.go` into an `api.Config` struct. Each flag
falls back to the matching env var so operators can supply secrets
without exposing them in `ps` output.

| Flag | Env | Default | Field |
|---|---|---|---|
| `--host` | `SERVE_HOST` (via caller) | `127.0.0.1` | joined into `Addr` |
| `-p`, `--port` | `SERVE_PORT` (via caller) | `8080` | joined into `Addr` |
| `--templates-dir` | — | `image-templates` | `TemplatesDir` |
| `--manifest` | — | (embedded) | `ManifestPath` |
| `--jenkins-url` | `JENKINS_URL` | — | `JenkinsURL` |
| `--jenkins-user` | `JENKINS_USER` | — | `JenkinsUser` |
| `--jenkins-token` | `JENKINS_TOKEN` | — | `JenkinsToken` |
| `--jenkins-workers-path` | `JENKINS_WORKERS_PATH` | `ict-farm/workers` | `JenkinsWorkersPath` |
| `--packages-dir` | — | (embedded) | `PackagesDir` |
| `--pkgsvc-url` | `PKGSVC_URL` | — | `PkgsvcURL` |

`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are honoured by Go's default
`http.Transport` without any code in this repo; the compose file
propagates them through both the `backend` and `pkgsvc` services so
Intel-network builds work the same as internal-network ones.
`SSL_CERT_FILE` is honoured by `crypto/tls` directly — see the setup
guide's step 4 for how to build a private CA bundle when the system
`ca-certificates` package is missing the controller's root.

Host binding defaults to `127.0.0.1` on purpose: the API can trigger
privileged Jenkins builds on the operator's account, so exposing it on
`0.0.0.0` without a fronting auth layer is a footgun the flag help text
calls out explicitly.

## Failure modes and startup

There is **no local build path** after commit `c93683a0`. If any of
`JENKINS_URL` / `JENKINS_USER` / `JENKINS_TOKEN` is missing at startup,
`newJenkinsClient` returns `nil`, `s.jenkins == nil` in the dispatch
handler, and `POST /api/v1/jenkins/dispatch` returns `503
JENKINS_DISABLED`. The rest of the API keeps working — an operator
with a preserved build id from a previous session can still browse
`/details` and `/artifacts` for those historical builds, and package
search still resolves against whatever data source is configured.

If `PKGSVC_URL` is unset, `/api/v1/packages` serves the 32-record embed
scan and `/api/v1/packages/{os}/{arch}/{name}` returns
`404 PKGSVC_DISABLED`. If `PKGSVC_URL` is set but pkgsvc is
unreachable, `/api/v1/packages` still returns 200 (empty +
`X-Package-Index-Missing` header) while `/api/v1/packages/{os}/{arch}/{name}`
returns 502. The frontend renders a distinct "fallback active" banner
in the search dialog whenever it sees `X-Package-Index-Missing`.

The SSE stream survives long queue waits via the 15 s heartbeat
(a `: keepalive\n\n` comment line every 15 seconds, ignored by
`EventSource` but sufficient traffic for any intermediate proxy). The
`buildTracker` survives only the container's lifetime — a backend
restart invalidates every in-flight `buildId`, and the frontend rows
for those ids in `localStorage` reach the "no longer available on the
server" empty state on the next `/details` fetch. Persistence is a
follow-up (`workspace/builds/{id}/metadata.json`, no database) called
out in the ADR.

## Container and deployment

`Dockerfile.backend` is a two-stage build. Stage 1 is
`golang:1.25-bookworm`: `go build -trimpath -ldflags="-s -w"` with
`CGO_ENABLED=0` produces a static binary and layer-caches the module
download via `--mount=type=cache`. Stage 2 is `debian:12-slim` with
`ca-certificates`, `tini`, and `curl`. A non-root user
`ict:ict` (UID/GID `10001`) owns `/app` and runs the binary.

The runtime is deliberately not distroless: the config loader opens
`image-composer-tool.yml` and writes a log file, HTTPS to Jenkins wants
a full Debian CA bundle for Intel MITM certs, and a shell in
`docker exec` is invaluable when something goes wrong in prod. `tini`
runs as PID 1 so `SIGTERM` propagates cleanly to the Go server; the
compose `stop_grace_period: 30s` gives the server room to drain
in-flight SSE streams before Docker escalates to `SIGKILL`. The
`HEALTHCHECK` curls `http://127.0.0.1:8080/api/v1/manifest` — a cheap
in-memory read that returns 200 as long as the server is up.

`docker-compose.yml` wires the backend into an internal `ict-ui`
bridge network alongside `pkgsvc` (`Dockerfile.pkgsvc`) and `frontend`
(`Dockerfile.frontend`). The backend port is deliberately not
published; the frontend container's nginx is the only ingress and it
resolves `backend:8080` on the internal network. `env_file: .env`
supplies `JENKINS_*`; `PKGSVC_URL` defaults to `http://pkgsvc:9090`
via `${PKGSVC_URL:-http://pkgsvc:9090}`. `depends_on:
pkgsvc: {condition: service_healthy}` blocks the backend until
pkgsvc's own baked-in healthcheck passes, so a cold `docker compose
up` doesn't race the sidecar.

## Testing

The `internal/api` package's test suite exercises handlers directly via
`httptest`, never against a real Jenkins.

- **`api_test.go`** builds a `Server` with an in-memory manifest and a
  temp `TemplatesDir` populated with a minimal schema-valid YAML. It
  covers `handleGetManifest`, `handleCompose` (including the
  `?form=merged` branch), and the round-trip error surface for missing
  or malformed templates.
- **`handlers_packages_proxy_test.go`** spins up an `httptest.Server`
  as a fake pkgsvc and verifies `handleSearchPackages` rewrites the
  path to `/search`, forces `fields=legacy`, and round-trips the
  `X-Package-Index-Missing` header. A sibling case (in the same file)
  covers the `handlePackageDetails` path rewrite to
  `/package/{os}/{arch}/{name}` and the `502 PKGSVC_UNREACHABLE`
  behaviour when the fake server is closed before the request.
- **`phases_test.go`** feeds real log-line samples captured from prior
  worker runs into `detectPhase` and `installProgress`, asserting the
  stepper locks onto the intended phase at each pipeline segment. If
  ICT or the entrypoint pipeline changes its log format, the marker
  set in `phases.go` has to move with it — this test is the tripwire.

There is no test that hits a real Jenkins controller. The `jenkinsClient`
methods (`listWorkers`, `trigger`, `waitForBuild`, `fetchProgressiveText`,
`getRun`, `listArtifacts`, `stopBuild`) are wire-level thin wrappers; the
integration story lives in the setup guide's end-to-end walk-through
at [`docs/user-guide/get-started/web-ui-jenkins-dispatch.md`](../get-started/web-ui-jenkins-dispatch.md).