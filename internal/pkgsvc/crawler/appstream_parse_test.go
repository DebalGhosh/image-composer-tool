// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package crawler

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// BE-0: ParseAppStreamDep11 was the last 0% function in appstream.go. The overlay
// APPLY side (mergeUnique / appendUnique / coerceStrings / ApplyAppStream) is covered
// in appstream_apply_test.go — this file is only the dep11 YAML PARSER, and it does
// not re-test those helpers, only that the parser feeds them the right things.
//
// Why the parser is worth pinning: everything it gets wrong is SILENT. The
// orchestrator calls it best-effort (orchestrator.go:325 — `if overlay, err :=
// ParseAppStreamDep11(asBody); err == nil`), so a parser that returns an empty or
// wrongly-keyed map produces a crawl that logs nothing, ingests successfully, and
// leaves ~50k records with no AppStream enrichment. Search results then just look a
// bit worse: no summaries from AppStream, no category facets, no screenshots in the
// detail pane. Nothing fails, nothing alerts.

// dep11StreamFixture is a realistic abbreviated dep11 stream: the `File: DEP-11`
// header document, then component documents separated by `---`.
//
// It deliberately exercises, in one stream: a header with no Type/Package, two
// components sharing ONE binary package (the merge path), every Provides kind
// including an unknown one, both Provides value shapes (bare string and map), a
// screenshot with only thumbnails, a duplicate screenshot URL across documents, and
// a trailing component with no Package field at all.
//
// IDs are deliberately unlike the Package names so a key-scheme regression cannot
// hide — see TestParseAppStreamDep11KeysTheOverlayByBinaryPackageName.
const dep11StreamFixture = `File: DEP-11
Version: '0.16'
Origin: example-noble-main
MediaBaseUrl: http://mirror.example.invalid/appstream/pool
Priority: 100
---
Type: desktop-application
ID: org.example.Editor.desktop
Package: example-editor
Name:
  C: Example Editor
  de: Beispiel-Editor
Summary:
  C: A small text editor
  de: Ein kleiner Texteditor
Description:
  C: "<p>Marketing prose the v1 overlay deliberately drops.</p>"
Keywords:
  C:
    - editor
    - text
Categories:
  - Utility
  - TextEditor
Provides:
  binaries:
    - example-editor
    - exed
  mimetypes:
    - text/plain
    - text/markdown
  dbus:
    - id: org.example.Editor
      type: session
  python3:
    - exedlib
  library:
    - libexed.so.1
  firmware:
    - name: exed-fw.bin
  fonts:
    - name: Example Mono
  totally-unknown-kind:
    - dropped-on-purpose
Screenshots:
  - default: true
    source-image:
      url: http://mirror.example.invalid/shots/editor-main.png
      width: 1600
      height: 900
    thumbnails:
      - url: http://mirror.example.invalid/shots/editor-main-thumb.png
        width: 400
        height: 225
  - source-image:
      url: http://mirror.example.invalid/shots/editor-prefs.png
      width: 1600
      height: 900
  - thumbnails:
      - url: http://mirror.example.invalid/shots/editor-thumb-only.png
        width: 400
        height: 225
---
Type: font
ID: org.example.EditorFonts
Package: example-editor
Summary:
  C: A SECOND component for the same binary package
Keywords:
  C:
    - monospace
Categories:
  - Utility
Provides:
  fonts:
    - name: Example Serif
Screenshots:
  - source-image:
      url: http://mirror.example.invalid/shots/editor-prefs.png
      width: 1600
      height: 900
---
Type: console-application
ID: org.example.Ripper
Package: example-ripper
Summary:
  C: Rips things
Provides:
  binaries:
    - example-rip
  dbus:
    - service: example-ripper.service
---
Type: desktop-application
ID: org.example.Nameless.desktop
Summary:
  C: A component with no Package field at all
Provides:
  binaries:
    - orphan-binary
`

// --- assertion helpers -------------------------------------------------------

// wantOrdered compares slices where the parser's output order IS deterministic
// (single-locale input, documents visited in stream order).
func wantOrdered(t *testing.T, field string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s = %v, want %v", field, got, want)
		return
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%s[%d] = %q, want %q (full: %v)", field, i, got[i], want[i], got)
		}
	}
}

