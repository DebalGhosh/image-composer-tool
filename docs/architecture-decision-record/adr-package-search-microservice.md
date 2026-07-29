# ADR: Package Search Microservice

**Status**: Accepted
**Date**: 2026-07-29
**Authors**: ICT Team
**Technical Area**: Backend, Package Metadata, Container Topology
**Related**: [ADR: Web UI Tech Stack](./adr-web-ui-tech-stack.md), `internal/pkgsvc/`, `cmd/ict-pkgsvc/main.go`, `Dockerfile.pkgsvc`

---

## Summary

The fork splits the `/api/v1/packages` fuzzy-search catalogue out of the main
backend and into a dedicated Go microservice, `ict-pkgsvc`, packaged as a third
container alongside the frontend and the main backend. The main backend keeps
the `/api/v1/packages*` URL surface but reverse-proxies it to the microservice
when `PKGSVC_URL` is set; the microservice crawls upstream Debian/Ubuntu
metadata directly, builds a Bleve v2 index in-process, and serves it over
HTTP. An embedded-shard fallback stays in the main backend during migration so
single-binary local dev still works.

---

## Context

### Problem Statement

Prior to this ADR, `/api/v1/packages` was served entirely by the main backend.
`internal/api/handlers_packages.go` still shows the historical shape at
lines 42-48:

    //go:embed data/packages/*.json data/packages/*.yaml
    var packagesFS embed.FS

The embedded fallback carries two hand-maintained JSON shards under
`internal/api/data/packages/` (`ubuntu24-amd64.json` — 32 records — plus a
14-line `debian13-amd64.json` stub) driven by `data/packages/index.yaml`. The
serving path, `handleSearchPackages` (line 223 of the same file), implemented
a four-tier score — 0 exact name, 1 name-prefix, 2 name-substring, 3
description-substring — over that in-memory list. The frontend's
`PackageSearchCombobox` then re-scored the returned page through MiniSearch on
every keystroke.

Three properties of that arrangement bit us:

1. The catalogue was frozen at `go build` time. Adding a package or picking up
   an Ubuntu point-release meant regenerating a JSON shard, committing it,
   and shipping a new binary. There was no path for a running deployment to
   see upstream changes.
2. The nine-field on-disk schema (`n/v/d/a/s/r/o/t/p`) had no room for the
   richer metadata a real package picker needs: DebTags, AppStream
   categories/keywords, popcon install counts, homepage, provides
   sub-objects.
3. A useful catalogue is a memory-and-storage hog. Ubuntu noble main+universe
   amd64 alone is ~70,854 records; the two-family default corpus is roughly
   139k documents. Baking that into the main backend's process would tie the
   search-index footprint to every restart of the API server that also
   dispatches builds and streams SSE logs.

### Constraints

- The frontend must keep calling same-origin `/api/v1/packages` — no CORS,
  no rebase of the SPA's fetch layer.
- Local single-binary dev (`go build -o image-composer-tool
  ./cmd/image-composer-tool && ./image-composer-tool serve`) has to keep
  working without a sidecar. New contributors should not have to bring up
  Docker Compose just to open the Advanced tab.
- The microservice must be operable inside the CaaS "one image per service"
  model: no external index engine, no per-instance manual seeding.
- Corporate-proxy passthrough for the crawler must be a compose-time env-var
  concern, not a code concern.

---

## Decision

Move the package-search index into `ict-pkgsvc`, a separate Go binary defined
by `cmd/ict-pkgsvc/main.go`, packaged as `Dockerfile.pkgsvc` and wired into
`docker-compose.yml` as the `pkgsvc` service alongside `backend` and
`frontend`. The main backend keeps the public URL, but its handler is now a
reverse-proxy; the microservice owns the corpus, the index, and the crawler.

### Container topology

