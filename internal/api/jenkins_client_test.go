// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"strings"
	"testing"
)

// BE-0 coverage work. jenkins.go was almost entirely untested — it holds the
// 189-line runJenkinsBuild that the BE decomposition wants to split, and
// splitting untested dispatch code is how you silently send builds to the wrong
// worker. These tests cover the pure, decidable parts first: URL construction
// and the worker picker. The HTTP round-trips are left for a later pass with a
// httptest server.

// --- newJenkinsClient -------------------------------------------------------

func TestNewJenkinsClientRefusesIncompleteConfig(t *testing.T) {
	// Returning nil is the contract: callers must check and then refuse to serve
	// the Jenkins routes at all. A half-configured client that 401s on every
	// dispatch would be worse than an absent one.
	cases := []struct {
		name string
		cfg  Config
	}{
		{"all empty", Config{}},
		{"no url", Config{JenkinsUser: "u", JenkinsToken: "t"}},
		{"no user", Config{JenkinsURL: "https://j", JenkinsToken: "t"}},
		{"no token", Config{JenkinsURL: "https://j", JenkinsUser: "u"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := newJenkinsClient(c.cfg); got != nil {
				t.Fatalf("expected nil client for %s, got %+v", c.name, got)
			}
		})
	}
}

func TestNewJenkinsClientNormalisesConfig(t *testing.T) {
	c := newJenkinsClient(Config{
		JenkinsURL:         "https://cje.example.com/nex-cisv-devops02/",
		JenkinsUser:        "svc-user",
		JenkinsToken:       "tok",
		JenkinsWorkersPath: "/ict-farm/workers/",
	})
	if c == nil {
		t.Fatal("expected a client")
	}
	// Trailing slash trimmed from the base, or every derived URL would carry a
	// double slash after the host.
	if c.base != "https://cje.example.com/nex-cisv-devops02" {
		t.Errorf("base = %q, want the trailing slash trimmed", c.base)
	}
	// Leading AND trailing slashes trimmed from the workers path, because
	// folderURL() re-adds "/job/" around each segment.
	if c.workersPath != "ict-farm/workers" {
		t.Errorf("workersPath = %q, want %q", c.workersPath, "ict-farm/workers")
	}
	if c.http == nil {
		t.Error("http client must be owned by the jenkinsClient (per-request timeout)")
	}
}

func TestNewJenkinsClientDefaultsWorkersPath(t *testing.T) {
	// An empty workers path falls back to the farm's conventional location
	// rather than producing "{base}//" and 404ing at dispatch time.
	c := newJenkinsClient(Config{
		JenkinsURL: "https://j", JenkinsUser: "u", JenkinsToken: "t",
	})
	if c == nil {
		t.Fatal("expected a client")
	}
	if c.workersPath != "ict-farm/workers" {
		t.Errorf("workersPath = %q, want the ict-farm/workers default", c.workersPath)
	}
}

// --- URL construction -------------------------------------------------------

func TestFolderURL(t *testing.T) {
	// Jenkins nests folders as /job/<a>/job/<b>/ — NOT /job/a/b/. Getting this
	// wrong 404s the whole worker listing, so the shape is pinned explicitly.
	j := &jenkinsClient{base: "https://cje.example.com/dev02", workersPath: "ict-farm/workers"}
	want := "https://cje.example.com/dev02/job/ict-farm/job/workers/"
	if got := j.folderURL(); got != want {
		t.Errorf("folderURL() = %q, want %q", got, want)
	}
}

func TestFolderURLSingleSegment(t *testing.T) {
	j := &jenkinsClient{base: "https://j", workersPath: "workers"}
	if got, want := j.folderURL(), "https://j/job/workers/"; got != want {
		t.Errorf("folderURL() = %q, want %q", got, want)
	}
}

func TestFolderURLEscapesSegments(t *testing.T) {
	// Folder names with spaces are legal in Jenkins and do occur.
	j := &jenkinsClient{base: "https://j", workersPath: "ict farm/build workers"}
	got := j.folderURL()
	if strings.Contains(got, " ") {
		t.Errorf("folderURL() = %q, want spaces percent-encoded", got)
	}
	if want := "https://j/job/ict%20farm/job/build%20workers/"; got != want {
		t.Errorf("folderURL() = %q, want %q", got, want)
	}
}

