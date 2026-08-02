# AGENTS.md — image-composer-tool

> Cross-tool agent guide (Cursor, Claude Code, Aider, Codex CLI, etc.).
> GitHub Copilot reads [`.github/copilot-instructions.md`](.github/copilot-instructions.md) — that file is the source of truth. Keep this one in sync with its TL;DR and key conventions.

---

## TL;DR

1. **Plan, then act.** For any multi-step task, write a short plan and check items off as you go.
2. **Gather context efficiently.** Parallel reads/searches; read large ranges in one call; stop searching once you can act.
3. **Implement, don't just suggest.** Smallest diff that solves the problem.
4. **Verify after every edit.** Run package tests and `earthly +test-quick` + `earthly +lint` (or Go/golangci-lint fallbacks) before declaring done.
5. **Match existing patterns** — see [Project conventions](#project-conventions) below.
6. **Stay in scope.** No drive-by refactors, no new comments/docstrings on code you didn't change, no abstractions for one-off use.
7. **Update docs in the same PR** when behavior changes.
8. **Never bypass safety gates.** No `--no-verify`, no `git push --force`, no skipping tests. Confirm before destructive or shared-system actions.

---

## Architecture at a glance

Builds custom Linux images from pre-built packages.

- `internal/provider/` — per-OS orchestrators. Directory names `azl`, `debian13`, `elxr`, `emt`, `rcd`, `ubuntu` map to `target.os` / `OsName` values `azure-linux`, `debian`, `wind-river-elxr`, `edge-microvisor-toolkit`, `redhat-compatible-distro`, `ubuntu` (use the latter in templates). Each implements the `Provider` interface (`Name`, `Init`, `PreProcess`, `BuildImage`, `PostProcess`) and exports `OsName` + `Register()`.
- `internal/image/` — output formats: `rawmaker/`, `isomaker/`, `initrdmaker/`.
- `internal/chroot/` — isolated build envs with `deb/` and `rpm/` installers.
- `internal/config/` — template loading, defaults+user merge, validation.
- `internal/ospackage/` — `debutils/`, `rpmutils/` for dependency resolution.
- `cmd/image-composer-tool/` — CLI entrypoint and provider registration.

Data flow: CLI → Config loads template → `Provider.Init` → `PreProcess` (downloads) → `BuildImage` (chroot + image-maker) → `PostProcess`.

---

## Build, test, lint

Prefer **Earthly** (used by CI). Fall back to plain Go if Earthly is unavailable.

| Task | Earthly | Go fallback |
|---|---|---|
| Build | `earthly +build` | `go build ./...` |
| Test (fast) | `earthly +test-quick` | `go test ./...` |
| Test (coverage) | `earthly +test` | `go test -coverprofile=coverage.out ./...` |
| Lint | `earthly +lint` | `golangci-lint run` |

Coverage threshold lives in `.coverage-threshold` and auto-ratchets.

---

## Project conventions

- **Logger:** `var log = logger.Logger()` from `internal/utils/logger`. Never `fmt.Println` or stdlib `log`.
- **HTTP:** `network.GetSecureHTTPClient()` / `NewSecureHTTPClient()` from `internal/utils/network`. Never `http.DefaultClient`.
- **Shell:** `internal/utils/shell` (allowlisted). Never raw `exec.Command`.
- **Paths:** Always `filepath.Clean` paths derived from user input.
- **Errors:** Wrap with context: `fmt.Errorf("phase X: %w", err)`. Never ignore with `_`.
- **Cleanup:** Named returns + `defer` (not goto-fail style).
- **Tests:** stdlib `testing` only — no testify. Table-driven with `t.Run`. `t.TempDir()` for filesystem. `t.Parallel()` where safe.
- **Function/line limits:** ≤50 lines / 120 cols. Use a config struct beyond 4–5 params.
- **Linters enforced:** `govet`, `gofmt`, `errcheck`, `staticcheck`, `unused`, `gosimple`.

For path-scoped detail, see `.github/instructions/`:

- [`go-tests.instructions.md`](.github/instructions/go-tests.instructions.md) — Go test conventions
- [`provider.instructions.md`](.github/instructions/provider.instructions.md) — OS provider conventions
- [`image-templates.instructions.md`](.github/instructions/image-templates.instructions.md) — YAML image template conventions

---

## Security

- TLS 1.2+ via the project HTTP client.
- Shell allowlist enforced — adding a new command requires justification.
- Validate templates against `os-image-template.schema.json` (`image-composer-tool validate -t …`).
- File permissions: `0700` chroot dirs, `0755` general dirs, `0644` data, `0640` logs.
- Never embed secrets in fixtures, code, or logs.
- CI gates: Trivy (HIGH/CRITICAL fails), Gitleaks, Zizmor.

---

## Git & PRs

- Sign commits (`git commit -S`).
- Conventional commits: `type(scope): description` (`feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `build`, `ci`, `perf`).
- Branches: `feature/`, `fix/`, `docs/`, `refactor/`.
- Use `.github/PULL_REQUEST_TEMPLATE.md`.
- **Never** force-push shared branches, **never** `--no-verify`.
- Do **not** add AI co-author trailers unless the repo asks for them.
- The `gh` CLI is available — prefer it over manual web steps.

---

## Anti-patterns

- Adding `// TODO`, docstrings, or type annotations to unchanged code.
- "Helper" packages or interfaces for a single caller.
- Catching errors only to rewrap with no added context.
- Pulling new dependencies without stating why.
- Generating standalone "summary of changes" markdown files — put that in the PR body.

---

## Reusable prompts

- [`.github/prompts/add-os-provider.prompt.md`](.github/prompts/add-os-provider.prompt.md) — scaffold a new OS provider end-to-end.

---

## Hard-won context (read before touching the web UI or the farm)

- [`.claude/YAML-INTEGRITY.md`](.claude/YAML-INTEGRITY.md) — **mandatory** before
  editing `web/src/lib/draftFromYaml.ts`, `web/src/store.ts`,
  `internal/api/jenkins.go`, or the template schema. A UI defect handed the
  Jenkins farm silently-corrupted `TEMPLATE_YAML`: one build failed after
  installing all 270 packages, and two went **green while publishing images that
  did not match their templates**. Nine root causes, the four layers that now
  prevent it, and the invariant to keep (`cd web && npm run test:fidelity`).
- [`.claude/SESSION-FINDINGS.md`](.claude/SESSION-FINDINGS.md) — verified facts
  about the farm and build engine, plus corrections to the onboarding docs:
  the CAC branch split that is one cleanup away from a farm-wide outage, why ISO
  builds ship with no SBOM, two dead phase markers, the direction-dependent
  proxy trap, and how to run a local build on a proxied host.
- [`.claude/UI-LAYOUT.md`](.claude/UI-LAYOUT.md) — **mandatory** before adding a
  `sm:`/`md:`/`lg:`/`xl:` class under `web/src/components/`, putting
  `@container` on anything, or touching `--header-h`. Viewport breakpoints
  measure the wrong box here — content lives in percentage-sized resizable
  panes, and over part of its range a viewport breakpoint is *anti-correlated*
  with the width that matters. Also: why `container-type` silently kills
  dropdowns and `position: fixed` overlays, why Tailwind v4 regenerates classes
  you name in a comment, and which responsive work is still unfinished on
  `main`.

Two rules distilled from the YAML-integrity incident:

1. **When triaging a farm failure, diff the job's `TEMPLATE_YAML` parameter
   against the on-disk template first.** Job status says nothing about payload
   integrity.
2. **Prefer passing YAML through verbatim over reconstructing it.** Any
   reconstruction is only as complete as the model behind it.

---

## Key files

- `internal/config/config.go` — `ImageTemplate` struct
- `internal/provider/provider.go` — `Provider` interface
- `internal/utils/logger/` — zap-based project logger
- `internal/utils/network/securehttp.go` — secure HTTP client
- `internal/utils/shell/shell.go` — command allowlist
- `image-templates/*.yml` — example templates
- `config/osv/` — per-OS defaults
- `.golangci.yml` — lint config
- `.coverage-threshold` — current coverage floor
- `docs/architecture-decision-record/` — ADRs and design docs

---

*If you update conventions here, update [`.github/copilot-instructions.md`](.github/copilot-instructions.md) too — and vice versa.*