// wantSameSet compares ignoring order. Needed wherever the parser iterates a Go map
// (locale keys, Provides kinds): map iteration order is randomised, so asserting
// order there would be a flaky test rather than a real invariant.
func wantSameSet(t *testing.T, field string, got, want []string) {
	t.Helper()
	g := append([]string(nil), got...)
	w := append([]string(nil), want...)
	sort.Strings(g)
	sort.Strings(w)
	if strings.Join(g, "\x00") != strings.Join(w, "\x00") {
		t.Errorf("%s = %v, want the same set as %v", field, got, want)
	}
}

func mustParse(t *testing.T, body string) map[string]schema.PackageRecord {
	t.Helper()
	out, err := ParseAppStreamDep11([]byte(body))
	if err != nil {
		t.Fatalf("ParseAppStreamDep11: unexpected error: %v", err)
	}
	return out
}

func sortedKeys(m map[string]schema.PackageRecord) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// --- the key scheme ----------------------------------------------------------

func TestParseAppStreamDep11KeysTheOverlayByBinaryPackageName(t *testing.T) {
	// ⚠️ THE INVARIANT THIS FILE EXISTS TO PROTECT.
	//
	// ApplyAppStream looks records up as `overlay[r.Name]`, and r.Name is the BINARY
	// PACKAGE name from the Packages file. dep11 documents also carry an `ID`
	// (org.example.Editor.desktop) and a localised `Name` ("Example Editor"), either
	// of which is an easy mistake to key on. Get it wrong and every lookup misses:
	// the overlay applies to nothing, silently, with no error anywhere.
	out := mustParse(t, dep11StreamFixture)

	wantOrdered(t, "keys", sortedKeys(out), []string{"example-editor", "example-ripper"})

	// Control that makes the assertion above meaningful: the values that MUST NOT be
	// keys are genuinely present in the fixture, so keying on them would have
	// produced a different (and here, non-empty) map rather than nothing at all.
	for _, notAKey := range []string{
		"org.example.Editor.desktop", "org.example.EditorFonts", "org.example.Ripper",
		"Example Editor", "desktop-application", "font",
	} {
		if !strings.Contains(dep11StreamFixture, notAKey) {
			t.Fatalf("fixture no longer contains %q, so this guard proves nothing", notAKey)
		}
		if _, ok := out[notAKey]; ok {
			t.Errorf("overlay is keyed by %q; ApplyAppStream only ever looks up the "+
				"binary package name, so this overlay would apply to nothing", notAKey)
		}
	}

	// End-to-end: the map the parser produces must actually land when handed
	// straight to ApplyAppStream, which is the only thing the orchestrator does
	// with it.
	recs := []schema.PackageRecord{
		{Name: "example-editor", Summary: "from Packages"},
		{Name: "example-ripper"},
		{Name: "example-unrelated", Summary: "untouched"},
	}
	ApplyAppStream(recs, out)
	if recs[0].Summary != "A small text editor" {
		t.Errorf("example-editor Summary = %q, want the dep11 summary applied", recs[0].Summary)
	}
	if recs[1].Summary != "Rips things" {
		t.Errorf("example-ripper Summary = %q, want the dep11 summary applied", recs[1].Summary)
	}
	if recs[2].Summary != "untouched" {
		t.Errorf("example-unrelated Summary = %q, want no overlay", recs[2].Summary)
	}
}

func TestParseAppStreamDep11SkipsTheHeaderAndPackagelessComponents(t *testing.T) {
	// The first document of every real dep11 stream is a header (`File: DEP-11`)
	// with no Package, and streams also carry components whose app is shipped by no
	// single binary. Both must be dropped rather than become an entry under the
	// empty-string key — an "" entry would never match a record but would make the
	// overlay size misleading in logs, and would mask the ID/Name fields sitting on
	// the header.
	out := mustParse(t, dep11StreamFixture)
	if _, ok := out[""]; ok {
		t.Error(`overlay has an "" key; the header / Package-less components must be skipped`)
	}
	if len(out) != 2 {
		t.Errorf("overlay has %d entries (%v), want 2 — header and the Package-less "+
			"component must not land", len(out), sortedKeys(out))
	}
	// Control proving the skip is the Package field and not something else about
	// those documents: the SAME Package-less component, given a Package, does land.
	withPkg := strings.Replace(dep11StreamFixture,
		"ID: org.example.Nameless.desktop\n",
		"ID: org.example.Nameless.desktop\nPackage: example-nameless\n", 1)
	if got := mustParse(t, withPkg); len(got) != 3 {
		t.Errorf("with a Package added, overlay has %d entries (%v), want 3",
			len(got), sortedKeys(got))
	}
}

// --- localisation wrapper ----------------------------------------------------

