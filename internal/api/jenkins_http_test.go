// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// BE-0, the HTTP round-trips. These six methods were all at 0%, and they are the
// dispatch path: pick a worker, trigger a build, wait for a number, poll status,
// stream the log, list artifacts, stop on cancel. runJenkinsBuild — the 189-line
// function BE-1 wants to split — is nothing but a sequence of these calls, so
// splitting it safely requires each one pinned first.
//
// Every test drives a real httptest.Server so the request URL, method, headers
// and auth are all observable. That matters: several of these methods encode
// Jenkins-specific URL shapes (/job/a/job/b/ nesting, the tree= projections) that
// a unit test with a fake transport would not exercise.

// jenkinsTestClient points a jenkinsClient at a test server. Uses the real
// constructor so config normalisation is part of what is under test.
func jenkinsTestClient(t *testing.T, srv *httptest.Server) *jenkinsClient {
	t.Helper()
	c := newJenkinsClient(Config{
		JenkinsURL:         srv.URL,
		JenkinsUser:        "svc-user",
		JenkinsToken:       "svc-token",
		JenkinsWorkersPath: "ict-farm/workers",
	})
	if c == nil {
		t.Fatal("newJenkinsClient returned nil for a complete config")
	}
	return c
}

// --- do: authentication ------------------------------------------------------

func TestDoSetsBasicAuthOnEveryRequest(t *testing.T) {
	// Auth is applied in do(), not per-call-site, so every method inherits it.
	// A regression here 401s the entire dispatch path at once.
	var gotUser, gotPass string
	var gotOK bool
	var gotCharset string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser, gotPass, gotOK = r.BasicAuth()
		gotCharset = r.Header.Get("Accept-Charset")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := jenkinsTestClient(t, srv)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := c.do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	if !gotOK {
		t.Fatal("no Basic auth header was sent")
	}
	if gotUser != "svc-user" || gotPass != "svc-token" {
		t.Errorf("auth = %q/%q, want the configured user and token", gotUser, gotPass)
	}
	if gotCharset != "utf-8" {
		t.Errorf("Accept-Charset = %q, want utf-8", gotCharset)
	}
}

// --- listWorkers -------------------------------------------------------------

func TestListWorkersFiltersToWorkerPrefixAndSkipsDisabled(t *testing.T) {
	// Two filters, both load-bearing. The folder holds jobs that are not workers
	// (seed jobs, matrix parents), and a `disabled` worker must never be picked —
	// triggering it would queue a build that Jenkins never runs.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"jobs":[
			{"name":"worker-01","url":"u1","color":"blue"},
			{"name":"worker-02","url":"u2","color":"blue_anime"},
			{"name":"worker-03","url":"u3","color":"disabled"},
			{"name":"ictWorkerSeed","url":"u4","color":"notbuilt"},
			{"name":"matrix-parent","url":"u5","color":"blue"}
		]}`)
	}))
	defer srv.Close()

	got, err := jenkinsTestClient(t, srv).listWorkers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, j := range got {
		names = append(names, j.Name)
	}
	// worker-03 excluded (disabled), the two non-worker jobs excluded by prefix.
	// worker-02 INCLUDED despite being mid-build — pickWorker decides that, not
	// this function.
	want := []string{"worker-01", "worker-02"}
	if len(names) != len(want) {
		t.Fatalf("workers = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Errorf("workers[%d] = %q, want %q", i, names[i], want[i])
		}
	}
}

func TestListWorkersRequestShape(t *testing.T) {
	// The folder URL must nest /job/ per segment, and the tree= projection keeps
	// the response small on a farm with many jobs.
	var gotPath, gotQuery, gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery, gotAccept = r.URL.Path, r.URL.RawQuery, r.Header.Get("Accept")
		fmt.Fprint(w, `{"jobs":[]}`)
	}))
	defer srv.Close()

	if _, err := jenkinsTestClient(t, srv).listWorkers(context.Background()); err != nil {
		t.Fatal(err)
	}
	if want := "/job/ict-farm/job/workers/api/json"; gotPath != want {
		t.Errorf("path = %q, want %q (Jenkins nests /job/ per folder segment)", gotPath, want)
	}
	if !strings.Contains(gotQuery, "tree=") {
		t.Errorf("query = %q, want a tree= projection", gotQuery)
	}
	if gotAccept != "application/json" {
		t.Errorf("Accept = %q, want application/json", gotAccept)
	}
}

func TestListWorkersErrorsOnNon200(t *testing.T) {
	// The body is included in the error (capped at 4 KiB) because a Jenkins 403
	// carries the reason — a stale token, a missing folder permission — and
	// without it the operator gets "HTTP 403" and nothing to act on.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, "missing Job/Read permission")
	}))
	defer srv.Close()

	_, err := jenkinsTestClient(t, srv).listWorkers(context.Background())
	if err == nil {
		t.Fatal("expected an error for HTTP 403")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Errorf("error = %q, want the status code", err)
	}
	if !strings.Contains(err.Error(), "missing Job/Read permission") {
		t.Errorf("error = %q, want the response body included for diagnosis", err)
	}
}

func TestListWorkersErrorsOnMalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"jobs":[{"name":`)
	}))
	defer srv.Close()

	if _, err := jenkinsTestClient(t, srv).listWorkers(context.Background()); err == nil {
		t.Fatal("expected a decode error")
	}
}

