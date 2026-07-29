// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package crawler

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// ParseDebPackages reads a Debian-style `Packages` stanza file (already
// decompressed) and emits one PackageRecord per stanza. The parser is
// modelled after internal/ospackage/debutils/resolver.go:ParseRepositoryMetadata
// but retains the fields that parser drops — Tag, Section, Homepage,
// Recommends, Suggests, Enhances, Multi-Arch, Installed-Size, Source, Task,
// Description-md5 — plus consolidates multi-line Description bodies (RFC 822
// continuation lines starting with a space).
//
// The `os`, `release`, `arch`, and `component` args stamp identity onto
// every record; the parser doesn't infer them (a single Packages file only
// covers one component × arch).
//
// The optional `mirrorBase` is prepended to the `Filename:` field to build
// the SourceURL (e.g. mirrorBase="http://archive.ubuntu.com/ubuntu"
// + Filename="pool/main/g/gcc/gcc_..._amd64.deb"). Empty mirrorBase leaves
// SourceURL as the raw Filename.
func ParseDebPackages(
	body []byte,
	os, release, arch, component, mirrorBase string,
) ([]schema.PackageRecord, error) {
	if len(body) == 0 {
		return nil, errors.New("empty Packages body")
	}

	out := make([]schema.PackageRecord, 0, 4096)
	cur := newDebStanza(os, release, arch, component)

	// bufio.Scanner's default 64 KB line cap can trip on very long
	// Description continuations (some texlive stanzas are 200+ KB). Grow
	// the buffer generously — 4 MB per stanza is well past any real
	// Packages entry.
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	// currentField tracks which multi-line field we're in so continuation
	// lines (starting with a single space) get appended to the right slot.
	// Empty means "no active continuation".
	var currentField string

	for scanner.Scan() {
		line := scanner.Text()

		// Blank line = end of stanza.
		if line == "" {
			if cur.rec.Name != "" {
				out = append(out, cur.finalize(mirrorBase))
			}
			cur = newDebStanza(os, release, arch, component)
			currentField = ""
			continue
		}

		// Continuation line: single leading space, applies to the last
		// field. The APT spec also accepts a literal "." as an empty
		// paragraph separator inside Description.
		if strings.HasPrefix(line, " ") && currentField != "" {
			cur.appendContinuation(currentField, line)
			continue
		}

		// Key: value line.
		colonIdx := strings.Index(line, ":")
		if colonIdx <= 0 {
			continue // malformed; skip
		}
		key := line[:colonIdx]
		val := strings.TrimSpace(line[colonIdx+1:])
		currentField = key
		cur.set(key, val)
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan Packages: %w", err)
	}

	// Trailing stanza (file doesn't end with a blank line).
	if cur.rec.Name != "" {
		out = append(out, cur.finalize(mirrorBase))
	}

	return out, nil
}

// debStanza is the parse buffer for a single stanza. Kept separate from
// PackageRecord so we can accumulate continuation lines and normalise at
// finalise time.
type debStanza struct {
	rec         schema.PackageRecord
	descLines   []string // Description continuation lines (excluding headline)
	rawTag      string   // Tag: value — comma-split at finalise
	rawFilename string   // Filename: relative path; combined with mirrorBase
}

func newDebStanza(os, release, arch, component string) *debStanza {
	return &debStanza{
		rec: schema.PackageRecord{
			OS:        os,
			Release:   release,
			Arch:      arch,
			Component: component,
		},
	}
}