`docker-compose.yml` declares three services: `pkgsvc`, `backend`,
`frontend`. `pkgsvc` is not port-published; the backend reaches it over the
`ict-ui` bridge network under the DNS name `pkgsvc`, and the backend's
default `PKGSVC_URL` is `http://pkgsvc:9090` (see the `backend.environment`
block at `docker-compose.yml:81`). The frontend is served by nginx-
unprivileged listening on container port 8080 (mapped to host port 5173 in
compose); in dev, Vite proxies `/api/*` into the Go server directly. A
`pkgsvc-data` volume persists the Bleve mmap under `/var/lib/pkgsvc` so a
container restart does not force a full re-crawl.

The runtime image is `gcr.io/distroless/static-debian12:nonroot` (uid
65532). The container's healthcheck runs the binary's own
`ict-pkgsvc healthcheck` subcommand — `Dockerfile.pkgsvc:75-76` — which GETs
`http://127.0.0.1:$PKGSVC_LISTEN_ADDR/health` and exits 0 on 200. Because
the runtime has no shell and no curl, an in-binary probe is the only sane
option.

### Main-backend surface

`internal/api/handlers_packages.go` was reduced to a routing decision. At
line 223 the search handler now branches:

    if s.cfg.PkgsvcURL != "" {
        s.proxyToPkgsvc(w, r)
        return
    }
    // ...embed-scan fallback below...

`proxyToPkgsvc` (line 398) uses `httputil.NewSingleHostReverseProxy` to
rewrite `/api/v1/packages?q=…` into `/search?q=…&fields=legacy` on the
microservice. The `fields=legacy` projection is the on-wire compatibility
seam: `internal/pkgsvc/schema/record.go` exposes `ProjectToLegacy` so
`{ n, v, d, a, s, r, o, t, p[] }` still comes out the far side, byte-
identical to the pre-split response body. `handlePackageDetails` (line
352) does the same trick for `GET /api/v1/packages/{os}/{arch}/{name}`,
rewriting into `/package/{os}/{arch}/{name}`.

Both proxy paths set `X-Package-Index-Missing` on failure — the same header
the historic embed-scan path set on cache miss — so the frontend's fallback
banner logic keeps working unchanged.

### Microservice HTTP surface

`internal/pkgsvc/handler/search.go`'s `Routes()` (line 46) wires:

- `GET /search` — primary query. `fields=legacy` (default) returns the
  nine-field legacy record; `fields=full` returns the enriched
  `schema.PackageRecord` (homepage, provides sub-object, `tags[]`,
  `categories[]`, `keywords[]`, `depends[]`, `recommends[]`, popcon).
  `os`/`arch`/`limit`/`offset` are supported. `limit` is clamped to 1..100.
- `GET /package/{os}/{arch}/{name}` — single-record lookup, iterates known
  release+component combinations and returns the first `Idx.Get()` hit.
- `GET /suggest` — cheap typeahead over `name.ngram` + `keywords_ngram`.
- `GET /categories`, `GET /tags` — facet endpoints, marked "v2" in code.
- `GET /health` — always 200 while the process is alive; reports
  `docs` count. Deliberately never 503, so a slow crawler cannot force an
  orchestrator restart loop.
- `GET /readyz` — 503 until the index has at least one document; flips to
  200 when either the seed load or the first crawl lands. Compose's
  `depends_on: service_healthy` gates the backend on this.
- `POST /admin/refresh` — token-gated, forwards to
  `Orchestrator.TriggerRefresh(os, release, arch)`, 202 fire-and-forget.

### Search core

`internal/pkgsvc/index/bleve.go` builds a Bleve v2 index with a custom
mapping. `NewMapping` registers a `pkg_edge_ngram_filter` (min 2, max 15)
and the `pkg_edge_ngram` analyzer built as unicode-tokenize → lowercase →
edge_ngram. The same source string is indexed under two aliases:

- `name.exact` — keyword-lowercased, boost `20.0`.
- `name.ngram` — edge_ngram(2,15), boost `8.0`, and gets
  `SetFuzziness(1)` when the query is at least 4 characters (see
  `buildQuery`, line 388).

Query-time boosts, as set in `buildQuery` (lines 378-426):
`name.exact` 20, `name.ngram` 8, `provides.binary` 6, `keywords` 4,
`tags` 3, `summary` 2, `categories` 1.5, `description` 1.

