// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package schema

import (
	"encoding/json"
	"strings"
	"testing"
)

// This package was at 0% coverage. It matters more than its size suggests:
// ProjectToLegacy is the compatibility seam that lets the pkgsvc microservice
// serve the SAME nine-field shape the main backend's /api/v1/packages used to
// return directly, so the frontend needs no changes when the proxy cuts over. A
// regression here is a silently malformed package list in the UI's search — not
// a crash, just wrong data.

func TestProjectToLegacyMapsEveryField(t *testing.T) {
	r := &PackageRecord{
		Name:        "vim",
		Version:     "2:9.1.0016-1ubuntu7",
		Arch:        "amd64",
		Section:     "editors",
		OS:          "ubuntu",
		Release:     "noble",
		Summary:     "Vi IMproved - enhanced vi editor",
		Description: "a much longer description that should NOT win",
		Provides: Provides{
			Binary:  []string{"editor", "vim"},
			Library: []string{"libvim.so.1"},
		},
	}
	got := ProjectToLegacy(r)

	if got.Name != "vim" || got.Version != "2:9.1.0016-1ubuntu7" {
		t.Errorf("identity fields wrong: %+v", got)
	}
	if got.Arch != "amd64" || got.Section != "editors" || got.OS != "ubuntu" {
		t.Errorf("passthrough fields wrong: %+v", got)
	}
	// Repository is DERIVED — "<os> <release>", space-separated.
	if got.Repository != "ubuntu noble" {
		t.Errorf("Repository = %q, want %q", got.Repository, "ubuntu noble")
	}
	if got.Type != "deb" {
		t.Errorf("Type = %q, want deb for ubuntu", got.Type)
	}
}

func TestProjectToLegacyPrefersSummaryOverDescription(t *testing.T) {
	// Summary is short and indexed; Description can be paragraphs. The legacy
	// shape has one description field, and the UI renders it in a dropdown row —
	// so the short one must win when both exist.
	r := &PackageRecord{Summary: "short", Description: "long long long"}
	if got := ProjectToLegacy(r).Description; got != "short" {
		t.Errorf("Description = %q, want the Summary to win", got)
	}
}

func TestProjectToLegacyFallsBackToDescription(t *testing.T) {
	// Not every repo populates Summary. Falling back matters because a blank
	// description renders as an empty row in the search dropdown.
	r := &PackageRecord{Summary: "", Description: "the long one"}
	if got := ProjectToLegacy(r).Description; got != "the long one" {
		t.Errorf("Description = %q, want the fallback", got)
	}
}

func TestProjectToLegacyEmptyDescriptionWhenNeitherSet(t *testing.T) {
	if got := ProjectToLegacy(&PackageRecord{}).Description; got != "" {
		t.Errorf("Description = %q, want empty", got)
	}
}