func TestJobURL(t *testing.T) {
	j := &jenkinsClient{base: "https://j", workersPath: "ict-farm/workers"}
	want := "https://j/job/ict-farm/job/workers/job/worker-01/"
	if got := j.jobURL("worker-01"); got != want {
		t.Errorf("jobURL() = %q, want %q", got, want)
	}
}

func TestJobURLEscapesLeafName(t *testing.T) {
	j := &jenkinsClient{base: "https://j", workersPath: "w"}
	got := j.jobURL("worker 01")
	if want := "https://j/job/w/job/worker%2001/"; got != want {
		t.Errorf("jobURL() = %q, want %q", got, want)
	}
}

// --- encodeRelativePath -----------------------------------------------------

func TestEncodeRelativePathPreservesSlashes(t *testing.T) {
	// The whole point: percent-encode each SEGMENT but leave the separators
	// alone, because the result is appended after ".../artifact/" and Jenkins
	// resolves the path structurally. Encoding the slashes too would produce a
	// single opaque filename and 404.
	cases := []struct{ in, want string }{
		{"a/b/c.iso", "a/b/c.iso"},
		{"out/my image.raw", "out/my%20image.raw"},
		{"dir/a+b.txt", "dir/a+b.txt"},
		{"dir/a#b.txt", "dir/a%23b.txt"},
		{"dir/a?b.txt", "dir/a%3Fb.txt"},
		{"", ""},
		{"single.txt", "single.txt"},
		{"nested/deep/very/deep.log", "nested/deep/very/deep.log"},
	}
	for _, c := range cases {
		if got := encodeRelativePath(c.in); got != c.want {
			t.Errorf("encodeRelativePath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestEncodeRelativePathHandlesUnicode(t *testing.T) {
	got := encodeRelativePath("out/образ.iso")
	if strings.ContainsAny(got, "образ") {
		t.Errorf("encodeRelativePath() = %q, want the unicode segment encoded", got)
	}
	if !strings.HasPrefix(got, "out/") {
		t.Errorf("encodeRelativePath() = %q, want the separator preserved", got)
	}
}

// --- pickWorker -------------------------------------------------------------

// Jenkins encodes job state in `color`: "blue" is idle-and-last-succeeded,
// "blue_anime" means a build is running right now. The picker's rule is
// free-first, random fallback — see the doc comment on pickWorker.

func TestPickWorkerErrorsOnEmptyFleet(t *testing.T) {
	// The only error case. An empty fleet means the workers path is wrong or the
	// folder is empty, and dispatching nowhere must fail loudly.
	if _, err := pickWorker(nil); err == nil {
		t.Fatal("expected an error for an empty fleet")
	}
	if _, err := pickWorker([]jenkinsJob{}); err == nil {
		t.Fatal("expected an error for an empty slice")
	}
}

func TestPickWorkerPrefersIdle(t *testing.T) {
	// Two of three are mid-build; the idle one must be chosen every time, not
	// merely usually. Repeated because the fallback path is randomised and a
	// single pass could pass by luck.
	all := []jenkinsJob{
		{Name: "worker-01", Color: "blue_anime"},
		{Name: "worker-02", Color: "blue"},
		{Name: "worker-03", Color: "red_anime"},
	}
	for i := 0; i < 50; i++ {
		got, err := pickWorker(all)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Name != "worker-02" {
			t.Fatalf("iteration %d picked %q, want the only idle worker-02", i, got.Name)
		}
	}
}

func TestPickWorkerTreatsAnyNonAnimeColourAsIdle(t *testing.T) {
	// The test is a `_anime` SUFFIX check, not a whitelist of colours. So a
	// failed-but-idle worker ("red") is eligible — deliberately: last build's
	// outcome says nothing about current availability.
	for _, colour := range []string{"blue", "red", "yellow", "aborted", "notbuilt", "disabled", ""} {
		all := []jenkinsJob{
			{Name: "busy", Color: "blue_anime"},
			{Name: "candidate", Color: colour},
		}
		got, err := pickWorker(all)
		if err != nil {
			t.Fatalf("colour %q: unexpected error: %v", colour, err)
		}
		if got.Name != "candidate" {
			t.Errorf("colour %q: picked %q, want the idle candidate", colour, got.Name)
		}
	}
}

func TestPickWorkerFallsBackToTheWholeFleetWhenAllBusy(t *testing.T) {
	// A saturated farm must still dispatch — Jenkins queues the build. Refusing
	// here would make a busy fleet look like a broken one.
	all := []jenkinsJob{
		{Name: "worker-01", Color: "blue_anime"},
		{Name: "worker-02", Color: "red_anime"},
	}
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		got, err := pickWorker(all)
		if err != nil {
			t.Fatalf("expected a pick from a fully busy fleet, got %v", err)
		}
		seen[got.Name] = true
	}
	// Both must be reachable, or the "random" fallback is not random.
	if len(seen) != 2 {
		t.Errorf("over 200 picks saw %v, want both busy workers reachable", seen)
	}
}

func TestPickWorkerSpreadsAcrossIdleWorkers(t *testing.T) {
	// With several idle, the choice is uniform-ish. Asserting only that every
	// idle worker is reachable — a distribution assertion would be flaky by
	// construction and would test crypto/rand rather than this function.
	all := []jenkinsJob{
		{Name: "w1", Color: "blue"},
		{Name: "w2", Color: "blue"},
		{Name: "w3", Color: "blue"},
		{Name: "busy", Color: "blue_anime"},
	}
	seen := map[string]bool{}
	for i := 0; i < 300; i++ {
		got, err := pickWorker(all)
		if err != nil {
			t.Fatal(err)
		}
		if got.Name == "busy" {
			t.Fatalf("picked the busy worker %q while idle ones existed", got.Name)
		}
		seen[got.Name] = true
	}
	if len(seen) != 3 {
		t.Errorf("over 300 picks saw %v, want all three idle workers reachable", seen)
	}
}

func TestPickWorkerSingleWorker(t *testing.T) {
	// n == 1 short-circuits inside cryptoRandIntn; make sure that path returns
	// the sole worker rather than a zero value.
	got, err := pickWorker([]jenkinsJob{{Name: "only", Color: "blue_anime"}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "only" {
		t.Errorf("picked %q, want the sole worker", got.Name)
	}
}

// --- cryptoRandIntn ---------------------------------------------------------

func TestCryptoRandIntnBounds(t *testing.T) {
	// Must never return n — pickWorker uses it as a slice index, so an
	// off-by-one here is a panic in the dispatch path.
	for _, n := range []int{1, 2, 3, 7, 64} {
		for i := 0; i < 500; i++ {
			got := cryptoRandIntn(n)
			if got < 0 || got >= n {
				t.Fatalf("cryptoRandIntn(%d) = %d, out of [0,%d)", n, got, n)
			}
		}
	}
}

func TestCryptoRandIntnDegenerateInputs(t *testing.T) {
	// Defensive: 0 and negatives return 0 rather than panicking in
	// big.NewInt/rand.Int. Reachable only via an empty pool, which pickWorker
	// already guards, so this pins the guard rather than a live path.
	for _, n := range []int{0, 1, -1, -100} {
		if got := cryptoRandIntn(n); got != 0 {
			t.Errorf("cryptoRandIntn(%d) = %d, want 0", n, got)
		}
	}
}

func TestCryptoRandIntnCoversItsRange(t *testing.T) {
	// Every value in [0,n) should be reachable; a stuck generator would make the
	// worker picker always choose the same machine.
	const n = 5
	seen := map[int]bool{}
	for i := 0; i < 1000; i++ {
		seen[cryptoRandIntn(n)] = true
	}
	if len(seen) != n {
		t.Errorf("over 1000 draws saw %d distinct values of %d", len(seen), n)
	}
}
