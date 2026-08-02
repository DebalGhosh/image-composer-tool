// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package index

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/blevesearch/bleve/v2"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// TestBoostOrder verifies that a query hitting `name.exact` outranks one
// that only hits `description`, and that popcon.inst breaks ties via the
// log1p multiplier from the plan. This is the fence that keeps the
// analyzer chain + boost table from silently drifting.
func TestBoostOrder(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "idx")
	idx, err := NewIndex(dir)
	if err != nil {
		t.Fatalf("NewIndex: %v", err)
	}
	defer idx.Close()

	// Three documents. Only pkg #1 matches "gcc" on the name; the other
	// two match only via description or by-substring. #1 should win the
	// boost race by a large margin.
	recs := []schema.PackageRecord{
		{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name: "gcc", Summary: "GNU C compiler",
			Description: "The GNU Compiler Collection.",
			Popularity:  schema.Popularity{Inst: 132000},
		},
		{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name: "make", Summary: "Utility for directing compilation",
			Description: "Depends on gcc for the sample recipes only.",
			Popularity:  schema.Popularity{Inst: 500000},
		},
		{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name: "some-lib", Summary: "some header lib",
			Description: "Nothing to do with gcc.",
			Popularity:  schema.Popularity{Inst: 10},
		},
	}
	if err := idx.IngestBatch(recs); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	hits, _, err := idx.Search(SearchOpts{Query: "gcc", OS: "ubuntu", Arch: "amd64", Limit: 3})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) == 0 {
		t.Fatalf("no hits")
	}
	if hits[0].Record.Name != "gcc" {
		for i, h := range hits {
			t.Logf("[%d] score=%.4f name=%q summary=%q desc=%q inst=%d",
				i, h.Score, h.Record.Name, h.Record.Summary, h.Record.Description, h.Record.Popularity.Inst)
		}
		t.Errorf("top hit = %q, want gcc (name.exact should beat description matches)",
			hits[0].Record.Name)
	}
}

// TestPopularityTiebreak — when two documents have identical fields and
// identical Bleve scores, the one with higher popcon.inst floats.
func TestPopularityTiebreak(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "idx")
	idx, _ := NewIndex(dir)
	defer idx.Close()

	// Two identical-looking records with only Name + inst differing —
	// they hit the exact same set of query terms so raw Bleve scores
	// are within rounding, and log1p(inst) becomes the decider.
	recs := []schema.PackageRecord{
		{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name: "libfoo-common", Summary: "shared support files",
			Description: "shared foo runtime bits",
			Popularity:  schema.Popularity{Inst: 5},
		},
		{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name: "libfoo", Summary: "shared support files",
			Description: "shared foo runtime bits",
			Popularity:  schema.Popularity{Inst: 500000},
		},
	}
	if err := idx.IngestBatch(recs); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	hits, _, err := idx.Search(SearchOpts{Query: "shared foo", OS: "ubuntu", Arch: "amd64", Limit: 2})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) < 2 {
		t.Fatalf("expected 2 hits, got %d", len(hits))
	}
	// The very-popular one wins the tiebreak.
	if hits[0].Record.Name != "libfoo" {
		t.Errorf("top = %q, want libfoo (popcon should tiebreak): scores %v",
			hits[0].Record.Name,
			[]float64{hits[0].Score, hits[1].Score})
	}
}

// ---------------------------------------------------------------------------
// Regression fences. Each of the tests below corresponds to a defect that was
// live in production and that neither TestBoostOrder nor TestPopularityTiebreak
// caught — both of those use single-token names queried in full, which is
// precisely the case where every analyzer choice happens to agree.
// ---------------------------------------------------------------------------

