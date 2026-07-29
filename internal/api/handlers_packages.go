// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Package-search endpoint. Serves a fuzzy-searchable catalogue of RPM + DEB
// packages the Interactive tab (and any future consumer) can pick from.
//
// The catalogue is a static bundle of per-(os, arch) JSON shards laid out
// under internal/api/data/packages/. Shards are built offline by cmd/ict-index
// -- see the plan doc. Empty index at ingest time is a supported state: the
// endpoint returns 200 with an empty result set plus an X-Package-Index-Missing
// warning header so the UI can render a helpful fallback.
//
// On-wire schema (verbose keys, human-friendly):
//   { "query", "total", "packages":[{ "name","version","description",
//                                     "arch","section","repository",
//                                     "os","type","provides"[] }] }
//
// On-disk schema (compact keys, shard sizes stay small at 20k+ entries):
//   [ {"n","v","d","a","s","r","o","t","p"[]}, ... ]

package api

import (
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/open-edge-platform/image-composer-tool/internal/utils/logger"
	"sigs.k8s.io/yaml"
)

// packagesFS is the embedded fallback used when Config.PackagesDir is empty
// (single-binary default). Operators can override with --packages-dir at
// runtime to point at a freshly-built index directory on disk without
// rebuilding the binary.
//
//go:embed data/packages/*.json data/packages/*.yaml
var packagesFS embed.FS

// packageRecord mirrors the on-disk compact shape. JSON tags use short keys so
// the file layout stays tiny (a 30 k-row shard is ~1 MB gzipped).
type packageRecord struct {
	Name        string   `json:"n"`
	Version     string   `json:"v"`
	Description string   `json:"d"`
	Arch        string   `json:"a"`
	Section     string   `json:"s"`
	Repository  string   `json:"r"`
	OS          string   `json:"o"`
	Type        string   `json:"t"`
	Provides    []string `json:"p,omitempty"`
}

// packageResult is the wire format. Verbose keys so the JSON is
// self-documenting from a browser DevTools tab.
type packageResult struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Arch        string   `json:"arch"`
	Section     string   `json:"section"`
	Repository  string   `json:"repository"`
	OS          string   `json:"os"`
	Type        string   `json:"type"`
	Provides    []string `json:"provides,omitempty"`
}

// packageSearchResponse is the /packages endpoint body. `total` is the
// pre-limit hit count so the UI can render "showing 50 of 217".
type packageSearchResponse struct {
	Query    string          `json:"query"`
	Total    int             `json:"total"`
	Packages []packageResult `json:"packages"`
}

// packageIndexShard is one (os, arch) slice loaded at startup, kept sorted by
// Name so simple binary-search prefix scans work without a secondary index.
type packageIndexShard struct {
	OS      string
	Arch    string
	Records []packageRecord
}

// packageIndex is the whole in-memory catalogue. Keyed by "<os>-<arch>" so
// lookup is O(1). Nil-safe when no packages are configured.
type packageIndex struct {
	mu     sync.RWMutex
	shards map[string]*packageIndexShard // key: os-arch
	// missing tracks (os, arch) keys the operator asked for that we couldn't
	// find on disk. Populated when the index is loaded so the endpoint can
	// emit a soft warning header for a specific-but-unknown key.
	knownOS map[string]struct{}
}

// packageIndexInventory is the shape of data/packages/index.yaml.
type packageIndexInventory struct {
	Shards []struct {
		OS           string `json:"os"`
		Arch         string `json:"arch"`
		File         string `json:"file"`
		PackageCount int    `json:"package_count"`
		GeneratedAt  string `json:"generated_at"`
	} `json:"shards"`
}

// loadPackageIndex reads every JSON shard under the effective packages dir
// (Config.PackagesDir if set, else the embedded fallback). Never fails hard:
// a missing directory or a bad JSON shard is logged and skipped so /packages
// keeps serving whatever DID load.
func loadPackageIndex(packagesDir string) *packageIndex {
	pi := &packageIndex{
		shards:  make(map[string]*packageIndexShard),
		knownOS: make(map[string]struct{}),
	}

	// Pick the FS: on-disk override wins over the embedded copy.
	var indexBytes []byte
	var readShard func(name string) ([]byte, error)
	if packagesDir != "" {
		p := filepath.Join(packagesDir, "index.yaml")
		if b, err := os.ReadFile(p); err == nil {
			indexBytes = b
		} else if !errors.Is(err, os.ErrNotExist) {
			logger.Logger().Warnf("packages index.yaml read failed: %v", err)
		}
		readShard = func(name string) ([]byte, error) {
			return os.ReadFile(filepath.Join(packagesDir, name))
		}
	} else {
		if b, err := packagesFS.ReadFile("data/packages/index.yaml"); err == nil {
			indexBytes = b
		}
		readShard = func(name string) ([]byte, error) {
			return packagesFS.ReadFile("data/packages/" + name)
		}
	}

	if len(indexBytes) == 0 {
		logger.Logger().Info("package index has no inventory; /api/v1/packages will report empty")
		return pi
	}

	var inv packageIndexInventory
	if err := yaml.Unmarshal(indexBytes, &inv); err != nil {
		logger.Logger().Warnf("package index inventory failed to parse: %v", err)
		return pi
	}

	for _, s := range inv.Shards {
		key := s.OS + "-" + s.Arch
		pi.knownOS[key] = struct{}{}
		raw, err := readShard(s.File)
		if err != nil {
			logger.Logger().Warnf("package shard %q missing: %v", s.File, err)
			continue
		}
		var recs []packageRecord
		if err := json.Unmarshal(raw, &recs); err != nil {
			logger.Logger().Warnf("package shard %q failed to parse: %v", s.File, err)
			continue
		}
		// Guarantee sort-by-name so the ranked-result cap is deterministic
		// even if a hand-authored shard drifted out of order.
		sort.Slice(recs, func(i, j int) bool { return recs[i].Name < recs[j].Name })
		pi.shards[key] = &packageIndexShard{
			OS:      s.OS,
			Arch:    s.Arch,
			Records: recs,
		}
		logger.Logger().Infof("loaded package shard %s (%d packages)", key, len(recs))
	}

	return pi
}

