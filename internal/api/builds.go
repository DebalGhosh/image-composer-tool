// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/open-edge-platform/image-composer-tool/internal/config"
	"github.com/open-edge-platform/image-composer-tool/internal/utils/logger"
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
// Path is the local on-disk path for artifacts produced by the local build
// path. URL, when set, points at a remote-hosted artifact (Jenkins
// /artifact/<relPath>) and the UI prefers it over Path for the download link.
// Exactly one of Path / URL will be set in practice, but neither is required.
type artifact struct {
	Name string `json:"name"`
	Type string `json:"type"` // "image" | "sbom"
	Path string `json:"path,omitempty"`
	URL  string `json:"url,omitempty"`
}

// jenkinsMeta carries the Jenkins-specific state for a dispatched build.
// nil for locally-run builds.
type jenkinsMeta struct {
	Worker      string // e.g. "worker-04"
	JobURL      string // https://…/job/ict-farm/job/workers/job/worker-04/
	QueueURL    string // https://…/queue/item/<id>/
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

// build is the in-memory record of a single build (MVP-1: no persistence).
//
// All mutable fields are guarded by mu. ID, WorkDir, Template, and done are set
// once at construction and are safe to read without the lock. Jenkins is
// attached at construction for dispatched builds; its BuildURL/BuildNumber are
// mutated under mu once the queue item resolves.
type build struct {
	ID               string
	WorkDir          string
	CacheDir         string
	Template         string          // template file name (for display)
	TemplatePath     string          // resolved on-disk path (for download)
	TemplatePathYAML string          // raw YAML body for Jenkins builds (no on-disk file)
	Command          string          // exact command run, for the UI's troubleshoot panel
	Summary          *composeSummary // image configuration summary, nil for YAML builds
	Jenkins          *jenkinsMeta    // set for Jenkins-dispatched builds; nil otherwise
	done             chan struct{}   // closed when the build finishes
	// cancel unblocks the runner goroutine's HTTP calls + poll waits
	// when the /cancel handler fires. Set once in the dispatch handler
	// before the goroutine starts; nil for local exec builds (which
	// have no remote stop path in this MVP). Safe to call multiple
	// times — context.CancelFunc is idempotent.
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

// --- request/response bodies ---

type buildRequest struct {
	Compose *composeRequest `json:"compose"`
	YAML    string          `json:"yaml"`
}

type buildAccepted struct {
	BuildID string `json:"buildId"`
	Status  string `json:"status"`
	LogsURL string `json:"logsUrl"`
}

// handleStartBuild resolves the template, starts an os/exec build, and returns a
// build id. Basic sends {compose}; Advanced would send {yaml} (not used by the
// Basic slice but accepted for forward-compat).
func (s *Server) handleStartBuild(w http.ResponseWriter, r *http.Request) {
	var req buildRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body")
		return
	}

	id := uuid.NewString()
	buildRoot := filepath.Join(s.cfg.WorkDir, "builds", id)
	workDir := filepath.Join(buildRoot, "work")
	cacheDir := filepath.Join(buildRoot, "cache")
	// 0700: build logs and artifact metadata may be sensitive; keep them private.
	for _, d := range []string{workDir, cacheDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			writeError(w, http.StatusInternalServerError, "WORKDIR", "cannot create build work directory")
			return
		}
	}

	// Resolve the template path to build. Client errors (bad input, no match)
	// return 400; server errors (e.g. writing the inline template) return 500.
	templatePath, templateName, err := s.resolveBuildTemplate(&req, workDir)
	if err != nil {
		if errors.Is(err, errBadBuildRequest) {
			writeError(w, http.StatusBadRequest, "NO_MATCH", err.Error())
		} else {
			writeError(w, http.StatusInternalServerError, "TEMPLATE_RESOLVE", err.Error())
		}
		return
	}

	// Build the image summary. Best-effort: a merge failure here doesn't block
	// the build (compose already validated the template; this is for display only).
	var summary *composeSummary
	if req.Compose != nil {
		if merged, err := config.LoadAndMergeTemplate(templatePath); err == nil {
			s := buildComposeSummary(*req.Compose, merged)
			summary = &s
		}
	}

	name, cmdArgs := s.buildCommand(templatePath, workDir, cacheDir)
	b := &build{
		ID:           id,
		status:       statusRunning,
		WorkDir:      workDir,
		CacheDir:     cacheDir,
		Template:     templateName,
		TemplatePath: templatePath,
		Command:      name + " " + strings.Join(cmdArgs, " "),
		Summary:      summary,
		done:         make(chan struct{}),
	}
	s.tracker.add(b)

	go s.runBuild(b, name, cmdArgs)

	writeJSON(w, http.StatusAccepted, buildAccepted{
		BuildID: id,
		Status:  string(statusRunning),
		LogsURL: fmt.Sprintf("/api/v1/builds/%s/logs", id),
	})
}

