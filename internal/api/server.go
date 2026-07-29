// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Package api implements the HTTP backend for the ICT web UI. It serves a
// configuration manifest, resolves pre-authored templates, and fans image
// builds out to a Jenkins worker fleet — see
// docs/architecture-decision-record/adr-web-ui-tech-stack.md.
package api

import (
	"net/http"
	"time"

	"github.com/open-edge-platform/image-composer-tool/internal/utils/logger"
)

// Config holds the server's runtime configuration.
type Config struct {
	Addr         string // listen address, e.g. ":8080"
	TemplatesDir string // directory containing pre-authored templates
	ManifestPath string // optional manifest file; empty uses the embedded copy

	// Jenkins dispatch. When all three of JenkinsURL/JenkinsUser/JenkinsToken
	// are set, the /api/v1/jenkins/dispatch endpoint fans builds out to the
	// worker fleet under JenkinsWorkersPath. When unset, the endpoint returns
	// 503 and no builds can be triggered — this backend has no local-build
	// fallback.
	JenkinsURL         string // e.g. https://cje-pg-prod01.devtools.intel.com/nex-cisv-devops02
	JenkinsUser        string
	JenkinsToken       string
	JenkinsWorkersPath string // folder path, e.g. "ict-farm/workers"

	// PackagesDir overrides the embedded package-search index. Empty uses the
	// index bundled at build time via //go:embed. Set to a live directory
	// (e.g. one just written by `cmd/ict-index`) to refresh without a rebuild.
	PackagesDir string
}

// Server holds the API's dependencies and shared state.
type Server struct {
	cfg      Config
	manifest *Manifest
	tracker  *buildTracker
	jenkins  *jenkinsClient // nil when Jenkins env vars aren't set
	packages *packageIndex  // package-search catalogue; nil-safe when empty
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
	return &Server{
		cfg:      cfg,
		manifest: m,
		tracker:  newBuildTracker(),
		jenkins:  newJenkinsClient(cfg),
		packages: loadPackageIndex(cfg.PackagesDir),
	}, nil
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
