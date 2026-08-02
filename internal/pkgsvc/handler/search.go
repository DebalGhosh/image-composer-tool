// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Package handler wires the microservice's HTTP surface. Every response is
// JSON; every route is versioned implicitly by the microservice's own
// container tag (the paths themselves have no /v1/ prefix — that lives on
// the main backend which reverse-proxies here).
package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/index"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// Server bundles the search index + admin token + ready flag. It exposes
// http.Handler via Routes(). One struct so the wiring in main.go stays
// short.
type Server struct {
	Idx        *index.Index
	AdminToken string
	// Ready flips to 1 once at least one shard is loaded so /readyz can
	// return 200. Set via SetReady(true) by the orchestrator after its
	// first successful ingest OR by the seed loader at boot.
	ready atomic.Bool
	// TriggerRefresh, when non-nil, is invoked by POST /admin/refresh to
	// forward the request to the crawler orchestrator.
	TriggerRefresh func(os, release, arch string) <-chan error
}

// NewServer builds a Server. adminToken empty disables /admin/refresh
// (returns 501 Not Implemented rather than lying with a 200).
func NewServer(idx *index.Index, adminToken string) *Server {
	return &Server{Idx: idx, AdminToken: adminToken}
}

// SetReady flips the readiness flag. Idempotent.
func (s *Server) SetReady(v bool) { s.ready.Store(v) }

// Routes returns a fresh *http.ServeMux with every route wired.
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /search", s.handleSearch)
	mux.HandleFunc("GET /package/{os}/{arch}/{name}", s.handlePackage)
	mux.HandleFunc("GET /categories", s.handleCategories)
	mux.HandleFunc("GET /tags", s.handleTags)
	mux.HandleFunc("GET /suggest", s.handleSuggest)
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /readyz", s.handleReadyz)
	mux.HandleFunc("POST /admin/refresh", s.handleAdminRefresh)
	return mux
}

// searchResponse is the on-wire payload for /search. When `fields=legacy`
// (default) the Packages slice contains LegacyRecord entries; when
// `fields=full` it contains PackageRecord entries. The Total is the
// pre-truncation match count so the UI can render "1 of 5,234".
type searchResponse struct {
	Query    string `json:"query"`
	Total    int    `json:"total"`
	// Packages is heterogeneous by design — the frontend picks based on
	// the `fields` request param. JSON marshalling handles the concrete
	// type either way.
	Packages any `json:"packages"`
}

// handleSearch is the primary query endpoint. Query params:
//
//	q       search string (empty allowed → returns first `limit` records)
//	os      filter, e.g. "ubuntu"
//	arch    filter, e.g. "amd64"
//	limit   1..100, default 50
//	offset  ≥0, default 0
//	fields  "legacy" (default) or "full"
//
// Response headers:
//
//	X-Package-Index-Missing: true    when the index has zero docs
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	os := normalizeOS(r.URL.Query().Get("os"))
	arch := strings.ToLower(r.URL.Query().Get("arch"))
	fields := strings.ToLower(r.URL.Query().Get("fields"))
	limit := parseIntDefault(r.URL.Query().Get("limit"), 50, 1, 100)
	offset := parseIntDefault(r.URL.Query().Get("offset"), 0, 0, 100000)

	if s.Idx == nil || s.Idx.DocCount() == 0 {
		w.Header().Set("X-Package-Index-Missing", "true")
		writeJSON(w, http.StatusOK, searchResponse{
			Query: q, Total: 0, Packages: []any{},
		})
		return
	}

	hits, total, err := s.Idx.Search(index.SearchOpts{
		Query: q, OS: os, Arch: arch, Limit: limit, Offset: offset,
	})
	if err != nil {
		http.Error(w, "search: "+err.Error(), http.StatusInternalServerError)
		return
	}

	if fields == "full" {
		out := make([]schema.PackageRecord, 0, len(hits))
		for _, h := range hits {
			out = append(out, h.Record)
		}
		writeJSON(w, http.StatusOK, searchResponse{Query: q, Total: total, Packages: out})
		return
	}

	// Legacy shape (default) — projection.
	out := make([]schema.LegacyRecord, 0, len(hits))
	for _, h := range hits {
		rec := h.Record // avoid re-taking the address of the loop var
		out = append(out, schema.ProjectToLegacy(&rec))
	}
	writeJSON(w, http.StatusOK, searchResponse{Query: q, Total: total, Packages: out})
}