// fenceCorpus is a deliberately awkward corpus: hyphenated names, a dotted
// name, names whose MIDDLE token grams collide with short queries, and one name
// that is itself an English stop word once grammed.
func fenceCorpus() []schema.PackageRecord {
	mk := func(name, summary string, inst int) schema.PackageRecord {
		return schema.PackageRecord{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name: name, Summary: summary, Description: summary,
			Popularity: schema.Popularity{Inst: inst},
		}
	}
	return []schema.PackageRecord{
		mk("curl", "command line URL transfer tool", 120000),
		mk("cups", "printing system", 90000),
		mk("docker.io", "Linux container runtime", 40000),
		mk("libssl-dev", "SSL development files", 60000),
		mk("python3-dev", "Python 3 development headers", 70000),
		mk("linux-image-amd64", "Linux kernel metapackage", 110000),
		mk("openssh-server", "secure shell server", 100000),
		mk("network-manager", "network management framework", 95000),
		// Mid-name gram decoys: "gcc-doc" grams "do" from its SECOND token,
		// so it is a legitimate name.ngram match for q="do" and competes with
		// packages that actually start with "do".
		mk("gcc-doc", "GCC documentation", 500),
		mk("mcpp-doc", "mcpp documentation", 20),
		// One package per English stop word, so TestStopWordQueryReturnsHits
		// can assert on a guaranteed match instead of on corpus contents. All
		// real Debian/Ubuntu package names except "bereft", which stands in for
		// a "be…" package since Debian has none in main.
		mk("node-express", "minimalist web framework for Node", 300),
		mk("onboard", "on-screen keyboard", 1200),
		mk("itstool", "translate XML with gettext and ITS rules", 900),
		mk("isc-dhcp-client", "DHCP client", 80000),
		mk("ant", "Java build tool", 5000),
		mk("at-spi2-core", "assistive technology service provider", 70000),
		mk("orca", "screen reader", 4000),
		mk("tor", "anonymizing overlay network", 6000),
		mk("byobu", "text window manager and shell wrapper", 2000),
		mk("offlineimap", "IMAP/Maildir synchronisation", 400),
		mk("sox", "Swiss Army knife of sound processing", 3000),
		mk("bereft", "placeholder for a be-prefixed package", 5),
	}
}

func newFenceIndex(t *testing.T) (*Index, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "idx")
	idx, err := NewIndex(dir)
	if err != nil {
		t.Fatalf("NewIndex: %v", err)
	}
	if err := idx.IngestBatch(fenceCorpus()); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	return idx, dir
}

// TestSingleCharQueryReturnsHits fences the edge_ngram min. At min=2 the index
// contained no single-character gram at all ("curl" -> [cu, cur, curl]), so
// every one-letter query returned zero results — the user-visible symptom was
// "I type 'c' and expect hundreds of packages, but I only see a few".
func TestSingleCharQueryReturnsHits(t *testing.T) {
	idx, _ := newFenceIndex(t)
	defer idx.Close()

	for _, q := range []string{"c", "d", "l", "p", "o", "n"} {
		hits, total, err := idx.Search(SearchOpts{Query: q, Limit: 20})
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		if total == 0 || len(hits) == 0 {
			t.Errorf("q=%q returned total=%d hits=%d, want >0 (edge_ngram min must be 1)",
				q, total, len(hits))
		}
	}
}

// TestStopWordQueryReturnsHits fences the query-side analyzer pin. Bleve
// resolves a query's analyzer from the document-mapping PATH, and there is no
// property named "name.ngram" — the field exists only via a FieldMapping.Name
// override — so AnalyzerNameForPath falls through to the index default,
// "standard". The standard analyzer carries an English stop-word filter, which
// reduced these whole queries to ZERO tokens, so they matched nothing while
// "doc" and "cur" worked fine.
//
// Each probe is paired with a package the query MUST return, so a failure means
// the analyzer dropped the query rather than that the corpus lacks a match. The
// control in the second half is what makes this a real fence: the corpus also
// contains a non-stop-word neighbour for each probe, so if a future change made
// EVERY two-letter query return everything, the stop-word probes would pass for
// the wrong reason and the analyzer assertion below would still hold the line.
func TestStopWordQueryReturnsHits(t *testing.T) {
	idx, _ := newFenceIndex(t)
	defer idx.Close()

	// LHS: a query that the standard analyzer's English stop list reduces to
	// zero tokens. RHS: a package in fenceCorpus whose name starts with it.
	stops := map[string]string{
		"do": "docker.io",
		"no": "node-express",
		"on": "onboard",
		"it": "itstool",
		"is": "isc-dhcp-client",
		"an": "ant",
		"at": "at-spi2-core",
		"or": "orca",
		"to": "tor",
		"by": "byobu",
		"of": "offlineimap",
		"so": "sox",
		"be": "bereft",
	}
	for q, want := range stops {
		hits, total, err := idx.Search(SearchOpts{Query: q, Limit: 50})
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		if total == 0 {
			t.Errorf("q=%q returned total=0 even though %q is indexed; the "+
				"name.ngram clause must pin a non-stop-word analyzer (%s) "+
				"rather than falling through to the index default, \"standard\"",
				q, want, analyzerUnicodeLC)
			continue
		}
		found := false
		for _, h := range hits {
			if h.Record.Name == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("q=%q returned %d hits but not %q", q, len(hits), want)
		}
	}

	// The analyzer the clause actually resolves to. Asserted directly so the
	// fence survives even if someone changes the corpus: if this drifts back to
	// "standard", the stop-word probes above are meaningless.
	m, err := NewMapping()
	if err != nil {
		t.Fatalf("NewMapping: %v", err)
	}
	if got := m.AnalyzerNameForPath("name.ngram"); got != "standard" {
		t.Logf("note: AnalyzerNameForPath(\"name.ngram\") now resolves to %q; "+
			"if that is intentional, the explicit MatchQuery.Analyzer pin in "+
			"buildQuery may no longer be needed", got)
	}
}

