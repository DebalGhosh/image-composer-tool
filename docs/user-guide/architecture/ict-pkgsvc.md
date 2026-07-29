# ict-pkgsvc — Package Search Microservice

## Overview

`ict-pkgsvc` is a standalone Go microservice that owns the package-search corpus for the fork's web UI. It crawls upstream Debian and Ubuntu metadata (`Packages.xz` plus dep11 AppStream plus popcon), builds a fuzzy-searchable Bleve index on a persistent volume, and serves that index over an unversioned HTTP surface on `:9090`. Splitting the search corpus out of the main backend keeps the multi-hundred-megabyte Bleve mmap out of the Go binary and lets operators refresh the catalogue on a schedule independent of backend releases.

In the three-container deployment the frontend container's nginx terminates the browser request, forwards `/api/v1/*` to the main backend on `backend:8080`, and the main backend's `proxyToPkgsvc` handler (`internal/api/handlers_packages.go:398`) reverse-proxies `/api/v1/packages` to `http://pkgsvc:9090/search`. The frontend never speaks to `ict-pkgsvc` directly, so a same-origin CSP holds and the microservice needs no CORS layer.

    Browser ─► frontend (nginx :8080)
              └► backend (Go :8080)
                  ├─ /api/v1/manifest, /api/v1/builds, /api/v1/jenkins/*  (local)
                  └─ /api/v1/packages*  ──►  ict-pkgsvc (:9090) /search

## HTTP API

Every route is registered in `internal/pkgsvc/handler/search.go:46` on a plain `http.ServeMux`. All responses are JSON; the microservice has no path prefix of its own because versioning lives on the main backend's `/api/v1/` mount.

| Method | Path | Purpose | Response |
|---|---|---|---|
| GET | `/search` | Fuzzy query with optional `os`/`arch` filters, paging, and two projection modes | `{query, total, packages[]}` |
| GET | `/package/{os}/{arch}/{name}` | Single-record lookup by DocID components; scans known component/release pairs | Full `PackageRecord` or 404 |
| GET | `/suggest` | Cheap typeahead — hits only `name.ngram` and `keywords.ngram` | `{suggestions: [name, …]}` |
| GET | `/categories` | AppStream category facet (v2 stub) | `{"note":"categories facet: v2"}` |
| GET | `/tags` | DebTags facet (v2 stub) | `{"note":"tags facet: v2"}` |
| GET | `/health` | Liveness — always 200 while the process is up | `{status:"ok", docs:<int>}` |
| GET | `/readyz` | Readiness — 200 once a shard is loaded, else 503 | `{ready: true/false}` |
| POST | `/admin/refresh` | Fire a manual crawl; guarded by `X-Admin-Token` | `202 {accepted, os, release, arch}` |

`/search` accepts `q`, `os`, `arch`, `limit` (1..100, default 50), `offset` (≥0, default 0), and `fields`. When `fields=legacy` (the default) the `packages[]` slice is projected through `schema.ProjectToLegacy` (`internal/pkgsvc/schema/record.go:129`) so the response byte-matches the pre-microservice `/api/v1/packages` surface the frontend already consumes. When `fields=full`, each entry is the whole `schema.PackageRecord`. `handlePackage` returns the full record only — the legacy projection is a search-path affordance.

### Curl walkthrough

    curl -sS "http://127.0.0.1:9090/health"
    curl -sS "http://127.0.0.1:9090/readyz"
    curl -sS "http://127.0.0.1:9090/search?q=gcc&os=ubuntu&arch=amd64&limit=5"
    curl -sS "http://127.0.0.1:9090/search?q=gcc&fields=full&limit=1"
    curl -sS "http://127.0.0.1:9090/suggest?q=gc&limit=8"
    curl -sS "http://127.0.0.1:9090/package/ubuntu/amd64/gcc"
    curl -sS "http://127.0.0.1:9090/categories"
    curl -sS "http://127.0.0.1:9090/tags"

The admin refresh requires the token — an unset `PKGSVC_ADMIN_TOKEN` on the server makes the route return `501 Not Implemented` rather than lie with a `200`:

    curl -sS -X POST \
        -H "X-Admin-Token: $PKGSVC_ADMIN_TOKEN" \
        "http://127.0.0.1:9090/admin/refresh?os=ubuntu&release=noble&arch=amd64"

`os` on `/search` is normalised by `normalizeOS` (`internal/pkgsvc/handler/search.go:178`): the codenames the frontend uses (`ubuntu24`, `debian13`) collapse to the family names (`ubuntu`, `debian`) that Bleve actually indexes, and any unknown token has its trailing digits stripped so a future `fedora40` still lands on the `fedora` family.

## Configuration

Every knob is an env var; the microservice has no config file. `loadConfig` in `cmd/ict-pkgsvc/main.go:212` is the single source of truth for defaults.

| Env var | Default | Purpose |
|---|---|---|
| `PKGSVC_LISTEN_ADDR` | `:9090` | Passed to `http.Server.Addr`; the `healthcheck` subcommand rewrites a bare `:9090` to `127.0.0.1:9090` so a docker probe stays local (`main.go:180`) |
| `PKGSVC_CACHE_DIR` | `/var/lib/pkgsvc/cache` | Raw upstream artefacts land here; also anchors the sibling `state.json` |
| `PKGSVC_INDEX_DIR` | `/var/lib/pkgsvc/index` | The Bleve directory; `main.go:70` opens `<PKGSVC_INDEX_DIR>/main` |
| `PKGSVC_REFRESH_INTERVAL` | `6h` | Time between crawler ticks. Accepts `time.ParseDuration` strings; integers are read as seconds so YAML files that hate unquoted `6h` work anyway (`main.go:309`) |
| `PKGSVC_SOURCES` | `ubuntu:noble:amd64,debian:trixie:amd64` | Comma-separated `os:release:arch` triples parsed by `buildSources` (`main.go:231`); unknown families reject at boot rather than silently mis-crawl |
| `PKGSVC_UBUNTU_MIRROR` | `http://archive.ubuntu.com/ubuntu` | Prefix for the ubuntu family's `dists/<release>/…` fetches |
| `PKGSVC_DEBIAN_MIRROR` | `http://deb.debian.org/debian` | Same, Debian family |
| `PKGSVC_CRAWLER_ENABLED` | `false` | When `false` the periodic tick is a no-op; `/admin/refresh` still fires. Ships false so migration step 1 behaves byte-identically to the pre-microservice era off the embedded seed corpus |
| `PKGSVC_ADMIN_TOKEN` | `""` (unset) | Guards `POST /admin/refresh` (`search.go:255`). Unset means the route returns 501 |
| `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` | passthrough | `docker-compose.yml:44` forwards these; the Go stdlib `http.Transport` reads them for the crawler's outbound calls |

The default `Sources` string means "Ubuntu noble amd64 plus Debian trixie amd64"; `buildSources` also fixes the component list per family — `main`+`universe` for Ubuntu, `main` for Debian — and picks the popcon URL (`https://popcon.ubuntu.com/by_inst` or `https://popcon.debian.org/by_inst.gz`).

## Corpus pipeline

`Orchestrator.refreshOne` (`internal/pkgsvc/crawler/orchestrator.go:263`) walks each configured `Source` through a five-step pipeline. It never partial-swaps: any error at any step logs and returns, leaving the previously-ingested index intact.

The **first** step fetches `${MirrorBase}/dists/<release>/InRelease` through `HTTPFetcher.Fetch` (`internal/pkgsvc/crawler/fetcher.go:71`). InRelease itself is passed with an empty `checksum` argument — v1 relies on the mirror's clearsign anchor and does not verify the OpenPGP wrapper (a v2 hardening item). `ParseInRelease` (`internal/pkgsvc/crawler/inrelease.go:37`) walks the `SHA256:` paragraph and returns a `map[relPath]hexDigest`.

The **second** step, per component, reads the expected SHA256 for `<component>/binary-<arch>/Packages.xz` out of the map, compares it to the digest recorded for that shard in `state.json` (`internal/pkgsvc/state/state.go`, keyed by `ShardKey(os, release, arch, component)`), and skips the shard when nothing has drifted. When the digest has changed, `HTTPFetcher.Fetch` re-fetches the file and cryptographically verifies the compressed body against the InRelease-declared hash before returning bytes (`fetcher.go:93`). A mismatch returns `ErrChecksumMismatch` and the shard is dropped, not partially ingested.

The **third** step parses the decompressed body with `ParseDebPackages` (`internal/pkgsvc/crawler/deb.go:34`). This is the wrapper the fork keeps to work around `internal/ospackage/debutils.ParseRepositoryMetadata`'s narrow surface — the upstream parser drops fields the search UI needs, so `ParseDebPackages` preserves `Tag`, `Section`, `Homepage`, `Recommends`, `Suggests`, `Multi-Arch`, `Installed-Size`, `Source`, `Task`, `Description-md5`, and folds continuation-line `Description` bodies into a single string (with a 4 MiB scanner buffer for the pathological texlive stanzas at `deb.go:50`). `Filename:` is prefixed with `MirrorBase` to become `PackageRecord.SourceURL`.

The **fourth** step merges the dep11 AppStream YAML at `<component>/dep11/Components-<release>-<arch>.yml.gz`. `ParseAppStreamDep11` (`internal/pkgsvc/crawler/appstream.go:65`) deserialises the multi-document YAML; `ApplyAppStream` (`appstream.go:164`) merges each overlay entry onto the matching `PackageRecord`, contributing `Keywords[]`, `Categories[]`, screenshot URLs, and the `Provides` sub-object splits (`binary`, `library`, `mimetype`, `dbus`, `python`, `font`, `firmware`). Fetch or parse failure here is warned, not fatal — dep11 is a nice-to-have overlay.

The **fifth** step is popcon. `HTTPFetcher.Fetch` transparently gunzips `.gz` URLs (`fetcher.go:116`), and `ParsePopcon` (`internal/pkgsvc/crawler/popcon.go:27`) reads the `rank name inst vote old recent no-files (maintainer)` table skipping `#` comments and any non-numeric leading token. `ApplyPopcon` (`popcon.go:65`) stamps each record's `Popularity{Inst, Vote, Old, Recent}`. Missing packages stay at zero and correctly sort below anything with a real signal under the tiebreak below. Popcon fetch failure is warned but does not skip the shard.

The batch is then committed via `Index.IngestBatch` (`internal/pkgsvc/index/bleve.go:239`) — one Bleve batch, one fsync, `storeRecs[DocID(r)] = *r` in the mirror map, all under `Index.mu` write-locked. `Index` does not rebuild-then-swap directories; it updates docs in place by stable ID, and readers observe the batch atomically at commit time via Bleve's own snapshot semantics. Persistent state lives at `/var/lib/pkgsvc/cache/`, `/var/lib/pkgsvc/index/main/`, and `/var/lib/pkgsvc/state.json` (the latter path is `filepath.Join(cfg.CacheDir, "..", "state.json")` at `main.go:90`).

## Search core (Bleve)

`NewMapping` (`internal/pkgsvc/index/bleve.go:54`) wires the analyzer chain. Two custom analyzers get registered on the mapping:

| Analyzer | Chain | Where it's used |
|---|---|---|
| `pkg_keyword_lc` | `single` tokenizer → `lowercase` | `name.exact` — case-insensitive exact match on the package name |
| `pkg_edge_ngram` | `unicode` tokenizer → `lowercase` → `edge_ngram(2,15)` | `name.ngram` and `keywords.ngram` — prefix + typeahead surface |

Human text uses stock analyzers: `summary` is the `standard` analyzer, `description` is the English analyzer (`en.AnalyzerName`, stored=false because the long body isn't retrieved from the index — it comes from the `storeRecs` mirror). Faceted keyword fields (`tags`, `categories`, `section`, `os`, `release`, `arch`, `component`, and every `provides.*` sub-field) go through the built-in `keyword` analyzer. The `name` and `keywords` struct fields each use the two-names-one-source trick: `FieldMapping.Name` is overridden on each `*FieldMapping` so a single JSON value is indexed under two analyzer chains without one clobbering the other (`bleve.go:88`).

`buildQuery` (`bleve.go:367`) assembles the disjunction with a fixed boost table:

| Field | Boost | Notes |
|---|---|---|
| `name.exact` | 20.0 | `TermQuery` on the lowercased raw string |
| `name.ngram` | 8.0 | `MatchQuery`; `SetFuzziness(1)` only when `len(q) >= 4` |
| `provides.binary` | 6.0 | Exact term match |
| `keywords` | 4.0 | Standard-analyzer match |
| `tags` | 3.0 | DebTags exact term |
| `summary` | 2.0 | Standard-analyzer match |
| `categories` | 1.5 | Exact term |
| `description` | 1.0 | English-analyzer match; long text, no fuzziness |

`os` and `arch` filters attach via a `ConjunctionQuery` so they narrow rather than score — cheaper than a per-suite reindex.

The **popularity tiebreak** is applied after Bleve returns. `Search` requests `opts.Limit*4` hits with `Fields=["popularity.inst"]` (`bleve.go:306`), then rescores each with

    factor = 1.0 + POP_WEIGHT * min(1.0, log1p(inst) / log1p(POP_ANCHOR))
    score' = hit.Score * factor

where `POP_WEIGHT = 0.5` and `POP_ANCHOR = 100000` (`bleve.go:330`). The multiplier is bounded to `1.5×` and the anchor is calibrated to Ubuntu noble's rough median for a well-installed package — packages an order of magnitude more popular saturate the factor. The naïve `score * log1p(inst)` variant that got rejected during design gave a ~13× spread at `inst=500k`, which trivially beat the field boosts and made popular-but-tangential matches dominate; capping the popularity contribution below the field boost separation (20× vs. 1×) is why an exact `name.exact` hit still outranks a well-installed description-only match.

Document IDs are `os/release/arch/component/name` — see `DocID` (`bleve.go:264`). Re-ingest of the same package in a later crawl updates the existing document rather than duplicating it, and `handlePackage` uses the same shape to try Debian's component precedence order (`main`, `universe`, `multiverse`, `restricted`) across the two release names the fork ships with (`noble`, `trixie`, `jammy`, `bookworm`) before returning 404.

## Facets (v2)

`/categories` and `/tags` are placeholder handlers today — they return `{"note":"categories facet: v2"}` and `{"note":"tags facet: v2"}` respectively (`search.go:156`, `search.go:163`). The Bleve mapping already indexes `categories`, `tags`, and `section` as `keyword` faceted fields, so the aggregation is a one-shot `bleve.NewFacetRequest` when the UI actually needs it; nothing in the frontend consumes these routes yet.

Section aggregation still works for the frontend via the paged `/search` response: every hit carries `section` in its `LegacyRecord` projection, so the Interactive tab can bucket the current page client-side without a facet endpoint. That's the fallback the UI relies on until the v2 facets ship.

## Failure modes

**Cold start with no index**. `handleSearch` checks `s.Idx.DocCount() == 0` first and returns `{total:0, packages:[]}` with an `X-Package-Index-Missing: true` response header (`search.go:92`). `/readyz` returns 503 until either the seed loader (`seed.LoadEmbedded`, `main.go:82`) or the first successful crawler ingest lands, at which point `srv.SetReady(true)` (`main.go:113`, `main.go:143`) flips the atomic flag. Kubernetes / docker-compose `depends_on: service_healthy` will hold the main backend off the proxy until the flip.

**Refresh failure**. `refreshOne` never partial-swaps — a fetch error, a checksum mismatch, or a parse failure logs `refresh_failed` with `os`/`release`/`arch`/`err` (`orchestrator.go:189`) and returns. The previously-ingested `storeRecs` + Bleve directory stay intact; `state.json` is not updated for the failed shard, so the next tick will retry.

**Manual refresh coalescing**. `refreshAll` guards on `Orchestrator.inflight` (`orchestrator.go:166`) — a `/admin/refresh` fired while a scheduled refresh is running logs `refresh skipped: already in-flight` and returns immediately. The forceCh buffer is size 4; `TriggerRefresh` drops to `"refresh queue full; try again"` when it's saturated (`orchestrator.go:157`).

**Disk pressure**. The current tree has no on-disk quota enforcement — there is no `PKGSVC_CACHE_MAX_BYTES` or `PKGSVC_INDEX_MAX_BYTES` in `loadConfig`, and no LRU eviction path on the raw artefact cache. Operators size the `pkgsvc-data` volume for the corpus; with the default two-source set (`ubuntu:noble:amd64,debian:trixie:amd64`) the Bleve directory sits at roughly one to two GiB and the raw cache under `/var/lib/pkgsvc/cache/` is small because the crawler decompresses on the fly and does not persist the raw bodies. This is a known v2 gap.

## Container and CaaS deployment

`Dockerfile.pkgsvc` is a two-stage build. Stage 1 is `golang:1.25-bookworm` (`Dockerfile.pkgsvc:31`) with the module cache primed in its own layer so source changes do not re-download deps; the binary is compiled with `CGO_ENABLED=0 GOOS=linux GOARCH=amd64` and `-trimpath -ldflags="-s -w"` so it drops cleanly into the second stage. Stage 2 is `gcr.io/distroless/static-debian12:nonroot` (`Dockerfile.pkgsvc:57`) — the distroless image bakes UID 65532 (`nonroot`), the binary lands at `/usr/local/bin/ict-pkgsvc`, `VOLUME ["/var/lib/pkgsvc"]` declares the persistent mount, and `EXPOSE 9090` matches the default listen port. There is no shell in the image, so the `HEALTHCHECK` uses `exec` form and calls the binary's own `healthcheck` subcommand (`Dockerfile.pkgsvc:75`); that subcommand GETs `http://127.0.0.1:$PKGSVC_LISTEN_ADDR/health` and exits 0 or 1 (`main.go:173`), so the probe never touches the outbound network and does not need a curl binary in the image.

Docker-compose wiring lives in `docker-compose.yml`. The `pkgsvc` service (`docker-compose.yml:20`) declares the full env-var surface, mounts a named volume `pkgsvc-data` at `/var/lib/pkgsvc`, joins the `ict-ui` bridge network, and is intentionally not published — the backend reaches it over the internal network. `backend` (`docker-compose.yml:56`) sets `PKGSVC_URL: ${PKGSVC_URL:-http://pkgsvc:9090}` and declares `depends_on: pkgsvc: {condition: service_healthy}` so the Go server never fields a `/api/v1/packages` request while the microservice is still cold.

The CaaS re-target pattern is the reason `PKGSVC_URL` is a plain env var on the main backend rather than a build-time constant: swapping the value to any reachable pkgsvc DNS name or `host:port` (a Kubernetes Service, an internal load balancer, a colocated bare-metal instance) reroutes the reverse-proxy target without a frontend rebuild. The frontend keeps calling same-origin `/api/v1/packages` regardless.

## Testing

Every parser and index primitive is exercised locally against synthetic fixtures — CI never resolves `archive.ubuntu.com`. The `Fetcher` interface (`internal/pkgsvc/crawler/fetcher.go:32`) exists precisely so tests can inject an `httptest.Server`-backed impl and drive the orchestrator with hand-written bytes.

- `internal/pkgsvc/crawler/deb_test.go` — `TestParseDebPackages_PreservesDroppedFields` locks in that the wrapper retains every field the upstream `debutils` parser drops (Tag, Section, Homepage, Recommends, Suggests, Multi-Arch, Installed-Size, Source, Task) and that continuation-line Description folding round-trips. `TestParseInRelease_SHA256Map` covers the InRelease SHA256 paragraph parser.
- `internal/pkgsvc/crawler/popcon_test.go` — `TestParsePopcon` covers the by_inst table parser: comment skipping, non-numeric leading tokens, whitespace-split columns, `atoiSafe` on `?` cells.
- `internal/pkgsvc/index/bleve_test.go` — `TestBoostOrder` locks the field-boost table by asserting an exact `name.exact` hit outranks a keyword hit outranks a description-only hit for the same query. `TestPopularityTiebreak` verifies the log1p multiplier is bounded to 1.5× and cannot overturn the boost separation.
- `internal/api/handlers_packages_proxy_test.go` — `TestPkgsvcReverseProxy` stands up an `httptest.Server` masquerading as pkgsvc, points `PKGSVC_URL` at it, and asserts the main backend rewrites `/api/v1/packages` to `/search?fields=legacy` and streams the body through. `TestPkgsvcProxy_ErrorFallback` covers the 502 path: the `X-Package-Index-Missing: pkgsvc-unreachable;reason=proxy-error` header fires and the response is a valid empty-result JSON so the UI's fallback banner keeps working. `TestPkgsvcDetailsProxy_Path`, `TestPkgsvcDetailsProxy_NotConfigured`, and `TestPkgsvcDetailsProxy_Unreachable` cover the `/api/v1/packages/{os}/{arch}/{name}` details proxy — including that an empty `PKGSVC_URL` returns `PKGSVC_DISABLED` rather than pretending to serve.