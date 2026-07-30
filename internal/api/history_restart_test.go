// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- restart reconciliation ---

// A build persisted as non-terminal has no process behind it once it is being
// read back from disk, so it must not be replayed as live. Every non-terminal
// status maps to failed with an explanation.
func TestReconcileInterrupted(t *testing.T) {
	for _, status := range []buildStatus{statusNotStarted, statusRunning, statusCancelling} {
		got, msg := reconcileInterrupted(status, "")
		if got != statusFailed {
			t.Fatalf("%q reconciled to %q, want failed", status, got)
		}
		if !strings.Contains(msg, "interrupted by a server restart") {
			t.Fatalf("%q: message does not explain the interruption: %q", status, msg)
		}
		// The user has to know the work dir may still hold resources: nothing ran
		// the build's teardown.
		if !strings.Contains(msg, "loop devices") {
			t.Fatalf("%q: message should warn about leftover resources: %q", status, msg)
		}
	}
}

// Terminal statuses are already authoritative — reconciliation must not touch
// them, or a successful build would be relabelled on every restart.
func TestReconcileInterruptedLeavesTerminalAlone(t *testing.T) {
	for _, status := range []buildStatus{statusSuccess, statusFailed, statusCancelled} {
		got, msg := reconcileInterrupted(status, "original reason")
		if got != status {
			t.Fatalf("%q was rewritten to %q; terminal states are authoritative", status, got)
		}
		if msg != "original reason" {
			t.Fatalf("%q: errMsg altered to %q", status, msg)
		}
	}
}

// An interrupted build that had already recorded an error keeps it: the original
// reason is the more specific of the two, and losing it would hide why the build
// was failing before the restart.
func TestReconcileInterruptedPreservesExistingError(t *testing.T) {
	_, msg := reconcileInterrupted(statusRunning, "exit status 1")
	if !strings.HasPrefix(msg, "exit status 1") {
		t.Fatalf("original error lost: %q", msg)
	}
	if !strings.Contains(msg, "interrupted by a server restart") {
		t.Fatalf("interruption context lost: %q", msg)
	}
}

// buildFromMeta is the path used by the detail/logs handlers, so it must apply
// the same reconciliation as the list.
func TestBuildFromMetaReconcilesInterrupted(t *testing.T) {
	b := buildFromMeta("/tmp/x", buildMeta{ID: "b", Status: string(statusRunning)})
	if s := b.snapshot(); s.status != statusFailed {
		t.Fatalf("status = %q, want failed", s.status)
	}
}

// writeInterruptedMeta persists a build record stuck in a non-terminal state,
// exactly as a server that was killed mid-build leaves behind.
func writeInterruptedMeta(t *testing.T, s *Server, id string, status buildStatus) {
	t.Helper()
	rootDir := filepath.Join(s.buildsRoot(), id)
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(buildMeta{ID: id, Status: string(status)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metaPath(rootDir), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// The regression this fixes: after a restart the UI called /builds, saw a
// not-started record, and adopted it as the in-flight compose — disabling Compose
// and offering a Cancel that could only fail. The list must report it terminal.
func TestHandleListBuildsReportsInterruptedAsFailed(t *testing.T) {
	s := newTestServer(t)
	writeInterruptedMeta(t, s, "ghost", statusNotStarted)

	rec := httptest.NewRecorder()
	s.handleListBuilds(rec, httptest.NewRequest(http.MethodGet, "/api/v1/builds", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var got struct{ Builds []historyItem }
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decoding: %v (%s)", err, rec.Body.String())
	}
	if len(got.Builds) != 1 {
		t.Fatalf("got %d builds, want 1", len(got.Builds))
	}
	if got.Builds[0].Status != string(statusFailed) {
		t.Fatalf("status = %q, want failed (a dead record must not look live)", got.Builds[0].Status)
	}
}

// A genuinely running build is tracked in memory and overlaid on top of the disk
// record, so reconciliation must not downgrade it — otherwise the live build the
// user is watching would flip to failed.
func TestHandleListBuildsKeepsLiveBuildRunning(t *testing.T) {
	s := newTestServer(t)
	writeInterruptedMeta(t, s, "live", statusRunning)
	// Same id, but present in the tracker: this build really is running.
	s.tracker.add(&build{ID: "live", status: statusRunning, done: make(chan struct{})})

	rec := httptest.NewRecorder()
	s.handleListBuilds(rec, httptest.NewRequest(http.MethodGet, "/api/v1/builds", nil))

	var got struct{ Builds []historyItem }
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if len(got.Builds) != 1 {
		t.Fatalf("got %d builds, want 1 (the live record must overlay the disk one)", len(got.Builds))
	}
	if got.Builds[0].Status != string(statusRunning) {
		t.Fatalf("status = %q, want running", got.Builds[0].Status)
	}
}

// --- kill path resolution ---

// The cancel bug this fixes: signalCancel passes a bare "kill", which sudo
// resolves against its own secure_path. On a host with /usr/local/bin/kill
// shadowing /usr/bin/kill, the command sudo runs is not necessarily the one the
// operator assumed, so the sudoers rule must name the path sudo will actually
// pick. resolveSudoHelper resolves that path (probing sudo's secure_path), and it
// is what both the generated rule and the startup log report — so the rule and
// the invocation agree. It must always return an absolute path ending in "kill".
func TestKillPathIsAbsolute(t *testing.T) {
	p := resolveSudoHelper("kill")
	if !filepath.IsAbs(p) {
		t.Fatalf("resolveSudoHelper(kill) = %q, want an absolute path (sudoers rules must name an absolute path)", p)
	}
	if filepath.Base(p) != "kill" {
		t.Fatalf("resolveSudoHelper(kill) = %q, want a path ending in kill", p)
	}
}

// The resolution is deterministic, so the path logged at startup is the path the
// generated sudoers rule names — an operator scoping a rule from `--print-sudoers`
// (or the startup line) must not find a different binary resolved at cancel time.
func TestKillPathIsStable(t *testing.T) {
	if a, b := resolveSudoHelper("kill"), resolveSudoHelper("kill"); a != b {
		t.Fatalf("resolveSudoHelper(kill) returned %q then %q; must be stable", a, b)
	}
}
