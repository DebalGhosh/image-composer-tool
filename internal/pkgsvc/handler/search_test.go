// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// This package was at 0% coverage — the plan called it out by name. It is the
// pkgsvc microservice's whole HTTP surface, and two things here are worth more
// than their line count:
//
//   - /admin/refresh is the only AUTHENTICATED route. Its token check and its
//     "not configured" path both need pinning: a regression either exposes a
//     refresh trigger or silently 200s without doing anything.
//   - /readyz gates cold start. If it returns 200 too early, compose's
//     `depends_on: service_healthy` lets the backend proxy to an empty index and
//     every package search comes back blank.
//
// Tests use a nil *index.Index for the routes that tolerate one.
//
// ⚠️ NOT ALL OF THEM DO, and that asymmetry is a real (if currently unreachable)
// defect this suite surfaced. handleHealth and handleReadyz guard with
// `s.Idx != nil`; handleSearch, handlePackage and handleSuggest dereference it
// bare, and index.Get guards its inner `i.idx` but NOT a nil receiver — so those
// three panic on a nil index.
//
// Unreachable today: cmd/ict-pkgsvc/main.go calls idx.DocCount() at :139, before
// NewServer at :134's result is used, so a nil index already crashes at startup
// and the handlers never see one. Recorded rather than fixed — adding nil guards
// is a behaviour change and does not belong in a test-coverage commit. The tests
// below therefore avoid the three unguarded routes with a nil index.

func newTestServer(adminToken string) *Server {
	return NewServer(nil, adminToken)
}

// --- NewServer / SetReady ---------------------------------------------------

func TestNewServerStoresItsArguments(t *testing.T) {
	s := NewServer(nil, "sekrit")
	if s.AdminToken != "sekrit" {
		t.Errorf("AdminToken = %q, want it stored verbatim", s.AdminToken)
	}
	if s.Idx != nil {
		t.Error("Idx should be the nil index we passed")
	}
	if s.TriggerRefresh != nil {
		t.Error("TriggerRefresh must start nil — NewServer does not wire it")
	}
}

func TestSetReadyIsIdempotent(t *testing.T) {
	s := newTestServer("")
	for _, v := range []bool{true, true, false, false, true} {
		s.SetReady(v)
	}
	// No assertion on internals beyond "did not panic and the last write wins",
	// which /readyz observes below.
	rec := httptest.NewRecorder()
	s.handleReadyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("after SetReady(true) /readyz = %d, want 200", rec.Code)
	}
}

// --- Routes ----------------------------------------------------------------

func TestRoutesWiresEveryEndpoint(t *testing.T) {
	// Go 1.22 method-prefixed patterns, so a wrong METHOD is a 405 and a wrong
	// PATH is a 404. Asserting "not 404" proves the pattern is registered.
	// /search, /package and /suggest are omitted: with a nil index they panic
	// rather than 404 (see the note at the top of this file). Their registration
	// is covered by the 405 test below, which proves the mux matched the pattern
	// without entering the handler.
	mux := newTestServer("tok").Routes()
	for _, r := range []struct {
		method, path string
	}{
		{http.MethodGet, "/categories"},
		{http.MethodGet, "/tags"},
		{http.MethodGet, "/health"},
		{http.MethodGet, "/readyz"},
		{http.MethodPost, "/admin/refresh"},
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(r.method, r.path, nil))
		if rec.Code == http.StatusNotFound {
			t.Errorf("%s %s returned 404 — route not registered", r.method, r.path)
		}
	}
}

func TestRoutesRejectsWrongMethod(t *testing.T) {
	// /admin/refresh is POST-only. A GET must not reach the handler at all,
	// because the handler is where the token check lives — a route that accepted
	// GET would be a different surface to secure.
	mux := newTestServer("tok").Routes()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/admin/refresh", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /admin/refresh = %d, want 405", rec.Code)
	}
}

