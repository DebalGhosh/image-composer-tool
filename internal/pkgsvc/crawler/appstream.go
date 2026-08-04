// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package crawler

import (
	"bytes"
	"errors"
	"fmt"
	"sort"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
	"gopkg.in/yaml.v3"
)

// ErrDep11PartialParse reports that some documents in a dep11 stream were skipped
// because they did not fit the component struct, while the rest parsed fine.
//
// It exists so "partly broken" is distinguishable from "unreadable". The overlay
// returned alongside it is USABLE and callers should apply it — a stream where one
// upstream document has a type error should still enrich the other ~50k components.
// Only a non-ErrDep11PartialParse error means the map is not worth applying.
var ErrDep11PartialParse = errors.New("appstream: dep11 stream partially parsed")

// AppStreamComponent is the subset of a dep11 YAML document we care about.
// Debian's dep11 stream is a stack of YAML documents (header + one per
// component); we decode one document at a time via yaml.Decoder.
//
// Field reference: https://www.freedesktop.org/software/appstream/docs/chap-DEP-11.html
//
// Only English (`C`) summaries and descriptions are extracted in v1;
// non-en locales are dropped. i18n is a v2 item.
type AppStreamComponent struct {
	Type   string `yaml:"Type"`
	ID     string `yaml:"ID"`
	Name   map[string]string `yaml:"Name"`
	Summary map[string]string `yaml:"Summary"`
	// Package is the binary package name that ships the .desktop /
	// firmware / etc. In v1 we key merges on this.
	Package string `yaml:"Package"`
	Keywords map[string][]string `yaml:"Keywords"`
	Categories []string `yaml:"Categories"`
	// Provides is a MAP of kind -> list; possible kinds include
	// `binaries`, `mimetypes`, `dbus`, `python2/3`, `library`, `firmware`,
	// `fonts`, and free-form `id`.
	Provides map[string][]any `yaml:"Provides"`
	// Screenshots is a list of {"default":true, "thumbnails":[...],
	// "source-image":{url,width,height}}. We flatten to a URL list.
	Screenshots []AppStreamScreenshot `yaml:"Screenshots"`
}

// AppStreamScreenshot models the shape we consume — thumbnails + source URLs.
type AppStreamScreenshot struct {
	Default     bool                `yaml:"default"`
	SourceImage AppStreamImage      `yaml:"source-image"`
	Thumbnails  []AppStreamImage    `yaml:"thumbnails"`
}

// AppStreamImage is a single {url, width, height} entry.
type AppStreamImage struct {
	URL    string `yaml:"url"`
	Width  int    `yaml:"width"`
	Height int    `yaml:"height"`
}

// ParseAppStreamDep11 decodes a decompressed dep11 YAML stream (multi-doc)
// and returns per-binary-package overlays keyed by package name. Each
// overlay is a subset of PackageRecord — the caller applies these on top of
// the Packages-derived records via ApplyAppStream.
//
// Behaviour:
//   - The first document in a dep11 stream is a header (`File: DEP-11`) which
//     lacks a Type. We skip any document without a valid Package field.
//   - Multiple components sharing a Package name are merged; keywords /
//     categories / provides slots are unioned.
//   - A document that does not fit the struct is SKIPPED, not fatal. dep11 comes
//     from a third-party mirror, so one upstream type error must not cost the
//     other ~50k components their enrichment. The returned error is non-nil only
//     when the stream itself is unreadable.
func ParseAppStreamDep11(body []byte) (map[string]schema.PackageRecord, error) {
	dec := yaml.NewDecoder(bytes.NewReader(body))
	out := make(map[string]schema.PackageRecord, 512)
	skipped := 0
	for {
		var c AppStreamComponent
		if err := dec.Decode(&c); err != nil {
			// io.EOF on trailing doc = normal termination.
			if err.Error() == "EOF" {
				break
			}
			// Header + trailing garbage docs sometimes yield decode
			// errors on strict YAML, so SKIP the bad document and keep
			// going. Returning here used to abandon every component
			// after the first malformed one — measured at 4 of 10 lost
			// on a stream with one bad document in the middle — and the
			// caller's `err == nil` gate then discarded even the
			// components that had parsed. One upstream typo cost a whole
			// suite its AppStream enrichment.
			//
			// A yaml.TypeError is a single document failing to fit the
			// struct: the decoder has consumed it and can continue. Any
			// other error means the stream itself is unreadable, so
			// there is nothing to continue to and we stop.
			var typeErr *yaml.TypeError
			if errors.As(err, &typeErr) {
				skipped++
				continue
			}
			return out, fmt.Errorf("dep11 decode: %w", err)
		}
		if c.Package == "" {
			continue
		}

		merged := out[c.Package]

		// Summary: prefer English "C" locale; fall back to the
		// lowest-named non-empty locale. Skip if already set (multiple
		// components for the same binary — first wins to keep results
		// stable).
		//
		// The fallback iterates SORTED locale keys, not the map directly.
		// Ranging a Go map is randomised, so a component with no "C" entry
		// and two translations used to index a different language on each
		// crawl of byte-identical input (measured: 359 German / 41 French
		// over 400 parses). That produced a summary that changed for no
		// reason and pure churn in the index. Which locale wins is
		// arbitrary either way; being arbitrary and STABLE is what matters.
		if merged.Summary == "" {
			if s, ok := c.Summary["C"]; ok && s != "" {
				merged.Summary = s
			} else {
				for _, s := range sortedValues(c.Summary) {
					if s != "" {
						merged.Summary = s
						break
					}
				}
			}
		}

		// Keywords: union across "C" + any other locale we see. We
		// index them together — losing locale annotation is fine for
		// search purposes at this scope.
		for _, kws := range c.Keywords {
			merged.Keywords = mergeUnique(merged.Keywords, kws)
		}

		// Categories: union.
		merged.Categories = mergeUnique(merged.Categories, c.Categories)

		// Provides: map -> Provides sub-object. dep11 uses these
		// kinds (from the spec): `binaries`, `mimetypes`, `dbus`,
		// `python2`, `python3`, `library`, `firmware`, `fonts`.
		if len(c.Provides) > 0 {
			for kind, vals := range c.Provides {
				strs := coerceStrings(vals)
				switch kind {
				case "binaries":
					merged.Provides.Binary = mergeUnique(merged.Provides.Binary, strs)
				case "mimetypes":
					merged.Provides.MimeType = mergeUnique(merged.Provides.MimeType, strs)
				case "dbus":
					merged.Provides.DBus = mergeUnique(merged.Provides.DBus, strs)
				case "python2", "python3":
					merged.Provides.Python = mergeUnique(merged.Provides.Python, strs)
				case "library":
					merged.Provides.Library = mergeUnique(merged.Provides.Library, strs)
				case "firmware":
					merged.Provides.Firmware = mergeUnique(merged.Provides.Firmware, strs)
				case "fonts":
					merged.Provides.Font = mergeUnique(merged.Provides.Font, strs)
				}
			}
		}

		// Screenshots: flatten to source URL list. Prefer default
		// screenshot's source-image URL when present; otherwise take
		// all source-image URLs. Thumbnails aren't cached in v1.
		for _, s := range c.Screenshots {
			if s.SourceImage.URL != "" {
				merged.Screenshots = appendUnique(merged.Screenshots, s.SourceImage.URL)
			}
		}

		out[c.Package] = merged
	}
	if skipped > 0 {
		// Non-fatal, but it must not be silent: a mirror publishing malformed dep11
		// would otherwise look identical to a clean crawl. The caller decides how
		// loudly to report it — the orchestrator logs a warning and, unlike before,
		// still applies the overlay it did get.
		return out, fmt.Errorf("%w: %d document(s) skipped, %d component(s) parsed",
			ErrDep11PartialParse, skipped, len(out))
	}
	return out, nil
}