func TestParseAppStreamDep11PrefersTheCLocaleSummary(t *testing.T) {
	// dep11 nests human strings under a language key. v1 indexes English only, so
	// the "C" entry must win over any translation present in the same document —
	// otherwise a German or French summary lands in an English-only search index and
	// the record simply stops matching the words users type. Nothing breaks; the
	// package just becomes unfindable by its own words.
	out := mustParse(t, dep11StreamFixture)
	if got := out["example-editor"].Summary; got != "A small text editor" {
		t.Errorf("Summary = %q, want the C locale (the de translation is also present "+
			"in the fixture and must not win)", got)
	}

	// The assertion above ALONE is not enough, and mutation-testing proved it:
	// deleting the C-locale lookup leaves the map-ranging fallback, which picks C
	// roughly half the time on a two-locale document, so the test passed the mutant
	// by coin-flip. Nine locales and thirty parses make an accidental pass
	// (1/9 per parse) impossible in practice, while correct code returns C every
	// single time — so this is a hard assertion, not a probabilistic one.
	var b strings.Builder
	b.WriteString("---\nPackage: p\nSummary:\n  C: the English one\n")
	for _, loc := range []string{"de", "fr", "es", "it", "pt", "nl", "pl", "ru"} {
		fmt.Fprintf(&b, "  %s: translation-%s\n", loc, loc)
	}
	for i := 0; i < 30; i++ {
		if got := mustParse(t, b.String())["p"].Summary; got != "the English one" {
			t.Fatalf("parse %d: Summary = %q, want the C locale to win over all eight "+
				"translations", i, got)
		}
	}
}

func TestParseAppStreamDep11FallsBackWhenTheCLocaleIsMissingOrBlank(t *testing.T) {
	// Some components ship only translations, or ship `C: ""`. Rather than index a
	// blank summary (which renders as an empty line in the results list) the parser
	// takes the first non-empty locale it finds.
	//
	// Each case has exactly ONE non-empty non-C locale on purpose: the fallback
	// iterates a Go map, so with two candidates the winner is genuinely
	// nondeterministic between runs. See TestParseAppStreamDep11SummaryFallbackIsOrderIndependent.
	cases := []struct {
		name, doc, want string
	}{
		{
			name: "no C key at all",
			doc:  "---\nPackage: p\nSummary:\n  de: Nur Deutsch\n",
			want: "Nur Deutsch",
		},
		{
			name: "C present but blank",
			doc:  "---\nPackage: p\nSummary:\n  C: \"\"\n  de: Nur Deutsch\n",
			want: "Nur Deutsch",
		},
		{
			name: "every locale blank leaves the summary empty",
			doc:  "---\nPackage: p\nSummary:\n  C: \"\"\n  de: \"\"\n",
			want: "",
		},
		{
			name: "no Summary block at all",
			doc:  "---\nPackage: p\nCategories:\n  - Utility\n",
			want: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out := mustParse(t, c.doc)
			if got := out["p"].Summary; got != c.want {
				t.Errorf("Summary = %q, want %q", got, c.want)
			}
		})
	}
}

func TestParseAppStreamDep11FallbackSkipsBlankLocalesDeterministically(t *testing.T) {
	// Companion to the table above, which mutation-testing showed was too weak on
	// its own: with the fallback's `if s != ""` guard removed, a two-locale document
	// picks the blank one about half the time, so the table passed the mutant by
	// coin-flip.
	//
	// Here eight of nine locales are blank, so a parser that does not skip blanks
	// lands an empty summary 8 times in 9 — and correct code returns the one real
	// string every time. An empty summary presents as a package row with a blank
	// second line in the search results: not an error, just a hole in the UI.
	var b strings.Builder
	b.WriteString("---\nPackage: p\nSummary:\n")
	for _, loc := range []string{"de", "fr", "es", "it", "pt", "nl", "pl", "ru"} {
		fmt.Fprintf(&b, "  %s: \"\"\n", loc)
	}
	b.WriteString("  ja: the only real one\n")
	for i := 0; i < 30; i++ {
		if got := mustParse(t, b.String())["p"].Summary; got != "the only real one" {
			t.Fatalf("parse %d: Summary = %q, want the one non-blank locale — blank "+
				"locale entries must be skipped, not raced against", i, got)
		}
	}
}