func TestListWorkersEmptyFleetIsNotAnError(t *testing.T) {
	// An empty folder is a configuration problem, but listWorkers reports it as
	// an empty slice — pickWorker turns it into the error. Keeping the layers
	// separate means the error message names the real cause.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"jobs":[]}`)
	}))
	defer srv.Close()

	got, err := jenkinsTestClient(t, srv).listWorkers(context.Background())
	if err != nil {
		t.Fatalf("an empty fleet must not error here: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d workers, want 0", len(got))
	}
}

// --- trigger -----------------------------------------------------------------

func TestTriggerPostsOnlyTemplateYAML(t *testing.T) {
	// ⚠️ EXACTLY ONE PARAMETER, deliberately. Every other build parameter is
	// omitted so the worker's own declared defaults apply (ictWorkerSeed /
	// matrix.defaults in the CaC repo). Sending more would override them
	// silently and produce builds that differ from a manual Jenkins run.
	var gotMethod, gotPath, gotCT string
	var gotForm url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotCT = r.Method, r.URL.Path, r.Header.Get("Content-Type")
		_ = r.ParseForm()
		gotForm = r.PostForm
		w.Header().Set("Location", "http://jenkins/queue/item/42/")
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	yaml := "imageName: test\npackages:\n  - vim"
	queueURL, err := jenkinsTestClient(t, srv).trigger(context.Background(), "worker-07", yaml)
	if err != nil {
		t.Fatal(err)
	}
	if queueURL != "http://jenkins/queue/item/42/" {
		t.Errorf("queueURL = %q, want the Location header verbatim", queueURL)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %s, want POST", gotMethod)
	}
	if want := "/job/ict-farm/job/workers/job/worker-07/buildWithParameters"; gotPath != want {
		t.Errorf("path = %q, want %q", gotPath, want)
	}
	if !strings.HasPrefix(gotCT, "application/x-www-form-urlencoded") {
		t.Errorf("Content-Type = %q, want form-urlencoded", gotCT)
	}
	if len(gotForm) != 1 {
		t.Errorf("form had %d params (%v), want exactly TEMPLATE_YAML", len(gotForm), gotForm)
	}
	if gotForm.Get("TEMPLATE_YAML") != yaml {
		t.Errorf("TEMPLATE_YAML = %q, want the YAML byte-for-byte", gotForm.Get("TEMPLATE_YAML"))
	}
}

func TestTriggerAccepts201(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://jenkins/queue/item/7/")
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	got, err := jenkinsTestClient(t, srv).trigger(context.Background(), "worker-01", "yaml")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://jenkins/queue/item/7/" {
		t.Errorf("queueURL = %q, want the Location header verbatim", got)
	}
}

