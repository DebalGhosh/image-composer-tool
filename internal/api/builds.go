// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"context"
	"strings"
	"sync"
)

// buildStatus is the lifecycle state of a build.
type buildStatus string

const (
	statusRunning   buildStatus = "running"
	statusSuccess   buildStatus = "success"
	statusFailed    buildStatus = "failed"
	statusCancelled buildStatus = "cancelled"
)

// artifact describes one output file (image or SBOM).
//
// URL points at the remote-hosted artifact (Jenkins /artifact/<relPath>) and
// the UI uses it for the download link. Path is retained on the struct for
// display purposes when the Jenkins job also carries a relative path; it is
// never populated by this backend for a local file since Jenkins-dispatch is
// the only supported build mode.
type artifact struct {
	Name string `json:"name"`
	Type string `json:"type"` // "image" | "sbom"
	Path string `json:"path,omitempty"`
	URL  string `json:"url,omitempty"`
}

// jenkinsMeta carries the Jenkins-specific state for a dispatched build.
type jenkinsMeta struct {
	Worker   string // e.g. "worker-04"
	JobURL   string // https://…/job/ict-farm/job/workers/job/worker-04/
	QueueURL string // https://…/queue/item/<id>/
	// BuildURL is what surfaces to the UI ("logs ↗" link). We append
	// /cloudbees-pipeline-explorer/ to it because that view is more
	// useful than the plain build page.
	BuildURL string // https://…/job/…/worker-04/<N>/cloudbees-pipeline-explorer/
	// RawBuildURL is the un-decorated Jenkins build URL. Kept separate
	// so the cancel path (POST rawURL+"stop") + any future rebuild /
	// changeSet fetches don't have to string-slice BuildURL. Same
	// mutation window as BuildURL (set under mu once the queue item
	// resolves).
	RawBuildURL string // https://…/job/…/worker-04/<N>/
	BuildNumber int    // 0 until assigned
	// Artifactory upload directory the PUBLISH stage prints via
	//   echo "Artefacts published to: https://af01p-png.…/artifactory/<repo>/<job>/<datetime>/"
	// Captured from the tailed log so the UI can surface it as a first-class
	// hyperlink instead of making the operator search the log.
	ArtifactoryURL string
}

// build is the in-memory record of a single Jenkins-dispatched build
// (MVP-1: no persistence).
//
// All mutable fields are guarded by mu. ID, Template, TemplatePathYAML, and
// done are set once at construction and are safe to read without the lock.
// Jenkins is attached at construction; its BuildURL/BuildNumber are mutated
// under mu once the queue item resolves.
type build struct {
	ID               string
	Template         string          // template file name (for display)
	TemplatePathYAML string          // raw YAML body handed to Jenkins
	Command          string          // exact dispatch request, for the UI's troubleshoot panel
	Summary          *composeSummary // image configuration summary, nil for YAML-only builds
	Jenkins          *jenkinsMeta    // set for every build in this backend
	done             chan struct{}   // closed when the build finishes
	// cancel unblocks the runner goroutine's HTTP calls + poll waits
	// when the /cancel handler fires. Set once in the dispatch handler
	// before the goroutine starts. Safe to call multiple times —
	// context.CancelFunc is idempotent.
	cancel context.CancelFunc

	mu        sync.Mutex
	status    buildStatus
	logLines  []string // buffered log history for late log subscribers
	artifacts []artifact
	errMsg    string
	// wake is a broadcast channel: it is CLOSED (never sent-on) by
	// appendLog to wake every SSE subscriber that's blocked on it, then
	// atomically replaced with a fresh channel under mu. Subscribers grab
	// the current channel under mu and select on it; when it closes they
	// re-grab and drain freshly-appended lines. Push-based — no polling.
	wake chan struct{}
}

// result is an immutable snapshot of a build's terminal state.
type result struct {
	status    buildStatus
	artifacts []artifact
	errMsg    string
}

// snapshot returns the build's current status, artifacts, and error under lock.
func (b *build) snapshot() result {
	b.mu.Lock()
	defer b.mu.Unlock()
	arts := make([]artifact, len(b.artifacts))
	copy(arts, b.artifacts)
	return result{status: b.status, artifacts: arts, errMsg: b.errMsg}
}

// buildTracker holds all builds for the process lifetime.
type buildTracker struct {
	mu     sync.Mutex
	builds map[string]*build
}