func TestParseAppStreamDep11SummaryFallbackIsDeterministic(t *testing.T) {
	// This test previously tolerated a nondeterminism instead of asserting against
	// it. With no "C" locale and two or more non-empty translations, the fallback
	// ranged over a Go map, so WHICH translation got indexed differed between crawls
	// of byte-identical input — measured at 359 German / 41 French over 400 parses.
	// A record's summary flipped language for no reason, and every crawl rewrote
	// documents that had not changed.
	//
	// The fallback now walks locale keys in sorted order. Which locale wins is still
	// arbitrary — "de" beats "fr" only alphabetically — but it is arbitrary and
	// STABLE, which is the property that matters.
	//
	// Asserting an exact value is what makes this test meaningful: the old
	// "one of the candidates" form passed under both behaviours.
	const doc = "---\nPackage: p\nSummary:\n  de: Deutsch\n  fr: Francais\n"
	for i := range 50 {
		if got := mustParse(t, doc)["p"].Summary; got != "Deutsch" {
			t.Fatalf("parse %d: Summary = %q, want %q — the lowest-sorted locale must "+
				"win every time", i, got, "Deutsch")
		}
	}

	// Insertion order in the YAML must not matter either, only key order.
	const reversed = "---\nPackage: p\nSummary:\n  fr: Francais\n  de: Deutsch\n"
	if got := mustParse(t, reversed)["p"].Summary; got != "Deutsch" {
		t.Errorf("with the locales written in the other order, Summary = %q, want %q; "+
			"the choice must depend on the key, not on document order", got, "Deutsch")
	}

	// And "C" still outranks the sort when present — the sorted walk is only the
	// FALLBACK, not a replacement for the English preference.
	//
	// The locale here has to sort BEFORE "C" for this to prove anything, and that is
	// narrower than it looks: sort.Strings is bytewise, so every lowercase tag
	// ("ar", "de") sorts AFTER uppercase "C" and would pass under either rule. Only
	// an uppercase-initial tag earlier than C — dep11 writes territory variants like
	// "AR" — actually distinguishes them.
	const withC = "---\nPackage: p\nSummary:\n  AR: Arabic\n  C: English\n"
	if got := mustParse(t, withC)["p"].Summary; got != "English" {
		t.Errorf("Summary = %q, want %q: the C locale must beat a locale that sorts "+
			"before it, or the sorted fallback has replaced the English preference",
			got, "English")
	}
}

func TestParseAppStreamDep11UnionsKeywordsAcrossLocales(t *testing.T) {
	// Locale annotation is dropped and every locale's keywords are indexed together
	// — searching "Texteditor" should find the package even though the index is
	// nominally English. Asserted as a set because the locale map's iteration order
	// is randomised.
	const doc = "---\nPackage: p\nKeywords:\n  C:\n    - editor\n    - text\n  de:\n    - Texteditor\n"
	out := mustParse(t, doc)
	wantSameSet(t, "Keywords", out["p"].Keywords, []string{"editor", "text", "Texteditor"})
}

func TestParseAppStreamDep11NeverPopulatesDescription(t *testing.T) {
	// Pinned deliberately, matching the ApplyAppStream merge policy: the Packages
	// long description is authoritative for search recall, and AppStream
	// Descriptions are HTML marketing prose. AppStreamComponent has no Description
	// field at all, so the fixture's `Description:` block is parsed and discarded.
	//
	// If this ever starts failing, someone wired HTML into the overlay and it will
	// be rendered raw (or escaped and ugly) in the UI detail pane.
	if !strings.Contains(dep11StreamFixture, "<p>Marketing prose") {
		t.Fatal("fixture no longer carries a Description block; this guard proves nothing")
	}
	out := mustParse(t, dep11StreamFixture)
	if got := out["example-editor"].Description; got != "" {
		t.Errorf("Description = %q, want it left empty for the Packages parser", got)
	}
	// Same for the localised Name: AppStreamComponent parses it but the overlay
	// never carries it, because ApplyAppStream reads r.Name as the LOOKUP KEY. A
	// PackageRecord whose Name is "Example Editor" would never match the "Name" the
	// Packages parser produced, and — since ApplyAppStream never writes Name — the
	// only way it could get there is a future refactor.
	//
	// Asserted through ApplyAppStream, not just on the map value: checking the
	// overlay's Name field alone was too weak (mutation-testing showed a document
	// with no Name later in the stream resets it to "" anyway). This asserts the
	// thing that actually matters — the record's own Name survives the overlay.
	// A SINGLE-component stream, because the multi-component fixture masked this:
	// the second component for example-editor carries no Name, so an overlay that
	// did copy Name would have had it reset to "" by the second document and the
	// assertion would have passed anyway. Mutation-testing caught exactly that.
	single := mustParse(t, "---\nType: desktop-application\nID: org.example.Solo.desktop\n"+
		"Package: example-solo\nName:\n  C: Solo Display Name\n")
	if got := single["example-solo"].Name; got != "" {
		t.Errorf("overlay Name = %q, want it empty — Name is the lookup key, not a "+
			"display string", got)
	}
	recs := []schema.PackageRecord{{Name: "example-solo"}}
	ApplyAppStream(recs, single)
	if recs[0].Name != "example-solo" {
		t.Errorf("record Name = %q, want %q — the binary package name must survive the "+
			"overlay or every later lookup (indexing, dedup, the popcon join) misses",
			recs[0].Name, "example-solo")
	}
}