// find returns the shard for (os, arch), or nil if unknown.
func (pi *packageIndex) find(os, arch string) *packageIndexShard {
	if pi == nil {
		return nil
	}
	pi.mu.RLock()
	defer pi.mu.RUnlock()
	return pi.shards[os+"-"+arch]
}

// isKnown reports whether the inventory advertises this (os, arch) at all.
// Distinguishes "we know this key exists but the shard failed to load" from
// "the operator asked for a key nobody has ever heard of."
func (pi *packageIndex) isKnown(os, arch string) bool {
	if pi == nil {
		return false
	}
	pi.mu.RLock()
	defer pi.mu.RUnlock()
	_, ok := pi.knownOS[os+"-"+arch]
	return ok
}

// handleSearchPackages serves GET /api/v1/packages?os=&arch=&q=&limit=.
//
// When Config.PkgsvcURL is non-empty the request is reverse-proxied to the
// ict-pkgsvc microservice's /search endpoint with fields=legacy (which
// projects the enriched PackageRecord shape back to the same 9-field
// LegacyRecord the frontend has always consumed). When empty, we fall
// through to the embedded-shard scan — the migration-safety-net path that
// keeps single-binary local dev working with no sidecar.
//
// Server-side ranking of the embed fallback is intentionally simple: exact
// name match first, then case-insensitive name-prefix, then name-substring,
// then description-substring. The client (MiniSearch) does the fuzzy
// scoring on the returned page. The microservice does something much
// richer server-side (see internal/pkgsvc/index/bleve.go).
func (s *Server) handleSearchPackages(w http.ResponseWriter, r *http.Request) {
	// Reverse-proxy path: preferred when PkgsvcURL is configured. Uses
	// httputil.NewSingleHostReverseProxy so headers (including
	// X-Package-Index-Missing) round-trip unchanged.
	if s.cfg.PkgsvcURL != "" {
		s.proxyToPkgsvc(w, r)
		return
	}

	q := r.URL.Query().Get("q")
	osParam := r.URL.Query().Get("os")
	arch := r.URL.Query().Get("arch")
	if arch == "" {
		arch = "amd64"
	}
	if osParam == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "os is required")
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 200 {
		limit = 200
	}

	shard := s.packages.find(osParam, arch)
	if shard == nil {
		// Two flavours of empty: known key with missing shard, and totally
		// unknown key. Both return 200 empty + a header the UI can key off,
		// so the operator's fallback banner explains what's going on.
		if !s.packages.isKnown(osParam, arch) {
			w.Header().Set("X-Package-Index-Missing", osParam+"-"+arch+";reason=unknown")
		} else {
			w.Header().Set("X-Package-Index-Missing", osParam+"-"+arch+";reason=load-failed")
		}
		writeJSON(w, http.StatusOK, packageSearchResponse{
			Query:    q,
			Total:    0,
			Packages: []packageResult{},
		})
		return
	}

	needle := strings.ToLower(strings.TrimSpace(q))

	type scored struct {
		rec   *packageRecord
		score int // lower = better (0 exact-name, 1 name-prefix, 2 name-substr, 3 desc-substr)
	}
	hits := make([]scored, 0, len(shard.Records))
	for i := range shard.Records {
		rec := &shard.Records[i]
		if needle == "" {
			hits = append(hits, scored{rec: rec, score: 9}) // stable dump, name-sorted
			continue
		}
		lower := strings.ToLower(rec.Name)
		switch {
		case lower == needle:
			hits = append(hits, scored{rec: rec, score: 0})
		case strings.HasPrefix(lower, needle):
			hits = append(hits, scored{rec: rec, score: 1})
		case strings.Contains(lower, needle):
			hits = append(hits, scored{rec: rec, score: 2})
		case strings.Contains(strings.ToLower(rec.Description), needle):
			hits = append(hits, scored{rec: rec, score: 3})
		}
	}
	// Stable sort by score first, then name (already name-sorted, so this
	// preserves alpha order within each score bucket).
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score < hits[j].score
		}
		return hits[i].rec.Name < hits[j].rec.Name
	})

	total := len(hits)
	if limit < total {
		hits = hits[:limit]
	}

	out := make([]packageResult, 0, len(hits))
	for _, h := range hits {
		out = append(out, packageResult{
			Name:        h.rec.Name,
			Version:     h.rec.Version,
			Description: h.rec.Description,
			Arch:        h.rec.Arch,
			Section:     h.rec.Section,
			Repository:  h.rec.Repository,
			OS:          h.rec.OS,
			Type:        h.rec.Type,
			Provides:    h.rec.Provides,
		})
	}

	writeJSON(w, http.StatusOK, packageSearchResponse{
		Query:    q,
		Total:    total,
		Packages: out,
	})
}

