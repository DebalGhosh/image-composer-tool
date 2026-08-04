// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"

	"sigs.k8s.io/yaml"
)

// TestPkgsvcReverseProxy verifies that handleSearchPackages forwards to
// PkgsvcURL/search when the config is set, rewrites the path, forces
// fields=legacy, and preserves any custom headers the microservice sets.
func TestPkgsvcReverseProxy(t *testing.T) {
	// Fake pkgsvc that records the incoming path + query, echoes them
	// back as the JSON body, and sets an X-Package-Index-Missing header
	// so we can assert header round-trip.
	pkgsvc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search" {
			t.Errorf("proxy path = %q, want /search", r.URL.Path)
		}
		if r.URL.Query().Get("fields") != "legacy" {
			t.Errorf("fields = %q, want legacy", r.URL.Query().Get("fields"))
		}
		if r.URL.Query().Get("q") != "gcc" {
			t.Errorf("q = %q, want gcc", r.URL.Query().Get("q"))
		}
		if r.URL.Query().Get("os") != "ubuntu" {
			t.Errorf("os = %q, want ubuntu", r.URL.Query().Get("os"))
		}
		w.Header().Set("X-Package-Index-Missing", "ubuntu-amd64;reason=demo")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"query":"gcc","total":1,"packages":[{"name":"gcc","version":"13"}]}`))
	}))
	defer pkgsvc.Close()

	pkgsvcURL, _ := url.Parse(pkgsvc.URL)
	s := &Server{cfg: Config{PkgsvcURL: pkgsvcURL.String()}}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/packages?q=gcc&os=ubuntu&arch=amd64", nil)
	rr := httptest.NewRecorder()
	s.handleSearchPackages(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	body, _ := io.ReadAll(rr.Body)
	if !strings.Contains(string(body), `"name":"gcc"`) {
		t.Errorf("body missing gcc: %s", body)
	}
	// Header must round-trip.
	if got := rr.Header().Get("X-Package-Index-Missing"); got != "ubuntu-amd64;reason=demo" {
		t.Errorf("X-Package-Index-Missing = %q, want round-tripped", got)
	}
}

// TestPkgsvcProxy_ErrorFallback: when PKGSVC_URL points at an unreachable
// host, the ErrorHandler should surface an empty response + the missing
// header so the frontend still renders the fallback banner instead of a
// 502 toast.
func TestPkgsvcProxy_ErrorFallback(t *testing.T) {
	s := &Server{cfg: Config{PkgsvcURL: "http://127.0.0.1:1"}} // guaranteed refused
	req := httptest.NewRequest(http.MethodGet, "/api/v1/packages?q=whatever&os=ubuntu&arch=amd64", nil)
	rr := httptest.NewRecorder()
	s.handleSearchPackages(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (fallback path)", rr.Code)
	}
	if got := rr.Header().Get("X-Package-Index-Missing"); !strings.Contains(got, "pkgsvc-unreachable") {
		t.Errorf("expected pkgsvc-unreachable header, got %q", got)
	}
	body, _ := io.ReadAll(rr.Body)
	if !strings.Contains(string(body), `"total":0`) {
		t.Errorf("body missing total:0, got %s", body)
	}
}

// TestPkgsvcDetailsProxy_Path verifies that a caller hitting
// /api/v1/packages/{os}/{arch}/{name} lands on the microservice at
// /package/{os}/{arch}/{name}, with the caller's ambient query string
// stripped so nothing accidental leaks upstream.
func TestPkgsvcDetailsProxy_Path(t *testing.T) {
	pkgsvc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/package/ubuntu/amd64/gcc" {
			t.Errorf("proxy path = %q, want /package/ubuntu/amd64/gcc", r.URL.Path)
		}
		if r.URL.RawQuery != "" {
			t.Errorf("query = %q, want empty (proxy must strip)", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"name":"gcc","version":"13","homepage":"https://gcc.gnu.org/"}`))
	}))
	defer pkgsvc.Close()

	s := &Server{cfg: Config{PkgsvcURL: pkgsvc.URL}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/packages/ubuntu/amd64/gcc?ignored=1", nil)
	// Manually populate path values — httptest.NewRequest does NOT run
	// the mux, so r.PathValue would be empty otherwise.
	req.SetPathValue("os", "ubuntu")
	req.SetPathValue("arch", "amd64")
	req.SetPathValue("name", "gcc")
	rr := httptest.NewRecorder()
	s.handlePackageDetails(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	body, _ := io.ReadAll(rr.Body)
	if !strings.Contains(string(body), `"homepage":"https://gcc.gnu.org/"`) {
		t.Errorf("body missing homepage: %s", body)
	}
}

// TestPkgsvcDetailsProxy_NotConfigured: when PkgsvcURL is empty, the
// details endpoint 404s cleanly rather than trying to serve from the
// embed fallback (which has no equivalent single-record lookup).
func TestPkgsvcDetailsProxy_NotConfigured(t *testing.T) {
	s := &Server{cfg: Config{}} // no PkgsvcURL
	req := httptest.NewRequest(http.MethodGet, "/api/v1/packages/ubuntu/amd64/gcc", nil)
	req.SetPathValue("os", "ubuntu")
	req.SetPathValue("arch", "amd64")
	req.SetPathValue("name", "gcc")
	rr := httptest.NewRecorder()
	s.handlePackageDetails(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 when pkgsvc not configured", rr.Code)
	}
}

// TestPkgsvcDetailsProxy_Unreachable: when PkgsvcURL points at a refused
// port, the ErrorHandler surfaces 502 so the dialog's detail pane can
// render its "detail unavailable" state instead of hanging.
func TestPkgsvcDetailsProxy_Unreachable(t *testing.T) {
	s := &Server{cfg: Config{PkgsvcURL: "http://127.0.0.1:1"}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/packages/ubuntu/amd64/gcc", nil)
	req.SetPathValue("os", "ubuntu")
	req.SetPathValue("arch", "amd64")
	req.SetPathValue("name", "gcc")
	rr := httptest.NewRecorder()
	s.handlePackageDetails(rr, req)
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 when pkgsvc unreachable", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// BE-0 coverage, the pkgsvc seam. The four tests above pin the happy paths;
// everything below closes the gaps that were still at 0%: the Director's
// fields= negotiation, the full query passthrough, the Host rewrite, the
// ErrorHandler's exact fallback SHAPE (not just its status), the two
// deliberately-distinct PkgsvcURL misconfiguration answers, and
// packagesFSStats.
//
// Every test drives the handler through a real httptest server standing in
// for ict-pkgsvc, because the whole point of these two functions is the wire
// shape they produce — a fake RoundTripper would let a Director bug through.
// ---------------------------------------------------------------------------

// recordingPkgsvc returns a stand-in pkgsvc that captures the LAST request it
// saw and answers with `body`. Reads of the captured request happen after
// ServeHTTP has returned, i.e. after the response round-trip, so there is no
// need to lock (matches the pattern in jenkins_http_test.go).
type recordedRequest struct {
	path   string
	query  url.Values
	host   string
	hits   int
	rawURL string
}

func recordingPkgsvc(t *testing.T, body string) (*httptest.Server, *recordedRequest) {
	t.Helper()
	rec := &recordedRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.hits++
		rec.path = r.URL.Path
		rec.query = r.URL.Query()
		rec.host = r.Host
		rec.rawURL = r.URL.String()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, rec
}

// deadPkgsvcURL returns the address of a server that has been shut down, so a
// dial against it is refused immediately. Preferred over a hard-coded port
// number: the port was really bound by this process a moment ago, so nothing
// else is listening and nothing can filter (and therefore hang) the connect.
func deadPkgsvcURL(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	u := srv.URL
	srv.Close()
	return u
}

// --- Director: fields= negotiation ------------------------------------------

// The proxy must FORCE fields=legacy when the caller omits it — the embed-era
// wire shape is what the older PackageSearchCombobox consumes, and pkgsvc's
// own default is the enriched shape, so a dropped default silently changes the
// JSON keys under a frontend that then renders blank rows.
//
// It must equally HONOUR an explicit fields=. That is not hypothetical: the
// dialog's api.searchPackagesFull already sets fields=full (web/src/api/client.ts),
// so clobbering the caller's value would empty the whole detail pane —
// homepage, popcon, provides — with a 200 and no error anywhere to see.
func TestPkgsvcProxy_FieldsNegotiation(t *testing.T) {
	cases := []struct {
		name       string
		callerURL  string
		wantFields string
	}{
		{"absent forces legacy", "/api/v1/packages?os=ubuntu24&arch=amd64&q=tzdata", "legacy"},
		{"explicit full is honoured", "/api/v1/packages?os=ubuntu24&arch=amd64&q=tzdata&fields=full", "full"},
		{"explicit legacy stays legacy", "/api/v1/packages?os=ubuntu24&arch=amd64&fields=legacy", "legacy"},
		// fields= with an empty value is indistinguishable from absent as far
		// as Query().Get is concerned, so it must also get the default rather
		// than reach pkgsvc as an empty string it would have to interpret.
		{"empty value falls back to legacy", "/api/v1/packages?os=ubuntu24&fields=", "legacy"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv, rec := recordingPkgsvc(t, `{"query":"tzdata","total":0,"packages":[]}`)
			s := &Server{cfg: Config{PkgsvcURL: srv.URL}}

			rr := httptest.NewRecorder()
			s.handleSearchPackages(rr, httptest.NewRequest(http.MethodGet, c.callerURL, nil))

			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
			}
			if rec.hits != 1 {
				t.Fatalf("pkgsvc hits = %d, want exactly 1", rec.hits)
			}
			if got := rec.query["fields"]; len(got) != 1 || got[0] != c.wantFields {
				t.Errorf("upstream fields = %v, want [%s]", got, c.wantFields)
			}
			if rec.path != "/search" {
				t.Errorf("upstream path = %q, want /search", rec.path)
			}
		})
	}
}

// --- Director: query passthrough --------------------------------------------

// Paging is the reason this matters. limit/offset are computed by the caller
// and only ever validated upstream; a Director that rebuilt the query from a
// known-keys allowlist (or dropped RawQuery entirely) would silently pin every
// caller to page one — the UI's "load more" would keep re-rendering the same
// 50 rows with no error to explain it. A real paging defect downstream of this
// passthrough is what motivated the assertion, so it compares the WHOLE
// parameter set, not just the keys we happen to remember.
func TestPkgsvcProxy_PreservesEveryQueryParam(t *testing.T) {
	srv, rec := recordingPkgsvc(t, `{"query":"lib","total":0,"packages":[]}`)
	s := &Server{cfg: Config{PkgsvcURL: srv.URL}}

	rr := httptest.NewRecorder()
	s.handleSearchPackages(rr, httptest.NewRequest(http.MethodGet,
		"/api/v1/packages?q=lib&os=debian13&arch=arm64&limit=25&offset=75", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	want := url.Values{
		"q":      {"lib"},
		"os":     {"debian13"},
		"arch":   {"arm64"},
		"limit":  {"25"},
		"offset": {"75"}, // the paging cursor: dropping it resets every page to 0
		"fields": {"legacy"},
	}
	if !reflect.DeepEqual(rec.query, want) {
		t.Errorf("upstream query = %v, want %v", rec.query, want)
	}
}

// A repeated key is a set, not a scalar. Query().Encode() round-trips all
// values, but a rebuild that used Get() per key would keep only the first —
// which is how a multi-select filter quietly narrows to its first choice.
func TestPkgsvcProxy_PreservesRepeatedQueryKeys(t *testing.T) {
	srv, rec := recordingPkgsvc(t, `{"query":"","total":0,"packages":[]}`)
	s := &Server{cfg: Config{PkgsvcURL: srv.URL}}

	rr := httptest.NewRecorder()
	s.handleSearchPackages(rr, httptest.NewRequest(http.MethodGet,
		"/api/v1/packages?os=ubuntu24&section=kernel&section=devel", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	got := rec.query["section"]
	sort.Strings(got)
	if !reflect.DeepEqual(got, []string{"devel", "kernel"}) {
		t.Errorf("upstream section = %v, want both values", got)
	}
}

// --- Director: Host rewrite -------------------------------------------------

// nginx fronts this backend in the compose deployment and sets Host to the
// public name. Forwarding that Host verbatim points pkgsvc's own routing (and
// any future vhost split) at a name it does not serve, which presents as a
// blanket 404 from a service that is demonstrably up.
func TestPkgsvcProxy_ReplacesCallerHostWithTargetHost(t *testing.T) {
	srv, rec := recordingPkgsvc(t, `{"query":"","total":0,"packages":[]}`)
	target, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	s := &Server{cfg: Config{PkgsvcURL: srv.URL}}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/packages?os=ubuntu24", nil)
	req.Host = "ict-frontdoor.invalid" // what an nginx front-end would send
	rr := httptest.NewRecorder()
	s.handleSearchPackages(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if rec.host == "ict-frontdoor.invalid" {
		t.Error("caller Host reached pkgsvc; the Director must replace it with the target host")
	}
	if rec.host != target.Host {
		t.Errorf("upstream Host = %q, want the pkgsvc target host %q", rec.host, target.Host)
	}
}

// Same rule on the single-record route, which has its own Director copy — the
// two are easy to let drift apart.
func TestPkgsvcDetailsProxy_ReplacesCallerHostWithTargetHost(t *testing.T) {
	srv, rec := recordingPkgsvc(t, `{"name":"tzdata"}`)
	target, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	s := &Server{cfg: Config{PkgsvcURL: srv.URL}}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/packages/ubuntu24/amd64/tzdata", nil)
	req.Host = "ict-frontdoor.invalid"
	req.SetPathValue("os", "ubuntu24")
	req.SetPathValue("arch", "amd64")
	req.SetPathValue("name", "tzdata")
	rr := httptest.NewRecorder()
	s.handlePackageDetails(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if rec.host != target.Host {
		t.Errorf("upstream Host = %q, want the pkgsvc target host %q", rec.host, target.Host)
	}
}

// --- ErrorHandler: the fallback contract ------------------------------------

// The single most load-bearing assertion in this file. When pkgsvc is down the
// frontend keys its bundled-corpus fallback on X-Package-Index-Missing and then
// calls .map on `packages` UNGUARDED. So the contract is narrow: 200 (not 5xx,
// or the api client throws and the dialog shows an error toast instead of the
// fallback), the header present, and packages an EMPTY ARRAY — `null` would
// satisfy a len()==0 assertion in Go and still throw
// "Cannot read properties of null" in the browser.
func TestPkgsvcProxy_UnreachableFallbackShape(t *testing.T) {
	s := &Server{cfg: Config{PkgsvcURL: deadPkgsvcURL(t)}}

	rr := httptest.NewRecorder()
	s.handleSearchPackages(rr, httptest.NewRequest(http.MethodGet,
		"/api/v1/packages?os=ubuntu24&arch=amd64&q=tzdata", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: a non-2xx makes the api client throw and "+
			"suppresses the bundled-corpus fallback entirely", rr.Code)
	}
	if got := rr.Header().Get("X-Package-Index-Missing"); got != "pkgsvc-unreachable;reason=proxy-error" {
		t.Errorf("X-Package-Index-Missing = %q, want %q", got, "pkgsvc-unreachable;reason=proxy-error")
	}
	if got := rr.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}

	// Inspect the raw JSON: decoding into []packageResult cannot tell `[]`
	// from `null`, and that difference is exactly what breaks the browser.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatalf("fallback body is not JSON (%v): %s", err, rr.Body.String())
	}
	if got := string(raw["packages"]); got != "[]" {
		t.Errorf("packages = %s, want [] — null throws in the frontend's unguarded .map", got)
	}
	if got := string(raw["total"]); got != "0" {
		t.Errorf("total = %s, want 0", got)
	}
	// The query echo is what the dialog re-displays above the fallback list.
	if got := string(raw["query"]); got != `"tzdata"` {
		t.Errorf("query = %s, want \"tzdata\" echoed back from the caller's q", got)
	}
}

// The details route deliberately does NOT share that soft fallback: a missing
// detail pane is cosmetic, so it answers a real 502 with a machine-readable
// code. Asserting both sides here keeps a future "make everything consistent"
// refactor from collapsing them and turning a dead pkgsvc into a stream of
// empty-but-successful package pages.
func TestPkgsvcDetailsProxy_UnreachableIsAnError(t *testing.T) {
	s := &Server{cfg: Config{PkgsvcURL: deadPkgsvcURL(t)}}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/packages/ubuntu24/amd64/tzdata", nil)
	req.SetPathValue("os", "ubuntu24")
	req.SetPathValue("arch", "amd64")
	req.SetPathValue("name", "tzdata")
	rr := httptest.NewRecorder()
	s.handlePackageDetails(rr, req)

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rr.Code)
	}
	if got := errCode(t, rr); got != "PKGSVC_UNREACHABLE" {
		t.Errorf("error code = %q, want PKGSVC_UNREACHABLE", got)
	}
	if rr.Header().Get("X-Package-Index-Missing") != "" {
		t.Error("the details route must not emit the search fallback header; " +
			"the dialog would treat a detail blip as a missing whole index")
	}
}

// --- misconfiguration: two distinct answers ---------------------------------

// errCode pulls error.code out of a writeError body. A field read, not a
// substring match: the two codes below share a prefix.
func errCode(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	var eb errorBody
	if err := json.Unmarshal(rr.Body.Bytes(), &eb); err != nil {
		t.Fatalf("decode error body (%v): %s", err, rr.Body.String())
	}
	return eb.Error.Code
}

// "no pkgsvc configured" and "pkgsvc configured wrong" are different operator
// problems and are reported differently on purpose: 404/PKGSVC_DISABLED is the
// expected single-binary dev state that the dialog silently degrades around,
// while 500/PKGSVC_URL_INVALID means a typo in PKGSVC_URL that nobody would
// ever find if it were reported as a benign 404.
func TestPkgsvcDetailsProxy_MisconfigurationCodesAreDistinct(t *testing.T) {
	// url.Parse is lenient; an unclosed IPv6 bracket is one of the few
	// shapes it genuinely rejects, which is what makes it a usable stand-in
	// for a fat-fingered PKGSVC_URL.
	const malformed = "http://[::1"
	if _, err := url.Parse(malformed); err == nil {
		t.Fatalf("fixture no longer malformed: url.Parse(%q) succeeded", malformed)
	}

	cases := []struct {
		name       string
		pkgsvcURL  string
		wantStatus int
		wantCode   string
	}{
		{"unset", "", http.StatusNotFound, "PKGSVC_DISABLED"},
		{"malformed", malformed, http.StatusInternalServerError, "PKGSVC_URL_INVALID"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := &Server{cfg: Config{PkgsvcURL: c.pkgsvcURL}}
			req := httptest.NewRequest(http.MethodGet, "/api/v1/packages/ubuntu24/amd64/tzdata", nil)
			req.SetPathValue("os", "ubuntu24")
			req.SetPathValue("arch", "amd64")
			req.SetPathValue("name", "tzdata")
			rr := httptest.NewRecorder()
			s.handlePackageDetails(rr, req)

			if rr.Code != c.wantStatus {
				t.Errorf("status = %d, want %d", rr.Code, c.wantStatus)
			}
			if got := errCode(t, rr); got != c.wantCode {
				t.Errorf("error code = %q, want %q", got, c.wantCode)
			}
		})
	}
}

// The search proxy shares the malformed-URL guard but NOT the disabled one:
// an empty PkgsvcURL there means "serve from the embedded shards", which is a
// success path. Only a broken URL is an error, and it must be a loud 500
// rather than the soft empty-result fallback — otherwise a typo'd PKGSVC_URL
// looks exactly like a healthy backend with an empty index.
func TestPkgsvcProxy_MalformedURLIsAServerError(t *testing.T) {
	s := &Server{cfg: Config{PkgsvcURL: "http://[::1"}}

	rr := httptest.NewRecorder()
	s.handleSearchPackages(rr, httptest.NewRequest(http.MethodGet,
		"/api/v1/packages?os=ubuntu24&arch=amd64", nil))

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rr.Code)
	}
	if got := errCode(t, rr); got != "PKGSVC_URL_INVALID" {
		t.Errorf("error code = %q, want PKGSVC_URL_INVALID", got)
	}
	if rr.Header().Get("X-Package-Index-Missing") != "" {
		t.Error("a malformed PKGSVC_URL must not masquerade as a missing index")
	}
}

