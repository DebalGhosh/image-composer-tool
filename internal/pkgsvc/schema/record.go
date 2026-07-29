// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Package schema defines the on-wire and in-index record shapes for the
// ict-pkgsvc microservice. Two shapes are surfaced:
//
//   - PackageRecord: the full, enriched shape sourced from upstream Debian /
//     Ubuntu metadata plus DebTags + AppStream + popcon. This is what Bleve
//     indexes and what /search?fields=full returns.
//
//   - LegacyRecord: the 9-field projection that byte-matches the response the
//     main backend's /api/v1/packages used to serve directly. Every proxy
//     call defaults to this shape so the frontend needs zero changes in v1;
//     ProjectToLegacy performs the projection.
package schema

// PackageRecord is the enriched, indexed shape.
//
// Field-level notes:
//
//   - Keywords[] merges DebTags human tokens (the RHS of `use::browsing` etc.),
//     AppStream <keywords> entries, and the last segment of rpm:group when a
//     v2 RPM crawler lands.
//   - Categories[] merges AppStream <categories> and the freedesktop.org menu
//     spec top-level groups (Development, Network, Graphics, AudioVideo, …).
//   - Tags[] preserves the raw DebTags controlled vocabulary
//     (`use::browsing`, `works-with-format::html`, …) verbatim for
//     facet-filtering by full tag path.
//   - Provides is a sub-object rather than a flat list so the Bleve mapping
//     can boost "provides a binary named X" independently from "provides
//     dbus service Y". Empty sub-fields serialise as [] not null.
type PackageRecord struct {
	// Identity
	OS        string `json:"os"`        // "ubuntu", "debian", …
	Release   string `json:"release"`   // "noble", "trixie"
	Arch      string `json:"arch"`      // "amd64", "arm64"
	Component string `json:"component"` // "main", "universe", "multiverse"
	Name      string `json:"name"`
	Version   string `json:"version"`
	Source    string `json:"source,omitempty"` // source package (many binaries share one)

	// Human-facing metadata
	Section     string `json:"section,omitempty"` // "devel", "net", "libs", …
	Summary     string `json:"summary,omitempty"` // short one-line description
	Description string `json:"description,omitempty"`
	Homepage    string `json:"homepage,omitempty"`

	// Sizing / installability
	InstalledSize int64  `json:"installedSize,omitempty"` // KiB
	MultiArch     string `json:"multiArch,omitempty"`     // foreign/same/allowed

	// Search facets
	Tags       []string `json:"tags,omitempty"`       // DebTags: `use::browsing`
	Categories []string `json:"categories,omitempty"` // AppStream + freedesktop
	Keywords   []string `json:"keywords,omitempty"`   // AppStream <keywords> etc.
	Tasks      []string `json:"tasks,omitempty"`      // Ubuntu Task: seed lists

	// Provides (what this package satisfies for other packages / apps)
	Provides Provides `json:"provides"`

	// Media
	Screenshots []string `json:"screenshots,omitempty"` // URLs only, no bytes

	// Dependency graph
	Depends    []string `json:"depends,omitempty"`
	Recommends []string `json:"recommends,omitempty"`
	Suggests   []string `json:"suggests,omitempty"`

	// Ranking signal
	Popularity Popularity `json:"popularity"`

	// Provenance
	SourceURL string `json:"sourceUrl,omitempty"` // http://mirror/…/foo.deb
	LastSeen  string `json:"lastSeen,omitempty"`  // RFC3339 UTC
}

// Provides captures the varied "this package supplies X" facets Debian
// packaging exposes. Empty slices marshal as [] so callers can rely on
// JavaScript truthiness without null-checks.
type Provides struct {
	Binary   []string `json:"binary"`   // "gcc", "gcc-13"
	Library  []string `json:"library"`  // "libc.so.6", "libssl.so.3"
	MimeType []string `json:"mimetype"` // "application/pdf"
	DBus     []string `json:"dbus"`     // "org.freedesktop.NetworkManager"
	Python   []string `json:"python"`   // "python3.12", "python3-requests"
	Font     []string `json:"font,omitempty"`
	Firmware []string `json:"firmware,omitempty"`
}

// Popularity mirrors the popcon columns. Zero-values are meaningful — a
// package with popcon.inst==0 has never been installed via popcon-reporting
// systems and should sort BELOW any package with a real signal.
type Popularity struct {
	Inst   int `json:"inst"`   // installations reported
	Vote   int `json:"vote"`   // used-recently votes
	Old    int `json:"old"`    // installed but not recently used
	Recent int `json:"recent"` // upgraded within 30 days
}

// LegacyRecord is the byte-identical projection of PackageRecord that the
// main backend's original GET /api/v1/packages handler returned. Kept so the
// frontend (PackageSearchCombobox + MiniSearch) needs zero changes when the
// proxy cuts over.
//
// The nine fields are:
//
//	name, version, description, arch, section, repository, os, type, provides[]
//
// The old backend used `type: "deb"` for every Debian record and
// `repository` was populated from the shard's declared repo name. In the
// microservice, `type` is derived from OS family (ubuntu/debian → "deb",
// fedora/rhel → "rpm" in v2) and `repository` from `<os> <release>`.
type LegacyRecord struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Arch        string   `json:"arch"`
	Section     string   `json:"section"`
	Repository  string   `json:"repository"`
	OS          string   `json:"os"`
	Type        string   `json:"type"`
	Provides    []string `json:"provides"`
}

// ProjectToLegacy folds a PackageRecord into the historical 9-field shape.
// The flattened `provides` combines Binary + Library since that matches
// what the old handler served (it merged rpm:provides + deb Provides
// into a single flat list).
func ProjectToLegacy(r *PackageRecord) LegacyRecord {
	provides := make([]string, 0, len(r.Provides.Binary)+len(r.Provides.Library))
	provides = append(provides, r.Provides.Binary...)
	provides = append(provides, r.Provides.Library...)

	return LegacyRecord{
		Name:        r.Name,
		Version:     r.Version,
		Description: firstNonEmpty(r.Summary, r.Description),
		Arch:        r.Arch,
		Section:     r.Section,
		Repository:  r.OS + " " + r.Release,
		OS:          r.OS,
		Type:        typeForOS(r.OS),
		Provides:    provides,
	}
}

// typeForOS maps an OS family id to the "deb" / "rpm" tag the legacy
// response used. Unknown families fall back to "deb" so the response never
// contains an empty type field.
func typeForOS(os string) string {
	switch os {
	case "fedora", "rhel", "rocky", "alma", "centos", "opensuse":
		return "rpm"
	case "alpine":
		return "apk"
	default:
		return "deb"
	}
}

// firstNonEmpty returns the first non-empty argument, or "" if all empty.
// Used so LegacyRecord.Description prefers Summary (short, indexed) but
// falls back to the long Description when a repo doesn't set Summary.
func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}