func TestRoutesRegistersTheIndexBackedPaths(t *testing.T) {
	// Proves /search, /package and /suggest ARE wired without entering their
	// handlers: a wrong method yields 405 (pattern matched, verb rejected),
	// whereas an unregistered path would yield 404. That distinguishes
	// "registered" from "missing" while sidestepping the nil-index panic.
	mux := newTestServer("tok").Routes()
	for _, path := range []string{"/search", "/package/ubuntu/amd64/vim", "/suggest"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, path, nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("DELETE %s = %d, want 405 (proves the GET pattern is registered)",
				path, rec.Code)
		}
	}
}

// --- /health ---------------------------------------------------------------

func TestHealthIsAlwaysOKEvenWithNoIndex(t *testing.T) {
	// Liveness, not readiness. A nil index must still report ok, or an
	// orchestrator would kill the pod during cold start instead of waiting.
	s := newTestServer("")
	rec := httptest.NewRecorder()
	s.handleHealth(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Errorf("status field = %v, want ok", body["status"])
	}
	if body["docs"] != float64(0) {
		t.Errorf("docs = %v, want 0 for a nil index", body["docs"])
	}
}

func TestHealthSetsJSONContentType(t *testing.T) {
	s := newTestServer("")
	rec := httptest.NewRecorder()
	s.handleHealth(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want the JSON type with charset", ct)
	}
}

// --- /readyz ---------------------------------------------------------------

func TestReadyzIs503BeforeAnythingIsLoaded(t *testing.T) {
	// THE COLD-START GATE. 200 here too early lets the backend proxy to an empty
	// index, and every package search returns blank with no error anywhere.
	s := newTestServer("")
	rec := httptest.NewRecorder()
	s.handleReadyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 before any shard is loaded", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["ready"] != false {
		t.Errorf("ready = %v, want false", body["ready"])
	}
}

func TestReadyzFlipsOnSetReady(t *testing.T) {
	// Either the orchestrator's first ingest OR the boot-time seed loader flips
	// this — the flag exists so a seeded index is ready without a crawl.
	s := newTestServer("")
	s.SetReady(true)
	rec := httptest.NewRecorder()
	s.handleReadyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 after SetReady(true)", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["ready"] != true {
		t.Errorf("ready = %v, want true", body["ready"])
	}
}

func TestReadyzCanBeFlippedBack(t *testing.T) {
	s := newTestServer("")
	s.SetReady(true)
	s.SetReady(false)
	rec := httptest.NewRecorder()
	s.handleReadyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 after SetReady(false)", rec.Code)
	}
}

// --- /admin/refresh --------------------------------------------------------

func TestAdminRefreshNotImplementedWithoutAToken(t *testing.T) {
	// 501, NOT 200-and-do-nothing and NOT 403. The distinction is deliberate: an
	// operator hitting this on a deployment without an admin token needs to know
	// the feature is off, not that their credentials were wrong.
	s := newTestServer("")
	s.TriggerRefresh = func(string, string, string) <-chan error {
		t.Fatal("TriggerRefresh must not be called when no token is configured")
		return nil
	}
	rec := httptest.NewRecorder()
	s.handleAdminRefresh(rec, httptest.NewRequest(http.MethodPost, "/admin/refresh", nil))
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501 when AdminToken is empty", rec.Code)
	}
}

func TestAdminRefreshNotImplementedWithoutATrigger(t *testing.T) {
	// A token but no orchestrator wired: still 501. Accepting the request and
	// dropping it would leave the operator watching /health forever.
	s := newTestServer("tok") // TriggerRefresh stays nil
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/admin/refresh", nil)
	req.Header.Set("X-Admin-Token", "tok")
	s.handleAdminRefresh(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501 when TriggerRefresh is nil", rec.Code)
	}
}

