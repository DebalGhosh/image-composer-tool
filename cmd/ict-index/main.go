// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// ict-index crawls RPM + Debian package repositories and writes a compact JSON
// catalogue the web-ui backend serves from GET /api/v1/packages.
//
// It's a thin CLI wrapper around the same parsers `image-composer-tool build`
// uses -- internal/ospackage/debutils.ParseRepositoryMetadata and
// internal/ospackage/rpmutils.ParseRepositoryMetadata -- so the on-disk
// catalogue tracks exactly what a build would see.
//
// Usage:
//
//	ict-index --config <config.yaml> --out <output-dir>
//
// Config YAML shape:
//
//	shards:
//	  - os:   ubuntu24
//	    arch: amd64
//	    repositories:
//	      - name: noble-updates/main
//	        type: deb
//	        baseURL: http://archive.ubuntu.com/ubuntu
//	        release: dists/noble-updates/Release
//	        packages: dists/noble-updates/main/binary-amd64/Packages.gz
//	        gpgKey: https://.../ubuntu-archive-keyring.gpg
//	      - name: openvino/main
//	        type: deb
//	        baseURL: https://apt.repos.intel.com/openvino/2025
//	        release: dists/ubuntu24/Release
//	        packages: dists/ubuntu24/main/binary-amd64/Packages.gz
//	        gpgKey: https://apt.repos.intel.com/intel-gpg-keys/GPG-PUB-KEY-INTEL-SW-PRODUCTS.PUB
//	      - name: some-rpm-repo
//	        type: rpm
//	        baseURL: https://.../
//	        primary: repodata/primary.xml.gz
//
// Output layout (matches the /api/v1/packages handler's expectations):
//
//	<out>/index.yaml              — inventory (os, arch, filename, count, timestamp)
//	<out>/<os>-<arch>.json        — one compact JSON per shard
//
// v1 has no CI wiring; the source repos this crawls don't exist yet. Run by
// hand when the source repos are ready; commit the output back into the
// image-composer-tool repo under internal/api/data/packages/.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/open-edge-platform/image-composer-tool/internal/ospackage"
	"github.com/open-edge-platform/image-composer-tool/internal/ospackage/debutils"
	"github.com/open-edge-platform/image-composer-tool/internal/ospackage/rpmutils"
	"sigs.k8s.io/yaml"
)

// crawlConfig is the top-level `config.yaml` shape. Kept in this file (not
// shared with internal/api) because the crawler owns its own input contract
// -- the api package doesn't need to know about `type: deb` vs `type: rpm`.
type crawlConfig struct {
	Shards []crawlShard `json:"shards"`
}

type crawlShard struct {
	OS           string       `json:"os"`
	Arch         string       `json:"arch"`
	Repositories []repoSource `json:"repositories"`
}

type repoSource struct {
	Name     string `json:"name"`    // display name used as `repository` on the record
	Type     string `json:"type"`    // "deb" or "rpm"
	BaseURL  string `json:"baseURL"` // repo root
	Release  string `json:"release,omitempty"`  // deb: dists/.../Release path (relative to BaseURL)
	Packages string `json:"packages,omitempty"` // deb: dists/.../Packages.gz path
	Primary  string `json:"primary,omitempty"`  // rpm: repodata/primary.xml.gz path
	GPGKey   string `json:"gpgKey,omitempty"`   // deb: URL to the ASCII-armored public key
}