func TestTriggerNeverObservesA302(t *testing.T) {
	// ⚠️ THE `http.StatusFound` BRANCH IN trigger() IS UNREACHABLE, and this test
	// documents why rather than pretending to exercise it.
	//
	// The source comments say "Very old (<1.519) returned 302; accept either."
	// But jenkinsClient uses http.Client's DEFAULT redirect policy, which FOLLOWS
	// a 302 transparently — so trigger() is handed the response from the redirect
	// TARGET and never sees 302 at all. Proven here: the server records two
	// requests, and the error names the target's status.
	//
	// Not a live bug: every supported Jenkins returns 201, so the reachable path
	// is the one that works. Recorded because the dead branch reads as coverage
	// that does not exist, and because a future CheckRedirect that stops following
	// would make it live — at which point this test should be inverted.
	var hits int32
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&hits, 1) == 1 {
			// Redirect within this server so no external DNS or proxy is involved.
			w.Header().Set("Location", srv.URL+"/landed")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	_, err := jenkinsTestClient(t, srv).trigger(context.Background(), "worker-01", "yaml")
	if n := atomic.LoadInt32(&hits); n != 2 {
		t.Fatalf("server saw %d requests, want 2 — the client must have followed the 302", n)
	}
	if err == nil {
		t.Fatal("expected an error: the followed response was a 200 with no Location")
	}
	if !strings.Contains(err.Error(), "200") {
		t.Errorf("error = %q, want it to name the FOLLOWED status (200), proving the "+
			"302 branch was never entered", err)
	}
}

func TestTriggerErrorsWithoutALocationHeader(t *testing.T) {
	// A 201 with no Location means we cannot find the queue item, so the build is
	// unobservable even though Jenkins accepted it. Better a loud error than a
	// build the UI can never attach to.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	_, err := jenkinsTestClient(t, srv).trigger(context.Background(), "worker-01", "yaml")
	if err == nil {
		t.Fatal("expected an error when Location is absent")
	}
	if !strings.Contains(err.Error(), "Location") {
		t.Errorf("error = %q, want it to name the missing header", err)
	}
}

func TestTriggerErrorsOnOtherStatuses(t *testing.T) {
	for _, code := range []int{http.StatusOK, http.StatusBadRequest, http.StatusForbidden, http.StatusInternalServerError} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
			fmt.Fprint(w, "nope")
		}))
		_, err := jenkinsTestClient(t, srv).trigger(context.Background(), "worker-01", "yaml")
		srv.Close()
		if err == nil {
			t.Errorf("HTTP %d: expected an error", code)
			continue
		}
		if !strings.Contains(err.Error(), "worker-01") {
			t.Errorf("HTTP %d: error = %q, want the worker name for diagnosis", code, err)
		}
	}
}

// --- waitForBuild ------------------------------------------------------------

func TestWaitForBuildReturnsOnFirstPollWhenAssigned(t *testing.T) {
	// The happy fast path: Jenkins already assigned an executable, so this
	// returns without ever hitting the 1s ticker.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"id":42,"cancelled":false,"executable":{"number":18,"url":"http://jenkins/job/worker-07/18"}}`)
	}))
	defer srv.Close()

	buildURL, num, err := jenkinsTestClient(t, srv).waitForBuild(
		context.Background(), srv.URL+"/queue/item/42", nil)
	if err != nil {
		t.Fatal(err)
	}
	// A trailing slash is appended so downstream URL concatenation
	// (buildURL + "api/json") produces a valid path.
	if buildURL != "http://jenkins/job/worker-07/18/" {
		t.Errorf("buildURL = %q, want a trailing slash appended", buildURL)
	}
	if num != 18 {
		t.Errorf("buildNumber = %d, want 18", num)
	}
}

