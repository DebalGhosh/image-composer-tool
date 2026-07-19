// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// buildDetails carries the reproducibility/troubleshooting metadata the UI shows
// in its collapsible "Build details" panel: the exact command, the resolved
// template, and either the per-build work/cache directories (local path) or the
// Jenkins-run metadata (dispatched path).
type buildDetails struct {
	BuildID     string          `json:"buildId"`
	Status      string          `json:"status"`
	Command     string          `json:"command"`
	Template    string          `json:"template"`
	TemplateURL string          `json:"templateUrl"`
	WorkDir     string          `json:"workDir,omitempty"`
	CacheDir    string          `json:"cacheDir,omitempty"`
	Summary     *composeSummary `json:"summary,omitempty"`
	Jenkins     *jenkinsDetails `json:"jenkins,omitempty"`
}

// jenkinsDetails is the Jenkins-run subset of buildDetails, populated only for
// dispatched builds. Empty (or absent) for locally-run ones.
type jenkinsDetails struct {
	Worker      string `json:"worker"`
	JobURL      string `json:"jobUrl"`
	BuildURL    string `json:"buildUrl"`
	BuildNumber int    `json:"buildNumber"`
	QueueURL    string `json:"queueUrl,omitempty"`
}

// handleBuildDetails returns the command and paths for a build so the UI can show
// exactly what ran and offer the template for download.
func (s *Server) handleBuildDetails(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	b, ok := s.tracker.get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "build not found")
		return
	}
	res := b.snapshot()
	details := buildDetails{
		BuildID:     id,
		Status:      string(res.status),
		Command:     b.Command,
		Template:    b.Template,
		TemplateURL: "/api/v1/builds/" + id + "/template",
		WorkDir:     b.WorkDir,
		CacheDir:    b.CacheDir,
		Summary:     b.Summary,
	}
	if b.Jenkins != nil {
		b.mu.Lock()
		details.Jenkins = &jenkinsDetails{
			Worker:      b.Jenkins.Worker,
			JobURL:      b.Jenkins.JobURL,
			BuildURL:    b.Jenkins.BuildURL,
			BuildNumber: b.Jenkins.BuildNumber,
			QueueURL:    b.Jenkins.QueueURL,
		}
		b.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, details)
}

// handleBuildTemplate serves the exact template file that was built, as a
// download, so the operator can inspect or reuse the resolved YAML.
//
// For local builds this reads the on-disk file at TemplatePath. For Jenkins
// dispatches the YAML lives only in memory (TemplatePathYAML) -- we serve that
// directly.
func (s *Server) handleBuildTemplate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	b, ok := s.tracker.get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "build not found")
		return
	}

	name := b.Template
	if name == "" {
		if b.TemplatePath != "" {
			name = filepath.Base(b.TemplatePath)
		} else {
			name = "template.yml"
		}
	}

	var data []byte
	switch {
	case b.TemplatePathYAML != "":
		data = []byte(b.TemplatePathYAML)
	case b.TemplatePath != "":
		var err error
		data, err = os.ReadFile(b.TemplatePath)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "TEMPLATE_READ", "cannot read template file")
			return
		}
	default:
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no template recorded for this build")
		return
	}

	w.Header().Set("Content-Type", "application/yaml")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
	_, _ = w.Write(data)
}

// handleBuildArtifactDownload serves a single build artifact by name as a
// download. The artifact must be in the build's recorded artifact list —
// arbitrary paths are not accepted.
//
// Artifact files are owned by root (ICT builds run under sudo). When --sudo is
// configured we stream via `sudo -n cat`; otherwise we read directly (dev env).
func (s *Server) handleBuildArtifactDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	name := r.PathValue("name")
	b, ok := s.tracker.get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "build not found")
		return
	}
	res := b.snapshot()
	var artifactPath string
	for _, a := range res.artifacts {
		if a.Name == name {
			artifactPath = a.Path
			break
		}
	}
	if artifactPath == "" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "artifact not found")
		return
	}

	// Guard against a poisoned artifact entry escaping the per-build workspace.
	// Artifact paths are populated from log parsing; validate they stay inside
	// the build's work directory before serving.
	if !strings.HasPrefix(filepath.Clean(artifactPath), filepath.Clean(b.WorkDir)) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "artifact path outside build workspace")
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(artifactPath)))
	w.Header().Set("Content-Type", "application/octet-stream")

	if s.cfg.Sudo {
		// Stream via `sudo cat` so large ISOs don't require buffering the whole
		// file in memory. StdoutPipe gives us a reader we can io.Copy directly
		// to the response writer, chunk by chunk. `--` prevents a path starting
		// with `-` from being interpreted as a flag by cat.
		cmd := exec.CommandContext(r.Context(), "sudo", "-n", "cat", "--", artifactPath)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			http.Error(w, "failed to open artifact stream", http.StatusInternalServerError)
			return
		}
		if err := cmd.Start(); err != nil {
			http.Error(w, "failed to read artifact", http.StatusInternalServerError)
			return
		}
		_, _ = io.Copy(w, stdout)
		_ = cmd.Wait()
		return
	}

	f, err := os.Open(artifactPath)
	if err != nil {
		http.Error(w, "cannot read artifact file", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	_, _ = io.Copy(w, f)
}
