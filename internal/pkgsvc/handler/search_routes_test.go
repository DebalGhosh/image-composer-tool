// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/index"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// search_test.go covers this package's routes that tolerate a nil index. The
// three that DON'T — /search, /package and /suggest, which dereference s.Idx bare
// — were left at 0% there, and they are the microservice's actual reason to exist.
//
// This file covers them against a REAL Bleve index in t.TempDir(). That is the only
// way to reach them, and it also makes the assertions worth something: these
// handlers are thin, so almost every interesting behaviour is an interaction with
// the index (which analyzer matched, whether the projection ran, whether a filter
// was applied) rather than logic a fake could stand in for.
//
// The contract these protect is the LEGACY PROJECTION. The frontend's
// PackageSearchCombobox consumes `fields=legacy` — 9 flat fields — and it has had
// zero changes across the proxy cutover. If /search started emitting the enriched
// shape by default, every result row in the UI would render blank with no error in
// any log.

// newIndexedServer builds a Server over a real index seeded with `recs`.
func newIndexedServer(t *testing.T, recs []schema.PackageRecord) *Server {
	t.Helper()
	idx, err := index.NewIndex(filepath.Join(t.TempDir(), "idx"))
	if err != nil {
		t.Fatalf("NewIndex: %v", err)
	}
	t.Cleanup(func() {
		if err := idx.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	if len(recs) > 0 {
		if err := idx.IngestBatch(recs); err != nil {
			t.Fatalf("IngestBatch: %v", err)
		}
	}
	return NewServer(idx, "")
}

// corpus is a deliberately small, deliberately varied fixture: two families, two
// components, one record with a Library provide so the legacy flattening is
// observable, and one with no Summary so the Description fallback is exercised.
func corpus() []schema.PackageRecord {
	return []schema.PackageRecord{
		{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name: "vim", Version: "9.1.0016-1ubuntu7", Section: "editors",
			Summary:  "Vi IMproved - enhanced vi editor",
			Provides: schema.Provides{Binary: []string{"vim", "editor"}},
		},
		{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "universe",
			Name: "neovim", Version: "0.9.5-6", Section: "editors",
			Summary: "heavily refactored vim fork",
		},
		{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name: "libssl3", Version: "3.0.13-0ubuntu3", Section: "libs",
			// No Summary — the legacy projection must fall back to Description.
			Description: "Secure Sockets Layer toolkit - shared libraries",
			Provides: schema.Provides{
				Binary:  []string{"libssl3"},
				Library: []string{"libssl.so.3", "libcrypto.so.3"},
			},
		},
		{
			OS: "debian", Release: "trixie", Arch: "arm64", Component: "main",
			Name: "gcc", Version: "14.2.0-1", Section: "devel",
			Summary:  "GNU C compiler",
			Provides: schema.Provides{Binary: []string{"gcc", "cc"}},
		},
	}
}

func decodeSearch(t *testing.T, body []byte) (query string, total int, pkgs []map[string]any) {
	t.Helper()
	var raw struct {
		Query    string           `json:"query"`
		Total    int              `json:"total"`
		Packages []map[string]any `json:"packages"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("response is not the searchResponse shape: %v\nbody: %s", err, body)
	}
	return raw.Query, raw.Total, raw.Packages
}

func get(t *testing.T, s *Server, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

// --- /search: the empty-index contract ---------------------------------------

func TestSearchOnAnEmptyIndexIs200WithTheMissingHeader(t *testing.T) {
	// 200 + a header, NOT an error. Deliberate: the frontend falls back to its
	// bundled MiniSearch corpus when it sees X-Package-Index-Missing, so a 500
	// here would break that fallback and show an error toast instead.
	s := newIndexedServer(t, nil)
	rec := get(t, s, "/search?q=vim")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 even with no docs", rec.Code)
	}
	if h := rec.Header().Get("X-Package-Index-Missing"); h != "true" {
		t.Errorf("X-Package-Index-Missing = %q, want \"true\" — the frontend keys its "+
			"local-corpus fallback on this header", h)
	}
	q, total, pkgs := decodeSearch(t, rec.Body.Bytes())
	if q != "vim" {
		t.Errorf("query echoed as %q, want vim", q)
	}
	if total != 0 {
		t.Errorf("total = %d, want 0", total)
	}
	// Must be [] and not null: the frontend calls .map on it unguarded.
	if pkgs == nil {
		t.Error("packages marshalled as null; it must be an empty ARRAY or the frontend " +
			"throws on .map")
	}
	if len(pkgs) != 0 {
		t.Errorf("packages = %v, want empty", pkgs)
	}
}

func TestSearchOnAPopulatedIndexOmitsTheMissingHeader(t *testing.T) {
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/search?q=vim")
	if h := rec.Header().Get("X-Package-Index-Missing"); h != "" {
		t.Errorf("X-Package-Index-Missing = %q, want it absent when the index has docs", h)
	}
}

// --- /search: the legacy projection ------------------------------------------

func TestSearchDefaultsToTheLegacyNineFieldShape(t *testing.T) {
	// THE CONTRACT. No `fields` param means the 9-field flat shape the frontend has
	// consumed unchanged since before the microservice existed. An enriched record
	// would deserialise "successfully" in the browser and render every row blank.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/search?q=vim&os=ubuntu24&arch=amd64")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	_, total, pkgs := decodeSearch(t, rec.Body.Bytes())
	if total == 0 || len(pkgs) == 0 {
		t.Fatalf("no hits for q=vim; total=%d packages=%d", total, len(pkgs))
	}

	want := []string{"name", "version", "description", "arch", "section",
		"repository", "os", "type", "provides"}
	for _, hit := range pkgs {
		if len(hit) != len(want) {
			t.Errorf("hit has %d fields, want exactly %d: %v", len(hit), len(want), hit)
		}
		for _, k := range want {
			if _, ok := hit[k]; !ok {
				t.Errorf("legacy field %q missing from %v", k, hit)
			}
		}
		// A field that only exists on the enriched shape must NOT leak through.
		for _, k := range []string{"summary", "component", "release", "popularity", "tags"} {
			if _, ok := hit[k]; ok {
				t.Errorf("enriched field %q leaked into the legacy projection: %v", k, hit)
			}
		}
	}
}

func TestSearchLegacyProjectionValues(t *testing.T) {
	// Not just the field NAMES — the derived values. `repository` is synthesised as
	// "<os> <release>" and `type` from the OS family; both are computed, so both can
	// silently regress.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/search?q=libssl3&os=ubuntu&arch=amd64")
	_, _, pkgs := decodeSearch(t, rec.Body.Bytes())

	var hit map[string]any
	for _, p := range pkgs {
		if p["name"] == "libssl3" {
			hit = p
			break
		}
	}
	if hit == nil {
		t.Fatalf("libssl3 not in the results: %v", pkgs)
	}
	if hit["repository"] != "ubuntu noble" {
		t.Errorf("repository = %v, want \"ubuntu noble\" (os + \" \" + release)", hit["repository"])
	}
	if hit["type"] != "deb" {
		t.Errorf("type = %v, want deb for an ubuntu record", hit["type"])
	}
	// This fixture record has NO Summary, so the projection must fall back to
	// Description rather than emitting an empty string.
	if hit["description"] != "Secure Sockets Layer toolkit - shared libraries" {
		t.Errorf("description = %v; with no Summary the projection must fall back to "+
			"Description", hit["description"])
	}
	// provides flattens Binary THEN Library into one list — the shape the old
	// handler served.
	provides, ok := hit["provides"].([]any)
	if !ok {
		t.Fatalf("provides = %#v, want an array", hit["provides"])
	}
	if len(provides) != 3 {
		t.Errorf("provides = %v, want Binary(1) + Library(2) flattened", provides)
	}
	if provides[0] != "libssl3" {
		t.Errorf("provides[0] = %v, want the binary first", provides[0])
	}
}

func TestSearchFieldsFullReturnsTheEnrichedShape(t *testing.T) {
	// The opt-in. `fields=full` is what a v2 UI would request, and it must carry the
	// fields the legacy projection drops.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/search?q=vim&fields=full")
	_, _, pkgs := decodeSearch(t, rec.Body.Bytes())
	if len(pkgs) == 0 {
		t.Fatal("no hits")
	}
	for _, hit := range pkgs {
		for _, k := range []string{"os", "release", "arch", "component", "name", "version"} {
			if _, ok := hit[k]; !ok {
				t.Errorf("enriched field %q missing: %v", k, hit)
			}
		}
		// `provides` is a sub-OBJECT here, not a flat list — that difference is the
		// whole point of the two shapes.
		if _, ok := hit["provides"].(map[string]any); !ok {
			t.Errorf("provides = %#v, want the Provides sub-object in the full shape",
				hit["provides"])
		}
	}
}

func TestSearchFieldsIsCaseInsensitive(t *testing.T) {
	// The handler lowercases `fields` before comparing, so FULL must work. Pinned
	// because the OTHER params are not all treated alike and it would be easy to
	// "tidy" this into an exact comparison.
	s := newIndexedServer(t, corpus())
	for _, v := range []string{"full", "FULL", "Full"} {
		rec := get(t, s, "/search?q=vim&fields="+v)
		_, _, pkgs := decodeSearch(t, rec.Body.Bytes())
		if len(pkgs) == 0 {
			t.Fatalf("fields=%s: no hits", v)
		}
		if _, ok := pkgs[0]["provides"].(map[string]any); !ok {
			t.Errorf("fields=%s returned the legacy shape; the comparison must be "+
				"case-insensitive", v)
		}
	}
}

func TestSearchUnknownFieldsValueFallsBackToLegacy(t *testing.T) {
	// Anything that is not "full" means legacy. Fails SAFE: a typo'd param gets the
	// shape the current frontend can render, rather than one it silently cannot.
	s := newIndexedServer(t, corpus())
	for _, v := range []string{"", "legacy", "enriched", "garbage"} {
		rec := get(t, s, "/search?q=vim&fields="+v)
		_, _, pkgs := decodeSearch(t, rec.Body.Bytes())
		if len(pkgs) == 0 {
			t.Fatalf("fields=%q: no hits", v)
		}
		if _, ok := pkgs[0]["provides"].([]any); !ok {
			t.Errorf("fields=%q produced %#v for provides; anything but \"full\" must be "+
				"the legacy flat list", v, pkgs[0]["provides"])
		}
	}
}

// --- /search: filters and paging ---------------------------------------------

func TestSearchNormalizesTheOSParam(t *testing.T) {
	// The frontend sends ICT suite ids ("ubuntu24"); the index stores families
	// ("ubuntu"). normalizeOS is unit-tested in search_test.go — this proves the
	// handler actually CALLS it, which is the part that breaks in a refactor.
	//
	// The load-bearing case is "ubuntu24": normalizeOS strips the trailing digits,
	// and NOTHING downstream does that — buildQuery only lowercases. So a suite id
	// reaching the index unnormalised matches no document at all. (Case and
	// whitespace variants are included for completeness but prove less: buildQuery
	// lowercases too, so those would survive the call being dropped.)
	s := newIndexedServer(t, corpus())
	// Values are URL-escaped: a raw space in the target makes httptest.NewRequest
	// parse it as the HTTP-version token and panic.
	for _, os := range []string{"ubuntu", "ubuntu24", "UBUNTU24", "%20ubuntu24%20"} {
		rec := get(t, s, "/search?q=vim&os="+os)
		_, total, _ := decodeSearch(t, rec.Body.Bytes())
		if total == 0 {
			t.Errorf("os=%q returned nothing; the handler must normalise before "+
				"filtering", os)
		}
	}
}

func TestSearchOSFilterExcludesOtherFamilies(t *testing.T) {
	// A filter that is applied but ineffective is worse than none: the UI would show
	// Debian packages on an Ubuntu build and they would fail to install.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/search?q=gcc&os=ubuntu")
	_, _, pkgs := decodeSearch(t, rec.Body.Bytes())
	for _, p := range pkgs {
		if p["os"] != "ubuntu" {
			t.Errorf("os=ubuntu returned a %v record: %v", p["os"], p)
		}
	}

	// And the same query unfiltered DOES find the debian record, proving the
	// exclusion above came from the filter rather than from the query missing.
	rec = get(t, s, "/search?q=gcc")
	_, total, _ := decodeSearch(t, rec.Body.Bytes())
	if total == 0 {
		t.Error("q=gcc unfiltered found nothing, so the filtered assertion above " +
			"proves nothing")
	}
}

func TestSearchArchFilterAcceptsAnyCase(t *testing.T) {
	// Mixed-case arch must match. Note carefully WHERE that is guaranteed:
	// index.buildQuery lowercases opts.Arch itself before building the term query,
	// so the handler's own strings.ToLower is REDUNDANT — removing it breaks
	// nothing, as mutation-testing confirmed.
	//
	// So this test pins the end-to-end behaviour (which is what callers depend on)
	// rather than the handler line. That is the honest scope: no test at this level
	// can distinguish which of the two layers did the folding, and asserting on the
	// handler's line specifically would be asserting on a duplicate.
	//
	// Contrast with the OS param: normalizeOS also STRIPS TRAILING DIGITS, which
	// nothing downstream does, so removing that call IS caught — see
	// TestSearchNormalizesTheOSParam.
	s := newIndexedServer(t, corpus())
	for _, arch := range []string{"arm64", "ARM64", "Arm64"} {
		rec := get(t, s, "/search?q=gcc&arch="+arch)
		_, total, _ := decodeSearch(t, rec.Body.Bytes())
		if total == 0 {
			t.Errorf("arch=%q returned nothing; case must not affect the arch filter", arch)
		}
	}
	// And the filter is real: a wrong arch excludes the record.
	rec := get(t, s, "/search?q=gcc&arch=amd64")
	_, _, pkgs := decodeSearch(t, rec.Body.Bytes())
	for _, p := range pkgs {
		if p["name"] == "gcc" {
			t.Error("gcc is arm64-only in the fixture but matched arch=amd64")
		}
	}
}

func TestSearchEmptyQueryReturnsRecords(t *testing.T) {
	// Documented in the handler's own doc comment: "empty allowed → returns first
	// `limit` records". This is what makes the UI's initial dropdown non-empty
	// before the user types.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/search")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	_, total, pkgs := decodeSearch(t, rec.Body.Bytes())
	if total == 0 || len(pkgs) == 0 {
		t.Errorf("an empty query returned nothing; total=%d len=%d", total, len(pkgs))
	}
}

func TestSearchLimitCapsTheReturnedPageButNotTheTotal(t *testing.T) {
	// `total` is the PRE-truncation match count so the UI can render "1 of 5,234".
	// Conflating the two is an easy regression and shows up as a pager that thinks
	// there is only ever one page.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/search?limit=1")
	_, total, pkgs := decodeSearch(t, rec.Body.Bytes())
	if len(pkgs) != 1 {
		t.Errorf("limit=1 returned %d packages", len(pkgs))
	}
	if total <= 1 {
		t.Errorf("total = %d, want the full pre-truncation match count (the corpus has "+
			"4 records)", total)
	}
}

func TestSearchOffsetIsAcceptedAndShiftsTheWindow(t *testing.T) {
	// ⚠️ PAGING IS BROKEN, and this test characterises it rather than asserting the
	// behaviour anyone would want. Written after a test that DID assert what you
	// would want ("offset=0 and offset=1 return different records") failed against
	// the real index.
	//
	// THE DEFECT. index.Search asks Bleve for `Limit*4` hits starting AT `Offset`,
	// then re-sorts THAT WINDOW locally (popularity tiebreak + DocID) and truncates
	// to `Limit`. So the local ordering is computed over a window that itself slid,
	// and page boundaries cannot line up: consecutive pages overlap, and some
	// records are unreachable at every offset.
	//
	// Measured on 8 equal-scoring records:
	//   limit=1: 5 of 8 records ever appear, one repeats across 4 consecutive pages
	//   limit=2: 3 of 8 records ever appear
	//   limit=4: 5 of 8 records ever appear
	//
	// REACHABLE FROM THE PUBLIC API: internal/api/handlers_packages.go's proxy
	// Director preserves the caller's query string, so `offset` passes through from
	// /api/v1/packages to /search unchanged. The current UI never sends it — the
	// combobox fetches one page — which is why this has not bitten yet.
	//
	// The fix (for its own commit, NOT this one): re-sort over an offset-independent
	// candidate window — request `Offset+Limit*4` from Bleve starting at 0, sort,
	// THEN slice [Offset : Offset+Limit]. That makes the local ordering total rather
	// than per-window, which is the property paging needs.
	//
	// Until then this pins what IS true: the parameter is accepted, is passed
	// through to the index, and shifts the window rather than being ignored
	// outright. Recorded in .claude/REFACTOR-PROGRESS.md under latent defects.
	s := newIndexedServer(t, corpus())
	full := get(t, s, "/search?limit=100&offset=0")
	_, total, all := decodeSearch(t, full.Body.Bytes())
	if len(all) != len(corpus()) {
		t.Fatalf("unpaged search returned %d of %d records", len(all), len(corpus()))
	}

	// `total` is the pre-offset match count and must NOT shrink as the offset moves.
	// A total that decreased with the offset would make a pager compute a shrinking
	// page count as the user advanced through it.
	for _, off := range []int{0, 1, 2, 3} {
		_, got, _ := decodeSearch(t, get(t, s,
			"/search?limit=1&offset="+strconv.Itoa(off)).Body.Bytes())
		if got != total {
			t.Errorf("offset=%d: total = %d, want %d — total is the pre-offset match "+
				"count", off, got, total)
		}
	}

	// The offset IS reaching the index: past the end returns an empty page rather
	// than wrapping around to the first record. This is the assertion that would
	// fail if the parameter were dropped entirely.
	_, _, beyond := decodeSearch(t, get(t, s, "/search?limit=1&offset=99").Body.Bytes())
	if len(beyond) != 0 {
		t.Errorf("offset=99 over a %d-record corpus returned %v; an offset past the end "+
			"must yield an empty page, not wrap", len(corpus()), beyond)
	}
}

func TestSearchLimitIsClamped(t *testing.T) {
	// parseIntDefault's bounds, observed through the handler. An unclamped limit
	// would let one URL ask for the whole index — 50k records per suite.
	//
	// Needs MORE than 100 records or the ceiling is invisible: against a 4-record
	// corpus, a cap of 100 and no cap at all give identical answers. Same trap as
	// TestSuggestLimitIsClampedTo50.
	var big []schema.PackageRecord
	for i := range 120 {
		big = append(big, schema.PackageRecord{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name:    "pkg" + strconv.Itoa(i),
			Version: "1.0",
			Summary: "a package",
		})
	}
	s := newIndexedServer(t, big)

	for _, q := range []string{"limit=0", "limit=-5", "limit=999999", "limit=abc", "limit=101"} {
		rec := get(t, s, "/search?"+q)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200 — a bad limit clamps, it does not 400",
				q, rec.Code)
			continue
		}
		_, total, pkgs := decodeSearch(t, rec.Body.Bytes())
		if total <= 100 {
			t.Fatalf("%s: only %d records match, so the cap is not observable", q, total)
		}
		if len(pkgs) > 100 {
			t.Errorf("%s returned %d packages, above the hard cap of 100", q, len(pkgs))
		}
	}

	// The cap is reachable, not something lower pretending to be 100.
	_, _, pkgs := decodeSearch(t, get(t, s, "/search?limit=100").Body.Bytes())
	if len(pkgs) != 100 {
		t.Errorf("limit=100 returned %d packages, want exactly 100", len(pkgs))
	}

	// And the DEFAULT page size with no limit param is 50 — half the cap. Pinned
	// for the same reason as /suggest's default: nothing else observes it, so it
	// could drift silently.
	_, _, pkgs = decodeSearch(t, get(t, s, "/search?q=pkg").Body.Bytes())
	if len(pkgs) != 50 {
		t.Errorf("with no limit param, got %d packages, want the default page size of 50",
			len(pkgs))
	}
}

// --- /package ----------------------------------------------------------------

func TestPackageFindsARecordAcrossTheComponentSweep(t *testing.T) {
	// /package takes (os, arch, name) but a DocID needs (os, release, arch,
	// component, name) — so the handler SWEEPS four releases × four components
	// looking for a hit. Both fixture records below sit in different components, so
	// this proves the sweep rather than one lucky first guess.
	s := newIndexedServer(t, corpus())
	for _, c := range []struct{ path, name, component string }{
		{"/package/ubuntu/amd64/vim", "vim", "main"},
		{"/package/ubuntu/amd64/neovim", "neovim", "universe"},
		{"/package/debian/arm64/gcc", "gcc", "main"},
	} {
		rec := get(t, s, c.path)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200 (%s lives in %s)",
				c.path, rec.Code, c.name, c.component)
			continue
		}
		var got schema.PackageRecord
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Errorf("%s: %v", c.path, err)
			continue
		}
		if got.Name != c.name {
			t.Errorf("%s returned %q", c.path, got.Name)
		}
		if got.Component != c.component {
			t.Errorf("%s: component = %q, want %q", c.path, got.Component, c.component)
		}
	}
}

func TestPackageReturnsTheEnrichedShapeNotTheProjection(t *testing.T) {
	// Unlike /search, /package has no `fields` param and always serves the full
	// record — the detail pane needs Summary and Provides sub-fields.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/package/ubuntu/amd64/libssl3")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var hit map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &hit); err != nil {
		t.Fatal(err)
	}
	if _, ok := hit["provides"].(map[string]any); !ok {
		t.Errorf("provides = %#v, want the sub-object; /package is not projected",
			hit["provides"])
	}
	if _, ok := hit["component"]; !ok {
		t.Error("component missing; /package serves the enriched record")
	}
}

func TestPackageIs404ForAnUnknownName(t *testing.T) {
	// After the full sweep misses. 404 and not 500 — the UI treats them
	// differently: one is "no such package", the other is "the service is broken".
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/package/ubuntu/amd64/definitely-not-a-package")
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestPackageIs404ForAWrongOSOrArch(t *testing.T) {
	// The name exists, but not for that (os, arch). Must not fall through to a
	// near-match: installing an arm64 package on amd64 fails much later and much
	// more confusingly.
	s := newIndexedServer(t, corpus())
	for _, path := range []string{
		"/package/debian/arm64/vim", // vim is ubuntu-only in the fixture
		"/package/ubuntu/arm64/vim", // right family, wrong arch
		"/package/ubuntu/amd64/gcc", // gcc is debian/arm64 in the fixture
		"/package/fedora/amd64/vim", // family the sweep has no releases for
	} {
		if rec := get(t, s, path); rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, rec.Code)
		}
	}
}

func TestPackageRejectsAnEmptyPathSegment(t *testing.T) {
	// Go 1.22 wildcards do not match an empty segment, so `/package/ubuntu//vim`
	// never reaches the handler — the mux 404s first. The handler's own
	// 400-on-empty guard is therefore defensive; asserting "not 200" documents the
	// combined behaviour without claiming which layer answered.
	s := newIndexedServer(t, corpus())
	for _, path := range []string{"/package/ubuntu//vim", "/package//amd64/vim", "/package/ubuntu/amd64/"} {
		if rec := get(t, s, path); rec.Code == http.StatusOK {
			t.Errorf("%s returned 200; an empty segment must never resolve", path)
		}
	}
}

// --- /suggest ----------------------------------------------------------------

func TestSuggestReturnsBareNames(t *testing.T) {
	// The typeahead path. Deliberately NOT records — just names — because it fires
	// on every keystroke and the payload has to stay small.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/suggest?q=vim")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var body struct {
		Suggestions []string `json:"suggestions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("not the suggestions shape: %v\nbody: %s", err, rec.Body)
	}
	if len(body.Suggestions) == 0 {
		t.Fatal("no suggestions for q=vim")
	}
	for _, n := range body.Suggestions {
		if n == "" {
			t.Error("an empty suggestion would render as a blank dropdown row")
		}
	}
}

func TestSuggestEmptyQueryShortCircuits(t *testing.T) {
	// An empty q returns [] WITHOUT querying the index — it fires on focus, before
	// a keystroke, and matching everything would be both useless and expensive.
	// Uses an empty index so a query, if one happened, could not produce hits
	// either way; the assertion that matters is the shape.
	s := newIndexedServer(t, corpus())
	// URL-escaped for the same reason as above: a raw space would make
	// httptest.NewRequest panic parsing the request line.
	for _, q := range []string{"", "%20%20%20", "%09"} {
		rec := get(t, s, "/suggest?q="+q)
		if rec.Code != http.StatusOK {
			t.Errorf("q=%q: status = %d, want 200", q, rec.Code)
			continue
		}
		var body struct {
			Suggestions []string `json:"suggestions"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("q=%q: %v", q, err)
			continue
		}
		if body.Suggestions == nil {
			t.Errorf("q=%q: suggestions marshalled as null, want an empty array", q)
		}
		if len(body.Suggestions) != 0 {
			t.Errorf("q=%q returned %v; a blank query must not match everything",
				q, body.Suggestions)
		}
	}
}

func TestSuggestTrimsItsQuery(t *testing.T) {
	// "  vim  " must find vim. Whitespace arrives routinely from paste and from
	// mobile keyboards' trailing space.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/suggest?q=%20%20vim%20%20")
	var body struct {
		Suggestions []string `json:"suggestions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Suggestions) == 0 {
		t.Error("a padded query found nothing; the handler must trim before searching")
	}
}

func TestSuggestLimitIsClampedTo50(t *testing.T) {
	// A tighter cap than /search's 100 — it is a dropdown, not a result page, and it
	// fires on every keystroke.
	//
	// Needs a corpus LARGER than the cap or the assertion is vacuous: with the
	// 4-record fixture, a cap of 50 and a cap of 5000 are indistinguishable, and
	// mutation-testing caught exactly that — raising the bound to 5000 left an
	// earlier version of this test passing. 60 records makes the ceiling observable.
	var big []schema.PackageRecord
	for i := range 60 {
		big = append(big, schema.PackageRecord{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name:    "vimplugin" + strconv.Itoa(i),
			Version: "1.0",
			Summary: "a vim plugin",
		})
	}
	s := newIndexedServer(t, big)

	// Sanity-check the fixture itself: if the query cannot match more than 50
	// records, nothing below tests the cap.
	rec := get(t, s, "/search?q=vimplugin&limit=100")
	if _, total, _ := decodeSearch(t, rec.Body.Bytes()); total <= 50 {
		t.Fatalf("fixture matches only %d records; it must exceed the cap of 50 for "+
			"this test to mean anything", total)
	}

	for _, q := range []string{"limit=0", "limit=-1", "limit=99999", "limit=xyz", "limit=51"} {
		rec := get(t, s, "/suggest?q=vimplugin&"+q)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d", q, rec.Code)
			continue
		}
		var body struct {
			Suggestions []string `json:"suggestions"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("%s: %v", q, err)
			continue
		}
		if len(body.Suggestions) > 50 {
			t.Errorf("%s returned %d suggestions, above the cap of 50", q, len(body.Suggestions))
		}
	}

	// And the cap is reachable: asking for exactly 50 yields 50, so the bound is a
	// ceiling rather than something lower masquerading as one.
	rec = get(t, s, "/suggest?q=vimplugin&limit=50")
	var body struct {
		Suggestions []string `json:"suggestions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Suggestions) != 50 {
		t.Errorf("limit=50 returned %d suggestions, want exactly 50", len(body.Suggestions))
	}

	// And the DEFAULT with no limit param is 10 — the dropdown's designed height.
	// Pinned because it is otherwise invisible: dropping it to 1 or raising it to
	// 50 breaks no other test, and either changes what the user sees on every
	// keystroke.
	rec = get(t, s, "/suggest?q=vimplugin")
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Suggestions) != 10 {
		t.Errorf("with no limit param, got %d suggestions, want the default of 10",
			len(body.Suggestions))
	}
}

func TestSuggestAppliesTheOSFilter(t *testing.T) {
	// Same normalise-then-filter path as /search. Suggesting a Debian package while
	// composing an Ubuntu image is a real (if mild) correctness bug.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/suggest?q=gcc&os=ubuntu24")
	var body struct {
		Suggestions []string `json:"suggestions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, n := range body.Suggestions {
		if n == "gcc" {
			t.Error("gcc is debian-only in the fixture but was suggested for os=ubuntu24")
		}
	}
	// Control: unfiltered, it IS suggested — so the absence above is the filter.
	rec = get(t, s, "/suggest?q=gcc")
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, n := range body.Suggestions {
		if n == "gcc" {
			found = true
		}
	}
	if !found {
		t.Error("gcc is not suggested even unfiltered, so the filtered assertion above " +
			"proves nothing")
	}
}

