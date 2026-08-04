// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package crawler

import (
	"testing"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// BE-0 continues into the crawler, the largest remaining backend gap (29.2%).
//
// These are the AppStream overlay helpers. They decide what enrichment lands on a
// package record, and a mistake here is invisible: the search index simply carries
// slightly wrong metadata, so results rank oddly rather than anything failing.
//
// The invariant most worth protecting is that Provides.Binary is NEVER merged from
// AppStream — see the note on TestApplyAppStreamNeverTouchesProvidesBinary.

// --- mergeUnique -------------------------------------------------------------

func TestMergeUniqueUnionsPreservingFirstSeenOrder(t *testing.T) {
	got := mergeUnique([]string{"b", "a"}, []string{"c", "a", "d"})
	want := []string{"b", "a", "c", "d"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] = %q, want %q — order must be first-seen, not sorted", i, got[i], want[i])
		}
	}
}

func TestMergeUniqueDropsEmptyStrings(t *testing.T) {
	// dep11 YAML can carry empty entries where a field was present but blank.
	// An empty keyword would become an empty facet chip in the UI.
	got := mergeUnique([]string{"a", "", "b"}, []string{"", "c", ""})
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestMergeUniqueDeduplicatesWithinEachSide(t *testing.T) {
	got := mergeUnique([]string{"x", "x", "y"}, []string{"y", "z", "z"})
	want := []string{"x", "y", "z"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestMergeUniqueEmptyBReturnsAVERBATIM(t *testing.T) {
	// ⚠️ AN ASYMMETRY, pinned as current behaviour rather than endorsed.
	//
	// The `if len(b) == 0 { return a }` fast path skips the cleaning loop
	// entirely, so when there is nothing to add, duplicates and empty strings
	// already present in `a` SURVIVE — whereas the same input with a non-empty `b`
	// comes back cleaned.
	//
	// Reachable: ApplyAppStream calls this for nine fields per record, and most
	// dep11 entries populate only one or two, so the majority of calls take this
	// path. Harmless in practice because `a` originates from the Packages-file
	// parser, which does not emit blanks or dupes — but the inconsistency is real
	// and a caller feeding dirty data would be surprised.
	dirty := []string{"x", "x", ""}
	got := mergeUnique(dirty, nil)
	if len(got) != 3 {
		t.Errorf("got %v (len %d), want the input returned verbatim (len 3); if this "+
			"now fails, the fast path was removed and this note is stale", got, len(got))
	}

	// Contrast: the same `a` WITH something to merge does get cleaned.
	cleaned := mergeUnique(dirty, []string{"y"})
	want := []string{"x", "y"}
	if len(cleaned) != len(want) {
		t.Fatalf("with a non-empty b, got %v, want %v", cleaned, want)
	}
}

func TestMergeUniqueBothEmpty(t *testing.T) {
	if got := mergeUnique(nil, nil); len(got) != 0 {
		t.Errorf("got %v, want empty", got)
	}
}

func TestMergeUniqueEmptyAKeepsB(t *testing.T) {
	got := mergeUnique(nil, []string{"a", "", "a", "b"})
	want := []string{"a", "b"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestMergeUniqueDoesNotAliasItsInputs(t *testing.T) {
	// The union path builds a fresh slice, so mutating the result must not reach
	// back into either argument. ApplyAppStream assigns the result over the
	// original field, so aliasing would be a subtle data race waiting to happen.
	a := []string{"a"}
	b := []string{"b"}
	got := mergeUnique(a, b)
	got[0] = "MUTATED"
	if a[0] != "a" {
		t.Errorf("a[0] = %q; mergeUnique must not alias its first argument", a[0])
	}
	if b[0] != "b" {
		t.Errorf("b[0] = %q; mergeUnique must not alias its second argument", b[0])
	}
}

// --- appendUnique ------------------------------------------------------------

func TestAppendUnique(t *testing.T) {
	cases := []struct {
		name string
		xs   []string
		s    string
		want []string
	}{
		{"appends a new value", []string{"a"}, "b", []string{"a", "b"}},
		{"skips a duplicate", []string{"a", "b"}, "a", []string{"a", "b"}},
		{"skips an empty string", []string{"a"}, "", []string{"a"}},
		{"appends to nil", nil, "a", []string{"a"}},
		{"empty into nil stays nil", nil, "", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := appendUnique(c.xs, c.s)
			if len(got) != len(c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
			for i := range c.want {
				if got[i] != c.want[i] {
					t.Errorf("[%d] = %q, want %q", i, got[i], c.want[i])
				}
			}
		})
	}
}

func TestAppendUniqueIsCaseSensitive(t *testing.T) {
	// Pinned deliberately: dep11 ids are case-significant ("org.Foo.Bar" is a
	// different D-Bus name from "org.foo.bar"), so folding case here would merge
	// two genuinely distinct services.
	got := appendUnique([]string{"org.Foo.Bar"}, "org.foo.bar")
	if len(got) != 2 {
		t.Errorf("got %v, want both spellings kept — dep11 ids are case-significant", got)
	}
}

// --- coerceStrings -----------------------------------------------------------

func TestCoerceStringsPassesPlainStrings(t *testing.T) {
	got := coerceStrings([]any{"gcc", "gcc-13"})
	if len(got) != 2 || got[0] != "gcc" || got[1] != "gcc-13" {
		t.Errorf("got %v, want the strings verbatim", got)
	}
}

func TestCoerceStringsExtractsIdServiceName(t *testing.T) {
	// dep11's Provides values are heterogeneous: a bare string for binaries, a
	// map for D-Bus ({id}), systemd services ({service}), and some fonts
	// ({name}). All three keys must be understood or the facet silently loses
	// entries.
	got := coerceStrings([]any{
		map[string]any{"id": "org.freedesktop.NetworkManager"},
		map[string]any{"service": "sshd.service"},
		map[string]any{"name": "DejaVu Sans"},
	})
	want := []string{"org.freedesktop.NetworkManager", "sshd.service", "DejaVu Sans"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestCoerceStringsPrefersIdOverServiceAndName(t *testing.T) {
	// The key order in the source is id, service, name, and it `break`s on the
	// first hit — so a map carrying several contributes exactly one value.
	got := coerceStrings([]any{
		map[string]any{"name": "n", "service": "s", "id": "i"},
	})
	if len(got) != 1 {
		t.Fatalf("got %v, want exactly one value per map", got)
	}
	if got[0] != "i" {
		t.Errorf("got %q, want %q — id has highest precedence", got[0], "i")
	}
}

func TestCoerceStringsSkipsUnusableEntries(t *testing.T) {
	// Anything that is neither a string nor a map with one of the three keys is
	// dropped rather than stringified — "map[foo:bar]" in a search facet would be
	// worse than a missing entry.
	got := coerceStrings([]any{
		42,
		true,
		nil,
		[]any{"nested"},
		map[string]any{"unknown": "x"},
		map[string]any{"id": ""},   // present but blank
		map[string]any{"id": 1234}, // present but not a string
		"keep-me",
	})
	if len(got) != 1 || got[0] != "keep-me" {
		t.Errorf("got %v, want only the usable string", got)
	}
}

func TestCoerceStringsEmptyInput(t *testing.T) {
	if got := coerceStrings(nil); len(got) != 0 {
		t.Errorf("got %v, want empty", got)
	}
	if got := coerceStrings([]any{}); got == nil {
		t.Error("want a non-nil empty slice for an empty input")
	}
}

// --- ApplyAppStream ----------------------------------------------------------

func TestApplyAppStreamNoOpsOnAnEmptyOverlay(t *testing.T) {
	// The common case for a suite with no dep11 data. Records must be untouched,
	// not blanked.
	//
	// NOTE from mutation-testing: deleting the `if len(overlay) == 0 { return }`
	// guard breaks no test, and that is correct rather than a gap — without it the
	// loop still runs but every map lookup misses, so nothing is mutated either
	// way. The guard is a PERFORMANCE short-circuit: the orchestrator calls this
	// over a slice of ~50k records per shard, so skipping the whole scan when a
	// suite has no dep11 data is worth a branch. Kept, and kept documented.
	recs := []schema.PackageRecord{{Name: "vim", Summary: "original"}}
	ApplyAppStream(recs, nil)
	if recs[0].Summary != "original" {
		t.Errorf("Summary = %q, want it untouched", recs[0].Summary)
	}
	ApplyAppStream(recs, map[string]schema.PackageRecord{})
	if recs[0].Summary != "original" {
		t.Errorf("Summary = %q, want it untouched", recs[0].Summary)
	}
}

func TestApplyAppStreamSkipsRecordsWithNoOverlayEntry(t *testing.T) {
	recs := []schema.PackageRecord{
		{Name: "vim", Summary: "vim original"},
		{Name: "gcc", Summary: "gcc original"},
	}
	ApplyAppStream(recs, map[string]schema.PackageRecord{
		"vim": {Summary: "vim enriched"},
	})
	if recs[0].Summary != "vim enriched" {
		t.Errorf("vim Summary = %q, want the overlay applied", recs[0].Summary)
	}
	if recs[1].Summary != "gcc original" {
		t.Errorf("gcc Summary = %q, want it untouched", recs[1].Summary)
	}
}

func TestApplyAppStreamOverwritesSummaryOnlyWhenNonEmpty(t *testing.T) {
	// A dep11 entry with no summary must not blank a Packages-file description.
	recs := []schema.PackageRecord{{Name: "vim", Summary: "from Packages"}}
	ApplyAppStream(recs, map[string]schema.PackageRecord{"vim": {Summary: ""}})
	if recs[0].Summary != "from Packages" {
		t.Errorf("Summary = %q, want an empty overlay summary to be ignored", recs[0].Summary)
	}

	ApplyAppStream(recs, map[string]schema.PackageRecord{"vim": {Summary: "from AppStream"}})
	if recs[0].Summary != "from AppStream" {
		t.Errorf("Summary = %q, want a non-empty overlay summary to win", recs[0].Summary)
	}
}

func TestApplyAppStreamNeverTouchesProvidesBinary(t *testing.T) {
	// ⚠️ THE INVARIANT THIS FILE EXISTS TO PROTECT.
	//
	// Provides.Binary is authoritative from the Packages file's Provides/Depends.
	// AppStream's `binaries` list is a SUBSET — only the .desktop-launchable ones —
	// so merging it in would be harmless, but merging it as a REPLACEMENT, or
	// unioning a subset over a superset in a future refactor, would silently drop
	// binaries the dependency resolver needs.
	//
	// Every other Provides sub-field IS unioned. This test asserts the one
	// exception explicitly, because the omission looks like an oversight.
	recs := []schema.PackageRecord{{
		Name: "gcc",
		Provides: schema.Provides{
			Binary:   []string{"gcc", "gcc-13", "cc"},
			MimeType: []string{"text/x-c"},
		},
	}}
	ApplyAppStream(recs, map[string]schema.PackageRecord{
		"gcc": {Provides: schema.Provides{
			Binary:   []string{"gcc-gui"}, // must NOT appear
			MimeType: []string{"text/x-c++"},
		}},
	})

	for _, b := range recs[0].Provides.Binary {
		if b == "gcc-gui" {
			t.Fatal("AppStream's binaries leaked into Provides.Binary; it must stay " +
				"authoritative from the Packages file")
		}
	}
	if len(recs[0].Provides.Binary) != 3 {
		t.Errorf("Provides.Binary = %v, want the original three untouched",
			recs[0].Provides.Binary)
	}
	// Contrast: MimeType IS merged.
	if len(recs[0].Provides.MimeType) != 2 {
		t.Errorf("Provides.MimeType = %v, want both merged", recs[0].Provides.MimeType)
	}
}

func TestApplyAppStreamUnionsEveryOtherProvidesField(t *testing.T) {
	recs := []schema.PackageRecord{{
		Name: "pkg",
		Provides: schema.Provides{
			MimeType: []string{"a/1"},
			DBus:     []string{"d.1"},
			Python:   []string{"p1"},
			Library:  []string{"l1"},
			Firmware: []string{"f1"},
			Font:     []string{"n1"},
		},
	}}
	ApplyAppStream(recs, map[string]schema.PackageRecord{
		"pkg": {Provides: schema.Provides{
			MimeType: []string{"a/2"},
			DBus:     []string{"d.2"},
			Python:   []string{"p2"},
			Library:  []string{"l2"},
			Firmware: []string{"f2"},
			Font:     []string{"n2"},
		}},
	})
	p := recs[0].Provides
	for name, got := range map[string][]string{
		"MimeType": p.MimeType, "DBus": p.DBus, "Python": p.Python,
		"Library": p.Library, "Firmware": p.Firmware, "Font": p.Font,
	} {
		if len(got) != 2 {
			t.Errorf("%s = %v, want both entries unioned", name, got)
		}
	}
}

func TestApplyAppStreamUnionsKeywordsCategoriesScreenshots(t *testing.T) {
	recs := []schema.PackageRecord{{
		Name:        "pkg",
		Keywords:    []string{"editor"},
		Categories:  []string{"Development"},
		Screenshots: []string{"http://s/1.png"},
	}}
	ApplyAppStream(recs, map[string]schema.PackageRecord{
		"pkg": {
			Keywords:    []string{"editor", "vi"}, // "editor" is a duplicate
			Categories:  []string{"Utility"},
			Screenshots: []string{"http://s/2.png"},
		},
	})
	if len(recs[0].Keywords) != 2 {
		t.Errorf("Keywords = %v, want the duplicate collapsed", recs[0].Keywords)
	}
	if len(recs[0].Categories) != 2 {
		t.Errorf("Categories = %v, want both", recs[0].Categories)
	}
	if len(recs[0].Screenshots) != 2 {
		t.Errorf("Screenshots = %v, want both", recs[0].Screenshots)
	}
}

func TestApplyAppStreamMutatesInPlace(t *testing.T) {
	// It takes a slice and writes through &records[i] rather than returning a new
	// slice — the crawler applies several overlays in sequence over one large
	// slice, so copying per pass would be wasteful. Pinned so a future signature
	// change is deliberate.
	recs := []schema.PackageRecord{{Name: "vim"}}
	ApplyAppStream(recs, map[string]schema.PackageRecord{"vim": {Summary: "s"}})
	if recs[0].Summary != "s" {
		t.Error("ApplyAppStream must mutate the caller's slice in place")
	}
}

func TestApplyAppStreamOnAnEmptyRecordSlice(t *testing.T) {
	// Must not panic. Reachable when a shard parses to zero records.
	ApplyAppStream(nil, map[string]schema.PackageRecord{"x": {Summary: "s"}})
	ApplyAppStream([]schema.PackageRecord{}, map[string]schema.PackageRecord{"x": {Summary: "s"}})
}