// --- Provides routing --------------------------------------------------------

func TestParseAppStreamDep11RoutesEachProvidesKindToItsOwnField(t *testing.T) {
	// dep11's Provides is a map of kind -> heterogeneous list. Each kind must land
	// in its own Provides sub-field because the Bleve mapping boosts them
	// independently; a mis-routed kind means "provides dbus service X" queries
	// silently match nothing while the data sits in the wrong bucket.
	//
	// This also asserts the two value SHAPES reach coerceStrings correctly (bare
	// strings for binaries, maps carrying id / service / name) — coerceStrings
	// itself is tested in appstream_apply_test.go and is not re-tested here.
	out := mustParse(t, dep11StreamFixture)
	ed := out["example-editor"].Provides

	wantOrdered(t, "Provides.Binary", ed.Binary, []string{"example-editor", "exed"})
	wantOrdered(t, "Provides.MimeType", ed.MimeType, []string{"text/plain", "text/markdown"})
	wantOrdered(t, "Provides.DBus", ed.DBus, []string{"org.example.Editor"}) // from {id: ...}
	wantOrdered(t, "Provides.Python", ed.Python, []string{"exedlib"})        // python3 -> Python
	wantOrdered(t, "Provides.Library", ed.Library, []string{"libexed.so.1"})
	wantOrdered(t, "Provides.Firmware", ed.Firmware, []string{"exed-fw.bin"}) // from {name: ...}

	rip := out["example-ripper"].Provides
	wantOrdered(t, "ripper Provides.Binary", rip.Binary, []string{"example-rip"})
	// {service: ...} is the systemd shape; it must reach DBus, not be dropped.
	wantOrdered(t, "ripper Provides.DBus", rip.DBus, []string{"example-ripper.service"})

	// An unrecognised kind is dropped rather than guessed at. The control that makes
	// this meaningful is that a RECOGNISED kind in the very same Provides map did
	// land (asserted above), so this is a per-kind filter and not a whole-map skip.
	if !strings.Contains(dep11StreamFixture, "dropped-on-purpose") {
		t.Fatal("fixture no longer carries an unknown Provides kind; guard is stale")
	}
	for _, field := range [][]string{
		ed.Binary, ed.MimeType, ed.DBus, ed.Python, ed.Library, ed.Firmware, ed.Font,
	} {
		for _, v := range field {
			if v == "dropped-on-purpose" {
				t.Errorf("an unrecognised Provides kind leaked into %v", field)
			}
		}
	}
}

func TestParseAppStreamDep11FoldsBothPythonKindsIntoOneField(t *testing.T) {
	// The spec has separate `python2` and `python3` kinds; both are indexed under
	// one Provides.Python facet. Losing python2 would silently drop the older half
	// of the corpus from "provides python module" queries. Set comparison: the two
	// kinds are two keys of one map, so their relative order is randomised.
	const doc = "---\nPackage: p\nProvides:\n  python2:\n    - legacy-mod\n  python3:\n    - modern-mod\n"
	out := mustParse(t, doc)
	wantSameSet(t, "Provides.Python", out["p"].Provides.Python,
		[]string{"legacy-mod", "modern-mod"})
}

// --- merging several components onto one package -----------------------------

