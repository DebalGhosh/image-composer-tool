// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Binary ict-pkgsvc is the package-search microservice for the ICT web UI.
// It crawls upstream Debian/Ubuntu metadata (Packages.xz + dep11 AppStream +
// popcon), builds a fuzzy-searchable Bleve index, and serves it over HTTP.
// The main backend reverse-proxies /api/v1/packages here so the frontend
// stays on same-origin.
//
// Configuration is entirely via env vars — no config file. See
// /home/debalgho/.claude/plans/here-s-the-thing-if-gleaming-iverson.md for
// the full list.
//
// Subcommands:
//
//	ict-pkgsvc              — start the HTTP server (default when no args)
//	ict-pkgsvc healthcheck  — GET the local /health; exit 0 on 200
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/crawler"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/handler"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/index"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/seed"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/state"
)

func main() {
	// Route to the healthcheck subcommand when invoked as
	// `ict-pkgsvc healthcheck` (called by docker HEALTHCHECK).
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthcheck())
	}
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "ict-pkgsvc: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	cfg := loadConfig()
	log.Info("starting ict-pkgsvc",
		"listen", cfg.ListenAddr,
		"cacheDir", cfg.CacheDir,
		"indexDir", cfg.IndexDir,
		"refreshInterval", cfg.RefreshInterval.String(),
		"crawlerEnabled", cfg.CrawlerEnabled,
		"sources", cfg.Sources)

	// Bleve index — persisted on the mounted volume so a restart with an
	// unchanged corpus doesn't re-crawl.
	idx, err := index.NewIndex(filepath.Join(cfg.IndexDir, "main"))
	if err != nil {
		return fmt.Errorf("open index: %w", err)
	}
	defer func() {
		_ = idx.Close()
	}()

	if idx.WasRebuilt() {
		log.Warn("index mapping changed; previous index moved aside and rebuilt empty",
			"staleDir", idx.StaleDir())
	}

	// Seed corpus: only ingest embedded shards when the index is empty.
	// DocCount() now reads through to Bleve, so this guard reflects what is
	// actually on disk. A warm restart over a populated volume — 44 seed docs
	// or a full crawl — therefore does NOT re-run the seed. Before, DocCount()
	// read 0 after every reopen, so the seed was silently re-ingested on every
	// boot; that accident was the only thing repopulating the in-memory record
	// mirror, and it would have overwritten real crawled metadata with the thin
	// seed projection once the crawler was enabled (the seed's synthetic
	// release/component values produce the same DocIDs a real crawl does).
	if idx.DocCount() == 0 {
		if n, err := seed.LoadEmbedded(idx); err != nil {
			log.Warn("seed load failed", "err", err.Error())
		} else if n > 0 {
			log.Info("seed corpus loaded", "records", n)
		}
	} else {
		log.Info("index already populated; skipping seed", "docs", idx.DocCount())
	}

	// Crawler state file: /var/lib/pkgsvc/state.json.
	stateStore, err := state.Open(filepath.Join(cfg.CacheDir, "..", "state.json"))
	if err != nil {
		log.Warn("state.Open failed; starting fresh", "err", err.Error())
		stateStore, _ = state.Open("")
	}

	// A rebuilt index and a populated state.json are contradictory: the shard
	// hashes say "upstream unchanged since last crawl", but the index that
	// crawl produced is gone. The orchestrator skips any shard whose hash still
	// matches, so leaving them would strand an empty index. Drop them.
	if idx.WasRebuilt() {
		stateStore.Reset()
		if err := stateStore.Save(); err != nil {
			log.Warn("state reset save failed", "err", err.Error())
		} else {
			log.Info("crawler state reset after index rebuild")
		}
	}

	// Assemble sources from the PKGSVC_SOURCES env spec:
	// "ubuntu:noble:amd64,debian:trixie:amd64"
	fetcher := crawler.NewHTTPFetcher(nil, 90*time.Second)
	sources, err := buildSources(cfg)
	if err != nil {
		return err
	}

	orch := crawler.New(sources, fetcher, idx, stateStore, log,
		cfg.RefreshInterval, cfg.CrawlerEnabled)

	// HTTP server.
	srv := handler.NewServer(idx, cfg.AdminToken)
	srv.TriggerRefresh = orch.TriggerRefresh
	// Seed already populated (or a persisted index survived): mark ready
	// immediately. Cold-start-with-no-seed keeps ready=false until the
	// first crawler ingest lands.
	if idx.DocCount() > 0 {
		srv.SetReady(true)
	}

	// Wire routes + basic access-log middleware.
	root := withRequestLog(log, srv.Routes())
	httpSrv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           root,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Signal handling: SIGTERM/SIGINT → graceful shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// Orchestrator goroutine — runs even when the crawler is disabled so
	// /admin/refresh still works.
	go orch.Run(ctx)

	// After the first successful crawl (if any), flip ready.
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if idx.DocCount() > 0 {
					srv.SetReady(true)
					return
				}
			}
		}
	}()

	log.Info("listening", "addr", cfg.ListenAddr)
	errCh := make(chan error, 1)
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		log.Info("shutting down")
	case err := <-errCh:
		return fmt.Errorf("http server: %w", err)
	}
	shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return httpSrv.Shutdown(shutCtx)
}