func TestWaitForBuildDetectsCancellation(t *testing.T) {
	// A queue item cancelled before execution must be an error, not an infinite
	// wait — the UI would otherwise sit on "dispatching" forever.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"id":42,"cancelled":true}`)
	}))
	defer srv.Close()

	_, _, err := jenkinsTestClient(t, srv).waitForBuild(
		context.Background(), srv.URL+"/queue/item/42", nil)
	if err == nil {
		t.Fatal("expected an error for a cancelled queue item")
	}
	if !strings.Contains(err.Error(), "cancelled") {
		t.Errorf("error = %q, want it to say cancelled", err)
	}
}

func TestWaitForBuildSurfacesNon200(t *testing.T) {
	// A 404 after the 5-minute queue-item retention window, or a 502 from the
	// reverse proxy. The comment in the source is explicit that looping on a
	// garbage-decoded empty struct is the bug this prevents.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, "queue item expired")
	}))
	defer srv.Close()

	_, _, err := jenkinsTestClient(t, srv).waitForBuild(
		context.Background(), srv.URL+"/queue/item/42", nil)
	if err == nil {
		t.Fatal("expected an error rather than a poll loop")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("error = %q, want the status code", err)
	}
}

func TestWaitForBuildReportsWhyOncePerDistinctReason(t *testing.T) {
	// `onWait` drives the UI's "waiting for an executor" line. It must fire on a
	// CHANGE of reason, not on every 1s poll, or the log fills with duplicates.
	var polls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&polls, 1)
		switch {
		case n <= 2:
			fmt.Fprint(w, `{"id":42,"why":"Waiting for next available executor"}`)
		case n == 3:
			fmt.Fprint(w, `{"id":42,"why":"worker-07 is offline"}`)
		default:
			fmt.Fprint(w, `{"id":42,"executable":{"number":9,"url":"http://j/9"}}`)
		}
	}))
	defer srv.Close()

	var reasons []string
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_, num, err := jenkinsTestClient(t, srv).waitForBuild(ctx, srv.URL+"/queue/item/42",
		func(reason string) { reasons = append(reasons, reason) })
	if err != nil {
		t.Fatal(err)
	}
	if num != 9 {
		t.Errorf("buildNumber = %d, want 9", num)
	}
	// Two DISTINCT reasons across three why-carrying polls: the repeat is skipped.
	want := []string{"Waiting for next available executor", "worker-07 is offline"}
	if len(reasons) != len(want) {
		t.Fatalf("onWait fired %d times with %v, want %d distinct reasons",
			len(reasons), reasons, len(want))
	}
	for i := range want {
		if reasons[i] != want[i] {
			t.Errorf("reasons[%d] = %q, want %q", i, reasons[i], want[i])
		}
	}
}

func TestWaitForBuildHonoursContextCancellation(t *testing.T) {
	// A queued build on a saturated fleet waits arbitrarily long, so the caller's
	// context is the only bound. Cancelling must unblock promptly.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"id":42,"why":"Waiting"}`)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, err := jenkinsTestClient(t, srv).waitForBuild(ctx, srv.URL+"/queue/item/42", nil)
	if err == nil {
		t.Fatal("expected a context error")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("took %v to notice cancellation; the ticker must not swallow it", elapsed)
	}
}

func TestWaitForBuildIgnoresAZeroExecutableNumber(t *testing.T) {
	// Jenkins briefly reports an executable with number 0 during assignment. The
	// `!= 0` test is what stops the caller being handed build #0, which 404s.
	var polls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&polls, 1) == 1 {
			fmt.Fprint(w, `{"id":42,"executable":{"number":0,"url":""}}`)
			return
		}
		fmt.Fprint(w, `{"id":42,"executable":{"number":5,"url":"http://j/5"}}`)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_, num, err := jenkinsTestClient(t, srv).waitForBuild(ctx, srv.URL+"/queue/item/42", nil)
	if err != nil {
		t.Fatal(err)
	}
	if num != 5 {
		t.Errorf("buildNumber = %d, want 5 — number 0 must be ignored", num)
	}
}

// --- getRun ------------------------------------------------------------------