func TestParseAppStreamDep11MergesComponentsSharingOnePackage(t *testing.T) {
	// One binary package routinely ships several components (a desktop app plus its
	// fonts, an app plus an addon). The parser must accumulate rather than clobber:
	// with last-write-wins, whichever component happened to come last in the stream
	// would be the only one enriching the record.
	out := mustParse(t, dep11StreamFixture)
	ed := out["example-editor"]

	// Summary is FIRST-wins, for stable output across crawls (the doc comment says
	// so explicitly). The second component's summary is deliberately loud so a
	// last-wins regression is unmistakable.
	if ed.Summary == "A SECOND component for the same binary package" {
		t.Error("Summary came from the LAST component; first-wins keeps results " +
			"stable when upstream reorders the stream")
	}
	if ed.Summary != "A small text editor" {
		t.Errorf("Summary = %q, want the first component's", ed.Summary)
	}

	// Keywords / Categories / Provides / Screenshots accumulate. Order is
	// deterministic here: each document has a single Keywords locale and documents
	// are visited in stream order.
	wantOrdered(t, "Keywords", ed.Keywords, []string{"editor", "text", "monospace"})
	wantOrdered(t, "Categories", ed.Categories, []string{"Utility", "TextEditor"})
	wantOrdered(t, "Provides.Font", ed.Provides.Font, []string{"Example Mono", "Example Serif"})

	// "Utility" appears in both documents; the union must collapse it or the UI
	// facet count double-counts.
	if strings.Count(strings.Join(ed.Categories, ","), "Utility") != 1 {
		t.Errorf("Categories = %v, want the duplicate Utility collapsed", ed.Categories)
	}
}

// --- screenshots -------------------------------------------------------------

func TestParseAppStreamDep11FlattensScreenshotsToSourceURLs(t *testing.T) {
	// Screenshots are flattened to a source-image URL list; thumbnails are not
	// cached in v1. A screenshot entry with ONLY thumbnails therefore contributes
	// nothing, and the same URL appearing in two components is deduplicated (the
	// detail pane would otherwise render the same image twice).
	out := mustParse(t, dep11StreamFixture)
	wantOrdered(t, "Screenshots", out["example-editor"].Screenshots, []string{
		"http://mirror.example.invalid/shots/editor-main.png",
		"http://mirror.example.invalid/shots/editor-prefs.png",
	})

	// Explicit: no thumbnail URL leaks in. Thumbnails are present in the fixture, so
	// this is a real exclusion and not a vacuous check.
	if !strings.Contains(dep11StreamFixture, "editor-main-thumb.png") ||
		!strings.Contains(dep11StreamFixture, "editor-thumb-only.png") {
		t.Fatal("fixture no longer carries thumbnails; this exclusion proves nothing")
	}
	for _, u := range out["example-editor"].Screenshots {
		if strings.Contains(u, "thumb") {
			t.Errorf("thumbnail URL %q leaked into Screenshots", u)
		}
	}

	// NOTE: the doc comment on the Screenshots loop says it prefers the `default`
	// screenshot's URL "when present; otherwise take all". The code takes ALL
	// source-image URLs unconditionally — `default: true` on the first entry has no
	// effect. Pinned as-is (both editor-main and editor-prefs land above); the
	// comment is the thing that is out of date, not the behaviour.
}

// --- malformed input ---------------------------------------------------------

func TestParseAppStreamDep11EmptyAndHeaderOnlyStreams(t *testing.T) {
	// A component that ships no dep11 data still has a Components-*.yml.gz on some
	// mirrors: an empty file, or a header with no components. Both must be an empty
	// overlay and a nil error, so the orchestrator takes the success path and
	// ingests the Packages-derived records unenriched.
	for _, c := range []struct{ name, body string }{
		{"empty body", ""},
		{"a bare newline", "\n"},
		{"document separator only", "---\n"},
		{"header with no components", "File: DEP-11\nOrigin: example-noble-main\nPriority: 100\n"},
		{"header then an empty document", "File: DEP-11\n---\n"},
	} {
		t.Run(c.name, func(t *testing.T) {
			out, err := ParseAppStreamDep11([]byte(c.body))
			if err != nil {
				t.Errorf("err = %v, want nil — an empty dep11 stream is not a failure", err)
			}
			if out == nil {
				t.Error("out = nil; ApplyAppStream tolerates a nil map but callers " +
					"log len(overlay), so a non-nil empty map is the contract")
			}
			if len(out) != 0 {
				t.Errorf("out = %v, want empty", out)
			}
		})
	}
}

