// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// handleBuildLogs streams a build's logs as Server-Sent Events. Replays the
// buffered history, then follows new lines PUSH-based via build.waitChan()
// (no polling), and finally emits a terminal `complete` or `error` event.
//
// A 15 s heartbeat (SSE comment line, ignored by EventSource) keeps
// intermediate reverse proxies from killing the connection during long
// Jenkins queue waits when no log lines are flowing.
func (s *Server) handleBuildLogs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	b, ok := s.tracker.get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "build not found")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "NO_STREAM", "streaming unsupported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// X-Accel-Buffering disables response buffering in nginx (harmless
	// elsewhere) so lines ship the instant we Flush() them.
	w.Header().Set("X-Accel-Buffering", "no")

	// Track the last phase + install counter we told the client, so the
	// `phase` event only fires on genuine transitions instead of after
	// every appended log line. Keeps chatter down without needing a
	// separate wake channel — detectPhase is O(n) over the log buffer,
	// which is fine for a build's few-thousand-line buffer.
	lastPhase := ""
	lastInstallDone := -1
	lastInstallTotal := -1
	emitPhase := func(lines []string) {
		ph := detectPhase(lines)
		done, total := installProgress(lines)
		if ph == lastPhase && done == lastInstallDone && total == lastInstallTotal {
			return
		}
		lastPhase, lastInstallDone, lastInstallTotal = ph, done, total
		sendEvent(w, "phase", map[string]any{
			"phase":         ph,
			"installDone":   done,
			"installTotal":  total,
		})
	}

	sent := 0
	emit := func() {
		lines := b.snapshotLogs()
		for ; sent < len(lines); sent++ {
			sendEvent(w, "log", map[string]string{"message": lines[sent]})
		}
		emitPhase(lines)
		flusher.Flush()
	}

	emit() // replay buffered history

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		wake := b.waitChan() // grabbed under mu; observes pre-append state
		select {
		case <-r.Context().Done():
			return
		case <-wake:
			// New line(s) appended. Drain and loop.
			emit()
		case <-heartbeat.C:
			// SSE comment lines start with ':' and are ignored by the
			// EventSource parser -- they only serve to keep the TCP
			// connection alive through idle-connection killers.
			_, _ = fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case <-b.done:
			emit() // drain remaining lines
			res := b.snapshot()
			switch res.status {
			case statusSuccess:
				arts := res.artifacts
				if arts == nil {
					arts = []artifact{}
				}
				// One authoritative "done" phase transition so the
				// stepper's last step lights up even if the log
				// substring markers didn't reach it (e.g. a template
				// whose upload path doesn't emit an "Uploading to
				// Artifactory" line).
				sendEvent(w, "phase", map[string]any{
					"phase":        "done",
					"installDone":  lastInstallDone,
					"installTotal": lastInstallTotal,
				})
				sendEvent(w, "complete", map[string]any{
					"status":    string(statusSuccess),
					"artifacts": arts,
				})
			case statusCancelled:
				// Distinct event so the browser can render cancellation
				// with its own visual (not the red 'failed' toast).
				sendEvent(w, "error", map[string]any{
					"status":  string(statusCancelled),
					"message": res.errMsg,
				})
			default:
				sendEvent(w, "error", map[string]any{
					"status":  string(statusFailed),
					"message": res.errMsg,
				})
			}
			flusher.Flush()
			return
		}
	}
}

// sendEvent writes one SSE event with a JSON data payload.
func sendEvent(w http.ResponseWriter, event string, data any) {
	payload, err := json.Marshal(data)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload)
}