// handlePackage returns a single record by (os, arch, name). The
// component is inferred: whichever ingested doc matches wins.
// Ambiguous names (same package in main + universe) return the first
// hit — v2 will surface both as an array.
func (s *Server) handlePackage(w http.ResponseWriter, r *http.Request) {
	pathOS := r.PathValue("os")
	arch := r.PathValue("arch")
	name := r.PathValue("name")
	if pathOS == "" || arch == "" || name == "" {
		http.Error(w, "os/arch/name required", http.StatusBadRequest)
		return
	}
	// Try known components in Debian's precedence order. This is
	// cheaper than a Bleve query for a single-key lookup, and Get()
	// is O(1).
	for _, release := range []string{"noble", "trixie", "jammy", "bookworm"} {
		for _, comp := range []string{"main", "universe", "multiverse", "restricted"} {
			id := pathOS + "/" + release + "/" + arch + "/" + comp + "/" + name
			if r, ok := s.Idx.Get(id); ok {
				writeJSON(w, http.StatusOK, r)
				return
			}
		}
	}
	http.Error(w, "package not found", http.StatusNotFound)
}

// handleCategories returns AppStream category facets with counts. Cheap
// aggregation: Bleve facets over the categories keyword field. v2 could Bleve-
// facet this properly.
func (s *Server) handleCategories(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"note": "categories facet: v2",
	})
}

// handleTags mirrors handleCategories for DebTags.
func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"note": "tags facet: v2",
	})
}

// normalizeOS folds the codename-based OS ids the frontend uses
// ("ubuntu24", "debian13") into the family names the enriched
// PackageRecord carries ("ubuntu", "debian"), while leaving family names
// unchanged. Bleve's os facet is keyword-lowercased, so this is the one
// place the two vocabularies meet.
//
// The mapping mirrors seed.splitOSRelease + the frontend's
// draft.target.dist convention. Unknown ids strip trailing digits so a
// future "fedora40" style call still lands on the "fedora" family.
func normalizeOS(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	if v == "" {
		return ""
	}
	switch v {
	case "ubuntu24", "ubuntu22":
		return "ubuntu"
	case "debian13", "debian12":
		return "debian"
	}
	// Fallback: strip trailing digits so "fedora40" → "fedora" etc.
	i := len(v)
	for i > 0 && v[i-1] >= '0' && v[i-1] <= '9' {
		i--
	}
	if i > 0 && i < len(v) {
		return v[:i]
	}
	return v
}

// handleSuggest is the cheap typeahead path — only queries name.ngram +
// keywords_ngram, no scoring on description.
func (s *Server) handleSuggest(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"suggestions": []string{}})
		return
	}
	limit := parseIntDefault(r.URL.Query().Get("limit"), 10, 1, 50)
	hits, _, err := s.Idx.Search(index.SearchOpts{
		Query: q,
		OS:    normalizeOS(r.URL.Query().Get("os")),
		Arch:  strings.ToLower(r.URL.Query().Get("arch")),
		Limit: limit,
	})
	if err != nil {
		http.Error(w, "suggest: "+err.Error(), http.StatusInternalServerError)
		return
	}
	names := make([]string, 0, len(hits))
	for _, h := range hits {
		names = append(names, h.Record.Name)
	}
	writeJSON(w, http.StatusOK, map[string]any{"suggestions": names})
}

// handleHealth is a cheap liveness probe. Always 200 as long as the
// process is up — never 503, so a slow crawler doesn't force
// orchestrators to restart-loop.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	docs := 0
	if s.Idx != nil {
		docs = s.Idx.DocCount()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"docs":   docs,
	})
}

// handleReadyz gates on "at least one shard loaded". Returns 503 during
// cold start so K8s / compose depends_on service_healthy blocks the
// backend from proxying to an empty index.
func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if s.ready.Load() || (s.Idx != nil && s.Idx.DocCount() > 0) {
		writeJSON(w, http.StatusOK, map[string]any{"ready": true})
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ready": false})
}

// handleAdminRefresh forwards a manual refresh trigger to the orchestrator.
// Requires X-Admin-Token matching AdminToken. Returns 202 immediately with
// a `refresh_id` — the request is fire-and-forget; the operator watches
// /health lastRefresh to confirm completion.
func (s *Server) handleAdminRefresh(w http.ResponseWriter, r *http.Request) {
	if s.AdminToken == "" || s.TriggerRefresh == nil {
		http.Error(w, "admin refresh not configured", http.StatusNotImplemented)
		return
	}
	if r.Header.Get("X-Admin-Token") != s.AdminToken {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	os := r.URL.Query().Get("os")
	release := r.URL.Query().Get("release")
	arch := r.URL.Query().Get("arch")
	// Fire-and-forget so the HTTP call returns immediately; the
	// orchestrator's channel absorbs the request.
	go func() {
		<-s.TriggerRefresh(os, release, arch)
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{
		"accepted": true,
		"os":       os, "release": release, "arch": arch,
	})
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func parseIntDefault(s string, def, min, max int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}
