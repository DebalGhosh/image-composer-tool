// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Package api implements the HTTP backend for the ICT web UI. It serves a
// configuration manifest, resolves pre-authored templates, and triggers image
// builds via the ICT binary — see docs/architecture-decision-record/adr-web-ui-tech-stack.md.
package api

import (
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/open-edge-platform/image-composer-tool/internal/utils/logger"
)

// Config holds the server's runtime configuration.
type Config struct {
	Addr         string // listen address, e.g. ":8080"
	TemplatesDir string // directory containing pre-authored templates
	ICTBinary    string // path to the image-composer-tool binary for builds
	WorkDir      string // base directory for per-build work/output directories
	Sudo         bool   // run builds under `sudo -n` (ICT needs root for chroot)
	ManifestPath string // optional manifest file; empty uses the embedded copy

	// Jenkins dispatch. When all three of JenkinsURL/JenkinsUser/JenkinsToken
	// are set, the /api/v1/jenkins/dispatch endpoint fans builds out to the
	// worker fleet under JenkinsWorkersPath instead of executing them locally.
	JenkinsURL         string // e.g. https://cje-pg-prod01.devtools.intel.com/nex-cisv-devops02
	JenkinsUser        string
	JenkinsToken       string
	JenkinsWorkersPath string // folder path, e.g. "ict-farm/workers"
}

// Server holds the API's dependencies and shared state.
type Server struct {
	cfg      Config
	manifest *Manifest
	tracker  *buildTracker
	jenkins  *jenkinsClient // nil when Jenkins env vars aren't set
}

// New constructs a Server, loading and validating the embedded manifest.
func New(cfg Config) (*Server, error) {
	m, err := loadManifest(cfg.ManifestPath)
	if err != nil {
		return nil, err
	}
	if cfg.TemplatesDir == "" {
		cfg.TemplatesDir = "image-templates"
	}
	if cfg.ICTBinary == "" {
		cfg.ICTBinary = discoverICTBinary()
	}
	if cfg.WorkDir == "" {
		cfg.WorkDir = "webui-workspace"
	}
	return &Server{
		cfg:      cfg,
		manifest: m,
		tracker:  newBuildTracker(),
		jenkins:  newJenkinsClient(cfg),
	}, nil
}

// discoverICTBinary picks the image-composer-tool binary to invoke when the
// operator doesn't pass --ict-binary. We don't know whether they built with
// `earthly +build` (outputs ./build/) or a plain `go build` (often the repo
// root), so probe both, preferring ./build/, then fall back to a PATH lookup.
func discoverICTBinary() string {
	candidates := []string{"./build/image-composer-tool", "./image-composer-tool"}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return c
		}
	}
	if p, err := exec.LookPath("image-composer-tool"); err == nil {
		return p
	}
	// Nothing found; return the conventional path so the eventual build failure
	// names a sensible location.
	return "./build/image-composer-tool"
}

// Start registers routes and blocks serving HTTP.
func (s *Server) Start() error {
	log := logger.Logger()
	mux := s.routes()
	handler := withMiddleware(mux)

	srv := &http.Server{
		Addr:              s.cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Infof("ICT web UI API listening on %s", s.cfg.Addr)
	return srv.ListenAndServe()
}
