// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"net"
	"os"

	"github.com/open-edge-platform/image-composer-tool/internal/api"
	"github.com/spf13/cobra"
)

var (
	serveHost      string
	servePort      string
	serveTemplates string
	serveBinary    string
	serveWorkDir   string
	serveSudo      bool
	serveManifest  string

	// Jenkins dispatch. When JENKINS_URL/USER/TOKEN are set (either via env
	// vars or --jenkins-* flags), the /api/v1/jenkins/dispatch endpoint fans
	// the UI's Build button out to a randomly-picked idle worker in the
	// configured folder. When unset, the Jenkins endpoints return 503 and the
	// server behaves like the upstream (local-build) build.
	serveJenkinsURL     string
	serveJenkinsUser    string
	serveJenkinsToken   string
	serveJenkinsWorkers string

	// Package-search index override. Empty uses the copy embedded at build
	// time; setting this to a directory (e.g. output of `cmd/ict-index`)
	// swaps the catalogue at startup without a rebuild.
	servePackagesDir string
)

// createServeCommand creates the `serve` subcommand that runs the web UI API.
func createServeCommand() *cobra.Command {
	serveCmd := &cobra.Command{
		Use:   "serve [flags]",
		Short: "Run the web UI backend API server",
		Long: `Start the HTTP API that backs the ICT web UI.

Serves the configuration manifest, resolves pre-authored templates, and triggers
image builds via the image-composer-tool binary with streaming build logs.`,
		RunE: executeServe,
	}

	serveCmd.Flags().StringVar(&serveHost, "host", "127.0.0.1",
		"Address to bind. Defaults to localhost only; set 0.0.0.0 to expose on all "+
			"interfaces (not recommended — this API can trigger privileged builds).")
	serveCmd.Flags().StringVarP(&servePort, "port", "p", "8080", "Port to listen on")
	serveCmd.Flags().StringVar(&serveTemplates, "templates-dir", "image-templates", "Directory of pre-authored templates")
	serveCmd.Flags().StringVar(&serveBinary, "ict-binary", "",
		"Path to the image-composer-tool binary used for builds. "+
			"If empty, auto-detects ./build/image-composer-tool, then ./image-composer-tool, then $PATH.")
	serveCmd.Flags().StringVar(&serveWorkDir, "work-dir", "webui-workspace", "Base directory for per-build work/output directories")
	serveCmd.Flags().BoolVar(&serveSudo, "sudo", false,
		"Run builds under `sudo -n` (ICT requires root for chroot/mount). "+
			"Grant a scoped, passwordless sudoers rule for the ICT binary only, "+
			"e.g. `<svc-user> ALL=(root) NOPASSWD: /path/to/image-composer-tool build *` "+
			"— do not give the service blanket sudo.")
	serveCmd.Flags().StringVar(&serveManifest, "manifest", "",
		"Path to a manifest YAML to read from disk (live-editable, no rebuild). "+
			"When empty, the manifest embedded at build time is used.")

	// Jenkins dispatch flags. Each defaults to the matching env var so operators
	// can plug credentials in via `JENKINS_TOKEN=... ict serve` without exposing
	// them on the command line (visible in ps output). Empty URL/USER/TOKEN
	// disables the dispatch endpoint entirely (returns 503 on POST).
	serveCmd.Flags().StringVar(&serveJenkinsURL, "jenkins-url", os.Getenv("JENKINS_URL"),
		"Jenkins controller URL, e.g. https://cje-pg-prod01.devtools.intel.com/nex-cisv-devops02 (env: JENKINS_URL)")
	serveCmd.Flags().StringVar(&serveJenkinsUser, "jenkins-user", os.Getenv("JENKINS_USER"),
		"Jenkins user for API token auth (env: JENKINS_USER)")
	serveCmd.Flags().StringVar(&serveJenkinsToken, "jenkins-token", os.Getenv("JENKINS_TOKEN"),
		"Jenkins API token (env: JENKINS_TOKEN). Prefer the env var; the flag is visible in ps.")
	serveCmd.Flags().StringVar(&serveJenkinsWorkers, "jenkins-workers-path", envOrDefault("JENKINS_WORKERS_PATH", "ict-farm/workers"),
		"Folder path under which the worker-* jobs live (env: JENKINS_WORKERS_PATH)")

	serveCmd.Flags().StringVar(&servePackagesDir, "packages-dir", "",
		"Directory of package-search index shards (from `cmd/ict-index`). "+
			"When empty, the shards embedded at build time under "+
			"internal/api/data/packages/ are used.")

	return serveCmd
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func executeServe(cmd *cobra.Command, args []string) error {
	srv, err := api.New(api.Config{
		// net.JoinHostPort brackets IPv6 hosts correctly (e.g. [::1]:8080).
		Addr:               net.JoinHostPort(serveHost, servePort),
		TemplatesDir:       serveTemplates,
		ICTBinary:          serveBinary,
		WorkDir:            serveWorkDir,
		Sudo:               serveSudo,
		ManifestPath:       serveManifest,
		JenkinsURL:         serveJenkinsURL,
		JenkinsUser:        serveJenkinsUser,
		JenkinsToken:       serveJenkinsToken,
		JenkinsWorkersPath: serveJenkinsWorkers,
		PackagesDir:        servePackagesDir,
	})
	if err != nil {
		return err
	}
	return srv.Start()
}