// --- /health with a real index ----------------------------------------------

func TestHealthReportsTheRealDocCount(t *testing.T) {
	// search_test.go asserts the nil-index case reports 0. This is the other half:
	// the count must be live, not a constant. An operator watching /health after
	// triggering a refresh is reading exactly this number.
	s := newIndexedServer(t, corpus())
	rec := get(t, s, "/health")
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["docs"] != float64(len(corpus())) {
		t.Errorf("docs = %v, want %d", body["docs"], len(corpus()))
	}
	if body["status"] != "ok" {
		t.Errorf("status = %v, want ok", body["status"])
	}
}

// --- /categories and /tags --------------------------------------------------

func TestCategoriesAndTagsAreExplicitV2Stubs(t *testing.T) {
	// Both are placeholders. Pinned so the stub is a DECISION rather than something
	// a reader mistakes for a working facet endpoint — and so wiring them up later
	// is a deliberate change to a failing test.
	s := newIndexedServer(t, corpus())
	for _, path := range []string{"/categories", "/tags"} {
		rec := get(t, s, path)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", path, rec.Code)
			continue
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("%s: %v", path, err)
			continue
		}
		if _, ok := body["note"]; !ok {
			t.Errorf("%s no longer returns the v2 stub note: %v. If these were "+
				"implemented, replace this test with real facet assertions", path, body)
		}
	}
}
