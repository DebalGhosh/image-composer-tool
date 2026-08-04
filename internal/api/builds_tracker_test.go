// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"sync"
	"testing"
	"time"
)

// BE-0 coverage work, part two. findByJenkins and markCancelled were both at 0%.
// They are the two pieces of build-registry logic the BE decomposition will move,
// and both have a failure mode that is invisible in normal operation:
// findByJenkins backs a shareable deep-link, and markCancelled is the only thing
// that stops a runner goroutine polling Jenkins for up to its 6h context ceiling.

// --- findByJenkins ----------------------------------------------------------

func TestFindByJenkinsMatchesWorkerAndNumber(t *testing.T) {
	tr := newBuildTracker()
	tr.add(&build{ID: "b1", Jenkins: &jenkinsMeta{Worker: "worker-01", BuildNumber: 17}})
	tr.add(&build{ID: "b2", Jenkins: &jenkinsMeta{Worker: "worker-07", BuildNumber: 18}})

	got, ok := tr.findByJenkins("worker-07", 18)
	if !ok {
		t.Fatal("expected a match for worker-07 #18")
	}
	if got.ID != "b2" {
		t.Errorf("matched build %q, want b2", got.ID)
	}
}

func TestFindByJenkinsRequiresBothFieldsToMatch(t *testing.T) {
	// The pair is the identity. The same build number on a different worker is a
	// different build entirely — Jenkins numbers per job, not globally — so
	// matching on either field alone would resolve a deep-link to the wrong logs.
	tr := newBuildTracker()
	tr.add(&build{ID: "b1", Jenkins: &jenkinsMeta{Worker: "worker-01", BuildNumber: 18}})

	if _, ok := tr.findByJenkins("worker-07", 18); ok {
		t.Error("matched on build number alone; the (worker, number) pair is the key")
	}
	if _, ok := tr.findByJenkins("worker-01", 19); ok {
		t.Error("matched on worker alone; the (worker, number) pair is the key")
	}
}

func TestFindByJenkinsRejectsDegenerateInput(t *testing.T) {
	// Guard clause, and it is load-bearing: Jenkins queue resolution is async, so
	// a freshly-dispatched build sits in the registry with Worker: "" and
	// BuildNumber: 0 for a second or two. Without this check, a deep-link
	// carrying empty/zero values would match that placeholder and show the wrong
	// build's logs.
	tr := newBuildTracker()
	tr.add(&build{ID: "pending", Jenkins: &jenkinsMeta{Worker: "", BuildNumber: 0}})

	for _, c := range []struct {
		worker string
		num    int
	}{
		{"", 0}, {"", 18}, {"worker-01", 0}, {"worker-01", -1},
	} {
		if _, ok := tr.findByJenkins(c.worker, c.num); ok {
			t.Errorf("findByJenkins(%q, %d) matched; degenerate input must never match",
				c.worker, c.num)
		}
	}
}

func TestFindByJenkinsSkipsBuildsWithoutJenkinsMeta(t *testing.T) {
	// A build whose Jenkins field is nil must be skipped, not dereferenced.
	// Nil-panicking here would take down the whole details handler.
	tr := newBuildTracker()
	tr.add(&build{ID: "local", Jenkins: nil})
	tr.add(&build{ID: "dispatched", Jenkins: &jenkinsMeta{Worker: "w", BuildNumber: 3}})

	got, ok := tr.findByJenkins("w", 3)
	if !ok {
		t.Fatal("expected the dispatched build to be found past the nil-meta one")
	}
	if got.ID != "dispatched" {
		t.Errorf("matched %q, want dispatched", got.ID)
	}
}

func TestFindByJenkinsMissReturnsNilFalse(t *testing.T) {
	tr := newBuildTracker()
	tr.add(&build{ID: "b1", Jenkins: &jenkinsMeta{Worker: "worker-01", BuildNumber: 1}})

	got, ok := tr.findByJenkins("worker-99", 42)
	if ok {
		t.Error("expected no match")
	}
	if got != nil {
		t.Errorf("expected a nil build on miss, got %+v", got)
	}
}

func TestFindByJenkinsOnEmptyRegistry(t *testing.T) {
	if _, ok := newBuildTracker().findByJenkins("w", 1); ok {
		t.Error("expected no match in an empty registry")
	}
}

// --- markCancelled ----------------------------------------------------------

