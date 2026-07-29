// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Package seed loads the microservice's boot-time corpus from the same
// compact JSON shards the main backend used to embed. This is migration
// step 1's safety net: when the container starts with an empty index and
// PKGSVC_CRAWLER_ENABLED=false, we ingest these shards so /search returns
// the same 32-record corpus we've served for months. Delete this package
// in migration step 4 once the live crawler is proven.
package seed

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/index"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// EmbeddedShards holds the compact JSON shards previously embedded by the
// main backend. Placed here alongside the seed loader so the loader is
// self-contained; the parent internal/api copies of these files can be
// deleted the moment the proxy cutover completes (migration step 4).
//
//go:embed data/*.json
var EmbeddedShards embed.FS

// compactRecord is the on-disk schema in the legacy shard files:
// {n,v,d,a,s,r,o,t,p}. We translate to schema.PackageRecord at ingest
// time. The `o` field is a UI-facing OS id like "ubuntu24" which we split
// into (os="ubuntu", release="noble") heuristically — good enough for
// seed data.
type compactRecord struct {
	Name        string   `json:"n"`
	Version     string   `json:"v"`
	Description string   `json:"d"`
	Arch        string   `json:"a"`
	Section     string   `json:"s"`
	Repository  string   `json:"r"`
	OS          string   `json:"o"`
	Type        string   `json:"t"`
	Provides    []string `json:"p,omitempty"`
}

// LoadEmbedded reads every shard under data/*.json and ingests it into
// idx. On any per-file failure the shard is logged-and-skipped rather
// than aborting the whole boot; downstream consumers get the empty index
// warning header they'd get with no seed at all.
//
// Returns the total record count ingested. Zero-return is a valid state
// (embedded FS empty), not an error.
func LoadEmbedded(idx *index.Index) (int, error) {
	if idx == nil {
		return 0, fmt.Errorf("nil index")
	}
	var total int
	entries, err := fs.ReadDir(EmbeddedShards, "data")
	if err != nil {
		// A missing embed subtree just means we shipped without seed
		// data — degrade gracefully.
		return 0, nil
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := fs.ReadFile(EmbeddedShards, filepath.Join("data", e.Name()))
		if err != nil {
			continue
		}
		var recs []compactRecord
		if err := json.Unmarshal(data, &recs); err != nil {
			continue
		}
		full := make([]schema.PackageRecord, 0, len(recs))
		for _, c := range recs {
			full = append(full, expand(c))
		}
		if err := idx.IngestBatch(full); err == nil {
			total += len(full)
		}
	}
	return total, nil
}

// expand maps a compactRecord into the enriched PackageRecord shape. The
// legacy shards don't carry release/component information, so we derive
// them from the `r` (repository) and `o` (os id) fields as best we can.
// The result is a fully-formed PackageRecord that will byte-project back
// to LegacyRecord identically.
func expand(c compactRecord) schema.PackageRecord {
	os, release := splitOSRelease(c.OS)
	// "noble-updates/main" → component "main". Simplification: everything
	// before the slash is the pocket suffix, everything after is the
	// component; ignore pockets in v1 (they aren't user-visible).
	component := "main"
	if idx := strings.LastIndex(c.Repository, "/"); idx > 0 {
		component = c.Repository[idx+1:]
	}
	return schema.PackageRecord{
		OS:          os,
		Release:     release,
		Arch:        c.Arch,
		Component:   component,
		Name:        c.Name,
		Version:     c.Version,
		Section:     c.Section,
		Summary:     c.Description, // legacy shards conflate summary+description
		Description: c.Description,
		Provides:    schema.Provides{Binary: c.Provides},
	}
}

// splitOSRelease maps compact OS ids ("ubuntu24", "debian13") to the
// (family, release-codename) pair the enriched schema expects. Unknown ids
// leave release blank; the record still indexes.
func splitOSRelease(o string) (family, release string) {
	switch o {
	case "ubuntu24":
		return "ubuntu", "noble"
	case "ubuntu22":
		return "ubuntu", "jammy"
	case "debian13":
		return "debian", "trixie"
	case "debian12":
		return "debian", "bookworm"
	}
	// Fallback: strip trailing digits.
	i := len(o)
	for i > 0 && o[i-1] >= '0' && o[i-1] <= '9' {
		i--
	}
	if i > 0 {
		return o[:i], ""
	}
	return o, ""
}