// packageRecord mirrors the on-disk compact shape the api handler consumes.
// See internal/api/handlers_packages.go for the reader side; keep the JSON
// tags in lockstep with that file.
type packageRecord struct {
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

// inventoryEntry is one line in the output `index.yaml` inventory.
type inventoryEntry struct {
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	File         string `json:"file"`
	PackageCount int    `json:"package_count"`
	GeneratedAt  string `json:"generated_at"`
}

type inventoryDoc struct {
	Shards []inventoryEntry `json:"shards"`
}

func main() {
	configPath := flag.String("config", "", "Path to the crawler config YAML")
	outDir := flag.String("out", "", "Output directory (index.yaml + <os>-<arch>.json shards)")
	flag.Parse()

	if *configPath == "" || *outDir == "" {
		fmt.Fprintln(os.Stderr, "usage: ict-index --config <config.yaml> --out <output-dir>")
		os.Exit(2)
	}

	if err := run(context.Background(), *configPath, *outDir); err != nil {
		fmt.Fprintf(os.Stderr, "ict-index: %v\n", err)
		os.Exit(1)
	}
}

func run(_ context.Context, configPath, outDir string) error {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("reading config %q: %w", configPath, err)
	}
	var cfg crawlConfig
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return fmt.Errorf("parsing config: %w", err)
	}
	if len(cfg.Shards) == 0 {
		return errors.New("config has no shards")
	}

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("mkdir %q: %w", outDir, err)
	}

	inv := inventoryDoc{}
	stamp := time.Now().UTC().Format(time.RFC3339)

	// Per-shard scratch dir for the debutils parser (it stages Release files
	// and cached Packages.gz there). Kept under the out dir so an operator
	// can inspect it after a crawl.
	buildRoot := filepath.Join(outDir, ".build")
	if err := os.MkdirAll(buildRoot, 0o755); err != nil {
		return fmt.Errorf("mkdir buildRoot: %w", err)
	}

	for _, shard := range cfg.Shards {
		records, err := crawlShardRepos(shard, buildRoot)
		if err != nil {
			return fmt.Errorf("shard %s-%s: %w", shard.OS, shard.Arch, err)
		}
		if len(records) == 0 {
			fmt.Fprintf(os.Stderr, "warning: shard %s-%s produced 0 packages\n", shard.OS, shard.Arch)
			continue
		}
		sort.Slice(records, func(i, j int) bool {
			return records[i].Name < records[j].Name
		})
		fileName := shard.OS + "-" + shard.Arch + ".json"
		if err := writeShard(filepath.Join(outDir, fileName), records); err != nil {
			return fmt.Errorf("write shard %s: %w", fileName, err)
		}
		inv.Shards = append(inv.Shards, inventoryEntry{
			OS:           shard.OS,
			Arch:         shard.Arch,
			File:         fileName,
			PackageCount: len(records),
			GeneratedAt:  stamp,
		})
		fmt.Fprintf(os.Stderr, "wrote %s (%d packages)\n", fileName, len(records))
	}

	invBytes, err := yaml.Marshal(inv)
	if err != nil {
		return fmt.Errorf("marshal inventory: %w", err)
	}
	if err := os.WriteFile(filepath.Join(outDir, "index.yaml"), invBytes, 0o644); err != nil {
		return fmt.Errorf("write inventory: %w", err)
	}
	return nil
}

// crawlShardRepos runs every repo in the shard through the appropriate parser,
// tags each package with (os, repo, type), dedupes by name (highest-priority
// repo wins on collision -- v1: first-encountered wins, priority-aware dedup
// deferred to when we actually have multi-repo overlap).
func crawlShardRepos(shard crawlShard, buildRoot string) ([]packageRecord, error) {
	seen := make(map[string]struct{})
	var out []packageRecord

	for _, repo := range shard.Repositories {
		var infos []ospackage.PackageInfo
		var err error
		switch repo.Type {
		case "deb":
			pkgs := repo.BaseURL + "/" + repo.Packages
			rel := repo.BaseURL + "/" + repo.Release
			sign := rel + ".gpg"
			perRepoBuild := filepath.Join(buildRoot, safeFileName(shard.OS+"-"+shard.Arch+"-"+repo.Name))
			infos, err = debutils.ParseRepositoryMetadata(
				repo.BaseURL, pkgs, rel, sign, repo.GPGKey, perRepoBuild, shard.Arch, nil,
			)
		case "rpm":
			infos, err = rpmutils.ParseRepositoryMetadata(repo.BaseURL, repo.Primary, nil)
		default:
			return nil, fmt.Errorf("repo %q has unknown type %q (want deb or rpm)", repo.Name, repo.Type)
		}
		if err != nil {
			return nil, fmt.Errorf("repo %q: %w", repo.Name, err)
		}
		for _, p := range infos {
			key := p.PkgName
			if key == "" {
				key = p.Name
			}
			if _, dupe := seen[key]; dupe {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, packageRecord{
				Name:        key,
				Version:     p.Version,
				Description: p.Description,
				Arch:        p.Arch,
				Section:     "", // not carried by PackageInfo; leave empty until v2
				Repository:  repo.Name,
				OS:          shard.OS,
				Type:        repo.Type,
				Provides:    p.Provides,
			})
		}
	}
	return out, nil
}

func writeShard(path string, records []packageRecord) error {
	// Use a tiny handwritten encoder so the file matches the existing seed
	// shard (one record per line, easier to review in diffs than a single
	// giant blob).
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.SetEscapeHTML(false)
	// Preserve compact schema; each line is one record for review-friendliness.
	if _, err := f.WriteString("[\n"); err != nil {
		return err
	}
	for i, rec := range records {
		if i > 0 {
			if _, err := f.WriteString(",\n"); err != nil {
				return err
			}
		}
		if _, err := f.WriteString("  "); err != nil {
			return err
		}
		if err := enc.Encode(rec); err != nil {
			return err
		}
		// enc.Encode appends '\n' -- we already handled record separators
		// ourselves, so trim by seeking one byte back. Cheap; we're the
		// only writer.
		_, _ = f.Seek(-1, 1)
	}
	if _, err := f.WriteString("\n]\n"); err != nil {
		return err
	}
	return nil
}

// safeFileName strips filesystem-hostile characters from a repo name so it
// can be used as a per-repo cache directory under `buildRoot`.
func safeFileName(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-' || r == '_' || r == '.':
			out = append(out, r)
		default:
			out = append(out, '_')
		}
	}
	return string(out)
}