func TestGetRunDecodesBuildingAndResult(t *testing.T) {
	cases := []struct {
		body     string
		building bool
		result   string
	}{
		{`{"building":true,"result":null}`, true, ""},
		{`{"building":false,"result":"SUCCESS"}`, false, "SUCCESS"},
		{`{"building":false,"result":"FAILURE"}`, false, "FAILURE"},
		{`{"building":false,"result":"ABORTED"}`, false, "ABORTED"},
		{`{"building":false,"result":"UNSTABLE"}`, false, "UNSTABLE"},
		{`{"building":false,"result":"NOT_BUILT"}`, false, "NOT_BUILT"},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, c.body)
		}))
		got, err := jenkinsTestClient(t, srv).getRun(context.Background(), srv.URL+"/job/w/1/")
		srv.Close()
		if err != nil {
			t.Errorf("%s: %v", c.body, err)
			continue
		}
		if got.Building != c.building || got.Result != c.result {
			t.Errorf("%s -> %+v, want building=%v result=%q", c.body, got, c.building, c.result)
		}
	}
}

func TestGetRunErrorsOnNon200(t *testing.T) {
	// ⚠️ THE BODY MUST BE VALID JSON, and that is the whole point of this test.
	//
	// An empty-bodied 500 is NOT discriminating: without the status check,
	// json.Decode hits io.EOF and errors anyway, so the test would pass either way.
	// Mutation-testing caught exactly that — deleting the status guard broke
	// nothing until this case served a decodable body on a non-200.
	//
	// It also matters in production: a reverse proxy or a Jenkins error page can
	// return 502 with a JSON payload, and decoding it would yield building=false,
	// result="" — indistinguishable from a build that finished with no result, so
	// the poller would treat an outage as a terminal state.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprint(w, `{"building":false,"result":"SUCCESS"}`)
	}))
	defer srv.Close()

	_, err := jenkinsTestClient(t, srv).getRun(context.Background(), srv.URL+"/job/w/1/")
	if err == nil {
		t.Fatal("expected an error for HTTP 502 even though the body decodes cleanly")
	}
	if !strings.Contains(err.Error(), "502") {
		t.Errorf("error = %q, want the status code — not a decode error", err)
	}
}

func TestGetRunErrorsOnMalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"building":`)
	}))
	defer srv.Close()

	_, err := jenkinsTestClient(t, srv).getRun(context.Background(), srv.URL+"/job/w/1/")
	if err == nil {
		t.Fatal("expected a decode error")
	}
	if !strings.Contains(err.Error(), "decode run") {
		t.Errorf("error = %q, want it distinguishable from a status error", err)
	}
}

// --- stopBuild ---------------------------------------------------------------

func TestStopBuildRejectsAnEmptyURL(t *testing.T) {
	// Reachable: the /cancel handler can fire before Jenkins has assigned a
	// build, so buildURL is still "". Posting to "/stop" would hit the Jenkins
	// root, so this must refuse locally.
	err := (&jenkinsClient{}).stopBuild(context.Background(), "")
	if err == nil {
		t.Fatal("expected an error for an empty buildURL")
	}
	if !strings.Contains(err.Error(), "empty buildURL") {
		t.Errorf("error = %q, want it to name the cause", err)
	}
}

func TestStopBuildPostsToTheStopEndpoint(t *testing.T) {
	// /stop, NOT /term or /kill — the least forceful of Jenkins' three abort
	// endpoints and the right one behind a UI button.
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()

	if err := jenkinsTestClient(t, srv).stopBuild(context.Background(), srv.URL+"/job/w/18/"); err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %s, want POST", gotMethod)
	}
	if !strings.HasSuffix(gotPath, "/stop") {
		t.Errorf("path = %q, want it to end in /stop", gotPath)
	}
	if strings.Contains(gotPath, "/term") || strings.Contains(gotPath, "/kill") {
		t.Errorf("path = %q, must not use the forceful endpoints", gotPath)
	}
}

func TestStopBuildAcceptsTheSuccessCodes(t *testing.T) {
	// Jenkins redirects to the build page on success; the abort itself is async.
	for _, code := range []int{http.StatusOK, http.StatusFound, http.StatusNoContent} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
		}))
		err := jenkinsTestClient(t, srv).stopBuild(context.Background(), srv.URL+"/job/w/1/")
		srv.Close()
		if err != nil {
			t.Errorf("HTTP %d: unexpected error %v", code, err)
		}
	}
}

func TestStopBuildErrorsOnOtherStatuses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, "missing Build/Cancel permission")
	}))
	defer srv.Close()

	err := jenkinsTestClient(t, srv).stopBuild(context.Background(), srv.URL+"/job/w/1/")
	if err == nil {
		t.Fatal("expected an error for HTTP 403")
	}
	if !strings.Contains(err.Error(), "missing Build/Cancel permission") {
		t.Errorf("error = %q, want the body included for diagnosis", err)
	}
}

// --- listArtifacts -----------------------------------------------------------

func TestListArtifactsDecodesTheList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"artifacts":[
			{"fileName":"UPLOAD-MANIFEST.txt","relativePath":"upload/UPLOAD-MANIFEST.txt"},
			{"fileName":"image-composer-tool.log","relativePath":"logs/image-composer-tool.log"}
		]}`)
	}))
	defer srv.Close()

	got, err := jenkinsTestClient(t, srv).listArtifacts(context.Background(), srv.URL+"/job/w/18/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d artifacts, want 2", len(got))
	}
	if got[0].FileName != "UPLOAD-MANIFEST.txt" {
		t.Errorf("FileName = %q", got[0].FileName)
	}
	if got[0].RelativePath != "upload/UPLOAD-MANIFEST.txt" {
		t.Errorf("RelativePath = %q — the nested path must survive", got[0].RelativePath)
	}
}

func TestListArtifactsEmptyIsNotAnError(t *testing.T) {
	// The normal case for an ICT build: the pipeline archives only the manifest
	// and the log, and on a failure before PUBLISH it archives nothing. An empty
	// list must not read as a failure.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"artifacts":[]}`)
	}))
	defer srv.Close()

	got, err := jenkinsTestClient(t, srv).listArtifacts(context.Background(), srv.URL+"/job/w/1/")
	if err != nil {
		t.Fatalf("an empty artifact list must not error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d artifacts, want 0", len(got))
	}
}

func TestListArtifactsErrorsOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	if _, err := jenkinsTestClient(t, srv).listArtifacts(context.Background(), srv.URL+"/j/1/"); err == nil {
		t.Fatal("expected an error for HTTP 404")
	}
}

// --- fetchProgressiveText ----------------------------------------------------

func TestFetchProgressiveTextReadsChunkAndHeaders(t *testing.T) {
	var gotStart string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotStart = r.URL.Query().Get("start")
		w.Header().Set("X-Text-Size", "512")
		w.Header().Set("X-More-Data", "true")
		fmt.Fprint(w, "log line one\nlog line two\n")
	}))
	defer srv.Close()

	chunk, next, more, err := jenkinsTestClient(t, srv).
		fetchProgressiveText(context.Background(), srv.URL+"/job/w/18/", 100)
	if err != nil {
		t.Fatal(err)
	}
	if gotStart != "100" {
		t.Errorf("start param = %q, want the caller's offset", gotStart)
	}
	if !strings.Contains(string(chunk), "log line one") {
		t.Errorf("chunk = %q", chunk)
	}
	// X-Text-Size is Jenkins' CUMULATIVE offset, so it replaces the offset
	// rather than adding to it.
	if next != 512 {
		t.Errorf("nextOffset = %d, want 512 from X-Text-Size", next)
	}
	if !more {
		t.Error("more = false, want true while X-More-Data is \"true\"")
	}
}