After Bleve returns its TF-IDF-ish score, `Search` (line 291) reweights
by popcon install count. Constants at lines 331-332:

    popWeight = 0.5    // max additional multiplier (0.5 → up to 1.5×)
    popAnchor = 100000 // inst count that yields the full popWeight

producing `popFactor = 1 + 0.5 * min(1, log1p(inst)/log1p(100_000))`. The
1.5x cap is deliberate: the 20-vs-1 field-boost spread must stay wider
than any popularity swing, otherwise a popular description-substring hit
could out-rank a legitimate exact-name hit on an obscure package.

### Corpus and refresh

`PKGSVC_SOURCES` defaults to `ubuntu:noble:amd64,debian:trixie:amd64`
(`cmd/ict-pkgsvc/main.go:217`). `buildSources` at line 231 fans that spec
out into a `[]crawler.Source`, hard-wiring component lists per family
(`main+universe` for Ubuntu, `main` for Debian) and popcon URLs
(`popcon.ubuntu.com/by_inst`, `popcon.debian.org/by_inst.gz`). On a live
crawl the resulting corpus is roughly 70,854 records for Ubuntu noble
main+universe amd64 and 68,755 for Debian trixie main amd64 — about
139k total.

`internal/pkgsvc/crawler/orchestrator.go`'s `Run` (line 115) triggers a
refresh on start, then every `PKGSVC_REFRESH_INTERVAL` (default 6h) with
±10% jitter applied by `jitter(d)` at line 366. Per source, the refresh
fetches `dists/<release>/InRelease`, compares each component's SHA256
against the persisted `state.Store` snapshot at line 298, and short-
circuits when nothing changed. A shard that did change is re-fetched,
merged, and ingested via `Index.IngestBatch`; the index's own
`sync.RWMutex` (line 176) means concurrent `/search` calls only take
RLock and are never blocked by an ingest — the writer swaps under
Lock, and the previous handle is closed after the pointer flip. If a
refresh fails, the previous index is retained intact.

### Migration path

The rollout is four steps, tracked in `docker-compose.yml:37-41`:

1. **Seed parity.** Ship the microservice with `PKGSVC_CRAWLER_ENABLED=false`.
   `seed.LoadEmbedded` (invoked from `cmd/ict-pkgsvc/main.go:82`) loads the
   same embedded shards the main backend used to serve, so behaviour is
   byte-identical to the pre-split era.
2. **Crawler on.** Flip `PKGSVC_CRAWLER_ENABLED=true`, hit the live 139k
   corpus. The fork is at this step in production.
3. **Frontend rich-mode.** Frontend starts requesting `fields=full` for the
   detail pane, using the enriched schema.
4. **Delete embed fallback.** Remove `packagesFS` and the embed-scan branch
   from `handlers_packages.go`, making `PKGSVC_URL` mandatory.

The embed fallback stays through step 4 for local dev parity — a
contributor running `go run ./cmd/image-composer-tool serve` gets the same
32-row Ubuntu picker they had before, no compose required.

---

## Consequences

### Positive

- **Fresh catalogue.** Restarting the main backend no longer drops the
  search index; restarting `ict-pkgsvc` no longer kills in-flight Jenkins
  builds. The two failure domains are decoupled.
- **Horizontal scale.** `PKGSVC_URL` can be retargeted at a load-balanced
  fleet without touching backend code. The search tier scales
  independently of the build-dispatch tier.
- **Richer schema.** `fields=full` unlocks the enriched `PackageRecord`
  — homepage, popcon, `provides` sub-object, `tags[]`, `categories[]`,
  `keywords[]`, `depends[]`, `recommends[]` — with no change to the
  legacy on-wire shape.
- **Real query language.** Server-side Bleve replaces the four-tier
  substring score. The frontend no longer needs to re-index a 32-row
  response through MiniSearch on every keystroke.
- **Additive backends.** A future RPM Fedora or Alpine APKINDEX source
  is a new `crawler.Source` plus a new fetcher, not a main-backend
  patch.