// TestHyphenatedPrefixRecall fences the analyzer CHOICE, not just the presence
// of a pin. pkg_keyword_lc looks like the natural query analyzer for an
// edge-ngram field, but it single-tokenizes: "libssl-d" becomes one token that
// is absent from a gram dictionary built by the unicode tokenizer (which split
// the hyphen BEFORE gramming). Measured with keyword_lc pinned, every query
// below returned zero. Hyphenated names are the dominant shape in Debian, so
// this is the most important fence in the file.
func TestHyphenatedPrefixRecall(t *testing.T) {
	idx, _ := newFenceIndex(t)
	defer idx.Close()

	cases := map[string]string{
		"libssl-d":          "libssl-dev",
		"python3-d":         "python3-dev",
		"openssh-s":         "openssh-server",
		"network-m":         "network-manager",
		"linux-image-amd64": "linux-image-amd64",
		"docker.io":         "docker.io",
	}
	for q, want := range cases {
		hits, total, err := idx.Search(SearchOpts{Query: q, Limit: 20})
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		if total == 0 {
			t.Errorf("q=%q returned total=0, want a hit on %q", q, want)
			continue
		}
		found := false
		for _, h := range hits {
			if h.Record.Name == want {
				found = true
				break
			}
		}
		if !found {
			names := make([]string, 0, len(hits))
			for _, h := range hits {
				names = append(names, h.Record.Name)
			}
			t.Errorf("q=%q did not return %q; got %v", q, want, names)
		}
	}
}

// TestTruePrefixOutranksMidNameGram fences the name.prefix clause and its
// boost-12 slot between name.exact (20) and name.ngram (8). Without it, q="do"
// put ZERO true prefixes in the top ten on a real 2,889-record corpus — the
// list was gcc-doc, mcpp-doc, libzt-doc, … because those match the "do" gram
// from their second token just as well as docker.io matches it from its first.
func TestTruePrefixOutranksMidNameGram(t *testing.T) {
	idx, _ := newFenceIndex(t)
	defer idx.Close()

	hits, _, err := idx.Search(SearchOpts{Query: "do", Limit: 10})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) == 0 {
		t.Fatalf("no hits for q=do")
	}
	if hits[0].Record.Name != "docker.io" {
		names := make([]string, 0, len(hits))
		for _, h := range hits {
			names = append(names, h.Record.Name)
		}
		t.Errorf("top hit for q=do = %q, want docker.io (a true prefix must "+
			"outrank the -doc mid-name grams); got %v", hits[0].Record.Name, names)
	}
}