func TestProjectToLegacyFlattensBinaryThenLibrary(t *testing.T) {
	// ORDER IS PART OF THE CONTRACT: the old handler merged rpm:provides and deb
	// Provides into one flat list, binaries first. The UI matches user queries
	// against this list, so re-ordering changes which result ranks first.
	r := &PackageRecord{
		Provides: Provides{
			Binary:  []string{"gcc", "gcc-13"},
			Library: []string{"libgcc.so.1"},
			// These are deliberately NOT projected — the legacy shape has no
			// place for them, and inventing one would break the byte-match.
			MimeType: []string{"application/x-c"},
			DBus:     []string{"org.gnu.gcc"},
			Python:   []string{"python3-gcc"},
			Font:     []string{"someFont"},
			Firmware: []string{"someFirmware"},
		},
	}
	got := ProjectToLegacy(r).Provides
	want := []string{"gcc", "gcc-13", "libgcc.so.1"}
	if len(got) != len(want) {
		t.Fatalf("Provides = %v, want exactly %v (mimetype/dbus/python/font/firmware are NOT projected)", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("Provides[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestProjectToLegacyProvidesIsNeverNil(t *testing.T) {
	// `make([]string, 0, n)` not `var []string`. The difference is visible on the
	// wire: nil marshals to `null`, an empty slice to `[]`. The frontend does
	// `provides.some(...)` without a null check, so null would throw.
	got := ProjectToLegacy(&PackageRecord{})
	if got.Provides == nil {
		t.Fatal("Provides must be an empty slice, not nil")
	}
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"provides":[]`) {
		t.Errorf("marshalled as %s, want provides to serialise as []", b)
	}
}

func TestProjectToLegacyMarshalsAllNineFields(t *testing.T) {
	// The legacy shape is exactly nine fields with NO omitempty, so a zero-valued
	// record still emits every key. The frontend reads them positionally in
	// places; a disappearing key is a silent undefined.
	b, err := json.Marshal(ProjectToLegacy(&PackageRecord{}))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{
		"name", "version", "description", "arch",
		"section", "repository", "os", "type", "provides",
	} {
		if _, ok := m[k]; !ok {
			t.Errorf("field %q missing from the marshalled legacy record", k)
		}
	}
	if len(m) != 9 {
		t.Errorf("legacy record has %d fields, want exactly 9: %s", len(m), b)
	}
}

func TestTypeForOSFamilies(t *testing.T) {
	// Exercised through the public projection as well as directly, since the
	// mapping is what the UI's "type" chip renders.
	cases := map[string]string{
		"fedora":   "rpm",
		"rhel":     "rpm",
		"rocky":    "rpm",
		"alma":     "rpm",
		"centos":   "rpm",
		"opensuse": "rpm",
		"alpine":   "apk",
		"ubuntu":   "deb",
		"debian":   "deb",
	}
	for os, want := range cases {
		if got := typeForOS(os); got != want {
			t.Errorf("typeForOS(%q) = %q, want %q", os, got, want)
		}
		if got := ProjectToLegacy(&PackageRecord{OS: os}).Type; got != want {
			t.Errorf("ProjectToLegacy OS=%q gave Type=%q, want %q", os, got, want)
		}
	}
}

func TestTypeForOSUnknownFallsBackToDeb(t *testing.T) {
	// Deliberate: the legacy response must never carry an empty type field, and
	// deb is the majority case. An unrecognised family is a crawler gap, not a
	// reason to emit "".
	for _, os := range []string{"", "plan9", "windows", "UBUNTU", "Fedora"} {
		if got := typeForOS(os); got != "deb" {
			t.Errorf("typeForOS(%q) = %q, want the deb fallback", os, got)
		}
	}
}

func TestTypeForOSIsCaseSensitive(t *testing.T) {
	// Pinned as CURRENT behaviour, not endorsed. "Fedora" falls through to "deb",
	// which is wrong-looking but harmless while every crawler emits lowercase
	// family ids. Recorded so a future case-folding change is a deliberate one.
	if got := typeForOS("Fedora"); got != "deb" {
		t.Errorf("typeForOS(\"Fedora\") = %q; the switch is case-sensitive so this "+
			"falls through to deb", got)
	}
	if got := typeForOS("fedora"); got != "rpm" {
		t.Errorf("typeForOS(\"fedora\") = %q, want rpm", got)
	}
}

func TestFirstNonEmpty(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{[]string{"a", "b"}, "a"},
		{[]string{"", "b"}, "b"},
		{[]string{"", "", "c"}, "c"},
		{[]string{"", "", ""}, ""},
		{nil, ""},
		{[]string{}, ""},
		{[]string{" "}, " "}, // whitespace is non-empty; no trimming
	}
	for _, c := range cases {
		if got := firstNonEmpty(c.in...); got != c.want {
			t.Errorf("firstNonEmpty(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestProjectToLegacyRepositoryWithMissingRelease(t *testing.T) {
	// Repository is built by concatenation, so a missing release leaves a
	// trailing space. Pinned as current behaviour — it is cosmetic and the UI
	// renders it verbatim, so a future trim would be a visible change.
	got := ProjectToLegacy(&PackageRecord{OS: "ubuntu", Release: ""}).Repository
	if got != "ubuntu " {
		t.Errorf("Repository = %q; concatenation leaves the separator when Release "+
			"is empty", got)
	}
}
