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
// Server-side ranking is intentionally simple: an exact name match ranks
// first, then case-insensitive name-prefix, then case-insensitive
// name-substring, then case-insensitive description-substring, else drop.
// The client (MiniSearch) does the fancy fuzzy scoring on the returned page.
func (s *Server) handleSearchPackages(w http.ResponseWriter, r *http.Request) {
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