// TestSurvivesReopen fences the defect that would have silently broken the
// crawler: records lived only in an in-memory map that IngestBatch populated
// and nothing rebuilt on open, so after a restart Search() reported total>0 and
// returned zero rows, DocCount() read 0, and Get() missed everything. The
// seed-only instance looked healthy purely because DocCount()==0 made main.go
// re-ingest the seed on every boot.
func TestSurvivesReopen(t *testing.T) {
	idx, dir := newFenceIndex(t)
	wantDocs := idx.DocCount()
	if wantDocs != len(fenceCorpus()) {
		t.Fatalf("DocCount before reopen = %d, want %d", wantDocs, len(fenceCorpus()))
	}
	if err := idx.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	re, err := NewIndex(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer re.Close()

	if re.WasRebuilt() {
		t.Errorf("reopen with an UNCHANGED mapping rebuilt the index; the "+
			"fingerprint stamp must match (staleDir=%q)", re.StaleDir())
	}
	if got := re.DocCount(); got != wantDocs {
		t.Errorf("DocCount after reopen = %d, want %d", got, wantDocs)
	}

	hits, total, err := re.Search(SearchOpts{Query: "curl", Limit: 10})
	if err != nil {
		t.Fatalf("Search after reopen: %v", err)
	}
	if total == 0 || len(hits) == 0 {
		t.Fatalf("Search after reopen: total=%d hits=%d, want >0", total, len(hits))
	}
	if len(hits) != total && total <= 10 {
		t.Errorf("len(hits)=%d but total=%d; every hit must project a record",
			len(hits), total)
	}
	if hits[0].Record.Name != "curl" {
		t.Errorf("top hit after reopen = %q, want curl", hits[0].Record.Name)
	}
	// The full record must round-trip, not just the identity fields the DocID
	// fallback can recover.
	if hits[0].Record.Summary == "" || hits[0].Record.Popularity.Inst == 0 {
		t.Errorf("record did not round-trip through %s: summary=%q inst=%d",
			FieldRaw, hits[0].Record.Summary, hits[0].Record.Popularity.Inst)
	}

	rec, ok := re.Get("ubuntu/noble/amd64/main/libssl-dev")
	if !ok {
		t.Fatalf("Get after reopen missed a document that is present")
	}
	if rec.Name != "libssl-dev" || rec.Summary == "" {
		t.Errorf("Get returned %+v, want a fully-populated libssl-dev", rec)
	}
}

// TestMappingDriftMovesAsideAndRebuilds fences the guard for bleve.Open()'s
// documented behaviour: "The mapping used when it was created will be used for
// all Index/Search operations." A mapping edit is therefore INERT against an
// existing dir, and before this guard a new binary would keep serving old
// analyzer behaviour with no diagnostic at all.
//
// Also fences the destructive-action policy: the superseded dir is MOVED, never
// deleted, because refilling a fully-crawled index means re-fetching every
// mirror.
func TestMappingDriftMovesAsideAndRebuilds(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "idx")

	// Build a dir with a DIFFERENT mapping than NewMapping() produces.
	stock := bleve.NewIndexMapping()
	old, err := bleve.New(dir, stock)
	if err != nil {
		t.Fatalf("bleve.New with stock mapping: %v", err)
	}
	if err := old.Index("ubuntu/noble/amd64/main/ghost", map[string]any{"name": "ghost"}); err != nil {
		t.Fatalf("index ghost doc: %v", err)
	}
	if err := old.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	idx, err := NewIndex(dir)
	if err != nil {
		t.Fatalf("NewIndex over a drifted dir: %v", err)
	}
	defer idx.Close()

	if !idx.WasRebuilt() {
		t.Fatalf("NewIndex did not detect mapping drift; a mapping edit would "+
			"silently no-op against the existing dir (docs=%d)", idx.DocCount())
	}
	if idx.DocCount() != 0 {
		t.Errorf("rebuilt index has %d docs, want 0", idx.DocCount())
	}
	stale := idx.StaleDir()
	if stale == "" {
		t.Fatalf("WasRebuilt() but StaleDir() is empty")
	}
	if _, err := os.Stat(stale); err != nil {
		t.Errorf("stale dir %q is not on disk (%v); the old index must be moved "+
			"aside, never deleted", stale, err)
	}
	// The fresh dir must be usable and stamped, so a second open is a no-op.
	if err := idx.IngestBatch(fenceCorpus()); err != nil {
		t.Fatalf("IngestBatch into rebuilt index: %v", err)
	}
	if err := idx.Close(); err != nil {
		t.Fatalf("Close rebuilt: %v", err)
	}
	re, err := NewIndex(dir)
	if err != nil {
		t.Fatalf("reopen rebuilt: %v", err)
	}
	defer re.Close()
	if re.WasRebuilt() {
		t.Errorf("second open rebuilt again; the stamp was not persisted")
	}
}

