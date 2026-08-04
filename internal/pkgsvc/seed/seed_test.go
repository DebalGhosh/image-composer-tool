// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package seed

import (
	"encoding/json"
	"io/fs"
	"path/filepath"
	"testing"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/index"
)

// This package was at 0%. It translates the LEGACY compact shard format
// ({n,v,d,a,s,r,o,t,p}) into the enriched schema at boot, and it is what makes the
// index non-empty before any crawl has run — so /readyz can report ready and the
// backend can serve searches on a cold start.
//
// A mistranslation here is silent: records index successfully but under the wrong
// os/release/component, so a search filtered by OS returns nothing and looks like
// an empty index rather than a mapping bug.

// --- splitOSRelease ----------------------------------------------------------

func TestSplitOSReleaseKnownIds(t *testing.T) {
	// The four suites ICT actually ships. The release CODENAME matters: the
	// enriched schema and the Bleve mapping both key on it, and the compact format
	// only carries the UI-facing id ("ubuntu24").
	cases := map[string]struct{ family, release string }{
		"ubuntu24": {"ubuntu", "noble"},
		"ubuntu22": {"ubuntu", "jammy"},
		"debian13": {"debian", "trixie"},
		"debian12": {"debian", "bookworm"},
	}
	for in, want := range cases {
		family, release := splitOSRelease(in)
		if family != want.family || release != want.release {
			t.Errorf("splitOSRelease(%q) = (%q, %q), want (%q, %q)",
				in, family, release, want.family, want.release)
		}
	}
}

func TestSplitOSReleaseUnknownStripsDigitsAndBlanksRelease(t *testing.T) {
	// The fallback. Release is left EMPTY rather than guessed — a wrong codename
	// would put the record in a suite that does not exist, where nothing finds it.
	// The comment in the source is explicit that the record still indexes.
	cases := map[string]string{
		"fedora40":  "fedora",
		"rhel9":     "rhel",
		"alpine319": "alpine",
		"ubuntu26":  "ubuntu", // a future suite the switch has not learned yet
	}
	for in, wantFamily := range cases {
		family, release := splitOSRelease(in)
		if family != wantFamily {
			t.Errorf("splitOSRelease(%q) family = %q, want %q", in, family, wantFamily)
		}
		if release != "" {
			t.Errorf("splitOSRelease(%q) release = %q, want empty — never guess a codename",
				in, release)
		}
	}
}

func TestSplitOSReleaseNoDigitsPassesThrough(t *testing.T) {
	for _, in := range []string{"ubuntu", "debian", "fedora"} {
		family, release := splitOSRelease(in)
		if family != in || release != "" {
			t.Errorf("splitOSRelease(%q) = (%q, %q), want (%q, \"\")", in, family, release, in)
		}
	}
}

func TestSplitOSReleaseAllDigitsIsUnchanged(t *testing.T) {
	// `if i > 0` guards this. Stripping every character would return an EMPTY
	// family, and a record with no OS is unfilterable — worse than a nonsense one.
	for _, in := range []string{"24", "9", "0"} {
		family, _ := splitOSRelease(in)
		if family != in {
			t.Errorf("splitOSRelease(%q) family = %q, want it unchanged rather than emptied",
				in, family)
		}
	}
}

func TestSplitOSReleaseEmptyInput(t *testing.T) {
	family, release := splitOSRelease("")
	if family != "" || release != "" {
		t.Errorf("splitOSRelease(\"\") = (%q, %q), want both empty", family, release)
	}
}

func TestSplitOSReleaseIsCaseSensitive(t *testing.T) {
	// Pinned as current behaviour. "Ubuntu24" misses the switch and falls to the
	// digit-strip, yielding family "Ubuntu" with no release — which would not match
	// index records stored as "ubuntu". Harmless while every shard is generated
	// lowercase, but recorded so a future case-fold is deliberate.
	family, release := splitOSRelease("Ubuntu24")
	if family != "Ubuntu" || release != "" {
		t.Errorf("splitOSRelease(\"Ubuntu24\") = (%q, %q); the switch is case-sensitive "+
			"so this takes the fallback", family, release)
	}
}

// --- expand ------------------------------------------------------------------