func newBuildTracker() *buildTracker {
	return &buildTracker{builds: make(map[string]*build)}
}

func (t *buildTracker) add(b *build) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.builds[b.ID] = b
}

func (t *buildTracker) get(id string) (*build, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	b, ok := t.builds[id]
	return b, ok
}

// findByJenkins returns the build dispatched to (worker, buildNumber) if one
// exists in the registry. Enables URL-based deep-links: the UI can round-trip
// a shareable ?worker=X&buildNo=N and resolve it back to the internal build ID
// on cold load. Returns (nil, false) when no build matches.
//
// Iteration is O(N) over the registry, which stays fine because N is the
// count of dispatched-this-process builds (dozens at most before restart).
// If the registry ever grows past that we can add a secondary index keyed by
// (Worker, BuildNumber) — but until then the map scan avoids the bookkeeping.
func (t *buildTracker) findByJenkins(worker string, buildNumber int) (*build, bool) {
	if worker == "" || buildNumber <= 0 {
		return nil, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, b := range t.builds {
		if b.Jenkins == nil {
			continue
		}
		if b.Jenkins.Worker == worker && b.Jenkins.BuildNumber == buildNumber {
			return b, true
		}
	}
	return nil, false
}

// appendLog records a log line and is safe for concurrent use.
//
// Also wakes every SSE subscriber currently blocked on b.wake by closing
// the current wake channel and installing a fresh one for the next round.
// Close-once semantics mean N subscribers all unblock from a single
// broadcast with zero per-subscriber allocation.
func (b *build) appendLog(line string) {
	b.mu.Lock()
	b.logLines = append(b.logLines, line)
	prev := b.wake
	b.wake = make(chan struct{})
	b.mu.Unlock()
	if prev != nil {
		close(prev)
	}
}

func (b *build) snapshotLogs() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]string, len(b.logLines))
	copy(out, b.logLines)
	return out
}

// waitChan returns the current wake channel — a subscriber selects on this
// under mu, so it observes the pre-append value; when appendLog runs it
// closes exactly this channel, unblocking every waiter atomically.
func (b *build) waitChan() <-chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.wake == nil {
		b.wake = make(chan struct{})
	}
	return b.wake
}

// --- response bodies ---

type buildAccepted struct {
	BuildID string `json:"buildId"`
	Status  string `json:"status"`
	LogsURL string `json:"logsUrl"`
}

// finish records the build's terminal status, artifacts, and error under lock.
//
// Idempotent-for-terminal-states: if the build is already in a terminal
// state (success / failed / cancelled), we DON'T overwrite it. This
// matters for the stop-job flow — the /cancel handler marks the build
// cancelled synchronously, then a few seconds later the runner
// goroutine's poll loop notices Jenkins reported the build as
// FAILURE / ABORTED and would otherwise clobber "cancelled" back to
// "failed", which is misleading in the UI.
func (b *build) finish(status buildStatus, arts []artifact, errMsg string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.status != statusRunning && b.status != "" {
		return
	}
	b.status = status
	b.artifacts = arts
	b.errMsg = errMsg
}

// markCancelled transitions a running build into the cancelled terminal
// state directly, without waiting for the runner goroutine to notice
// Jenkins abort. Called by the /cancel HTTP handler. No-op if the
// build is already in a terminal state.
//
// Also signals the runner goroutine via b.cancel so its in-flight
// progressiveText / getRun HTTP calls unblock immediately. Without
// this, the runner would keep polling for up to the 6h ctx ceiling
// while Jenkins winds the worker down, and the SSE terminal event
// (gated on <-b.done, which is closed only when the runner returns)
// would fire seconds-to-minutes late — or never, if /stop is silently
// ineffective.
//
// The cancel is invoked OUTSIDE the mutex to avoid recursing into any
// callback that might try to take mu (finish() certainly does).
func (b *build) markCancelled(reason string) bool {
	b.mu.Lock()
	if b.status != statusRunning {
		b.mu.Unlock()
		return false
	}
	b.status = statusCancelled
	b.errMsg = reason
	cancel := b.cancel
	b.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return true
}

// classifyArtifact labels an output file as "sbom" or "image" by name.
// Used by the Jenkins-dispatch path when it enumerates the run's artifacts.
func classifyArtifact(name string) string {
	lower := strings.ToLower(name)
	if strings.Contains(lower, "sbom") || strings.Contains(lower, "spdx") {
		return "sbom"
	}
	return "image"
}
