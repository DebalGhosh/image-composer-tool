# Session findings — farm, build engine, environment

> Companion to [`YAML-INTEGRITY.md`](./YAML-INTEGRITY.md) (the UI → farm payload
> incident). This file collects everything else established by direct
> verification: what is true in the code and on the live farm, and where the
> existing docs are wrong.

Everything below was checked against source or a live system. Where a claim rests
only on prose in another doc, it says so.

---

## 1. Corrections to the shipped onboarding docs

`.claude/prompts/onboard.md` and `docs/user-guide/architecture/agent-warmup.md`
are detailed and mostly accurate, but these points are wrong or stale:

| Claim | Reality |
|---|---|
| Workspace is `/home/debalgho/ICT-triage/` with 7 sibling repos + 3 worktrees | Layout is per-machine. Verify before trusting any path. |
| Remote `fork` = DebalGhosh, `origin` = upstream | **Inverted** in a plain clone: `origin` IS the fork. Check `git remote -v` before any push. |
| Upstream has no web-UI code | Upstream **does** ship `internal/api`, `web/`, `internal/webui`. It lacks `jenkins.go`, `internal/pkgsvc`, `cmd/ict-pkgsvc`, `handlers_packages.go`. Jenkins dispatch and package search are the genuinely fork-only parts. |
| entrypoint stages: `startup → validate-config → flock → clone → materialise-inputs → go-build → ict-build → stage-artefacts → handoff` | Missing **`refresh-apt-index`** (a real 10th stage, between `go-build` and `ict-build`). And `startup` is written to the stage file *directly* at `entrypoint.sh:49`, bypassing `stage()`, so it **never emits a log line** — log-based phase detection can never observe it. |

## 2. The dispatch contract (verified end to end)

1. Backend POSTs `buildWithParameters` with exactly one field — **raw**
   `TEMPLATE_YAML` (`internal/api/jenkins.go:218`).
2. `ictBuild` declares it as a `text` parameter
   (`helpers/vars/ictBuild.groovy:193`), writes it to `.ict_qa_template.yaml`,
   then base64s it and passes **`TEMPLATE_YAML_B64`** into the container (`:597`).
3. `entrypoint.sh:351` decodes it to `image-templates/_ict_qa_active.yml`, dying
   if empty (`:352`).
4. ICT runs as `sudo -E ./image-composer-tool build image-templates/_ict_qa_active.yml`
   (`entrypoint.sh:67`, overridable via `ICT_BUILD_CMD`). `ICT_BUILD_TIMEOUT`
   defaults to 5400 s (90 min).

`ictBuild` has **five** stages: `PARAMS_ONLY`, `CLEAN`, `CHECKOUT CAC`, `BUILD`,
`PUBLISH`. There is **no `timeout()` and no `retry()`** in `options{}` — the only
timeout is the container's own.

## 3. Two dead / fork-local phase markers

`internal/api/phases.go` matches log substrings to drive the UI stepper:

- `"[dispatcher] picked worker"` is **fork-local** — the backend synthesizes it
  itself (`jenkins.go:518`); no farm code emits it. `detectPhase` lowercases
  lines, so the mixed-case log line matches.
- `"uploading to artifactory"` has **no producer anywhere**.
  `artifactory-upload.sh` prints `==> Publishing N file(s)`, `==> Target:`,
  `==> Publish complete.`, `==> Browse:`. Dead marker. Its sibling
  `"[pipeline] { (publish)"` *does* fire (Jenkins emits `[Pipeline] { (PUBLISH)`).

These exact strings are the only coupling between the farm and the stepper. A
stage rename on either side breaks it silently. When the stepper sticks, diff the
`stage()` call sites in `entrypoint.sh` against `phaseMarkers`.

## 4. CAC branch split — a latent farm-wide outage

The worker farm straddles two branches of the CAC repo, and which one a file
comes from depends on the mechanism:

| Mechanism | Branch | Set at |
|---|---|---|
| `readTrusted(...)` at parameter-default time | the job's own cpsScm branch = **`ict/experimental`** | `ictWorkerSeed.groovy:66` |
| `CHECKOUT CAC` stage `GitSCM` clone | **`ict/main`**, hardcoded | `ictBuild.groovy:501` |