// --- Director: the details path is built from path values --------------------

// The rewrite must come from the mux's path values, not from the caller's URL
// path. They differ whenever the route is mounted behind a prefix (nginx
// strips /ict/ in the compose deployment), and a proxy that forwarded
// r.URL.Path verbatim would send /api/v1/packages/... upstream and 404 on
// every detail fetch.
func TestPkgsvcDetailsProxy_PathComesFromPathValues(t *testing.T) {
	srv, rec := recordingPkgsvc(t, `{"name":"tzdata","version":"2026a"}`)
	s := &Server{cfg: Config{PkgsvcURL: srv.URL}}

	// Caller path deliberately unrelated to the path values.
	req := httptest.NewRequest(http.MethodGet, "/ict/api/v1/packages/x/y/z?stale=1", nil)
	req.SetPathValue("os", "ubuntu24")
	req.SetPathValue("arch", "amd64")
	req.SetPathValue("name", "tzdata")
	rr := httptest.NewRecorder()
	s.handlePackageDetails(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if rec.rawURL != "/package/ubuntu24/amd64/tzdata" {
		t.Errorf("upstream URL = %q, want /package/ubuntu24/amd64/tzdata "+
			"(path from PathValue, query stripped)", rec.rawURL)
	}
}

// Real Debian names carry '+' (g++, libstdc++-13-dev). The Director builds the
// upstream path by concatenating into req.URL.Path, which net/http escapes on
// the way out — so '+' must arrive as a literal plus in the path, not decoded
// into a space or re-read as a query separator. If it ever regressed, the C++
// toolchain packages would be the only rows whose detail pane silently 404s,
// which is the kind of bug that reads as "pkgsvc is flaky".
func TestPkgsvcDetailsProxy_NamesWithPlusReachUpstreamIntact(t *testing.T) {
	for _, name := range []string{"g++", "libstdc++-13-dev"} {
		t.Run(name, func(t *testing.T) {
			srv, rec := recordingPkgsvc(t, `{"name":"`+name+`"}`)
			s := &Server{cfg: Config{PkgsvcURL: srv.URL}}

			req := httptest.NewRequest(http.MethodGet, "/api/v1/packages/debian13/amd64/placeholder", nil)
			req.SetPathValue("os", "debian13")
			req.SetPathValue("arch", "amd64")
			req.SetPathValue("name", name)
			rr := httptest.NewRecorder()
			s.handlePackageDetails(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rr.Code)
			}
			// Compare the DECODED path: that is what pkgsvc's mux matches on.
			if want := "/package/debian13/amd64/" + name; rec.path != want {
				t.Errorf("upstream path = %q, want %q", rec.path, want)
			}
			// And nothing must have spilled into the query string.
			if len(rec.query) != 0 {
				t.Errorf("upstream query = %v, want empty", rec.query)
			}
		})
	}
}