func TestParseAppStreamDep11MalformedDocumentsDoNotPanic(t *testing.T) {
	// The crawler feeds this whatever a third-party mirror serves after gunzip. A
	// panic here takes down the crawl goroutine and, depending on recovery, the
	// whole pkgsvc process — far worse than a missing overlay. Every one of these
	// must come back as an ordinary error.
	//
	// Note which shapes are fatal: a type mismatch on ANY field of
	// AppStreamComponent aborts, including `Name` and screenshot `thumbnails`, which
	// the overlay never even uses. See the finding on
	// TestParseAppStreamDep11StopsAtTheFirstBadDocument.
	cases := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{"truncated mid-scalar", "---\nPackage: p\nSummary:\n  C: \"unterminated\n", true},
		{"truncated mid-flow-sequence", "---\nPackage: p\nCategories: [Utility, TextEdit", true},
		{"a tab where YAML wants spaces", "---\nPackage: p\n\tName: x\n", true},
		{"document is a bare scalar", "---\njust-a-scalar\n", true},
		{"document is a list", "---\n- a\n- b\n", true},
		{"Package is a list, not a string", "---\nPackage:\n  - p\n", true},
		{"Categories is a scalar, not a list", "---\nPackage: p\nCategories: notalist\n", true},
		{"Keywords is a scalar, not a locale map", "---\nPackage: p\nKeywords: notamap\n", true},
		{"Provides is a scalar, not a kind map", "---\nPackage: p\nProvides: notamap\n", true},
		{"a Provides kind holds a scalar, not a list", "---\nPackage: p\nProvides:\n  binaries: notalist\n", true},
		{"Screenshots is a scalar, not a list", "---\nPackage: p\nScreenshots: notalist\n", true},
		{"a Screenshots entry is a scalar", "---\nPackage: p\nScreenshots:\n  - notamap\n", true},
		{"Name is a bare string, not a locale map", "---\nPackage: p\nName: bare\n", true},
		// Shapes that are tolerated, so the table has controls and is not just a
		// list of things that happen to fail:
		{"an unknown top-level field is ignored", "---\nPackage: p\nFutureField: whatever\n", false},
		{"an unknown Provides kind is ignored", "---\nPackage: p\nProvides:\n  nosuchkind:\n    - x\n", false},
		{"a null document between components", "---\nPackage: p\n---\n---\nPackage: q\n", false},
		{"a non-string Provides entry is coerced away", "---\nPackage: p\nProvides:\n  binaries:\n    - 42\n", false},
		// A block list truncated after the dash is still well-formed YAML (the item
		// is null) and the empty Category is dropped downstream by mergeUnique, so
		// this is genuinely tolerated rather than an oversight.
		{"a block list truncated after a dash", "---\nPackage: p\nCategories:\n  - Utility\n  -", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// No recover(): a panic must fail the test loudly rather than be
			// swallowed into a "want error, got error" pass.
			out, err := ParseAppStreamDep11([]byte(c.body))
			if c.wantErr && err == nil {
				t.Errorf("err = nil, want a decode error for %q", c.body)
			}
			if !c.wantErr && err != nil {
				t.Errorf("err = %v, want nil for %q", err, c.body)
			}
			if out == nil {
				t.Error("out = nil even on the error path; the partial map must " +
					"always be returned so the caller can choose to use it")
			}
			// The message must name the stage so the orchestrator's warn line is
			// actionable. Either wording qualifies: a per-document type error is now
			// SKIPPED and reported as a partial parse, while a stream-level failure
			// still carries the "dep11 decode" context.
			if err != nil {
				msg := err.Error()
				if !strings.Contains(msg, "dep11 decode") && !errors.Is(err, ErrDep11PartialParse) {
					t.Errorf("err = %v, want either the dep11 decode context or the "+
						"ErrDep11PartialParse sentinel so the warn line names the stage", err)
				}
			}
		})
	}
}