func TestMarkCancelledTransitionsAndInvokesCancel(t *testing.T) {
	var cancelled bool
	b := &build{
		status: statusRunning,
		cancel: func() { cancelled = true },
	}

	if !b.markCancelled("user requested") {
		t.Fatal("expected markCancelled to report that it acted")
	}
	if b.status != statusCancelled {
		t.Errorf("status = %v, want %v", b.status, statusCancelled)
	}
	if b.errMsg != "user requested" {
		t.Errorf("errMsg = %q, want the supplied reason", b.errMsg)
	}
	if !cancelled {
		// This is the whole point of the function: without the cancel, the runner
		// keeps polling Jenkins until its context ceiling and the SSE terminal
		// event fires minutes late, or never.
		t.Error("cancel func was not invoked")
	}
}

func TestMarkCancelledIsIdempotent(t *testing.T) {
	// A second /cancel on an already-cancelled build must report false rather
	// than re-running the transition. The handler uses the bool to decide whether
	// to emit a terminal SSE event, so a second `true` would duplicate it.
	calls := 0
	b := &build{status: statusRunning, cancel: func() { calls++ }}

	if !b.markCancelled("first") {
		t.Fatal("first call should act")
	}
	if b.markCancelled("second") {
		t.Error("second call should report false")
	}
	if b.errMsg != "first" {
		t.Errorf("errMsg = %q; the second call must not overwrite the reason", b.errMsg)
	}
	if calls != 1 {
		t.Errorf("cancel invoked %d times, want exactly 1", calls)
	}
}

func TestMarkCancelledRefusesTerminalStates(t *testing.T) {
	// Only a RUNNING build may be cancelled. Flipping a finished build to
	// cancelled would rewrite history in the UI — a build that succeeded would
	// show as cancelled after a stray click.
	for _, st := range []buildStatus{statusSuccess, statusFailed, statusCancelled} {
		called := false
		b := &build{status: st, cancel: func() { called = true }}
		if b.markCancelled("nope") {
			t.Errorf("status %v: markCancelled acted, want refusal", st)
		}
		if b.status != st {
			t.Errorf("status %v: mutated to %v", st, b.status)
		}
		if called {
			t.Errorf("status %v: cancel invoked on a terminal build", st)
		}
	}
}

func TestMarkCancelledToleratesNilCancel(t *testing.T) {
	// cancel is set by the dispatch handler before the goroutine starts, so a
	// build observed between add() and that assignment has a nil func. The
	// transition must still happen rather than panicking.
	b := &build{status: statusRunning, cancel: nil}
	if !b.markCancelled("no runner yet") {
		t.Fatal("expected the transition to happen with a nil cancel")
	}
	if b.status != statusCancelled {
		t.Errorf("status = %v, want cancelled", b.status)
	}
}

func TestMarkCancelledInvokesCancelOutsideTheMutex(t *testing.T) {
	// ⚠️ THE DEADLOCK THIS PREVENTS. markCancelled deliberately releases b.mu
	// before calling cancel, because the cancel chain can re-enter code that
	// takes b.mu (finish() does). If it were called under the lock, this test
	// would deadlock rather than fail — so it is written to prove the lock is
	// FREE at call time by taking it from inside the callback.
	b := &build{status: statusRunning}
	b.cancel = func() {
		b.mu.Lock()
		b.mu.Unlock()
	}

	done := make(chan bool, 1)
	go func() { done <- b.markCancelled("reentrancy check") }()

	select {
	case ok := <-done:
		if !ok {
			t.Error("expected markCancelled to act")
		}
	case <-time.After(2 * time.Second):
		// 2s is far longer than a mutex hand-off needs, and short enough that a
		// real deadlock fails the suite promptly rather than hanging CI.
		t.Fatal("markCancelled deadlocked: cancel must be invoked with b.mu released")
	}
}

func TestMarkCancelledConcurrentCallsActExactlyOnce(t *testing.T) {
	// Twenty goroutines race to cancel the same build. Exactly one must win, and
	// the cancel func must run exactly once — otherwise a burst of clicks emits
	// several terminal events for one build.
	var mu sync.Mutex
	cancelCalls := 0
	b := &build{status: statusRunning}
	b.cancel = func() {
		mu.Lock()
		cancelCalls++
		mu.Unlock()
	}

	const n = 20
	var wg sync.WaitGroup
	results := make([]bool, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			results[i] = b.markCancelled("race")
		}(i)
	}
	wg.Wait()

	wins := 0
	for _, r := range results {
		if r {
			wins++
		}
	}
	if wins != 1 {
		t.Errorf("%d goroutines reported acting, want exactly 1", wins)
	}
	mu.Lock()
	got := cancelCalls
	mu.Unlock()
	if got != 1 {
		t.Errorf("cancel invoked %d times, want exactly 1", got)
	}
}
