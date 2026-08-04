// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package crawler

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/index"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/state"
)

// Source is one (os, release, arch) target the orchestrator should refresh.
// MirrorBase is the URL prefix used for `dists/<release>/…`.
type Source struct {
	OS         string   // "ubuntu", "debian"
	Release    string   // "noble", "trixie"
	Arch       string   // "amd64"
	MirrorBase string   // "http://archive.ubuntu.com/ubuntu"
	Components []string // ["main", "universe"]
	// PopconURL, when non-empty, is fetched and merged into every
	// record's Popularity. Ubuntu: "https://popcon.ubuntu.com/by_inst";
	// Debian: "https://popcon.debian.org/by_inst.gz". We honour the
	// extension for gzip detection.
	PopconURL string
}

// Orchestrator drives the refresh loop: on start + periodic ticker +
// manual /admin/refresh. Runs each Source concurrently, writes its own
// batch into the Bleve index under Index's own atomic-swap semantics, and
// never blocks the search path.
type Orchestrator struct {
	sources []Source
	fetcher Fetcher
	idx     *index.Index
	store   *state.Store
	log     *slog.Logger

	interval      time.Duration
	enabled       bool

	// stopCh closes when Run's context ends; forceCh gets a payload from
	// TriggerRefresh() so /admin/refresh works.
	forceCh chan refreshRequest

	// mu guards nothing about the index (Index has its own RWMutex);
	// it protects the "is a refresh in flight" boolean so a manual
	// trigger during a scheduled refresh coalesces rather than
	// double-fires.
	mu       sync.Mutex
	inflight bool
}

type refreshRequest struct {
	os       string
	release  string
	arch     string
	// done, when non-nil, receives a nil-or-error once the refresh
	// completes. Empty channel means "fire-and-forget".
	done chan error
}

// New builds an Orchestrator. `enabled=false` disables periodic crawling
// entirely — Run() still processes /admin/refresh triggers, and the index
// stays whatever seed corpus was ingested at boot. That's migration step 1
// behaviour: ship the microservice, keep the crawler flag off, prove the
// proxy path.
func New(
	sources []Source,
	fetcher Fetcher,
	idx *index.Index,
	store *state.Store,
	log *slog.Logger,
	interval time.Duration,
	enabled bool,
) *Orchestrator {
	if log == nil {
		log = slog.Default()
	}
	if interval <= 0 {
		interval = 6 * time.Hour
	}
	return &Orchestrator{
		sources:  sources,
		fetcher:  fetcher,
		idx:      idx,
		store:    store,
		log:      log,
		interval: interval,
		enabled:  enabled,
		forceCh:  make(chan refreshRequest, 4),
	}
}

// Run is the crawler loop. It:
//
//  1. Fires an initial refresh on start (if enabled).
//  2. Ticks every `interval` with ±10% jitter, refreshing each source
//     in its own goroutine (Bleve is safe for concurrent writes).
//  3. Consumes /admin/refresh triggers from forceCh regardless of
//     `enabled` — manual refreshes bypass the flag so an operator can
//     seed a first index without turning the whole crawler on.
//
// Returns when ctx is Done. The Bleve index is NOT closed here; the
// caller owns its lifecycle so /health can still serve during graceful
// shutdown.
func (o *Orchestrator) Run(ctx context.Context) {
	if o.enabled {
		o.refreshAll(ctx, "")
	}
	if o.interval <= 0 {
		<-ctx.Done()
		return
	}

	timer := time.NewTimer(jitter(o.interval))
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case req := <-o.forceCh:
			err := o.refreshFiltered(ctx, req.os, req.release, req.arch)
			if req.done != nil {
				req.done <- err
			}
		case <-timer.C:
			if o.enabled {
				o.refreshAll(ctx, "")
			}
			timer.Reset(jitter(o.interval))
		}
	}
}