### Negative

- **Extra container to operate.** `pkgsvc-data` volume, cache under
  `/var/lib/pkgsvc/cache` (4 GiB soft ceiling), Bleve mmap under
  `/var/lib/pkgsvc/index` (8 GiB soft ceiling). Backups and volume
  lifecycle become an ops concern.
- **Proxy hop.** Every `/api/v1/packages` call now traverses
  `httputil.NewSingleHostReverseProxy`. On loopback this is ~1 ms and
  invisible; in a WAN CaaS split it is meaningful and needs its own
  timeout budget.
- **Cold-start gap.** A fresh container with an empty volume serves an
  empty index until the first crawler ingest lands (~35s in practice).
  `/readyz` returns 503 during that window so compose
  `depends_on: service_healthy` blocks the backend from proxying to it,
  but a stateless restart under load still means clients see the empty
  window if compose ordering is bypassed.
- **New env-var surface.** `PKGSVC_LISTEN_ADDR`, `PKGSVC_CACHE_DIR`,
  `PKGSVC_INDEX_DIR`, `PKGSVC_REFRESH_INTERVAL`, `PKGSVC_SOURCES`,
  `PKGSVC_UBUNTU_MIRROR`, `PKGSVC_DEBIAN_MIRROR`,
  `PKGSVC_CRAWLER_ENABLED`, `PKGSVC_ADMIN_TOKEN`, `PKGSVC_URL`.
  Documented inline in `docker-compose.yml:30-46`.

### Neutral

- The main-backend `handleSearchPackages` no longer does its own
  scoring — it becomes a router. This is a code-shape shift, not a
  behaviour shift for the frontend.
- The client-side MiniSearch layer becomes redundant for served
  results, but stays useful for post-fetch filtering as long as the
  frontend continues to fetch pages rather than streaming.
- The embedded shards under `internal/api/data/packages/` remain in
  the tree through migration step 4. They are dead weight in
  microservice-enabled deployments but harmless.

---

## Rejected alternatives

**Keep the embed shards, regenerate them at build time via a
`cmd/ict-index` CLI.** Cleaner than hand-editing JSON, but still frozen
per image ship: a running deployment sees whatever the release engineer
saw, nothing later. Adding a new source (a new release, a new arch)
still requires a code change. No path to popcon or AppStream data.

**Serve search via a public API (Repology, packages.debian.org).**
Repology's public API is rate-limited to 1 req/s, which the Advanced
tab's per-keystroke autocomplete would consume immediately. Both are
external dependencies for what should be a stable internal service —
outages, DNS, and corporate-proxy egress become the picker's failure
modes.

**Bake a full-text engine as a sidecar — Meilisearch, Typesense,
Elasticsearch.** Any of these would work technically, but each drags a
second volume and a second env-var surface into the deployment for a
corpus that is only 100k-200k documents. A single-binary Go service
with Bleve stays inside the "one image per service" story the rest of
the fork commits to; sidecar orchestration is not paid for by the
scale we actually have.

**SQLite FTS5 in-process.** Considered specifically to keep the
microservice bytes-minimal, but FTS5's fuzzy story is weak — trigram
tokenizer at best, no true edit distance without the `spellfix1`
extension, which is not present in the `modernc.org/sqlite` pure-Go
build the rest of the codebase uses. The UX bar for a package picker
demands real typo tolerance, which Bleve's `name.ngram` +
`SetFuzziness(1)` delivers with a few lines of query builder.

---

## Implementation notes

### File map

    cmd/ict-pkgsvc/main.go               # binary entrypoint + config + subcommands
    Dockerfile.pkgsvc                    # two-stage build → distroless/static:nonroot
    docker-compose.yml                   # `pkgsvc` service, pkgsvc-data volume

    internal/pkgsvc/
    ├── crawler/
    │   ├── orchestrator.go              # Run loop, jitter, InRelease SHA256 gate
    │   ├── deb.go / appstream.go / popcon.go / inrelease.go / fetcher.go
    ├── handler/search.go                # HTTP routes
    ├── index/bleve.go                   # mapping, RWMutex, atomic swap, query
    ├── schema/record.go                 # PackageRecord + LegacyRecord + projection
    ├── seed/                            # embedded-shard bootstrap
    └── state/                           # persisted per-source SHA256 snapshot

    internal/api/handlers_packages.go    # main-backend proxy + embed fallback