// runHealthcheck implements the `ict-pkgsvc healthcheck` subcommand used
// by docker's HEALTHCHECK. GETs http://127.0.0.1:$PKGSVC_LISTEN_ADDR/health
// and exits 0 on a 200 response, 1 otherwise. Trimmed to localhost so the
// probe never accidentally hits the outbound network.
func runHealthcheck() int {
	addr := os.Getenv("PKGSVC_LISTEN_ADDR")
	if addr == "" {
		addr = ":9090"
	}
	// PKGSVC_LISTEN_ADDR may be ":9090" (unspecified host). Rewrite to
	// 127.0.0.1 for the probe.
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/health")
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "healthcheck: status %d\n", resp.StatusCode)
		return 1
	}
	return 0
}

// --- config ---

type config struct {
	ListenAddr      string
	CacheDir        string
	IndexDir        string
	RefreshInterval time.Duration
	Sources         string // raw PKGSVC_SOURCES value for logging
	UbuntuMirror    string
	DebianMirror    string
	CrawlerEnabled  bool
	AdminToken      string
}

func loadConfig() config {
	c := config{
		ListenAddr:     envOr("PKGSVC_LISTEN_ADDR", ":9090"),
		CacheDir:       envOr("PKGSVC_CACHE_DIR", "/var/lib/pkgsvc/cache"),
		IndexDir:       envOr("PKGSVC_INDEX_DIR", "/var/lib/pkgsvc/index"),
		Sources:        envOr("PKGSVC_SOURCES", "ubuntu:noble:amd64,debian:trixie:amd64"),
		UbuntuMirror:   envOr("PKGSVC_UBUNTU_MIRROR", "http://archive.ubuntu.com/ubuntu"),
		DebianMirror:   envOr("PKGSVC_DEBIAN_MIRROR", "http://deb.debian.org/debian"),
		CrawlerEnabled: envBool("PKGSVC_CRAWLER_ENABLED", false),
		AdminToken:     os.Getenv("PKGSVC_ADMIN_TOKEN"),
	}
	c.RefreshInterval = envDuration("PKGSVC_REFRESH_INTERVAL", 6*time.Hour)
	return c
}

// buildSources translates the PKGSVC_SOURCES env spec into []crawler.Source.
// Format: "os:release:arch,os:release:arch". The MirrorBase is derived from
// PKGSVC_{UBUNTU,DEBIAN}_MIRROR based on the family; unknown families are
// rejected with a build-time error rather than silently mis-crawling.
func buildSources(c config) ([]crawler.Source, error) {
	// Component list is fixed per family for v1 (main+universe for
	// Ubuntu, main for Debian). If we ever want repo-selective crawls
	// this becomes another env var.
	componentsFor := func(family string) []string {
		switch family {
		case "ubuntu":
			return []string{"main", "universe"}
		case "debian":
			return []string{"main"}
		}
		return nil
	}
	popconFor := func(family string) string {
		switch family {
		case "ubuntu":
			return "https://popcon.ubuntu.com/by_inst"
		case "debian":
			return "https://popcon.debian.org/by_inst.gz"
		}
		return ""
	}
	mirrorFor := func(family string) string {
		switch family {
		case "ubuntu":
			return c.UbuntuMirror
		case "debian":
			return c.DebianMirror
		}
		return ""
	}

	out := make([]crawler.Source, 0, 4)
	for _, tok := range strings.Split(c.Sources, ",") {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		parts := strings.Split(tok, ":")
		if len(parts) != 3 {
			return nil, fmt.Errorf("PKGSVC_SOURCES: expected os:release:arch, got %q", tok)
		}
		family := parts[0]
		mirror := mirrorFor(family)
		if mirror == "" {
			return nil, fmt.Errorf("PKGSVC_SOURCES: unknown family %q", family)
		}
		out = append(out, crawler.Source{
			OS:         family,
			Release:    parts[1],
			Arch:       parts[2],
			MirrorBase: mirror,
			Components: componentsFor(family),
			PopconURL:  popconFor(family),
		})
	}
	return out, nil
}

// envOr returns os.Getenv(key) or def when empty.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	if d, err := time.ParseDuration(v); err == nil {
		return d
	}
	// Accept plain integer seconds for compose files that get skittish
	// about unquoted "6h" in YAML.
	if n, err := strconv.Atoi(v); err == nil {
		return time.Duration(n) * time.Second
	}
	return def
}

// withRequestLog wraps h with a lightweight access log so ops can see
// what's hitting the service. Keeps latency + status in a single JSON line
// via the slog handler.
func withRequestLog(log *slog.Logger, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lrw := &loggingRW{ResponseWriter: w, code: http.StatusOK}
		h.ServeHTTP(lrw, r)
		log.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", lrw.code,
			"dur_ms", time.Since(start).Milliseconds(),
			"remote", clientAddr(r))
	})
}

type loggingRW struct {
	http.ResponseWriter
	code int
}

func (l *loggingRW) WriteHeader(code int) {
	l.code = code
	l.ResponseWriter.WriteHeader(code)
}

func clientAddr(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return xff
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