func TestExpandTranslatesEveryField(t *testing.T) {
	got := expand(compactRecord{
		Name:        "vim",
		Version:     "2:9.1.0016-1ubuntu7",
		Description: "Vi IMproved",
		Arch:        "amd64",
		Section:     "editors",
		Repository:  "noble-updates/main",
		OS:          "ubuntu24",
		Type:        "deb",
		Provides:    []string{"editor", "vim"},
	})

	if got.Name != "vim" || got.Version != "2:9.1.0016-1ubuntu7" {
		t.Errorf("identity wrong: %+v", got)
	}
	if got.OS != "ubuntu" || got.Release != "noble" {
		t.Errorf("(OS, Release) = (%q, %q), want (ubuntu, noble)", got.OS, got.Release)
	}
	if got.Arch != "amd64" || got.Section != "editors" {
		t.Errorf("passthrough wrong: %+v", got)
	}
	if got.Component != "main" {
		t.Errorf("Component = %q, want main from %q", got.Component, "noble-updates/main")
	}
	if len(got.Provides.Binary) != 2 {
		t.Errorf("Provides.Binary = %v, want the compact `p` list", got.Provides.Binary)
	}
}

func TestExpandConflatesSummaryAndDescription(t *testing.T) {
	// The legacy format has ONE text field, so both enriched fields get it. Worth
	// pinning: a future reader might "fix" this by blanking Summary, and the
	// legacy projection prefers Summary — so search result rows would go blank.
	got := expand(compactRecord{Description: "the only text there is"})
	if got.Summary != "the only text there is" {
		t.Errorf("Summary = %q, want the compact description", got.Summary)
	}
	if got.Description != "the only text there is" {
		t.Errorf("Description = %q, want the same value", got.Description)
	}
}

func TestExpandComponentParsing(t *testing.T) {
	cases := []struct {
		repository string
		want       string
		why        string
	}{
		{"noble-updates/main", "main", "everything after the last slash"},
		{"noble/universe", "universe", "simple pocket/component"},
		{"a/b/multiverse", "multiverse", "LastIndex, not first"},
		{"", "main", "no slash at all falls back to main"},
		{"noble-updates", "main", "no slash falls back to main"},
	}
	for _, c := range cases {
		got := expand(compactRecord{Repository: c.repository}).Component
		if got != c.want {
			t.Errorf("Repository %q -> Component %q, want %q (%s)",
				c.repository, got, c.want, c.why)
		}
	}
}

func TestExpandTrailingSlashYieldsAnEmptyComponent(t *testing.T) {
	// ⚠️ The "main" default does NOT hold here, and that is the point. A
	// repository of "noble/" has its slash at index 5, so `idx > 0` PASSES and the
	// component becomes `c.Repository[6:]` — the empty string. The default is only
	// a default until the guard is satisfied; it is not a validity check on the
	// result.
	//
	// A record with an empty component is filed under no component at all, so a
	// component-filtered search cannot see it. Not reachable from the shipped
	// shards (every `r` is "<pocket>/<component>"), but pinned so the asymmetry
	// with the leading-slash case below is documented rather than surprising.
	if got := expand(compactRecord{Repository: "noble/"}).Component; got != "" {
		t.Errorf("Repository %q -> Component %q, want the empty string: the `idx > 0` "+
			"guard passes and the slice is empty, so \"main\" is overwritten", "noble/", got)
	}
}

func TestExpandLeadingSlashRepositoryFallsBackToMain(t *testing.T) {
	// ⚠️ THE `idx > 0` GUARD, pinned. A repository of "/restricted" has its slash
	// at index 0, so the condition is false and the component stays "main" rather
	// than becoming "restricted".
	//
	// Defensible — a leading slash is malformed input and "main" is the safe
	// default — but it is NOT what a reader skimming `LastIndex` would predict, and
	// a record filed under the wrong component is invisible to a component-filtered
	// search. Recorded as current behaviour.
	got := expand(compactRecord{Repository: "/restricted"}).Component
	if got != "main" {
		t.Errorf("Repository %q -> Component %q, want main: the `idx > 0` guard rejects "+
			"a slash at position 0", "/restricted", got)
	}
	// Contrast: one character before the slash and it parses.
	if got := expand(compactRecord{Repository: "x/restricted"}).Component; got != "restricted" {
		t.Errorf("Repository %q -> Component %q, want restricted", "x/restricted", got)
	}
}

func TestExpandEmptyProvidesIsCarriedThrough(t *testing.T) {
	// The compact `p` field is omitempty, so most records have none. It must arrive
	// as an absent/empty list, not cause a panic.
	got := expand(compactRecord{Name: "libfoo"})
	if len(got.Provides.Binary) != 0 {
		t.Errorf("Provides.Binary = %v, want empty", got.Provides.Binary)
	}
}