// packagesFSStats is a small helper used by tests + startup logging that
// counts what's in the embedded fallback. Kept here so it's obvious the
// embedded shape is one dir, not a package.
func packagesFSStats() (int, error) {
	entries, err := fs.ReadDir(packagesFS, "data/packages")
	if err != nil {
		return 0, err
	}
	return len(entries), nil
}

// handlePackageDetails reverse-proxies GET /api/v1/packages/{os}/{arch}/{name}
// to the microservice's /package/{os}/{arch}/{name} single-record endpoint.
// Falls through to a 404 when PkgsvcURL is empty — the embed-scan fallback
// only carries the paged /packages surface, not per-record lookups.
//
// The frontend's PackageSearchDialog uses this to refresh the highlighted
// row's full metadata (homepage / popcon / provides / long description)
// without a full re-fetch of the page. On unreachable-pkgsvc the proxy
// answers 502 via the ErrorHandler so the dialog's detail pane renders
// its "detail unavailable" empty state instead of hanging.
func (s *Server) handlePackageDetails(w http.ResponseWriter, r *http.Request) {
	if s.cfg.PkgsvcURL == "" {
		writeError(w, http.StatusNotFound, "PKGSVC_DISABLED",
			"single-record package lookup requires the ict-pkgsvc microservice; set PKGSVC_URL on the backend")
		return
	}
	target, err := url.Parse(s.cfg.PkgsvcURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PKGSVC_URL_INVALID",
			"PKGSVC_URL is malformed: "+err.Error())
		return
	}
	osParam := r.PathValue("os")
	arch := r.PathValue("arch")
	name := r.PathValue("name")
	if osParam == "" || arch == "" || name == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "os/arch/name required")
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = "/package/" + osParam + "/" + arch + "/" + name
		// Path already carries everything; strip incoming query so any
		// junk the caller sent doesn't reach pkgsvc.
		req.URL.RawQuery = ""
		req.Host = target.Host
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, perr error) {
		logger.Logger().Warnf("pkgsvc details proxy error for %s: %v", r.URL.Path, perr)
		writeError(w, http.StatusBadGateway, "PKGSVC_UNREACHABLE",
			"could not reach ict-pkgsvc for package details: "+perr.Error())
	}
	proxy.ServeHTTP(w, r)
}

// proxyToPkgsvc reverse-proxies /api/v1/packages? … to the microservice's
// /search?fields=legacy path. The pkgsvc's legacy projection matches this
// endpoint's response shape byte-for-byte, so the frontend needs zero
// changes.
//
// Errors (unreachable pkgsvc, bad gateway, dial timeout) surface as 502
// through the httputil ErrorHandler. On any 502 the header
// X-Package-Index-Missing is set so the UI's fallback banner still fires
// (parity with the embed path's "index missing" case).
func (s *Server) proxyToPkgsvc(w http.ResponseWriter, r *http.Request) {
	target, err := url.Parse(s.cfg.PkgsvcURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PKGSVC_URL_INVALID",
			"PKGSVC_URL is malformed: "+err.Error())
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	// Rewrite the path so /api/v1/packages?q=… → target://search?q=…&fields=legacy.
	// httputil's default Director sets req.URL.Host + Scheme but keeps
	// req.URL.Path verbatim; we override to point at /search.
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = "/search"
		// Preserve the caller's query string but force fields=legacy so
		// the on-wire shape stays byte-identical. Any explicit
		// fields= in the caller's URL is honoured (lets the frontend
		// opt into fields=full later without a route change).
		q := req.URL.Query()
		if q.Get("fields") == "" {
			q.Set("fields", "legacy")
		}
		req.URL.RawQuery = q.Encode()
		// Drop the Host header the caller may have set (nginx does).
		req.Host = target.Host
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, perr error) {
		logger.Logger().Warnf("pkgsvc proxy error for %s: %v", r.URL.Path, perr)
		w.Header().Set("X-Package-Index-Missing", "pkgsvc-unreachable;reason=proxy-error")
		writeJSON(w, http.StatusOK, packageSearchResponse{
			Query:    r.URL.Query().Get("q"),
			Total:    0,
			Packages: []packageResult{},
		})
	}
	proxy.ServeHTTP(w, r)
}