### Boot-time behaviour

`run()` in `cmd/ict-pkgsvc/main.go` opens the Bleve index under
`$PKGSVC_INDEX_DIR/main` (line 70), then — only when `Idx.DocCount() == 0`
— pulls the embedded seed via `seed.LoadEmbedded` (line 82). A restart
on top of a persisted volume finds records already present and skips
the seed. The orchestrator is always started (line 131), even when
`PKGSVC_CRAWLER_ENABLED=false`, so `POST /admin/refresh` still works;
periodic ticks are the only thing the flag disables. A background
goroutine (lines 134-148) polls `Idx.DocCount()` every 5s and flips
`srv.SetReady(true)` once the first records land, so cold-start
`/readyz` transitions cleanly without a manual signal.

### Env vars — authoritative list

Defined in `loadConfig` at `cmd/ict-pkgsvc/main.go:212`:

| Var | Default | Purpose |
|---|---|---|
| `PKGSVC_LISTEN_ADDR` | `:9090` | HTTP listen address; also read by the `healthcheck` subcommand |
| `PKGSVC_CACHE_DIR` | `/var/lib/pkgsvc/cache` | Raw upstream fetch cache |
| `PKGSVC_INDEX_DIR` | `/var/lib/pkgsvc/index` | Bleve mmap dir |
| `PKGSVC_REFRESH_INTERVAL` | `6h` | Ticker period; accepts plain integer seconds |
| `PKGSVC_SOURCES` | `ubuntu:noble:amd64,debian:trixie:amd64` | Comma-separated `os:release:arch` |
| `PKGSVC_UBUNTU_MIRROR` | `http://archive.ubuntu.com/ubuntu` | Mirror base per family |
| `PKGSVC_DEBIAN_MIRROR` | `http://deb.debian.org/debian` | Mirror base per family |
| `PKGSVC_CRAWLER_ENABLED` | `false` | Master switch for periodic refreshes |
| `PKGSVC_ADMIN_TOKEN` | *(unset)* | `X-Admin-Token` value gating `POST /admin/refresh` |

Backend-side, `PKGSVC_URL` (defaulting to `http://pkgsvc:9090` in
compose) selects the proxy path over the embed fallback.

### Failure modes and their responses

- **Unreachable microservice.** `proxyToPkgsvc`'s `ErrorHandler`
  (`handlers_packages.go:425`) returns 200 with an empty result set
  and `X-Package-Index-Missing: pkgsvc-unreachable;reason=proxy-error`,
  matching the historic empty-index shape. The Advanced tab's
  fallback banner fires as if the shard were absent.
- **Details endpoint with `PKGSVC_URL` unset.** `handlePackageDetails`
  (line 352) returns 404 `PKGSVC_DISABLED` — the embed fallback
  never carried single-record lookups, so there is nothing to serve.
- **Malformed `PKGSVC_URL`.** Both proxy handlers return 500
  `PKGSVC_URL_INVALID` with the parse error verbatim.
- **Crawler failure on a shard.** The orchestrator logs and continues;
  the shard's previous records stay in the index. No user-visible
  state change beyond a stale timestamp.
- **Admin refresh without a token configured.** `handleAdminRefresh`
  (`handler/search.go:255`) returns 501 Not Implemented rather than
  lying with a 200 — an intentional signal to the operator that the
  service was not configured for administrative writes.

### Testing

`internal/pkgsvc/index/bleve_test.go` covers the mapping, boost order,
and popularity tiebreak cap. `internal/pkgsvc/crawler/deb_test.go` and
`popcon_test.go` cover the parser paths. The embed-fallback path in the
main backend is exercised by the existing `internal/api` test suite
through the historical shard layout at `internal/api/data/packages/`.