// set records a field's headline (non-continuation) value. Unknown keys are
// silently dropped — the Packages format is open-ended and we only care
// about a curated subset.
func (s *debStanza) set(key, val string) {
	switch key {
	case "Package":
		s.rec.Name = val
	case "Version":
		s.rec.Version = val
	case "Source":
		// Source can carry a version parenthesised: "gcc-defaults (1.234)".
		// Strip that; we track versions per binary already.
		if paren := strings.Index(val, " ("); paren > 0 {
			val = val[:paren]
		}
		s.rec.Source = val
	case "Section":
		s.rec.Section = val
	case "Homepage":
		s.rec.Homepage = val
	case "Description":
		s.rec.Summary = val // headline; body appended via continuation
	case "Description-md5":
		// Kept as a keyword facet for future i18n join to
		// Translation-en. Not surfaced in the JSON yet.
	case "Architecture":
		// Debian uses "all" for arch-independent packages; keep the
		// existing debutils convention of remapping to "noarch". A
		// package's stanza-declared arch overrides the parser input
		// (rare but valid — mixed-arch Packages files exist).
		if val == "all" || val == "any" {
			s.rec.Arch = "noarch"
		} else {
			s.rec.Arch = val
		}
	case "Multi-Arch":
		s.rec.MultiArch = val
	case "Installed-Size":
		if n, err := strconv.ParseInt(val, 10, 64); err == nil {
			s.rec.InstalledSize = n
		}
	case "Depends":
		s.rec.Depends = splitDepList(val)
	case "Pre-Depends":
		s.rec.Depends = append(s.rec.Depends, splitDepList(val)...)
	case "Recommends":
		s.rec.Recommends = splitDepList(val)
	case "Suggests":
		s.rec.Suggests = splitDepList(val)
	case "Provides":
		// Debian's Provides is a flat list; we bucket everything into
		// Binary since Debian doesn't distinguish provides-kinds the
		// way rpm:provides does. AppStream merge can promote entries
		// into Library / MimeType / DBus later.
		s.rec.Provides.Binary = splitDepList(val)
	case "Task":
		s.rec.Tasks = splitCsv(val)
	case "Filename":
		s.rawFilename = val
	case "Tag":
		s.rawTag = val
	}
}

// appendContinuation glues a "single-space-prefixed" line onto the field
// last set. For Description we accumulate lines to be joined at finalise;
// for Tag (which can wrap across lines with trailing commas), same
// approach.
func (s *debStanza) appendContinuation(field, line string) {
	// Strip the single leading space; a literal "." line becomes an
	// empty paragraph separator per APT convention.
	stripped := strings.TrimPrefix(line, " ")
	if stripped == "." {
		stripped = ""
	}
	switch field {
	case "Description":
		s.descLines = append(s.descLines, stripped)
	case "Tag":
		s.rawTag += " " + strings.TrimSpace(stripped)
	}
}

// finalize normalises accumulated multi-line state into the final record.
// Called once per stanza; safe to reuse debStanza afterwards only via
// newDebStanza.
func (s *debStanza) finalize(mirrorBase string) schema.PackageRecord {
	if len(s.descLines) > 0 {
		s.rec.Description = strings.Join(s.descLines, "\n")
	}
	if s.rawTag != "" {
		s.rec.Tags = splitCsv(s.rawTag)
	}
	if s.rawFilename != "" {
		if mirrorBase != "" {
			s.rec.SourceURL = strings.TrimSuffix(mirrorBase, "/") + "/" + s.rawFilename
		} else {
			s.rec.SourceURL = s.rawFilename
		}
	}
	return s.rec
}

// splitDepList parses a comma-separated dependency list and strips version
// constraints ("libc6 (>= 2.34)" → "libc6"). Alternatives ("foo | bar")
// keep both sides — we index the flat name set.
func splitDepList(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		for _, alt := range strings.Split(p, "|") {
			name := strings.TrimSpace(alt)
			if paren := strings.Index(name, " "); paren > 0 {
				name = name[:paren]
			}
			name = strings.TrimSpace(name)
			if name != "" {
				out = append(out, name)
			}
		}
	}
	return out
}

// splitCsv splits on commas, trims whitespace, and drops empties. Used for
// Task: and Tag: whose values are naturally comma-lists.
func splitCsv(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// DiscardAndClose is a tiny utility used by callers that want to make sure
// they close an io.ReadCloser even when they've already read everything
// they wanted. Kept out of the exported surface — internal use only.
var _ = io.Copy
