// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"net/http"
	"path/filepath"
)

// buildDetails carries the reproducibility/troubleshooting metadata the UI shows
// in its collapsible "Build details" panel: the exact command, the resolved
// template, and the Jenkins-run metadata.
type buildDetails struct {
	BuildID     string          `json:"buildId"`
	Status      string          `json:"status"`
	Command     string          `json:"command"`
	Template    string          `json:"template"`
	TemplateURL string          `json:"templateUrl"`
	Summary     *composeSummary `json:"summary,omitempty"`
	Jenkins     *jenkinsDetails `json:"jenkins,omitempty"`
}

// jenkinsDetails is the Jenkins-run subset of buildDetails.
type jenkinsDetails struct {
	Worker         string `json:"worker"`
	JobURL         string `json:"jobUrl"`
	BuildURL       string `json:"buildUrl"`
	BuildNumber    int    `json:"buildNumber"`
	QueueURL       string `json:"queueUrl,omitempty"`
	ArtifactoryURL string `json:"artifactoryUrl,omitempty"` // set after PUBLISH stage echoes it
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
		Summary:     b.Summary,
	}
	if b.Jenkins != nil {
		b.mu.Lock()
		details.Jenkins = &jenkinsDetails{
			Worker:         b.Jenkins.Worker,
			JobURL:         b.Jenkins.JobURL,
			BuildURL:       b.Jenkins.BuildURL,
			BuildNumber:    b.Jenkins.BuildNumber,
			QueueURL:       b.Jenkins.QueueURL,
			ArtifactoryURL: b.Jenkins.ArtifactoryURL,
		}
		b.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, details)
}

// handleBuildTemplate serves the exact template YAML that was dispatched, so
// the operator can inspect or reuse it. The YAML lives in memory on the build
// record (TemplatePathYAML) since dispatches never touch the local disk.
func (s *Server) handleBuildTemplate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	b, ok := s.tracker.get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "build not found")
		return
	}

	if b.TemplatePathYAML == "" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no template recorded for this build")
		return
	}

	name := b.Template
	if name == "" {
		name = "template.yml"
	}
	name = filepath.Base(name)

	w.Header().Set("Content-Type", "application/yaml")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
	_, _ = w.Write([]byte(b.TemplatePathYAML))
}