func TestExpandDoesNotPopulateEnrichedOnlyFields(t *testing.T) {
	// Seed data is legacy: it has no DebTags, AppStream or popcon signal. Those
	// fields must stay zero so a later crawl can fill them, and so the ranking
	// treats a seeded record as having no popularity signal rather than a real
	// score of zero being indistinguishable from "unknown".
	got := expand(compactRecord{Name: "vim", Description: "d", OS: "ubuntu24"})
	if len(got.Tags) != 0 || len(got.Categories) != 0 || len(got.Keywords) != 0 {
		t.Errorf("facets should be empty for seed data: tags=%v categories=%v keywords=%v",
			got.Tags, got.Categories, got.Keywords)
	}
	if got.Popularity.Inst != 0 || got.Popularity.Vote != 0 {
		t.Errorf("Popularity = %+v, want zero — seed data carries no popcon signal",
			got.Popularity)
	}
	if got.Homepage != "" || got.SourceURL != "" {
		t.Errorf("Homepage/SourceURL should be empty: %q / %q", got.Homepage, got.SourceURL)
	}
}

// --- LoadEmbedded ------------------------------------------------------------

func TestLoadEmbeddedRejectsANilIndex(t *testing.T) {
	// Called at boot from cmd/ict-pkgsvc. A nil index is a programming error, and
	// erroring beats a nil-deref panic during startup.
	n, err := LoadEmbedded(nil)
	if err == nil {
		t.Fatal("expected an error for a nil index")
	}
	if n != 0 {
		t.Errorf("count = %d, want 0 on error", n)
	}
}

// countEmbeddedRecords parses the shards independently of LoadEmbedded so the
// expected total is derived from the data rather than hard-coded. A hard-coded 44
// would start failing the day someone adds a shard, which is exactly the kind of
// brittle assertion that gets tests deleted.
//
// Note what this does NOT protect: because both sides are derived from the same
// files, a shard going MISSING lowers the expectation too and the comparison still
// passes. TestSeedCorpusInventory below is what catches that.
func countEmbeddedRecords(t *testing.T) int {
	t.Helper()
	entries, err := fs.ReadDir(EmbeddedShards, "data")
	if err != nil {
		t.Fatalf("the embedded data/ subtree is unreadable: %v", err)
	}
	var total int
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := fs.ReadFile(EmbeddedShards, filepath.Join("data", e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		var recs []compactRecord
		if err := json.Unmarshal(data, &recs); err != nil {
			t.Fatalf("%s is not a compactRecord array: %v", e.Name(), err)
		}
		total += len(recs)
	}
	return total
}

func TestSeedCorpusInventory(t *testing.T) {
	// The one assertion here that is deliberately NOT derived from the data. The
	// package doc calls the seed corpus "the same 32-record corpus we've served for
	// months", and it is the fallback that keeps /search answering when
	// PKGSVC_CRAWLER_ENABLED=false. If a shard silently disappears — a bad rebase, a
	// tooling change that stops emitting one — every derived comparison still passes,
	// because both sides shrink together. Only naming the suites catches it.
	//
	// Deliberately asserts the SUITES and a floor on the total, not an exact count:
	// adding records to an existing shard is normal maintenance and should not fail,
	// whereas losing a whole suite is a regression.
	entries, err := fs.ReadDir(EmbeddedShards, "data")
	if err != nil {
		t.Fatal(err)
	}
	present := map[string]bool{}
	for _, e := range entries {
		present[e.Name()] = true
	}
	for _, want := range []string{"ubuntu24-amd64.json", "debian13-amd64.json"} {
		if !present[want] {
			t.Errorf("shard %s is missing from the embedded corpus; a whole suite would "+
				"vanish from cold-start search results with no error anywhere", want)
		}
	}
	if n := countEmbeddedRecords(t); n < 32 {
		t.Errorf("the seed corpus is down to %d records; the package doc describes a "+
			"~32-record floor, so this is data loss rather than maintenance", n)
	}
}

func TestLoadEmbeddedIngestsEveryShardIntoARealIndex(t *testing.T) {
	// THE ONE THAT MATTERS. This is the boot path with PKGSVC_CRAWLER_ENABLED=false:
	// if it silently ingests zero records the service comes up "healthy" with an
	// empty index and every package search returns blank.
	//
	// Uses a real Bleve index in t.TempDir() rather than a fake, because the failure
	// this guards against — IngestBatch erroring per shard, which LoadEmbedded
	// swallows by design — only shows up against the real mapping.
	idx, err := index.NewIndex(filepath.Join(t.TempDir(), "idx"))
	if err != nil {
		t.Fatalf("NewIndex: %v", err)
	}
	defer func() {
		if err := idx.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	}()

	want := countEmbeddedRecords(t)
	if want == 0 {
		t.Fatal("no embedded records at all — the shards or the //go:embed pattern broke")
	}

	got, err := LoadEmbedded(idx)
	if err != nil {
		t.Fatalf("LoadEmbedded: %v", err)
	}
	if got != want {
		t.Errorf("LoadEmbedded ingested %d records, want %d from the shards. A shortfall "+
			"means IngestBatch errored and was swallowed per-shard", got, want)
	}
	// The returned count is only a claim about what was ATTEMPTED; ask the index.
	if n := idx.DocCount(); n != want {
		t.Errorf("index DocCount = %d, want %d — the records did not actually land", n, want)
	}
}

func TestEmbedPatternExcludesTheNonShardFiles(t *testing.T) {
	// `data/` on disk holds index.yaml next to the shards, and the //go:embed
	// pattern is `data/*.json` — so the YAML is never embedded at all. Worth
	// asserting because the alternative spelling (`all:data` or `data`) would pull
	// it in, json.Unmarshal would fail, and LoadEmbedded SWALLOWS per-file errors
	// by design — so the only symptom would be a quietly lower record count.
	//
	// Corollary: the loop's own `filepath.Ext(...) != ".json"` check is defensive
	// and currently unreachable. It stays as belt-and-braces for a future widening
	// of the pattern, which is why no test drives it.
	entries, err := fs.ReadDir(EmbeddedShards, "data")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("nothing embedded under data/")
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".json" {
			t.Errorf("%s is embedded but is not a .json shard; widen the loop's filter "+
				"or narrow the //go:embed pattern", e.Name())
		}
	}
	// And the file that must NOT be there.
	if _, err := fs.ReadFile(EmbeddedShards, "data/index.yaml"); err == nil {
		t.Error("data/index.yaml is embedded; the //go:embed pattern must stay data/*.json")
	}
}

