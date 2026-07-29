// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package crawler

import (
	"strings"
	"testing"
)

// stanzaFixture is a real-world abbreviated Debian Packages stanza with
// every field the wrapped parser needs to retain. Includes a multi-line
// Description body + a wrapped Tag: line so continuation handling gets
// exercised.
const stanzaFixture = `Package: gcc
Version: 4:13.2.0-7ubuntu1
Source: gcc-defaults (1.234)
Architecture: amd64
Maintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>
Section: devel
Priority: optional
Homepage: https://gcc.gnu.org/
Installed-Size: 51
Multi-Arch: allowed
Depends: cpp (= 4:13.2.0-7ubuntu1), gcc-13 (>= 13.2.0-1~)
Recommends: libc6-dev | libc-dev
Suggests: gcc-multilib, autoconf, automake, libtool, flex, bison, gdb, gcc-doc
Provides: c-compiler, gcc-x86-64-linux-gnu
Task: ubuntu-desktop, build-essential
Filename: pool/main/g/gcc-defaults/gcc_13.2.0-7ubuntu1_amd64.deb
Size: 5236
SHA256: abc123def456
Tag: devel::compiler, role::program,
 works-with-format::plain-text,
 use::compiling
Description: GNU C compiler
 This package is a dependency package which is intended to be used only
 for build environments so that they always keep up with the latest
 versions of GCC.
 .
 This is the default GNU C compiler for the current release of
 Ubuntu.

Package: libc6
Version: 2.39-0ubuntu8
Architecture: amd64
Section: libs
Homepage: https://www.gnu.org/software/libc/
Description: GNU C Library: Shared libraries
 Common shared library for glibc.
`

func TestParseDebPackages_PreservesDroppedFields(t *testing.T) {
	recs, err := ParseDebPackages(
		[]byte(stanzaFixture),
		"ubuntu", "noble", "amd64", "main",
		"http://archive.ubuntu.com/ubuntu",
	)
	if err != nil {
		t.Fatalf("parse err: %v", err)
	}
	if len(recs) != 2 {
		t.Fatalf("expected 2 records, got %d", len(recs))
	}

	// The wrapped parser must NOT drop the fields the upstream
	// resolver.go drops. Every assertion here corresponds to a field
	// the plan called out as "preserved" (Tag / Section / Homepage /
	// Recommends / Suggests / Multi-Arch / Installed-Size / Source /
	// Task / multi-line Description).
	gcc := recs[0]
	if gcc.Name != "gcc" {
		t.Errorf("name = %q, want gcc", gcc.Name)
	}
	if gcc.Section != "devel" {
		t.Errorf("section = %q, want devel", gcc.Section)
	}
	if gcc.Homepage != "https://gcc.gnu.org/" {
		t.Errorf("homepage = %q", gcc.Homepage)
	}
	if gcc.InstalledSize != 51 {
		t.Errorf("installedSize = %d, want 51", gcc.InstalledSize)
	}
	if gcc.MultiArch != "allowed" {
		t.Errorf("multiArch = %q, want allowed", gcc.MultiArch)
	}
	if gcc.Source != "gcc-defaults" {
		t.Errorf("source = %q, want gcc-defaults (version-suffix stripped)", gcc.Source)
	}
	// Tags: comma-split of Tag: field, wrapped across three lines.
	wantTags := []string{"devel::compiler", "role::program", "works-with-format::plain-text", "use::compiling"}
	if len(gcc.Tags) != len(wantTags) {
		t.Errorf("tags = %v, want %v", gcc.Tags, wantTags)
	} else {
		for i, w := range wantTags {
			if gcc.Tags[i] != w {
				t.Errorf("tag[%d] = %q, want %q", i, gcc.Tags[i], w)
			}
		}
	}
	// Recommends alternatives keep both sides.
	if len(gcc.Recommends) != 2 || gcc.Recommends[0] != "libc6-dev" || gcc.Recommends[1] != "libc-dev" {
		t.Errorf("recommends = %v", gcc.Recommends)
	}
	// Suggests comma-list preserved.
	if len(gcc.Suggests) < 4 || gcc.Suggests[0] != "gcc-multilib" {
		t.Errorf("suggests = %v", gcc.Suggests)
	}
	// Tasks parsed.
	if len(gcc.Tasks) != 2 || gcc.Tasks[0] != "ubuntu-desktop" || gcc.Tasks[1] != "build-essential" {
		t.Errorf("tasks = %v", gcc.Tasks)
	}
	// Multi-line Description body — continuation lines joined, .-lines
	// preserved as paragraph breaks.
	if !strings.Contains(gcc.Description, "This package is a dependency package") {
		t.Errorf("description body missing, got %q", gcc.Description)
	}
	if !strings.Contains(gcc.Description, "This is the default GNU C compiler") {
		t.Errorf("description second paragraph missing, got %q", gcc.Description)
	}
	// Summary is the headline (Description: line).
	if gcc.Summary != "GNU C compiler" {
		t.Errorf("summary = %q", gcc.Summary)
	}
	// SourceURL = mirrorBase + Filename.
	if !strings.HasSuffix(gcc.SourceURL, "pool/main/g/gcc-defaults/gcc_13.2.0-7ubuntu1_amd64.deb") {
		t.Errorf("sourceUrl = %q", gcc.SourceURL)
	}
	if !strings.HasPrefix(gcc.SourceURL, "http://archive.ubuntu.com/ubuntu/") {
		t.Errorf("sourceUrl missing mirror prefix: %q", gcc.SourceURL)
	}
	// Provides.Binary populated from Debian's Provides field.
	if len(gcc.Provides.Binary) != 2 || gcc.Provides.Binary[0] != "c-compiler" {
		t.Errorf("provides.binary = %v", gcc.Provides.Binary)
	}
}

func TestParseInRelease_SHA256Map(t *testing.T) {
	body := `Origin: Ubuntu
Suite: noble
Codename: noble
Architectures: amd64
SHA256:
 abc123 12345 main/binary-amd64/Packages.xz
 def456 6789  main/dep11/Components-noble-amd64.yml.gz
Description: Ubuntu Noble
`
	ir, err := ParseInRelease([]byte(body))
	if err != nil {
		t.Fatalf("parse err: %v", err)
	}
	if ir.SHA256["main/binary-amd64/Packages.xz"] != "abc123" {
		t.Errorf("packages hash mismatch: %v", ir.SHA256)
	}
	if ir.SHA256["main/dep11/Components-noble-amd64.yml.gz"] != "def456" {
		t.Errorf("appstream hash mismatch: %v", ir.SHA256)
	}
	if len(ir.SHA256) != 2 {
		t.Errorf("extra hashes: %v", ir.SHA256)
	}
}