// An incomplete (os, arch, name) triple is a 400 answered locally — it must
// never reach pkgsvc, where "/package/ubuntu24//tzdata" would be a confusing
// upstream 404 attributed to the microservice. Each field is checked
// independently, so a && instead of || in the guard leaks two of the three.
func TestPkgsvcDetailsProxy_RejectsIncompletePathValues(t *testing.T) {
	cases := map[string]struct{ os, arch, name string }{
		"missing os":   {"", "amd64", "tzdata"},
		"missing arch": {"ubuntu24", "", "tzdata"},
		"missing name": {"ubuntu24", "amd64", ""},
		"all missing":  {"", "", ""},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			srv, rec := recordingPkgsvc(t, `{"name":"leaked"}`)
			s := &Server{cfg: Config{PkgsvcURL: srv.URL}}

			req := httptest.NewRequest(http.MethodGet, "/api/v1/packages/a/b/c", nil)
			req.SetPathValue("os", c.os)
			req.SetPathValue("arch", c.arch)
			req.SetPathValue("name", c.name)
			rr := httptest.NewRecorder()
			s.handlePackageDetails(rr, req)

			if rr.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", rr.Code)
			}
			if got := errCode(t, rr); got != "BAD_REQUEST" {
				t.Errorf("error code = %q, want BAD_REQUEST", got)
			}
			if rec.hits != 0 {
				t.Errorf("pkgsvc saw %d request(s); an incomplete lookup must not be proxied", rec.hits)
			}
		})
	}
}