// errBadBuildRequest marks resolution failures caused by client input (bad
// request shape or an unmatched combination) so the handler can return 400;
// other errors are treated as server-side (500).
var errBadBuildRequest = errors.New("bad build request")

// resolveBuildTemplate returns the on-disk template path to build. For {compose}
// it looks up the manifest; for {yaml} it writes the body to the work dir.
func (s *Server) resolveBuildTemplate(req *buildRequest, workDir string) (path, name string, err error) {
	if req.YAML != "" {
		p := filepath.Join(workDir, "template.yml")
		if werr := os.WriteFile(p, []byte(req.YAML), 0o600); werr != nil {
			return "", "", fmt.Errorf("writing template: %w", werr) // server-side
		}
		return p, "template.yml", nil
	}
	if req.Compose == nil {
		return "", "", fmt.Errorf("%w: provide either compose or yaml", errBadBuildRequest)
	}
	c := req.Compose
	tmpl := s.manifest.findTemplate(c.Vertical, c.SKU, c.Platform, c.OS, c.ImageType)
	if tmpl == "" {
		return "", "", fmt.Errorf("%w: no template maps to the selected combination", errBadBuildRequest)
	}
	full, perr := safeTemplatePath(s.cfg.TemplatesDir, tmpl)
	if perr != nil {
		return "", "", fmt.Errorf("resolving template path: %w", perr) // server-side (bad manifest)
	}
	return full, tmpl, nil
}

// buildCommand assembles the argv for an ICT build, prefixing sudo when
// configured (ICT builds require root for chroot/mount operations).
//
// This intentionally uses os/exec directly rather than internal/utils/shell:
// the shell package runs commands synchronously via `bash -c` and returns the
// captured output as a string, whereas the API needs to hold the *exec.Cmd to
// stream stdout line-by-line to SSE subscribers and (in the cancellation story)
// signal the process group. The command surface here is fixed and minimal — a
// single hard-coded `image-composer-tool build` invocation with no user-derived
// arguments on the command line (selections are only manifest lookup keys) — so
// the allowlist the shell package provides adds no safety here.
func (s *Server) buildCommand(templatePath, workDir, cacheDir string) (name string, args []string) {
	// Per-build --work-dir and --cache-dir keep each build's scratch and package
	// cache isolated under the build root, so concurrent/repeat builds don't share
	// (root-owned) state and cleanup is a single directory removal.
	ictArgs := []string{"build", templatePath, "--work-dir", workDir, "--cache-dir", cacheDir}
	if s.cfg.Sudo {
		// -n: never prompt; fail fast if passwordless sudo isn't configured.
		return "sudo", append([]string{"-n", s.cfg.ICTBinary}, ictArgs...)
	}
	return s.cfg.ICTBinary, ictArgs
}