func TestLoadEmbeddedIsIdempotentByDocID(t *testing.T) {
	// Re-running the loader over the same index must not duplicate documents —
	// DocID is os/release/arch/component/name, all five derived deterministically
	// from the shard, so a second pass overwrites rather than appends. Reachable:
	// the seed loader runs at boot and an operator can trigger /admin/refresh,
	// which re-ingests over the live index.
	//
	// This is also why expand's component parsing matters beyond filtering: a
	// change to how the component is derived changes every DocID, and the next
	// seed load would then ADD a second copy of all 44 records instead of
	// replacing them.
	idx, err := index.NewIndex(filepath.Join(t.TempDir(), "idx"))
	if err != nil {
		t.Fatalf("NewIndex: %v", err)
	}
	defer func() {
		if err := idx.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	}()

	if _, err := LoadEmbedded(idx); err != nil {
		t.Fatalf("first LoadEmbedded: %v", err)
	}
	first := idx.DocCount()
	if _, err := LoadEmbedded(idx); err != nil {
		t.Fatalf("second LoadEmbedded: %v", err)
	}
	if second := idx.DocCount(); second != first {
		t.Errorf("DocCount went %d -> %d across two loads; seeding must be idempotent",
			first, second)
	}
}

func TestLoadEmbeddedProducesFindableRecords(t *testing.T) {
	// End-to-end: the whole point of seeding is that /search works on a cold start.
	// Asserting only DocCount would pass even if every record were expanded into
	// the wrong OS, which is the exact silent failure the expand tests above guard
	// field by field. This closes the loop by querying the way the handler does.
	idx, err := index.NewIndex(filepath.Join(t.TempDir(), "idx"))
	if err != nil {
		t.Fatalf("NewIndex: %v", err)
	}
	defer func() {
		if err := idx.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	}()
	if _, err := LoadEmbedded(idx); err != nil {
		t.Fatalf("LoadEmbedded: %v", err)
	}

	// The shards are ubuntu24-amd64 and debian13-amd64, so both families must be
	// reachable under their SPLIT names — "ubuntu", not "ubuntu24".
	for _, os := range []string{"ubuntu", "debian"} {
		hits, total, err := idx.Search(index.SearchOpts{OS: os, Limit: 5})
		if err != nil {
			t.Errorf("Search(OS=%q): %v", os, err)
			continue
		}
		if total == 0 || len(hits) == 0 {
			t.Errorf("Search(OS=%q) found nothing; splitOSRelease and the index disagree "+
				"about the family name", os)
		}
	}
	// And nothing may be filed under the unsplit compact id.
	if _, total, err := idx.Search(index.SearchOpts{OS: "ubuntu24", Limit: 1}); err == nil && total > 0 {
		t.Errorf("Search(OS=\"ubuntu24\") found %d records; the compact id must be split "+
			"into a family before indexing", total)
	}
}