**This is load-bearing.** `docker_builder_image.txt` **does not exist on
`ict/main`**, and `ictBuild.groovy:99-109` hard-errors at parameter-default time
if the pin is missing. Dispatch works today *only* because `readTrusted` resolves
against `ict/experimental`. Anyone "tidying up" that inconsistency, or flipping
`cacBranch` to `ict/main` before landing the pin, takes down **every** dockerMode
worker.

`docker_build_args.groovy` also differs between the branches (proxy handling).
`build-image.sh` and `artifactory-upload.sh` are identical.

## 5. Worker seeding

`ictWorkerSeed` (`helpers/vars/`) generates `worker-NN` jobs:
`WORKER_COUNT` defaults to **10**, clamped 1–200, zero-padded to 2 digits (3 above
99), `removedJobAction: 'DELETE'` so shrinking the count really deletes workers.
`ictRepo` defaults to **`DebalGhosh/image-composer-tool`** — the farm builds the
fork, not upstream.

`pickWorker` keys on the Jenkins `color` ending in **`_anime`** (build running),
**not** on `red`/`blue`. A red worker (last build failed) is still eligible.

## 6. The proxy trap — direction-dependent

Go's `http.ProxyFromEnvironment` and curl both **ignore glob syntax** in
`no_proxy`. A host set to `no_proxy=*.intel.com` therefore routes Intel-internal
traffic through the proxy anyway and fails TLS with curl exit 60 — which looks
exactly like an unreachable host or a bad certificate. Dot-prefix (`.intel.com`)
is the correct form.

Diagnostic: `openssl s_client` ignores proxy env, so it succeeds while curl fails
on the same host.

But the correct setting **depends on direction**, and both directions are live:

| Talking to | Setting | Why |
|---|---|---|
| Jenkins controller (`cje-pg-prod01.devtools.intel.com`) | `no_proxy` **includes** `.intel.com` | genuinely internal; the proxy breaks TLS |
| Intel package repos, from inside ict-builder | `no_proxy` **excludes** it (loopback only) | `apt.repos.intel.com` → Akamai, `files-rs.edgeorchestration.intel.com` → CloudFront; CDN-fronted public IPs that *need* the proxy |

`docker_build_args.groovy` forces `NO_PROXY=localhost,127.0.0.1,::1` inside the
container for exactly this reason. An `*.intel.com` hostname does **not** imply
proxy-exempt — check whether it resolves to RFC1918 space or a CDN edge.

## 7. ISO builds ship without an SBOM