// TriggerRefresh queues a manual refresh request. os/release/arch are
// optional filters — empty means "all matching". Returns a channel the
// caller can wait on for completion (nil on success or an error).
//
// If the queue is full (>4 in flight) it drops the request and returns an
// error immediately, on the theory that "we're already extremely busy"
// signals a real problem the operator should notice.
func (o *Orchestrator) TriggerRefresh(os, release, arch string) <-chan error {
	done := make(chan error, 1)
	select {
	case o.forceCh <- refreshRequest{os: os, release: release, arch: arch, done: done}:
	default:
		done <- fmt.Errorf("refresh queue full; try again")
	}
	return done
}

// refreshAll fans every configured source into refreshOne concurrently.
// osFilter (optional) narrows to just those matching os.
func (o *Orchestrator) refreshAll(ctx context.Context, osFilter string) {
	o.mu.Lock()
	if o.inflight {
		o.mu.Unlock()
		o.log.Info("refresh skipped: already in-flight")
		return
	}
	o.inflight = true
	o.mu.Unlock()
	defer func() {
		o.mu.Lock()
		o.inflight = false
		o.mu.Unlock()
	}()

	var wg sync.WaitGroup
	for _, src := range o.sources {
		if osFilter != "" && src.OS != osFilter {
			continue
		}
		src := src
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := o.refreshOne(ctx, src); err != nil {
				o.log.Error("refresh_failed",
					"os", src.OS, "release", src.Release, "arch", src.Arch,
					"err", err.Error())
			}
		}()
	}
	wg.Wait()
	if err := o.store.Save(); err != nil {
		o.log.Warn("state save failed", "err", err.Error())
	}
}

// refreshFiltered is called from /admin/refresh — filters by any of
// (os, release, arch) that are non-empty, then delegates to refreshAll's
// per-source loop.
func (o *Orchestrator) refreshFiltered(ctx context.Context, os, release, arch string) error {
	if os == "" && release == "" && arch == "" {
		o.refreshAll(ctx, "")
		return nil
	}
	// Filter and dispatch.
	matched := 0
	var wg sync.WaitGroup
	var firstErr error
	var errMu sync.Mutex
	for _, src := range o.sources {
		if os != "" && src.OS != os {
			continue
		}
		if release != "" && src.Release != release {
			continue
		}
		if arch != "" && src.Arch != arch {
			continue
		}
		matched++
		src := src
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := o.refreshOne(ctx, src); err != nil {
				o.log.Error("refresh_failed",
					"os", src.OS, "release", src.Release, "arch", src.Arch,
					"err", err.Error())
				errMu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				errMu.Unlock()
			}
		}()
	}
	wg.Wait()
	if matched == 0 {
		return fmt.Errorf("no sources matched (os=%q release=%q arch=%q)", os, release, arch)
	}
	if err := o.store.Save(); err != nil {
		o.log.Warn("state save failed", "err", err.Error())
	}
	return firstErr
}