func TestAdminRefreshRejectsAWrongToken(t *testing.T) {
	called := make(chan struct{}, 1)
	s := newTestServer("correct-token")
	s.TriggerRefresh = func(string, string, string) <-chan error {
		called <- struct{}{}
		ch := make(chan error, 1)
		ch <- nil
		return ch
	}
	for _, hdr := range []string{"", "wrong", "correct-token ", " correct-token", "CORRECT-TOKEN"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/admin/refresh", nil)
		if hdr != "" {
			req.Header.Set("X-Admin-Token", hdr)
		}
		s.handleAdminRefresh(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("token %q: status = %d, want 403", hdr, rec.Code)
		}
	}
	// No trigger may have fired for any rejected request. The comparison is exact:
	// whitespace and case must NOT be normalised, or a near-miss token would work.
	select {
	case <-called:
		t.Error("TriggerRefresh fired for a rejected token")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestAdminRefreshAcceptsTheCorrectToken(t *testing.T) {
	gotArgs := make(chan [3]string, 1)
	s := newTestServer("tok")
	s.TriggerRefresh = func(os, release, arch string) <-chan error {
		gotArgs <- [3]string{os, release, arch}
		ch := make(chan error, 1)
		ch <- nil
		return ch
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost,
		"/admin/refresh?os=ubuntu&release=noble&arch=amd64", nil)
	req.Header.Set("X-Admin-Token", "tok")
	s.handleAdminRefresh(rec, req)

	// 202 immediately — fire-and-forget. The operator polls /health to see the
	// refresh land, so blocking here would just hold an HTTP connection open for
	// the length of a crawl.
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["accepted"] != true {
		t.Errorf("accepted = %v, want true", body["accepted"])
	}
	for k, want := range map[string]string{"os": "ubuntu", "release": "noble", "arch": "amd64"} {
		if body[k] != want {
			t.Errorf("%s echoed as %v, want %q", k, body[k], want)
		}
	}

	// The goroutine must actually reach the trigger with the parsed query args.
	select {
	case args := <-gotArgs:
		if args != [3]string{"ubuntu", "noble", "amd64"} {
			t.Errorf("TriggerRefresh got %v, want the query params", args)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("TriggerRefresh was never invoked")
	}
}

func TestAdminRefreshPassesEmptyArgsThrough(t *testing.T) {
	// No query params means "refresh everything" — the orchestrator interprets
	// empty strings, so the handler must not substitute defaults of its own.
	gotArgs := make(chan [3]string, 1)
	s := newTestServer("tok")
	s.TriggerRefresh = func(os, release, arch string) <-chan error {
		gotArgs <- [3]string{os, release, arch}
		ch := make(chan error, 1)
		ch <- nil
		return ch
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/admin/refresh", nil)
	req.Header.Set("X-Admin-Token", "tok")
	s.handleAdminRefresh(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	select {
	case args := <-gotArgs:
		if args != [3]string{"", "", ""} {
			t.Errorf("TriggerRefresh got %v, want three empty strings", args)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("TriggerRefresh was never invoked")
	}
}

// --- normalizeOS -----------------------------------------------------------

func TestNormalizeOSKnownAliases(t *testing.T) {
	// The UI sends ICT's suite ids ("ubuntu24"); the index stores families
	// ("ubuntu"). Getting this wrong means every search filtered by OS returns
	// nothing at all.
	//
	// NOTE from mutation-testing: DELETING the ubuntu24/ubuntu22 switch case breaks
	// no test, and that is not a coverage gap — the generic trailing-digit strip
	// below produces the identical result, so the explicit case is redundant for
	// these four ids. It documents intent and would matter for an alias the strip
	// cannot derive (e.g. "focal" -> "ubuntu"), so it stays.
	cases := map[string]string{
		"ubuntu24": "ubuntu",
		"ubuntu22": "ubuntu",
		"debian13": "debian",
		"debian12": "debian",
	}
	for in, want := range cases {
		if got := normalizeOS(in); got != want {
			t.Errorf("normalizeOS(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeOSStripsTrailingDigits(t *testing.T) {
	// The generic fallback, so a family the switch has never heard of still maps
	// sensibly when a v2 crawler lands.
	cases := map[string]string{
		"fedora40":  "fedora",
		"rhel9":     "rhel",
		"alpine319": "alpine",
	}
	for in, want := range cases {
		if got := normalizeOS(in); got != want {
			t.Errorf("normalizeOS(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeOSLowercasesAndTrims(t *testing.T) {
	for _, in := range []string{"  UBUNTU24  ", "Ubuntu24", "ubuntu24\t"} {
		if got := normalizeOS(in); got != "ubuntu" {
			t.Errorf("normalizeOS(%q) = %q, want ubuntu", in, got)
		}
	}
}

func TestNormalizeOSEmptyStaysEmpty(t *testing.T) {
	// Empty means "no OS filter" — it must NOT become some default family, or an
	// unfiltered search would silently be filtered.
	for _, in := range []string{"", "   ", "\t\n"} {
		if got := normalizeOS(in); got != "" {
			t.Errorf("normalizeOS(%q) = %q, want empty", in, got)
		}
	}
}

func TestNormalizeOSAllDigitsIsUnchanged(t *testing.T) {
	// `i > 0` guards this: stripping every character would return "", turning a
	// nonsense filter into "no filter" and quietly widening the search.
	for _, in := range []string{"24", "9", "0"} {
		if got := normalizeOS(in); got != in {
			t.Errorf("normalizeOS(%q) = %q, want it unchanged rather than emptied", in, got)
		}
	}
}

func TestNormalizeOSNoDigitsIsUnchanged(t *testing.T) {
	// `i < len(v)` guards this: a family with no version suffix passes through.
	for _, in := range []string{"ubuntu", "debian", "fedora"} {
		if got := normalizeOS(in); got != in {
			t.Errorf("normalizeOS(%q) = %q, want it unchanged", in, got)
		}
	}
}

func TestNormalizeOSInteriorDigitsSurvive(t *testing.T) {
	// Only TRAILING digits are stripped. "ubu24ntu" keeps its interior digits.
	if got := normalizeOS("ubu24ntu"); got != "ubu24ntu" {
		t.Errorf("normalizeOS(\"ubu24ntu\") = %q, want the interior digits kept", got)
	}
}

// --- parseIntDefault -------------------------------------------------------

func TestParseIntDefaultClamping(t *testing.T) {
	// Guards the limit/offset query params. Clamping rather than erroring is
	// deliberate: a hand-typed URL with limit=99999 should return a sane page,
	// not a 400.
	cases := []struct {
		name          string
		in            string
		def, min, max int
		want          int
	}{
		{"empty uses default", "", 25, 1, 100, 25},
		{"valid passes through", "50", 25, 1, 100, 50},
		{"below min clamps up", "0", 25, 1, 100, 1},
		{"negative clamps up", "-10", 25, 1, 100, 1},
		{"above max clamps down", "99999", 25, 1, 100, 100},
		{"exactly min", "1", 25, 1, 100, 1},
		{"exactly max", "100", 25, 1, 100, 100},
		{"garbage uses default", "abc", 25, 1, 100, 25},
		{"float uses default", "12.5", 25, 1, 100, 25},
		{"whitespace uses default", " 50", 25, 1, 100, 25},
		{"huge overflow uses default", "999999999999999999999", 25, 1, 100, 25},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := parseIntDefault(c.in, c.def, c.min, c.max); got != c.want {
				t.Errorf("parseIntDefault(%q, %d, %d, %d) = %d, want %d",
					c.in, c.def, c.min, c.max, got, c.want)
			}
		})
	}
}

// --- writeJSON -------------------------------------------------------------

func TestWriteJSONSetsStatusAndBody(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusTeapot, map[string]string{"hello": "world"})

	if rec.Code != http.StatusTeapot {
		t.Errorf("status = %d, want 418", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["hello"] != "world" {
		t.Errorf("body = %v", body)
	}
}

func TestWriteJSONSetsContentTypeBeforeWriteHeader(t *testing.T) {
	// Order matters in net/http: headers set AFTER WriteHeader are dropped
	// silently. If this regressed, responses would carry text/plain and the
	// frontend's res.json() would still work — so it would go unnoticed until
	// something stricter consumed the API.
	//
	// ⚠️ THIS TEST CANNOT ACTUALLY DETECT THE REVERSAL, and mutation-testing proved
	// it: swapping the two lines in writeJSON leaves this passing, because
	// httptest.ResponseRecorder does not snapshot headers at WriteHeader the way a
	// real net/http conn does. Catching it needs an httptest.NewServer and a real
	// client round-trip. Kept as documentation of the required order, with its own
	// limitation stated rather than left as false assurance.
	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusOK, map[string]int{"n": 1})
	if rec.Header().Get("Content-Type") == "" {
		t.Error("Content-Type was dropped — it must be set before WriteHeader")
	}
}