// ApplyAppStream folds a dep11 overlay onto an already-parsed Packages
// record set. Merge policy:
//
//   - Summary: overlay wins if present (AppStream summaries are typically
//     more polished than the Packages headline).
//   - Description: never touched — the Packages long description is
//     authoritative for search recall; AppStream descriptions are richer
//     for display but we're keeping v1 lean.
//   - Keywords / Categories / Screenshots: unioned onto the target record.
//   - Provides.MimeType / DBus / Python / Library / Firmware / Font: unioned
//     onto the target's Provides sub-object. Provides.Binary is NOT touched
//     — it's authoritative from Depends/Provides in the Packages file, and
//     AppStream `binaries` may be a subset (only .desktop-launchable ones).
func ApplyAppStream(records []schema.PackageRecord, overlay map[string]schema.PackageRecord) {
	if len(overlay) == 0 {
		return
	}
	for i := range records {
		r := &records[i]
		add, ok := overlay[r.Name]
		if !ok {
			continue
		}
		if add.Summary != "" {
			r.Summary = add.Summary
		}
		r.Keywords = mergeUnique(r.Keywords, add.Keywords)
		r.Categories = mergeUnique(r.Categories, add.Categories)
		r.Screenshots = mergeUnique(r.Screenshots, add.Screenshots)
		r.Provides.MimeType = mergeUnique(r.Provides.MimeType, add.Provides.MimeType)
		r.Provides.DBus = mergeUnique(r.Provides.DBus, add.Provides.DBus)
		r.Provides.Python = mergeUnique(r.Provides.Python, add.Provides.Python)
		r.Provides.Library = mergeUnique(r.Provides.Library, add.Provides.Library)
		r.Provides.Firmware = mergeUnique(r.Provides.Firmware, add.Provides.Firmware)
		r.Provides.Font = mergeUnique(r.Provides.Font, add.Provides.Font)
	}
}

// mergeUnique returns a de-duplicated union of two string slices, preserving
// first-seen order. Empty strings are dropped.
// sortedValues returns m's values ordered by their keys, so a caller picking "the
// first non-empty one" gets the same answer on every run. Ranging a map directly is
// randomised by the runtime, which is how the summary fallback used to index a
// different locale on each crawl of identical input.
func sortedValues(m map[string]string) []string {
	if len(m) == 0 {
		return nil
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, m[k])
	}
	return out
}

func mergeUnique(a, b []string) []string {
	if len(b) == 0 {
		return a
	}
	seen := make(map[string]struct{}, len(a)+len(b))
	out := make([]string, 0, len(a)+len(b))
	for _, s := range a {
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	for _, s := range b {
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// appendUnique appends s to xs only if not already present.
func appendUnique(xs []string, s string) []string {
	if s == "" {
		return xs
	}
	for _, v := range xs {
		if v == s {
			return xs
		}
	}
	return append(xs, s)
}

// coerceStrings takes the YAML-decoded []any (dep11 Provides values can be
// heterogeneous — sometimes a string, sometimes a map with additional
// metadata) and reduces it to plain []string. Maps contribute their `id`
// or `service` field when present.
func coerceStrings(vs []any) []string {
	out := make([]string, 0, len(vs))
	for _, v := range vs {
		switch x := v.(type) {
		case string:
			out = append(out, x)
		case map[string]any:
			// dep11 uses {id: "org.foo.Bar"} for dbus,
			// {service: "..."} for systemd services, etc.
			for _, k := range []string{"id", "service", "name"} {
				if s, ok := x[k].(string); ok && s != "" {
					out = append(out, s)
					break
				}
			}
		}
	}
	return out
}