// refreshOne performs the full pipeline for one source:
//
//  1. Fetch dists/<release>/InRelease.
//  2. For each component, verify Packages.xz hasn't drifted (compare to
//     state.json). Skip everything untouched.
//  3. Fetch changed Packages.xz + dep11 + popcon. Parse. Merge overlays.
//  4. Ingest the merged record batch into Bleve (which handles the atomic
//     doc-update per record).
//  5. Update state.json entries.
//
// A failure at any step logs and returns; the previously-ingested state
// stays intact.
func (o *Orchestrator) refreshOne(ctx context.Context, src Source) error {
	inReleaseURL := fmt.Sprintf("%s/dists/%s/InRelease",
		trimSlash(src.MirrorBase), src.Release)

	body, err := o.fetcher.Fetch(ctx, inReleaseURL, "")
	if err != nil {
		return fmt.Errorf("fetch InRelease: %w", err)
	}
	ir, err := ParseInRelease(body)
	if err != nil {
		return fmt.Errorf("parse InRelease: %w", err)
	}

	// Optional popcon — fetched once per source and applied to every
	// component's batch. Failure here isn't fatal.
	var popcon map[string]schema.Popularity
	if src.PopconURL != "" {
		if pb, err := o.fetcher.Fetch(ctx, src.PopconURL, ""); err == nil {
			popcon = ParsePopcon(pb)
		} else {
			o.log.Warn("popcon fetch failed", "url", src.PopconURL, "err", err.Error())
		}
	}

	for _, comp := range src.Components {
		key := state.ShardKey(src.OS, src.Release, src.Arch, comp)
		relPath := fmt.Sprintf("%s/binary-%s/Packages.xz", comp, src.Arch)
		hash := ir.SHA256[relPath]
		if hash == "" {
			o.log.Warn("no SHA256 in InRelease", "path", relPath)
			continue
		}

		// Skip if we've already ingested this exact hash.
		prev, hadPrev := o.store.Get(key)
		if hadPrev && prev.PackagesSHA256 == hash {
			o.log.Info("skip: hash unchanged",
				"os", src.OS, "release", src.Release, "arch", src.Arch, "component", comp)
			continue
		}

		pkgURL := fmt.Sprintf("%s/dists/%s/%s",
			trimSlash(src.MirrorBase), src.Release, relPath)
		pbody, err := o.fetcher.Fetch(ctx, pkgURL, hash)
		if err != nil {
			o.log.Error("fetch Packages",
				"url", pkgURL, "err", err.Error())
			continue
		}
		records, err := ParseDebPackages(pbody, src.OS, src.Release, src.Arch, comp, src.MirrorBase)
		if err != nil {
			o.log.Error("parse Packages", "url", pkgURL, "err", err.Error())
			continue
		}

		// AppStream overlay for this component (best-effort).
		asRel := fmt.Sprintf("%s/dep11/Components-%s-%s.yml.gz",
			comp, src.Release, src.Arch)
		if asHash := ir.SHA256[asRel]; asHash != "" {
			asURL := fmt.Sprintf("%s/dists/%s/%s",
				trimSlash(src.MirrorBase), src.Release, asRel)
			if asBody, err := o.fetcher.Fetch(ctx, asURL, asHash); err == nil {
				overlay, err := ParseAppStreamDep11(asBody)
				// A PARTIAL parse still yields a usable overlay, so apply it and warn.
				// The old `err == nil` gate threw the whole map away on any error, which
				// meant one malformed upstream document cost this component every
				// summary, category and screenshot it had.
				if err != nil {
					o.log.Warn("appstream parse", "url", asURL, "err", err.Error())
				}
				if err == nil || errors.Is(err, ErrDep11PartialParse) {
					ApplyAppStream(records, overlay)
				}
			} else {
				o.log.Warn("appstream fetch",
					"url", asURL, "err", err.Error())
			}
		}

		if popcon != nil {
			ApplyPopcon(records, popcon)
		}

		now := time.Now().UTC()
		for i := range records {
			records[i].LastSeen = now.Format(time.RFC3339)
		}

		if err := o.idx.IngestBatch(records); err != nil {
			o.log.Error("bleve ingest",
				"os", src.OS, "release", src.Release, "arch", src.Arch, "component", comp,
				"err", err.Error())
			continue
		}
		o.store.Put(key, state.Shard{
			LastRefreshUTC: now,
			PackagesSHA256: hash,
			Docs:           len(records),
		})
		o.log.Info("refreshed",
			"os", src.OS, "release", src.Release, "arch", src.Arch,
			"component", comp, "records", len(records))
	}
	return nil
}

// jitter returns d ± 10%. Prevents multiple instances (or a full-fleet
// restart) from all hitting mirrors at the same second.
func jitter(d time.Duration) time.Duration {
	// crypto/rand for tests that stub the clock — no PRNG dep to seed.
	var b [8]byte
	_, _ = rand.Read(b[:])
	n := binary.BigEndian.Uint64(b[:])
	// Map to [-0.1, +0.1] fraction of d.
	fraction := float64(n%1000)/5000.0 - 0.1
	return d + time.Duration(float64(d)*fraction)
}

func trimSlash(s string) string {
	if len(s) > 0 && s[len(s)-1] == '/' {
		return s[:len(s)-1]
	}
	return s
}

// IndexDirFor returns a canonical path for a source's Bleve dir under root.
// Not used by the orchestrator (index has its own dir), but exported so
// tests can compute the path without duplicating the recipe.
func IndexDirFor(root string, s Source) string {
	return filepath.Join(root, fmt.Sprintf("%s-%s-%s", s.OS, s.Release, s.Arch))
}