func TestParseAppStreamDep11SkipsOneBadDocumentAndKeepsGoing(t *testing.T) {
	// THE FIX. This test previously pinned the opposite behaviour: the parser
	// RETURNED on the first decode error, so every component after a malformed one
	// was never seen, and the orchestrator's `err == nil` gate then discarded even
	// the partial map. One upstream typo cost a whole component its AppStream
	// enrichment — no summaries, no category facets, no screenshots for ~50k
	// records, visible only as a single warn line.
	//
	// Now a document that does not fit the struct is skipped and the stream
	// continues, so exactly one component is lost instead of all of them.
	//
	// The corpus is deliberately larger than the loss so "everything landed" and
	// "the skip is real" cannot both pass.
	const total, badAt = 50, 25
	var b strings.Builder
	b.WriteString("File: DEP-11\nOrigin: example-noble-main\n")
	for i := 0; i < total; i++ {
		fmt.Fprintf(&b, "---\nType: desktop-application\nID: org.example.P%02d\nPackage: pkg-%02d\n", i, i)
		if i == badAt {
			// A type mismatch on one field, the commonest real-world breakage.
			b.WriteString("Categories: not-a-list\n")
		} else {
			fmt.Fprintf(&b, "Summary:\n  C: package %02d\n", i)
		}
	}

	out, err := ParseAppStreamDep11([]byte(b.String()))

	// A partial parse still reports itself — silence would make a mirror publishing
	// malformed dep11 indistinguishable from a clean crawl.
	if err == nil {
		t.Fatal("err = nil; a skipped document must still be reported so the crawl " +
			"logs it")
	}
	if !errors.Is(err, ErrDep11PartialParse) {
		t.Errorf("errors.Is(err, ErrDep11PartialParse) = false; err = %v. The "+
			"orchestrator keys on this sentinel to decide the overlay is still "+
			"usable, so a plain error here would throw the whole map away again", err)
	}

	// Only the malformed document is lost. This is the assertion that would have
	// failed before the fix, when 25 of 50 were dropped.
	if len(out) != total-1 {
		t.Errorf("overlay has %d entries, want %d (everything but the one malformed "+
			"document)", len(out), total-1)
	}
	if _, ok := out[fmt.Sprintf("pkg-%02d", badAt)]; ok {
		t.Errorf("pkg-%02d landed, but its document is the malformed one", badAt)
	}
	// Components on BOTH sides of the bad document must be present — the trailing
	// half is what the old behaviour lost.
	for _, i := range []int{0, badAt - 1, badAt + 1, total - 1} {
		name := fmt.Sprintf("pkg-%02d", i)
		if got := out[name].Summary; got != fmt.Sprintf("package %02d", i) {
			t.Errorf("%s Summary = %q, want it parsed; components after the bad "+
				"document must survive", name, got)
		}
	}
}

func TestParseAppStreamDep11ReportsHowMuchItSkipped(t *testing.T) {
	// The error text is what lands in the crawl log, so it has to say enough for an
	// operator to judge severity: one bad document in a healthy stream is noise,
	// while thousands means the mirror changed format and the enrichment is
	// effectively gone.
	var b strings.Builder
	b.WriteString("File: DEP-11\n")
	for i := range 4 {
		fmt.Fprintf(&b, "---\nPackage: bad-%d\nCategories: not-a-list\n", i)
	}
	fmt.Fprintf(&b, "---\nPackage: good\nSummary:\n  C: fine\n")

	out, err := ParseAppStreamDep11([]byte(b.String()))
	if err == nil {
		t.Fatal("err = nil, want a partial-parse report")
	}
	if len(out) != 1 {
		t.Fatalf("overlay has %d entries, want 1 (only the good component)", len(out))
	}
	// Both numbers, so the ratio is legible.
	for _, want := range []string{"4 document(s) skipped", "1 component(s) parsed"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %q, want it to contain %q", err, want)
		}
	}
}

func TestParseAppStreamDep11StillFailsOnAnUnreadableStream(t *testing.T) {
	// The skip is scoped to yaml.TypeError — one document not fitting the struct.
	// A stream that is not parseable YAML at all is a different failure: there is
	// nothing to skip to, so it must still be fatal rather than silently yielding an
	// empty overlay that the orchestrator would happily apply.
	broken := []byte("File: DEP-11\n---\nPackage: p\n  bad: [indentation\n\t\ttabs\n")
	out, err := ParseAppStreamDep11(broken)
	if err == nil {
		t.Fatalf("err = nil for unparseable YAML; got %d entries", len(out))
	}
	if errors.Is(err, ErrDep11PartialParse) {
		t.Error("a syntactically broken stream was reported as a PARTIAL parse; the " +
			"orchestrator would then apply the overlay from a stream it could not read")
	}
}

func TestParseAppStreamDep11ParsesALargeCleanStream(t *testing.T) {
	// The happy-path counterpart to the test above: with no bad document, all 50
	// components land, each with its own summary. This is the control that proves
	// the abort test measures the abort and not some cap on the number of documents.
	const total = 50
	var b strings.Builder
	b.WriteString("File: DEP-11\nOrigin: example-noble-main\n")
	for i := 0; i < total; i++ {
		fmt.Fprintf(&b, "---\nType: desktop-application\nID: org.example.P%02d\nPackage: pkg-%02d\nSummary:\n  C: package %02d\n", i, i, i)
	}
	out := mustParse(t, b.String())
	if len(out) != total {
		t.Fatalf("overlay has %d entries, want all %d", len(out), total)
	}
	for i := 0; i < total; i++ {
		k := fmt.Sprintf("pkg-%02d", i)
		if got, want := out[k].Summary, fmt.Sprintf("package %02d", i); got != want {
			t.Errorf("%s Summary = %q, want %q", k, got, want)
		}
	}
}
