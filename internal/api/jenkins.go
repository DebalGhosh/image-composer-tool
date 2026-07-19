// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Jenkins dispatch path. The UI's "Build Image" button in this fork does NOT
// invoke the local ICT binary -- it fans a build out to one of N sibling
// Jenkins workers (worker-01..worker-NN) under a folder we call the "workers
// path" (default: ict-farm/workers). Selection is free-first, random fallback.
//
// The dispatch handler:
//
//	1. Lists jobs under ${JenkinsWorkersPath}, filters to the worker-* prefix,
//	   picks a currently-idle one at random (or, if all busy, a fully random one).
//	2. POSTs buildWithParameters with TEMPLATE_YAML set from the request body.
//	   Every other configured parameter is deliberately OMITTED so Jenkins uses
//	   the worker's per-parameter defaults -- see ictWorkerSeed / ictBuild.
//	3. Reads back the Location header (a queue item URL) and polls it until
//	   Jenkins assigns a build number (executable.number).
//	4. Tails ${buildURL}/logText/progressiveText via the X-Text-Size /
//	   X-More-Data offset protocol and appends each line to the in-memory
//	   build's log buffer. The existing SSE handler at
//	   /api/v1/builds/{id}/logs then relays those lines to the browser --
//	   the client contract (event names "log" / "complete" / "error") stays
//	   byte-identical to the local-build path.
//	5. On termination, fetches artifacts[] and rewrites each into an
//	   {Name, Type, URL} triple so the UI's artifact-download link can point
//	   straight at Jenkins' /artifact/<relPath> endpoint.
//
// CSRF crumb: not needed with an API token (jenkins.io CSRF Protection page:
// "Requests authenticating with an API token are exempt from CSRF protection").
// The token replaces both auth + crumb.

package api

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/open-edge-platform/image-composer-tool/internal/utils/logger"
)

// jenkinsClient is a thin HTTP client over the Jenkins REST API. All calls use
// HTTP Basic auth with the configured user + API token.
type jenkinsClient struct {
	base        string // e.g. https://cje-pg-prod01.devtools.intel.com/nex-cisv-devops02
	user        string
	token       string
	workersPath string       // e.g. "ict-farm/workers"
	http        *http.Client // owns its own client so we can set a per-request timeout
}

// newJenkinsClient constructs the client, or returns nil if the required config
// is missing -- callers must check and refuse to serve the Jenkins routes.
func newJenkinsClient(cfg Config) *jenkinsClient {
	if cfg.JenkinsURL == "" || cfg.JenkinsUser == "" || cfg.JenkinsToken == "" {
		return nil
	}
	base := strings.TrimRight(cfg.JenkinsURL, "/")
	workers := strings.Trim(cfg.JenkinsWorkersPath, "/")
	if workers == "" {
		workers = "ict-farm/workers"
	}
	return &jenkinsClient{
		base:        base,
		user:        cfg.JenkinsUser,
		token:       cfg.JenkinsToken,
		workersPath: workers,
		http:        &http.Client{Timeout: 30 * time.Second},
	}
}

// folderURL builds the Jenkins URL for the workers folder itself.
//
//	ict-farm/workers -> {base}/job/ict-farm/job/workers/
func (j *jenkinsClient) folderURL() string {
	segs := strings.Split(j.workersPath, "/")
	var b strings.Builder
	b.WriteString(j.base)
	for _, s := range segs {
		b.WriteString("/job/")
		b.WriteString(url.PathEscape(s))
	}
	b.WriteString("/")
	return b.String()
}