func TestFetchProgressiveTextFallsBackWhenHeaderIsMissing(t *testing.T) {
	// ⚠️ THE BUG THIS PREVENTS, verbatim from the source comment: a reverse proxy
	// that strips X-* headers would leave the offset unchanged, so the next tick
	// re-fetches the same range and DUPLICATES EVERY LOG LINE FOREVER. The
	// fallback advances by the chunk length instead.
	body := "abcdefghij" // 10 bytes
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, body)
	}))
	defer srv.Close()

	_, next, more, err := jenkinsTestClient(t, srv).
		fetchProgressiveText(context.Background(), srv.URL+"/j/1/", 40)
	if err != nil {
		t.Fatal(err)
	}
	if next != 50 {
		t.Errorf("nextOffset = %d, want 40+10=50 from the chunk length", next)
	}
	// X-More-Data absent means the writer closed.
	if more {
		t.Error("more = true, want false when X-More-Data is absent")
	}
}

func TestFetchProgressiveTextIgnoresAnUnparseableHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Text-Size", "not-a-number")
		fmt.Fprint(w, "12345")
	}))
	defer srv.Close()

	_, next, _, err := jenkinsTestClient(t, srv).
		fetchProgressiveText(context.Background(), srv.URL+"/j/1/", 7)
	if err != nil {
		t.Fatal(err)
	}
	if next != 12 {
		t.Errorf("nextOffset = %d, want 7+5=12 — an unparseable header falls back", next)
	}
}

func TestFetchProgressiveTextIgnoresABackwardsHeader(t *testing.T) {
	// `v >= offset` guards this. A header claiming a SMALLER cumulative size than
	// we already read would rewind the stream and re-deliver old lines.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Text-Size", "5")
		fmt.Fprint(w, "abc")
	}))
	defer srv.Close()

	_, next, _, err := jenkinsTestClient(t, srv).
		fetchProgressiveText(context.Background(), srv.URL+"/j/1/", 100)
	if err != nil {
		t.Fatal(err)
	}
	if next != 103 {
		t.Errorf("nextOffset = %d, want 100+3=103 — a backwards header must be ignored", next)
	}
}

func TestFetchProgressiveTextMoreDataIsExactlyTrue(t *testing.T) {
	// Only the literal string "true" counts. Anything else means the writer
	// closed, so the poller stops.
	for _, hdr := range []string{"false", "TRUE", "True", "1", "yes", ""} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if hdr != "" {
				w.Header().Set("X-More-Data", hdr)
			}
			fmt.Fprint(w, "x")
		}))
		_, _, more, err := jenkinsTestClient(t, srv).
			fetchProgressiveText(context.Background(), srv.URL+"/j/1/", 0)
		srv.Close()
		if err != nil {
			t.Errorf("header %q: %v", hdr, err)
			continue
		}
		if more {
			t.Errorf("X-More-Data=%q gave more=true; only the exact string \"true\" counts", hdr)
		}
	}
}

func TestFetchProgressiveTextErrorsOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	_, next, more, err := jenkinsTestClient(t, srv).
		fetchProgressiveText(context.Background(), srv.URL+"/j/1/", 99)
	if err == nil {
		t.Fatal("expected an error for HTTP 502")
	}
	// The offset must be returned UNCHANGED on error so a retry re-reads the same
	// range rather than skipping a chunk of log.
	if next != 99 {
		t.Errorf("nextOffset = %d on error, want the input offset 99 preserved", next)
	}
	if more {
		t.Error("more must be false on error")
	}
}

func TestFetchProgressiveTextEmptyChunkAtEOF(t *testing.T) {
	// Steady state once the build finishes: 200, no body, no X-More-Data.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Text-Size", "4096")
	}))
	defer srv.Close()

	chunk, next, more, err := jenkinsTestClient(t, srv).
		fetchProgressiveText(context.Background(), srv.URL+"/j/1/", 4096)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunk) != 0 {
		t.Errorf("chunk = %q, want empty", chunk)
	}
	if next != 4096 {
		t.Errorf("nextOffset = %d, want it to hold at 4096", next)
	}
	if more {
		t.Error("more = true at EOF")
	}
}
