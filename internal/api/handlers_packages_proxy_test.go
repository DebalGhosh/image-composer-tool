// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
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