// encodeRelativePath percent-encodes each "/"-separated segment of a Jenkins
// artifact relativePath so filenames with spaces / '#' / '?' / '+' / unicode
// don't produce malformed URLs when appended after ".../artifact/". Preserves
// the forward slashes between segments.
func encodeRelativePath(rel string) string {
	segs := strings.Split(rel, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

// jobURL builds the Jenkins URL for a specific worker job within the workers
// folder. name is the leaf job name (e.g. "worker-01").
func (j *jenkinsClient) jobURL(name string) string {
	return j.folderURL() + "job/" + url.PathEscape(name) + "/"
}

// do runs an authenticated request. Basic auth is set on every call; the
// caller supplies any extra headers.
func (j *jenkinsClient) do(req *http.Request) (*http.Response, error) {
	req.SetBasicAuth(j.user, j.token)
	req.Header.Set("Accept-Charset", "utf-8")
	return j.http.Do(req)
}

// jenkinsJob is one entry from the workers-folder listing.
type jenkinsJob struct {
	Name  string `json:"name"`
	URL   string `json:"url"`
	Color string `json:"color"` // ends in "_anime" while a build is in progress
}

type jenkinsJobList struct {
	Jobs []jenkinsJob `json:"jobs"`
}

// listWorkers returns every "worker-*" job under the workers folder. Jenkins'
// `color` field ends in `_anime` while a build is running -- we return both so
// the picker can prefer idle workers but still fall back.
func (j *jenkinsClient) listWorkers(ctx context.Context) ([]jenkinsJob, error) {
	u := j.folderURL() + "api/json?tree=jobs%5Bname%2Curl%2Ccolor%5D"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := j.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("list workers: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out jenkinsJobList
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode workers list: %w", err)
	}
	filtered := make([]jenkinsJob, 0, len(out.Jobs))
	for _, jb := range out.Jobs {
		if strings.HasPrefix(jb.Name, "worker-") && !strings.HasPrefix(jb.Color, "disabled") {
			filtered = append(filtered, jb)
		}
	}
	return filtered, nil
}

// pickWorker returns one worker job by the "free-first, random fallback" rule:
// prefer any whose `color` doesn't end in `_anime` (idle), else pick uniformly
// at random across all eligible workers. Returns an error only when the fleet
// is empty.
func pickWorker(all []jenkinsJob) (jenkinsJob, error) {
	if len(all) == 0 {
		return jenkinsJob{}, errors.New("no worker jobs found under the configured workers path")
	}
	idle := make([]jenkinsJob, 0, len(all))
	for _, w := range all {
		if !strings.HasSuffix(w.Color, "_anime") {
			idle = append(idle, w)
		}
	}
	pool := idle
	if len(pool) == 0 {
		pool = all
	}
	return pool[cryptoRandIntn(len(pool))], nil
}

// cryptoRandIntn returns a uniformly-random int in [0, n). Uses crypto/rand so
// the picker is deterministic-free across restarts (math/rand seeded from time
// would be fine here too; crypto/rand just removes one line of ceremony and
// avoids the debate).
func cryptoRandIntn(n int) int {
	if n <= 1 {
		return 0
	}
	nBig, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		return 0
	}
	return int(nBig.Int64())
}

// trigger POSTs buildWithParameters to the picked worker with just TEMPLATE_YAML.
// Every other configured parameter is omitted so the worker's declared defaults
// apply -- see ictWorkerSeed / matrix.defaults in the CaC repo. Returns the
// queue item URL from the Location header.
func (j *jenkinsClient) trigger(ctx context.Context, workerName, yaml string) (queueURL string, err error) {
	form := url.Values{}
	form.Set("TEMPLATE_YAML", yaml)

	u := j.jobURL(workerName) + "buildWithParameters"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")

	resp, err := j.do(req)
	if err != nil {
		return "", fmt.Errorf("trigger %s: %w", workerName, err)
	}
	defer resp.Body.Close()
	// Modern Jenkins returns 201 Created + Location. Very old (<1.519) returned
	// 302; accept either. Anything else is a real error.
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusFound {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("trigger %s: HTTP %d: %s", workerName, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	loc := resp.Header.Get("Location")
	if loc == "" {
		return "", fmt.Errorf("trigger %s: missing Location header", workerName)
	}
	return loc, nil
}

// jenkinsQueueItem models the fields of a queue item we care about.
type jenkinsQueueItem struct {
	ID         int    `json:"id"`
	Cancelled  bool   `json:"cancelled"`
	Why        string `json:"why"`
	Executable *struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	} `json:"executable"`
}

// waitForBuild polls a queue item URL until Jenkins assigns a build number or
// the item is cancelled. Returns the build URL + build number.
//
// The waitCtx is expected to include a deadline; we do not enforce a hard
// timeout inside this function. A busy fleet can leave an item queued
// arbitrarily long.
func (j *jenkinsClient) waitForBuild(waitCtx context.Context, queueURL string, onWait func(reason string)) (buildURL string, buildNumber int, err error) {
	u := strings.TrimRight(queueURL, "/") + "/api/json?tree=id%2Ccancelled%2Cwhy%2Cexecutable%5Bnumber%2Curl%5D"
	// Poll every 1 s. The queue item URL is guaranteed to resolve for 5
	// minutes after the item leaves the queue, so we don't have to be clever
	// about switching endpoints mid-wait.
	tick := time.NewTicker(1 * time.Second)
	defer tick.Stop()
	lastWhy := ""
	for {
		req, err := http.NewRequestWithContext(waitCtx, http.MethodGet, u, nil)
		if err != nil {
			return "", 0, err
		}
		req.Header.Set("Accept", "application/json")
		resp, err := j.do(req)
		if err != nil {
			return "", 0, err
		}
		// A non-200 (typically 404 after the 5-min queue-item retention
		// window, or a 502 from the reverse proxy) means we can't make
		// forward progress on this queue item -- surface it instead of
		// looping on a garbage-decoded empty struct.
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			return "", 0, fmt.Errorf("queue item poll: HTTP %d: %s",
				resp.StatusCode, strings.TrimSpace(string(body)))
		}
		var item jenkinsQueueItem
		derr := json.NewDecoder(resp.Body).Decode(&item)
		resp.Body.Close()
		if derr != nil {
			return "", 0, fmt.Errorf("decode queue item: %w", derr)
		}
		if item.Cancelled {
			return "", 0, errors.New("queue item was cancelled before execution")
		}
		if item.Executable != nil && item.Executable.Number != 0 {
			return strings.TrimRight(item.Executable.URL, "/") + "/", item.Executable.Number, nil
		}
		if onWait != nil && item.Why != "" && item.Why != lastWhy {
			onWait(item.Why)
			lastWhy = item.Why
		}
		select {
		case <-waitCtx.Done():
			return "", 0, waitCtx.Err()
		case <-tick.C:
		}
	}
}

// jenkinsRun models the fields of a build we care about while polling.
type jenkinsRun struct {
	Building bool   `json:"building"`
	Result   string `json:"result"` // "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | "NOT_BUILT"
}

func (j *jenkinsClient) getRun(ctx context.Context, buildURL string) (jenkinsRun, error) {
	u := buildURL + "api/json?tree=building%2Cresult"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return jenkinsRun{}, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := j.do(req)
	if err != nil {
		return jenkinsRun{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return jenkinsRun{}, fmt.Errorf("get run: HTTP %d", resp.StatusCode)
	}
	var run jenkinsRun
	if err := json.NewDecoder(resp.Body).Decode(&run); err != nil {
		return jenkinsRun{}, fmt.Errorf("decode run: %w", err)
	}
	return run, nil
}

// jenkinsArtifact mirrors one entry of a build's artifacts[] array.
type jenkinsArtifact struct {
	FileName     string `json:"fileName"`
	RelativePath string `json:"relativePath"`
}

// listArtifacts returns the archived artifact list for a completed build.
func (j *jenkinsClient) listArtifacts(ctx context.Context, buildURL string) ([]jenkinsArtifact, error) {
	u := buildURL + "api/json?tree=artifacts%5BfileName%2CrelativePath%5D"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := j.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list artifacts: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Artifacts []jenkinsArtifact `json:"artifacts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode artifacts: %w", err)
	}
	return out.Artifacts, nil
}

// fetchProgressiveText makes a single progressiveText call. Returns the new
// bytes, the next-offset to poll with, and whether the log writer is still open.
func (j *jenkinsClient) fetchProgressiveText(ctx context.Context, buildURL string, offset int64) (chunk []byte, nextOffset int64, more bool, err error) {
	u := fmt.Sprintf("%slogText/progressiveText?start=%d", buildURL, offset)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, offset, false, err
	}
	resp, err := j.do(req)
	if err != nil {
		return nil, offset, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, offset, false, fmt.Errorf("progressiveText: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, offset, false, err
	}
	// Advance the offset. Normally we trust Jenkins' X-Text-Size header (which
	// is the new cumulative byte offset). If the header is missing or
	// unparseable -- e.g. a reverse proxy stripped X-* headers -- fall back to
	// advancing by the chunk length so the caller doesn't re-fetch the same
	// range on the next tick and duplicate every log line forever.
	next := offset + int64(len(body))
	if s := resp.Header.Get("X-Text-Size"); s != "" {
		if v, perr := strconv.ParseInt(s, 10, 64); perr == nil && v >= offset {
			next = v
		}
	}
	// X-More-Data is present with value "true" while the writer is open.
	// Absent (== not "true") means we've hit the final chunk.
	more = resp.Header.Get("X-More-Data") == "true"
	return body, next, more, nil
}

// --- HTTP handlers ---

// jenkinsDispatchRequest is the incoming POST body from the browser.
type jenkinsDispatchRequest struct {
	YAML string `json:"yaml"`
}

// handleJenkinsDispatch picks a worker, triggers a build, and returns the
// standard buildAccepted response so the browser's SSE reader hits the
// existing /api/v1/builds/{id}/logs endpoint transparently.
func (s *Server) handleJenkinsDispatch(w http.ResponseWriter, r *http.Request) {
	if s.jenkins == nil {
		writeError(w, http.StatusServiceUnavailable, "JENKINS_DISABLED",
			"Jenkins dispatch is not configured on this server (set JENKINS_URL/USER/TOKEN).")
		return
	}
	var req jenkinsDispatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body")
		return
	}
	if strings.TrimSpace(req.YAML) == "" {
		writeError(w, http.StatusBadRequest, "EMPTY_YAML", "template YAML is empty")
		return
	}

	// Pick a worker. This is a short-lived call; use the request context.
	all, err := s.jenkins.listWorkers(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "JENKINS_UPSTREAM", err.Error())
		return
	}
	worker, err := pickWorker(all)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "NO_WORKERS", err.Error())
		return
	}

	// Trigger. Do this synchronously (the queue URL is what we need to hand
	// back before we can register the build).
	queueURL, err := s.jenkins.trigger(r.Context(), worker.Name, req.YAML)
	if err != nil {
		writeError(w, http.StatusBadGateway, "JENKINS_TRIGGER", err.Error())
		return
	}

	// Build the in-memory tracker entry. The background goroutine will attach
	// the buildNumber / buildURL as soon as Jenkins de-queues.
	id := uuid.NewString()
	jobURL := s.jenkins.jobURL(worker.Name)
	b := &build{
		ID:               id,
		status:           statusRunning,
		Command:          fmt.Sprintf("POST %sbuildWithParameters (TEMPLATE_YAML=<%d bytes>)", jobURL, len(req.YAML)),
		Template:         "template.yml",
		TemplatePathYAML: req.YAML,
		done:             make(chan struct{}),
		Jenkins: &jenkinsMeta{
			Worker:   worker.Name,
			JobURL:   jobURL,
			QueueURL: queueURL,
		},
	}
	s.tracker.add(b)

	// First log lines the operator sees. Give them the "who + where" up front.
	b.appendLog(fmt.Sprintf("[dispatcher] Picked worker: %s", worker.Name))
	b.appendLog(fmt.Sprintf("[dispatcher] Job URL:      %s", jobURL))
	b.appendLog(fmt.Sprintf("[dispatcher] Queue item:   %s", queueURL))
	b.appendLog(fmt.Sprintf("[dispatcher] TEMPLATE_YAML size: %d bytes", len(req.YAML)))

	go s.runJenkinsBuild(b)

	writeJSON(w, http.StatusAccepted, buildAccepted{
		BuildID: id,
		Status:  string(statusRunning),
		LogsURL: fmt.Sprintf("/api/v1/builds/%s/logs", id),
	})
}

// runJenkinsBuild resolves the queue item to a build, tails the log via
// progressiveText, and records terminal status + artifacts. Runs entirely in
// its own goroutine. Never panics.
func (s *Server) runJenkinsBuild(b *build) {
	log := logger.Logger()
	defer close(b.done)

	// Give the entire flow a generous timeout ceiling. ICT builds can be long
	// (2+ hours on some variants); the deadline here is a safety net against
	// a totally-wedged Jenkins call, not a real SLA.
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Hour)
	defer cancel()

	// 1) Wait for the build number.
	buildURL, buildNum, err := s.jenkins.waitForBuild(ctx, b.Jenkins.QueueURL, func(why string) {
		b.appendLog(fmt.Sprintf("[dispatcher] Waiting: %s", why))
	})
	if err != nil {
		msg := fmt.Sprintf("dispatch failed: %v", err)
		log.Warnf("build %s: %s", b.ID, msg)
		b.appendLog(msg)
		b.finish(statusFailed, nil, err.Error())
		return
	}
	b.mu.Lock()
	b.Jenkins.BuildURL = buildURL
	b.Jenkins.BuildNumber = buildNum
	b.mu.Unlock()
	b.appendLog(fmt.Sprintf("[dispatcher] Executing as build #%d — %s", buildNum, buildURL))

	// 2) Tail the log via progressiveText until the writer closes.
	var offset int64
	// A partial line that hasn't seen its trailing '\n' yet -- carried across
	// chunks so we never emit half a line.
	var partial strings.Builder
	// Poll on a tight cadence while running. Between polls, honour the context.
	poll := time.NewTicker(1 * time.Second)
	defer poll.Stop()
	// A single transient error (network blip, 502 from the reverse proxy)
	// shouldn't tear down a build that's still running on Jenkins. Allow a
	// handful of consecutive failures before giving up.
	const maxConsecutiveErrs = 5
	consecErrs := 0
	for {
		chunk, next, more, err := s.jenkins.fetchProgressiveText(ctx, buildURL, offset)
		if err != nil {
			consecErrs++
			log.Warnf("build %s: progressiveText error (%d/%d): %v", b.ID, consecErrs, maxConsecutiveErrs, err)
			if consecErrs >= maxConsecutiveErrs {
				b.appendLog(fmt.Sprintf("[dispatcher] log stream error: %v", err))
				b.finish(statusFailed, nil, err.Error())
				return
			}
			// Sleep before retrying so we don't hammer a flaky proxy.
			select {
			case <-ctx.Done():
				b.appendLog("[dispatcher] cancelled")
				b.finish(statusFailed, nil, ctx.Err().Error())
				return
			case <-poll.C:
			}
			continue
		}
		consecErrs = 0
		if len(chunk) > 0 {
			partial.Write(chunk)
			str := partial.String()
			nl := strings.LastIndexByte(str, '\n')
			if nl >= 0 {
				for _, line := range strings.Split(str[:nl], "\n") {
					b.appendLog(line)
				}
				remainder := str[nl+1:]
				partial.Reset()
				partial.WriteString(remainder)
			}
		}
		offset = next
		if !more {
			if partial.Len() > 0 {
				b.appendLog(partial.String())
				partial.Reset()
			}
			break
		}
		select {
		case <-ctx.Done():
			b.appendLog("[dispatcher] cancelled")
			b.finish(statusFailed, nil, ctx.Err().Error())
			return
		case <-poll.C:
		}
	}

	// 3) Fetch final build state.
	run, err := s.jenkins.getRun(ctx, buildURL)
	if err != nil {
		log.Warnf("build %s: run state fetch failed: %v", b.ID, err)
		b.appendLog(fmt.Sprintf("[dispatcher] could not read final build state: %v", err))
		b.finish(statusFailed, nil, err.Error())
		return
	}

	// 4) Fetch artifacts.
	jArts, err := s.jenkins.listArtifacts(ctx, buildURL)
	if err != nil {
		log.Warnf("build %s: artifact listing failed: %v", b.ID, err)
		b.appendLog(fmt.Sprintf("[dispatcher] artifact listing failed: %v", err))
	}
	arts := make([]artifact, 0, len(jArts))
	for _, a := range jArts {
		arts = append(arts, artifact{
			Name: a.FileName,
			Type: classifyArtifact(a.FileName),
			// Jenkins hosts the file directly. URL wins over Path in the UI.
			// relativePath is raw in the JSON payload — per-segment PathEscape
			// so filenames with spaces / '#' / '?' / '+' / unicode still work.
			URL: buildURL + "artifact/" + encodeRelativePath(a.RelativePath),
			// Path is the artifact's job-relative location (helpful info in
			// the details panel; not a filesystem path on this host).
			Path: a.RelativePath,
		})
	}

	// 5) Terminal state.
	switch run.Result {
	case "SUCCESS":
		b.appendLog(fmt.Sprintf("[dispatcher] Jenkins result: %s — %d artifact(s)", run.Result, len(arts)))
		b.finish(statusSuccess, arts, "")
	default:
		msg := fmt.Sprintf("Jenkins result: %s", run.Result)
		if run.Result == "" {
			msg = "Jenkins build ended with no result"
		}
		b.appendLog("[dispatcher] " + msg)
		// Include partial artifacts on failure too; some pipelines archive
		// intermediate outputs even when the top-level result is FAILURE.
		b.finish(statusFailed, arts, msg)
	}
}