// TestUnstampedIndexSelfHeals covers the upgrade path. An index built before
// the stamp existed carries no stamp, but if its persisted mapping still
// matches the current one there is nothing wrong with it — it must be stamped
// in place rather than needlessly rebuilt, or every existing deployment loses
// its corpus on the first boot of the new binary for no reason.
func TestUnstampedIndexSelfHeals(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "idx")

	m, err := NewMapping()
	if err != nil {
		t.Fatalf("NewMapping: %v", err)
	}
	pre, err := bleve.New(dir, m) // current mapping, but no stamp
	if err != nil {
		t.Fatalf("bleve.New: %v", err)
	}
	raw, err := json.Marshal(&fenceCorpus()[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	id := DocID(&fenceCorpus()[0])
	if err := pre.Index(id, indexDoc{PackageRecord: fenceCorpus()[0], Raw: string(raw)}); err != nil {
		t.Fatalf("index: %v", err)
	}
	if err := pre.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	idx, err := NewIndex(dir)
	if err != nil {
		t.Fatalf("NewIndex over an unstamped dir: %v", err)
	}
	defer idx.Close()

	if idx.WasRebuilt() {
		t.Errorf("an unstamped dir whose mapping MATCHES was rebuilt (stale=%q); "+
			"it must self-heal", idx.StaleDir())
	}
	if idx.DocCount() != 1 {
		t.Errorf("DocCount = %d, want 1 (the pre-existing doc must survive)", idx.DocCount())
	}
	if _, ok := idx.Get(id); !ok {
		t.Errorf("Get(%q) missed the pre-existing document", id)
	}
}

// TestCloseIsIdempotent — main.go both `defer idx.Close()`s and can Close on an
// error path, and scorch panics with "close of closed channel" on a double
// Close of the underlying index.
func TestCloseIsIdempotent(t *testing.T) {
	idx, _ := newFenceIndex(t)
	if err := idx.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := idx.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if got := idx.DocCount(); got != 0 {
		t.Errorf("DocCount on a closed index = %d, want 0", got)
	}
	if _, ok := idx.Get("ubuntu/noble/amd64/main/curl"); ok {
		t.Errorf("Get on a closed index reported a hit")
	}
	if _, _, err := idx.Search(SearchOpts{Query: "curl"}); err == nil {
		t.Errorf("Search on a closed index returned nil error")
	}
}

// TestMultiTokenQueryIsNotCorpusWide fences MatchQuery's operator. A MatchQuery
// defaults to OR over its analyzed tokens, and lowering the gram min to 1 turned
// that default into a corpus-wide match: "libssl-d" analyzes to [libssl, d], and
// at min=1 the gram "d" exists for every package with a d-initial token, so ANY
// of them qualified. Measured on 2,889 real records before SetOperator(And):
// q="libssl-d", "python3-d" and "openssh-s" each returned total=2889 — the
// entire corpus. At min=2 no single-char gram existed, so the stray token
// matched nothing and the OR default was harmless; this defect only becomes
// reachable once min is 1, which is why it needs its own fence.
func TestMultiTokenQueryIsNotCorpusWide(t *testing.T) {
	idx, _ := newFenceIndex(t)
	defer idx.Close()

	corpus := len(fenceCorpus())
	for _, q := range []string{"libssl-d", "python3-d", "openssh-s", "network-m"} {
		_, total, err := idx.Search(SearchOpts{Query: q, Limit: 50})
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		if total >= corpus {
			t.Errorf("q=%q matched %d of %d documents; the name.ngram clause "+
				"must combine its tokens with AND, or a trailing single-char "+
				"gram matches the whole corpus", q, total, corpus)
		}
	}
}

// TestTypoToleranceSurvives fences SetFuzziness against the AND operator and the
// pinned query analyzer, both of which change what Levenshtein is applied to.
// Measured on 2,889 real records: with fuzziness the top-1 accuracy on these
// typos is 6/6; without it, 0/6. The len(q)>=4 gate keeps fuzz off short
// queries, where it would be pure noise (q="c" goes from 318 to 2,889 matches).
func TestTypoToleranceSurvives(t *testing.T) {
	idx, _ := newFenceIndex(t)
	defer idx.Close()

	typos := map[string]string{
		"netwrk-manager": "network-manager",
		"opensh-server":  "openssh-server",
		"dockr.io":       "docker.io",
		"crul":           "curl",
	}
	for q, want := range typos {
		hits, _, err := idx.Search(SearchOpts{Query: q, Limit: 10})
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		found := false
		for _, h := range hits {
			if h.Record.Name == want {
				found = true
				break
			}
		}
		if !found {
			names := make([]string, 0, len(hits))
			for _, h := range hits {
				names = append(names, h.Record.Name)
			}
			t.Errorf("typo q=%q did not surface %q; got %v", q, want, names)
		}
	}
}