// --- upstream responses pass through untouched -------------------------------

// pkgsvc owns "no such package". Translating its 404 into anything else (or
// swallowing the body) would leave the dialog unable to distinguish "unknown
// package" from "pkgsvc is sick", which are different UI states.
func TestPkgsvcDetailsProxy_PassesUpstreamStatusAndBodyThrough(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Pkgsvc-Index-Generation", "42")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"no such package"}}`))
	}))
	defer srv.Close()

	s := &Server{cfg: Config{PkgsvcURL: srv.URL}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/packages/ubuntu24/amd64/nope", nil)
	req.SetPathValue("os", "ubuntu24")
	req.SetPathValue("arch", "amd64")
	req.SetPathValue("name", "nope")
	rr := httptest.NewRecorder()
	s.handlePackageDetails(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want the upstream 404 verbatim", rr.Code)
	}
	if got := errCode(t, rr); got != "NOT_FOUND" {
		t.Errorf("error code = %q, want the upstream NOT_FOUND body passed through", got)
	}
	if got := rr.Header().Get("X-Pkgsvc-Index-Generation"); got != "42" {
		t.Errorf("X-Pkgsvc-Index-Generation = %q, want 42 round-tripped", got)
	}
}

// --- routing: which of the two search backends runs -------------------------

// PkgsvcURL is the switch between the microservice and the embedded-shard
// scan, and the two disagree about required parameters: the embed path 400s
// without `os`, pkgsvc applies its own default. The control half of this test
// proves the embed path really is reachable and really does reject the same
// request — without it, "proxy answered 200" would pass even if the switch
// were inverted and both paths happened to be lenient.
func TestSearchPackagesRoutingHonoursPkgsvcURL(t *testing.T) {
	// Control: no PkgsvcURL -> embed scan, which demands os.
	embedOnly := &Server{cfg: Config{}, packages: loadPackageIndex("")}
	rrEmbed := httptest.NewRecorder()
	embedOnly.handleSearchPackages(rrEmbed, httptest.NewRequest(http.MethodGet, "/api/v1/packages?q=tzdata", nil))
	if rrEmbed.Code != http.StatusBadRequest {
		t.Fatalf("embed path status = %d, want 400 for a missing os "+
			"(control for the proxy assertion below)", rrEmbed.Code)
	}

	// With PkgsvcURL set, the very same request must be forwarded instead —
	// os-less and all, because parameter validation is pkgsvc's job now.
	srv, rec := recordingPkgsvc(t, `{"query":"tzdata","total":0,"packages":[]}`)
	proxied := &Server{cfg: Config{PkgsvcURL: srv.URL}, packages: loadPackageIndex("")}
	rrProxy := httptest.NewRecorder()
	proxied.handleSearchPackages(rrProxy, httptest.NewRequest(http.MethodGet, "/api/v1/packages?q=tzdata", nil))

	if rrProxy.Code != http.StatusOK {
		t.Fatalf("proxy path status = %d, want 200 (body %q)", rrProxy.Code, rrProxy.Body.String())
	}
	if rec.hits != 1 {
		t.Fatalf("pkgsvc hits = %d, want 1: the embed scan ran instead of the proxy", rec.hits)
	}
	if rec.query.Get("q") != "tzdata" {
		t.Errorf("upstream q = %q, want tzdata", rec.query.Get("q"))
	}
}