// runBuild executes the ICT binary, streams its output into the build's log
// buffer, and records the terminal status + artifacts.
func (s *Server) runBuild(b *build, name string, cmdArgs []string) {
	log := logger.Logger()
	defer close(b.done)

	// ICT builds require root (chroot, mounts), so the build runs under sudo, and
	// from the repo root since ICT resolves config/osv/... relative to cwd. The
	// per-build --work-dir/--cache-dir keep outputs isolated.
	//
	// Echo the exact command so the operator can reproduce it on the shell. This
	// is both logged server-side and pushed as the first build-log line so it
	// surfaces in the UI's Build page over SSE.
	log.Infof("build %s command: %s", b.ID, b.Command)
	b.appendLog("$ " + b.Command)

	cmd := exec.Command(name, cmdArgs...)

	// Merge stdout+stderr into a single stream via one pipe writer shared by both
	// fds. os/exec guards concurrent writes to the same *os.File writer with a
	// lock, so interleaving is safe — unlike assigning cmd.Stderr = cmd.Stdout,
	// which hands both fds the same pipe end and races. A pipe (not
	// CombinedOutput) is required so logs stream line-by-line to SSE as the build
	// runs rather than buffering until it exits.
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		b.appendLog(fmt.Sprintf("failed to start build: %v", err))
		b.finish(statusFailed, nil, err.Error())
		_ = pw.Close()
		_ = pr.Close()
		return
	}
	// Wait for the process in a goroutine and close the pipe writer when it
	// exits, so the scanner below sees EOF. The exit error is delivered on
	// waitCh (cmd.Wait is called exactly once, here).
	waitCh := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		_ = pw.Close()
		waitCh <- err
	}()

	scanner := bufio.NewScanner(pr)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		b.appendLog(scanner.Text())
	}
	// A scanner error (read failure, or a token exceeding the buffer) means the
	// captured log is truncated; record it so a build isn't silently marked
	// successful with incomplete output.
	scanErr := scanner.Err()
	if scanErr != nil {
		b.appendLog(fmt.Sprintf("warning: build log stream error: %v", scanErr))
	}

	waitErr := <-waitCh
	if waitErr != nil {
		log.Warnf("build %s failed: %v", b.ID, waitErr)
		b.finish(statusFailed, nil, waitErr.Error())
		return
	}
	if scanErr != nil {
		b.finish(statusFailed, nil, fmt.Sprintf("log stream error: %v", scanErr))
		return
	}

	// Prefer artifacts parsed from ICT's own output (authoritative name+path,
	// and immune to the root-owned output dirs the build creates under sudo).
	// Fall back to scanning the work dir if the output block wasn't found.
	arts := parseArtifacts(b.snapshotLogs())
	if len(arts) == 0 {
		arts = discoverArtifacts(b.WorkDir)
	}

	b.finish(statusSuccess, arts, "")
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

// parseArtifacts extracts the artifact list from ICT's build output. ICT prints
// each artifact as a bullet line with "name (size)" followed by a line holding
// the absolute path:
//
//   - minimal-os-image-ubuntu-26.04.raw.gz (1.13 GB)
//     /home/.../minimal/minimal-os-image-ubuntu-26.04.raw.gz
//
// Log lines carry a leading "<timestamp> INFO ..." prefix from the logger, so we
// match on the bullet and on a path segment rather than line position.
func parseArtifacts(logs []string) []artifact {
	var out []artifact
	var pending *artifact // artifact awaiting its path line

	for _, line := range logs {
		if idx := strings.Index(line, "• "); idx >= 0 {
			rest := strings.TrimSpace(line[idx+len("• "):])
			// Strip a trailing " (size)" suffix, keeping the filename.
			name := rest
			if p := strings.LastIndex(rest, " ("); p >= 0 {
				name = strings.TrimSpace(rest[:p])
			}
			if name != "" {
				out = append(out, artifact{Name: name, Type: classifyArtifact(name)})
				pending = &out[len(out)-1]
			}
			continue
		}
		// The path line for the most recent bullet: an absolute path ending in
		// that artifact's name.
		if pending != nil {
			if p := extractPath(line); p != "" && strings.HasSuffix(p, pending.Name) {
				pending.Path = p
				pending = nil
			}
		}
	}
	return out
}

// extractPath returns the trailing absolute path on a log line, or "".
func extractPath(line string) string {
	// Logger lines are tab-separated: "<ts>\t<LEVEL>\t<source:line>\t<message>".
	// The path lives in the final field; taking the first "/" would wrongly match
	// the "display/display.go:80" source prefix. Fall back to the whole line when
	// there are no tabs (a bare path line).
	if i := strings.LastIndex(line, "\t"); i >= 0 {
		line = line[i+1:]
	}
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "/") {
		return ""
	}
	return line
}

// classifyArtifact labels an output file as "sbom" or "image" by name.
func classifyArtifact(name string) string {
	lower := strings.ToLower(name)
	if strings.Contains(lower, "sbom") || strings.Contains(lower, "spdx") {
		return "sbom"
	}
	return "image"
}

// discoverArtifacts scans the build work dir for image + SBOM outputs. Used as a
// fallback when ICT's artifact block cannot be parsed from the logs.
func discoverArtifacts(workDir string) []artifact {
	var out []artifact
	_ = filepath.WalkDir(workDir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		lower := strings.ToLower(name)
		switch {
		case strings.Contains(lower, "sbom") || strings.HasSuffix(lower, ".spdx.json"):
			out = append(out, artifact{Name: name, Type: "sbom", Path: path})
		case strings.HasSuffix(lower, ".raw"), strings.HasSuffix(lower, ".raw.gz"),
			strings.HasSuffix(lower, ".iso"), strings.HasSuffix(lower, ".qcow2"):
			out = append(out, artifact{Name: name, Type: "image", Path: path})
		}
		return nil
	})
	return out
}