`generateSBOM` is only called from `InstallImageOs`
(`internal/image/imageos/imageos.go:124`, `:266`). **`isomaker` never calls
`InstallImageOs`** — ISO builds route through `initrdmaker` — so SBOM generation
is structurally unreachable on the ISO path. Confirmed upstream too
(`grep -c InstallImageOs` on upstream's `isomaker.go` = 0).

The tell in the log is a WARN naming the *literal default* filename:

    WARN manifest/manifest.go:323  SBOM file not found at tmp/spdx_manifest.json

That default is only rewritten to the real timestamped name **inside**
`generateSBOM` (`imageos.go:2271`). Seeing the unmutated name proves the function
never ran — not merely that a copy failed.

Consequence: any ISO published to Artifactory has no SBOM, while
`inspect --extract-sbom` and `compare --mode spdx` assume one is embedded at
`/usr/share/sbom`. Raw builds do produce one.

## 8. `debian13-x86_64-desktop-virtualization-iso` references a missing file

Line 253 points at `../additionalfiles/99-dhcp-en.network`. That file exists for
**azl3** and **emt3** only; debian13 ships `dhcp.network`. The path resolves
nowhere, so the ISO gets **no DHCP config** and the build only WARNs:

    WARN config/config.go:754  Ignoring additional file entry with non-existent local path

Byte-identical to upstream — an upstream bug.

## 9. Kernel pins: the fork/upstream divergence

Both sides fixed the same `worker-05` failure (`kernel.version` pinned to a
release absent from the noble archive) in **opposite** ways:

- **Fork** (`ac79afde`): pin `version: "6.8"` + swap to `linux-image-generic`
- **Upstream** (`bd78bc8d`): **drop** `kernel.version` entirely — a pin that can
  go stale *is* the antipattern; an empty version bypasses the resolver check

Upstream's is strictly more durable and was adopted. But upstream's sweep **missed
`robotics-demo-ubuntu24-x86_64.yml`**, which still carries the broken
`version: "6.17"` + `linux-image-generic-hwe-24.04` pair. Verified against the
live archive:

    noble-updates  linux-image-generic-hwe-24.04 -> 7.0.0-28.28~24.04.1
    noble-updates  linux-image-generic           -> 6.8.0-136.136

6.17 exists in neither, so a straight sync would reintroduce the failure. That one
file keeps a deliberate fork-side change (drop the pin, keep the metapackage).

Concrete-ABI pins (`server-cloud`, `dlstreamer`, `ptl-pv`, `fde-raw`) are the
legitimate case per upstream's own carve-out and were left alone.

**Not synced:** `ubuntu24-x86_64-fde-raw.yml`. It needs the `systemConfig.fde`
schema block and `imageos/fde.go` from upstream `1dab8c74` + `0a312ab4`
(~2,300 lines); without them it fails validation with
`additionalProperties 'fde' not allowed`.

## 10. Farm node with a broken CA store

`BSP-DOCKER9-UB18` fails every clone:

    fatal: unable to access 'https://github.com/DebalGhosh/image-composer-tool.git/':
    server certificate verification failed. CAfile: none CRLfile: none

Proven node-specific by a natural controlled experiment: four dispatches of a
**byte-identical** payload (SHA `719ac23a…`) went to four nodes; the three on
`BSP-DOCKER10-UB18`, `BSP-DOCKER20-SLES12` and `BSP-DOCKER8-UB18` built fine, the
one on `BSP-DOCKER9-UB18` died at `stage=clone` with `rc=128` before ICT ever ran.

Note the sibling warning `no .git-credentials or .netrc at /home/lab_bldmstr` is
**benign** — it appears on succeeding builds too. The CA bundle is the real
differentiator.

## 11. Running a local build on a proxied host

`build` needs root (mount/losetup/chroot) and this class of host has **no direct
egress** — every repo returns HTTP 000 without the DMZ proxy. `sudo`'s
`env_reset` strips the proxy vars and **refuses `-E` outright**.

The narrow fix is a `Defaults env_keep` line, *not* `SETENV`:

    Defaults env_keep += "http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY"
    <user> ALL=(root) NOPASSWD: /abs/path/to/build/image-composer-tool build *

`env_keep` passes exactly those six variables; `SETENV` would allow arbitrary
environment into a root process. Invoke **without** `-E`.

Gotchas: a wrapped terminal line can split a sudoers rule across two lines
(invalid syntax; sudo then skips the file and reports a parse error), and
`sudo -v` caching does **not** help a non-interactive agent because
`timestamp_type=tty` binds the ticket to a terminal.

`workspace/` is created `drwx------ root root`, so artifacts are unreadable
unprivileged — **trust the build log's own artifact table over `find`**, which
silently returns nothing.

## 12. Local build reference (for comparing farm output)

Built on Ubuntu 24 with Go 1.25, no docker/earthly:

| Template | Time | Artifacts |
|---|---|---|
| `ubuntu24-x86_64-robotics-jazzy-iso` | 22m16s | `robotics-jazzy-ubuntu24-24.04.iso` 6.62 GB + `template-dump.yaml` |
| `debian13-x86_64-desktop-virtualization-iso` | 7m29s | `debian13-x86_64-desktop-virtualization-13.0.iso` 924 MB + `template-dump.yaml` |
| `generic-handheld-os-template` (raw) | 29m54s | `minimal-desktop-ubuntu-24.04.raw.gz` 3.41 GB + `spdx_manifest_deb_*.json` 1.41 MB |

All `rc=0`, zero ERRORs. Note the ISO builds produced **no SBOM** (see §7) while
the raw build did.

Benign warnings seen throughout: `User root already exists` (idempotent),
`GRUB locale directory does not exist` (cosmetic), and frequent
`502 Bad Gateway; retrying` — the DMZ proxy intermittently 502s and the
5-attempt retry absorbs it.