// A fresh ReverseProxy (and Director closure) is built per request. If someone
// hoists it to a cached field on Server, the captured target/query state
// becomes shared mutable state across concurrent searches; under -race this
// test is what catches it, and in production it would mean one user's filters
// leaking into another's results.
func TestPkgsvcProxy_ConcurrentRequestsAreIndependent(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.URL.Query().Get("q")]++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"query":"","total":0,"packages":[]}`))
	}))
	defer srv.Close()

	s := &Server{cfg: Config{PkgsvcURL: srv.URL}}
	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		q := string(rune('a' + i))
		wg.Add(1)
		go func() {
			defer wg.Done()
			rr := httptest.NewRecorder()
			s.handleSearchPackages(rr, httptest.NewRequest(http.MethodGet,
				"/api/v1/packages?os=ubuntu24&q="+q, nil))
			if rr.Code != http.StatusOK {
				t.Errorf("q=%s status = %d, want 200", q, rr.Code)
			}
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != n {
		t.Errorf("pkgsvc saw %d distinct q values, want %d: %v", len(seen), n, seen)
	}
	for q, c := range seen {
		if c != 1 {
			t.Errorf("q=%s forwarded %d times, want exactly 1", q, c)
		}
	}
}

// --- packagesFSStats --------------------------------------------------------

// packagesFSStats is what startup logging uses to say "the binary shipped with
// N package files". It reads the embedded subtree, so the only way it can go
// wrong is by pointing at the wrong directory — and then it reports a
// plausible-but-meaningless number, which is the sort of thing nobody notices
// until an operator concludes the index is fine when it is empty.
//
// Expectations are derived from the //go:embed patterns rather than hard-coded,
// so adding a shard does not break the test; what IS pinned is that the count
// equals the data/packages listing and nothing else.
func TestPackagesFSStatsCountsTheEmbeddedPackagesDir(t *testing.T) {
	got, err := packagesFSStats()
	if err != nil {
		t.Fatalf("packagesFSStats: %v", err)
	}

	// Independent route to the same truth: the embed directives are
	// data/packages/*.json + data/packages/*.yaml.
	jsons, err := fs.Glob(packagesFS, "data/packages/*.json")
	if err != nil {
		t.Fatalf("glob json: %v", err)
	}
	yamls, err := fs.Glob(packagesFS, "data/packages/*.yaml")
	if err != nil {
		t.Fatalf("glob yaml: %v", err)
	}
	want := len(jsons) + len(yamls)
	if want < 2 {
		t.Fatalf("embed corpus too small to be meaningful (%d files); "+
			"expected at least index.yaml plus one shard", want)
	}
	if got != want {
		t.Errorf("packagesFSStats = %d, want %d (the data/packages listing)", got, want)
	}

	// Pin the directory itself, not just the arithmetic: counting the parent
	// data/ dir, or the repo root, would also produce a small positive number.
	// data/ holds manifest.yaml, which must NOT be in the package tally.
	names, err := fs.Glob(packagesFS, "data/packages/index.yaml")
	if err != nil || len(names) != 1 {
		t.Fatalf("embedded data/packages/index.yaml missing (glob err %v, hits %d)", err, len(names))
	}
	entries, err := fs.ReadDir(packagesFS, "data/packages")
	if err != nil {
		t.Fatalf("read embedded dir: %v", err)
	}
	var listed []string
	for _, e := range entries {
		if e.IsDir() {
			t.Errorf("unexpected sub-directory %q under data/packages: the helper counts "+
				"entries, so a nested dir would be tallied as one file", e.Name())
		}
		listed = append(listed, e.Name())
	}
	sort.Strings(listed)
	if len(listed) != got {
		t.Errorf("ReadDir listed %d entries (%v) but packagesFSStats said %d", len(listed), listed, got)
	}
	if slices.Contains(listed, "manifest.yaml") {
		t.Error("manifest.yaml is embedded under data/, not data/packages; " +
			"seeing it here means the helper walked one directory too high")
	}

	// Every shard the inventory advertises must be one of the counted files,
	// otherwise the number is not a count of loadable shards at all.
	inv := embeddedInventory(t)
	if len(inv.Shards) == 0 {
		t.Fatal("embedded index.yaml advertises no shards; the /packages fallback would be empty")
	}
	for _, sh := range inv.Shards {
		if !slices.Contains(listed, sh.File) {
			t.Errorf("inventory advertises shard %q but it is not in the embedded listing %v", sh.File, listed)
		}
	}
}

// packagesFSStats' error return is only reachable if the embedded directory
// itself is absent, which //go:embed makes a compile-time failure instead:
// there is no runtime input that can produce it. Deliberately untested rather
// than papered over with a fake FS the production code cannot receive.

func embeddedInventory(t *testing.T) packageIndexInventory {
	t.Helper()
	b, err := packagesFS.ReadFile("data/packages/index.yaml")
	if err != nil {
		t.Fatalf("read embedded inventory: %v", err)
	}
	var inv packageIndexInventory
	if err := yaml.Unmarshal(b, &inv); err != nil {
		t.Fatalf("parse embedded inventory: %v", err)
	}
	return inv
}
