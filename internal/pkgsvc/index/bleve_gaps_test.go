// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package index

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/mapping"
	bleveindex "github.com/blevesearch/bleve_index_api"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// This file fills the gaps bleve_test.go leaves: the stamp decision table in
// NewIndex, its I/O failure paths, the Search clamps, the degraded
// recordFromDocID fallback, and what happens when the underlying bleve handle
// starts returning errors. bleve_test.go owns the analyzer/boost fences; those
// are not repeated here.
//
// Deliberately NOT covered, and why. Each of these is a defensive branch that
// cannot be entered without editing bleve.go to add a seam only tests would use,
// which a coverage commit must not do:
//
//   - Search's Offset paging. It has a known defect characterised elsewhere;
//     nothing in this file passes a non-zero Offset.
//   - NewMapping's five AddCustomTokenFilter/AddCustomAnalyzer error returns.
//     Every argument is a compile-time constant applied to a mapping created
//     three lines earlier, so the only way to fail is to pass a bad name — i.e.
//     to change production code.
//   - NewIndex's propagation of NewMapping and mappingFingerprint errors, for
//     the same reason: both are called with no caller-controlled input.
//   - newStamped's SetInternal error and NewIndex's `close stale index` error.
//     Both need the KV store itself to fail mid-call; nothing reachable from the
//     public API can arrange that. TestFreshDirIsStampedInTheIndexStore covers
//     the SUCCESS side by reading the stamp back out of the closed dir.
//   - NewIndex's second newStamped error (after a successful move-aside). The
//     rename has just proved the parent writable and the path free.
//   - IngestBatch's json.Marshal error and batch.Index error. PackageRecord has
//     no channel/func/NaN member Marshal can reject, and DocID always contains
//     four separators so it is never the empty id Batch.Index refuses.
//   - Search's `buildQuery` error return: buildQuery's every path returns a nil
//     error today. Left as-is rather than asserted, since asserting a
//     never-taken branch would only pin an implementation detail.

// ---------------------------------------------------------------------------
// mappingFingerprint
// ---------------------------------------------------------------------------

// unmarshalableMapping is a mapping.IndexMapping whose JSON encoding always
// fails. The embedded interface is nil — mappingFingerprint only ever calls
// json.Marshal, so no interface method is invoked.
type unmarshalableMapping struct {
	mapping.IndexMapping
}

func (unmarshalableMapping) MarshalJSON() ([]byte, error) {
	return nil, fmt.Errorf("synthetic marshal failure")
}

// TestMappingFingerprintReportsMarshalFailure pins that a mapping which cannot
// be serialised produces an ERROR rather than a usable-looking empty
// fingerprint. If it returned ("", nil) instead, every index would be stamped
// with the same empty string, the stamp comparison in NewIndex would always
// succeed, and a genuinely incompatible mapping would be served silently — the
// exact failure the stamp exists to prevent, but now undetectable.
func TestMappingFingerprintReportsMarshalFailure(t *testing.T) {
	fp, err := mappingFingerprint(unmarshalableMapping{})
	if err == nil {
		t.Fatalf("want an error for an unmarshalable mapping, got fingerprint %q", fp)
	}
	if fp != "" {
		t.Errorf("fingerprint = %q on error, want the empty string so no caller can stamp with it", fp)
	}
	if !strings.Contains(err.Error(), "marshal mapping") {
		t.Errorf("error = %v, want it to name the failing step", err)
	}
}

// TestFingerprintIsSaltedAndFixedWidth guards the two properties the stamp
// mechanism actually leans on.
//
// The salt: docFormatVersion is mixed into the hash so a change to how a record
// is ENCODED (the _raw payload, say) invalidates existing dirs even though the
// mapping JSON is untouched. If the fmt.Fprintf line were dropped, a
// docFormatVersion bump would become inert and a new binary would keep reading
// documents it cannot parse — every search would then degrade to the DocID
// fallback and /search would return names with no summaries.
//
// The width: 32 hex chars, so the stamp stays a stable, log-greppable length.
func TestFingerprintIsSaltedAndFixedWidth(t *testing.T) {
	m, err := NewMapping()
	if err != nil {
		t.Fatalf("NewMapping: %v", err)
	}
	fp, err := mappingFingerprint(m)
	if err != nil {
		t.Fatalf("mappingFingerprint: %v", err)
	}
	if len(fp) != 32 {
		t.Errorf("fingerprint %q is %d chars, want 32", fp, len(fp))
	}
	if _, err := hex.DecodeString(fp); err != nil {
		t.Errorf("fingerprint %q is not hex: %v", fp, err)
	}

	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal mapping: %v", err)
	}
	// Recomputed by hand: salt first, then the mapping JSON.
	salted := sha256.New()
	fmt.Fprintf(salted, "v%d\n", docFormatVersion)
	salted.Write(b)
	if want := hex.EncodeToString(salted.Sum(nil))[:32]; fp != want {
		t.Errorf("fingerprint = %q, want %q — the hash must be sha256(\"v<docFormatVersion>\\n\" + mappingJSON)", fp, want)
	}
	// Equality with the UNsalted digest would mean the salt is not mixed in at
	// all, so a docFormatVersion bump could never invalidate a stale dir.
	plain := sha256.Sum256(b)
	if fp == hex.EncodeToString(plain[:])[:32] {
		t.Errorf("fingerprint equals the unsalted digest of the mapping JSON; "+
			"docFormatVersion (%d) is not part of the hash, so bumping it would "+
			"not invalidate a stale index", docFormatVersion)
	}

	// Stability across calls: the comparison in NewIndex is between a PERSISTED
	// stamp and a freshly computed one, so any map-iteration nondeterminism in
	// the mapping's JSON would rebuild a healthy index on every single boot.
	again, err := mappingFingerprint(m)
	if err != nil {
		t.Fatalf("mappingFingerprint (2nd): %v", err)
	}
	if again != fp {
		t.Errorf("fingerprint is not stable across calls: %q then %q", fp, again)
	}
}

// ---------------------------------------------------------------------------
// NewIndex: the stamp decision table
// ---------------------------------------------------------------------------

func currentStamp(t *testing.T) string {
	t.Helper()
	m, err := NewMapping()
	if err != nil {
		t.Fatalf("NewMapping: %v", err)
	}
	fp, err := mappingFingerprint(m)
	if err != nil {
		t.Fatalf("mappingFingerprint: %v", err)
	}
	return fp
}

// seedStampedDir builds an index dir with the CURRENT mapping, one real
// document, and whatever stamp the caller asks for.
func seedStampedDir(t *testing.T, dir, stamp string) (docID string) {
	t.Helper()
	m, err := NewMapping()
	if err != nil {
		t.Fatalf("NewMapping: %v", err)
	}
	idx, err := bleve.New(dir, m)
	if err != nil {
		t.Fatalf("bleve.New: %v", err)
	}
	rec := fenceCorpus()[0]
	raw, err := json.Marshal(&rec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	docID = DocID(&rec)
	if err := idx.Index(docID, indexDoc{PackageRecord: rec, Raw: string(raw)}); err != nil {
		t.Fatalf("index: %v", err)
	}
	if stamp != "" {
		if err := idx.SetInternal(indexStampKey, []byte(stamp)); err != nil {
			t.Fatalf("SetInternal: %v", err)
		}
	}
	if err := idx.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return docID
}

// TestFreshDirIsStampedInTheIndexStore asserts the stamp is actually WRITTEN,
// by reading it back out of the closed dir's own internal KV rather than
// inferring it from WasRebuilt(). The distinction matters: an unstamped dir
// still self-heals through the mapping comparison, so a NewIndex that forgot to
// SetInternal would look perfectly healthy on every reopen — right up until
// docFormatVersion is bumped, at which point the mapping is still identical, the
// self-heal fires, and documents written by the old encoding are served through
// the degraded fallback with no rebuild and no diagnostic.
//
// Also pins WHERE the stamp lives. Internal KV is inside the index's own store,
// so it is atomic with the index it describes; a sidecar file could be left
// behind by a partial delete or copied to the wrong dir.
func TestFreshDirIsStampedInTheIndexStore(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "idx")
	idx, err := NewIndex(dir)
	if err != nil {
		t.Fatalf("NewIndex: %v", err)
	}
	if idx.WasRebuilt() {
		t.Errorf("a brand-new dir reported WasRebuilt(); main.go would pointlessly reset state.json")
	}
	if err := idx.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	raw, err := bleve.Open(dir)
	if err != nil {
		t.Fatalf("bleve.Open: %v", err)
	}
	defer raw.Close()
	got, err := raw.GetInternal(indexStampKey)
	if err != nil {
		t.Fatalf("GetInternal(%s): %v", indexStampKey, err)
	}
	if want := currentStamp(t); string(got) != want {
		t.Errorf("stamp in the fresh dir = %q, want %q; NewIndex must persist the "+
			"fingerprint, not rely on the mapping self-heal to paper over its absence",
			got, want)
	}
}

// TestStaleStampRebuildsEvenWhenTheMappingMatches is the docFormatVersion-bump
// path, and the reason the stamp is STORED rather than recomputed on both sides.
//
// Here the on-disk mapping is byte-identical to NewMapping()'s, so the
// self-heal comparison would happily pass. Only the stamp disagrees. That is
// exactly what a docFormatVersion bump looks like: the mapping did not change,
// but the way documents were ENCODED did, so the old documents are unreadable
// and the dir must be discarded. Serving it instead means /search returns rows
// whose _raw cannot be parsed — a result list of bare names with no summaries
// and no popularity ordering.
//
// The second half is the control that makes the first half mean something: the
// same fixture with the CORRECT stamp must NOT be rebuilt. Without it a
// "rebuild always" regression would pass the assertions above.
func TestStaleStampRebuildsEvenWhenTheMappingMatches(t *testing.T) {
	root := t.TempDir()

	stale := filepath.Join(root, "stale-stamp")
	staleDoc := seedStampedDir(t, stale, strings.Repeat("0", 32)) // well-formed, wrong

	idx, err := NewIndex(stale)
	if err != nil {
		t.Fatalf("NewIndex over a wrongly-stamped dir: %v", err)
	}
	defer idx.Close()

	if !idx.WasRebuilt() {
		t.Fatalf("a dir carrying a stamp that does not match was NOT rebuilt; a "+
			"docFormatVersion bump would be inert and old documents would be "+
			"served through the degraded fallback (docs=%d)", idx.DocCount())
	}
	if got := idx.DocCount(); got != 0 {
		t.Errorf("rebuilt index has %d docs, want 0", got)
	}
	moved := idx.StaleDir()
	if moved == "" {
		t.Fatalf("WasRebuilt() but StaleDir() is empty; an operator cannot find or reclaim the old dir")
	}

	// Move aside, NEVER delete: refilling a crawled index means re-fetching every
	// mirror, so prove the documents are still readable where they were moved to
	// rather than merely that a directory of that name exists.
	old, err := bleve.Open(moved)
	if err != nil {
		t.Fatalf("the moved-aside dir is not a readable index (%v); the old corpus is unrecoverable", err)
	}
	defer old.Close()
	if doc, err := old.Document(staleDoc); err != nil || doc == nil {
		t.Errorf("moved-aside dir lost %q (doc=%v err=%v)", staleDoc, doc, err)
	}

	// The fresh dir must be stamped, or every subsequent boot rebuilds again.
	if err := idx.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	re, err := NewIndex(stale)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer re.Close()
	if re.WasRebuilt() {
		t.Errorf("the rebuilt dir was rebuilt AGAIN on reopen; newStamped did not persist the stamp")
	}

	// --- control: identical fixture, correct stamp ---
	good := filepath.Join(root, "good-stamp")
	goodDoc := seedStampedDir(t, good, currentStamp(t))
	keep, err := NewIndex(good)
	if err != nil {
		t.Fatalf("NewIndex over a correctly-stamped dir: %v", err)
	}
	defer keep.Close()
	if keep.WasRebuilt() {
		t.Fatalf("a correctly-stamped dir was rebuilt (stale=%q); the stamp, not "+
			"something else about the fixture, must be the deciding factor", keep.StaleDir())
	}
	if keep.StaleDir() != "" {
		t.Errorf("StaleDir = %q, want empty when nothing was moved", keep.StaleDir())
	}
	if _, ok := keep.Get(goodDoc); !ok {
		t.Errorf("Get(%q) missed the pre-existing document", goodDoc)
	}
}

// TestNewIndexParentPathIsAFile covers the mkdir guard. The index path comes
// from configuration; pointing it under a regular file (a bind-mounted
// state.json, a stray file where a data dir was expected) must surface a named
// error at startup instead of a bare EEXIST from somewhere deeper in bleve.
func TestNewIndexParentPathIsAFile(t *testing.T) {
	root := t.TempDir()
	blocker := filepath.Join(root, "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	idx, err := NewIndex(filepath.Join(blocker, "index", "main"))
	if err == nil {
		idx.Close()
		t.Fatalf("want an error when the index parent is a file")
	}
	if !strings.Contains(err.Error(), "mkdir index parent") {
		t.Errorf("error = %v, want it to name the mkdir step", err)
	}
	if idx != nil {
		t.Errorf("a failed NewIndex must return a nil *Index, got %+v", idx)
	}
}

// TestNewIndexCannotCreateTheDir covers the bleve.New failure path — the branch
// taken when os.Stat says the dir does not exist, so NewIndex commits to
// CREATING it, and the creation then fails.
//
// The fixture is a dangling symlink at the index path: Stat follows the link,
// finds nothing, and reports IsNotExist, but bleve.New's own existence check
// does not follow it and refuses ("path already exists"). That is the shape a
// moved or unmounted data volume leaves behind, and the contract is that it
// comes back as a wrapped error naming the dir rather than a panic or a silently
// empty index that then re-crawls every mirror.
//
// Deliberately not a chmod 0555 parent: permission tricks are inert when the
// suite runs as root, which it does in most CI containers, and a test that
// silently skips there is a test that does not exist.
func TestNewIndexCannotCreateTheDir(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "main")
	if err := os.Symlink(filepath.Join(root, "gone", "target"), dir); err != nil {
		t.Fatal(err)
	}
	// Precondition: NewIndex must take the create branch, not the open branch.
	if _, serr := os.Stat(dir); !os.IsNotExist(serr) {
		t.Fatalf("os.Stat(%q) = %v, want IsNotExist so NewIndex takes the create path", dir, serr)
	}

	idx, err := NewIndex(dir)
	if err == nil {
		idx.Close()
		t.Fatalf("want an error when the index dir cannot be created")
	}
	if !strings.Contains(err.Error(), "bleve.New") || !strings.Contains(err.Error(), dir) {
		t.Errorf("error = %v, want it to name bleve.New and the dir %q", err, dir)
	}
	if idx != nil {
		t.Errorf("a failed NewIndex must return a nil *Index, got %+v", idx)
	}
}

// TestNewIndexOnADirThatIsNotAnIndex covers the bleve.Open failure path. A dir
// that exists but holds junk (a half-extracted backup, a wrong volume mount) is
// NOT treated as drift: there is no mapping to compare, so NewIndex returns the
// error verbatim and main.go can log and skip. Moving it aside instead would let
// a mis-mounted volume quietly become an empty index that then re-crawls
// everything.
func TestNewIndexOnADirThatIsNotAnIndex(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "idx")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "junk.txt"), []byte("not an index"), 0o644); err != nil {
		t.Fatal(err)
	}
	idx, err := NewIndex(dir)
	if err == nil {
		idx.Close()
		t.Fatalf("want an error for a dir that is not a bleve index")
	}
	if !strings.Contains(err.Error(), "bleve.Open") {
		t.Errorf("error = %v, want it to name bleve.Open", err)
	}
	if idx != nil {
		t.Errorf("a failed NewIndex must return a nil *Index, got %+v", idx)
	}
	// Nothing was moved aside and nothing was deleted.
	if _, err := os.Stat(filepath.Join(dir, "junk.txt")); err != nil {
		t.Errorf("the unopenable dir was disturbed: %v", err)
	}
}

// TestNewIndexCannotMoveAsideStaleDir covers the rename failure. Drift is
// detected, the old handle is closed, and then the move fails.
//
// The contract that matters: NewIndex STOPS. Pressing on would mean bleve.New
// over a dir that still holds an incompatible index, which fails in turn with a
// far less legible message — and if it somehow succeeded it would be serving the
// stale mapping under a "rebuilt" banner. The error names both paths so an
// operator can see what was attempted.
//
// The blockers are NON-EMPTY directories occupying every `<dir>.stale-<unix>`
// name the clock could produce over a several-second window, which makes rename
// fail with EEXIST/ENOTEMPTY regardless of uid. A chmod-based fixture would be
// inert when the suite runs as root, and a silently-skipping test is no test.
func TestNewIndexCannotMoveAsideStaleDir(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "main")
	seedStampedDir(t, dir, strings.Repeat("f", 32)) // stale stamp -> must move aside

	now := time.Now().UTC().Unix()
	for delta := int64(-5); delta <= 5; delta++ {
		blocker := fmt.Sprintf("%s.stale-%d", dir, now+delta)
		if err := os.Mkdir(blocker, 0o755); err != nil {
			t.Fatal(err)
		}
		// Non-empty: renaming a dir ONTO an empty dir succeeds on Linux.
		if err := os.WriteFile(filepath.Join(blocker, "occupant"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	idx, err := NewIndex(dir)
	if err == nil {
		idx.Close()
		t.Fatalf("want an error when the stale dir cannot be moved aside")
	}
	if !strings.Contains(err.Error(), "move aside stale index") {
		t.Errorf("error = %v, want it to name the move-aside step", err)
	}
	if !strings.Contains(err.Error(), ".stale-") {
		t.Errorf("error = %v, want it to name the destination path", err)
	}
	if idx != nil {
		t.Errorf("a failed NewIndex must return a nil *Index, got %+v", idx)
	}
	// The original dir is still where it was, undamaged: a failed move must not
	// leave an operator with neither an index nor a backup.
	if _, serr := os.Stat(filepath.Join(dir, "index_meta.json")); serr != nil {
		t.Errorf("the stale dir was damaged by the failed move: %v", serr)
	}
}

// ---------------------------------------------------------------------------
// Search: the empty query, the clamps, the tiebreak ordering
// ---------------------------------------------------------------------------

// bulkCorpus builds n records that all match the query "filler" through their
// summary and differ only in name, so scores are identical and the ONLY thing
// separating them is the secondary sort key.
func bulkCorpus(n int) []schema.PackageRecord {
	recs := make([]schema.PackageRecord, 0, n)
	for i := 0; i < n; i++ {
		recs = append(recs, schema.PackageRecord{
			OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
			Name:       fmt.Sprintf("pkg-%03d", i),
			Summary:    "filler package",
			Popularity: schema.Popularity{Inst: 7},
		})
	}
	return recs
}

// TestEmptyQueryMatchesEverything covers buildQuery's MatchAll shortcut. The UI
// opens the package browser with no query and no os/arch selected; if that
// degenerate request produced an empty conjunction (or a MatchNone) the browser
// would render a blank list on first paint with no error anywhere to explain it.
func TestEmptyQueryMatchesEverything(t *testing.T) {
	idx, _ := newFenceIndex(t)
	defer idx.Close()

	corpus := len(fenceCorpus())
	hits, total, err := idx.Search(SearchOpts{Limit: corpus})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != corpus {
		t.Errorf("total = %d for an empty query, want the whole corpus (%d)", total, corpus)
	}
	if len(hits) != corpus {
		t.Errorf("len(hits) = %d, want %d", len(hits), corpus)
	}
	// Whitespace only is the same request: the UI sends what the user typed.
	_, total, err = idx.Search(SearchOpts{Query: "   ", Limit: corpus})
	if err != nil {
		t.Fatalf("Search(spaces): %v", err)
	}
	if total != corpus {
		t.Errorf("total = %d for a whitespace query, want %d (the query must be trimmed first)", total, corpus)
	}
	// Only an os/arch filter, still no query: the conjunction path with no
	// disjunction clause. Every fixture record is ubuntu/amd64.
	_, total, err = idx.Search(SearchOpts{OS: "ubuntu", Limit: corpus})
	if err != nil {
		t.Fatalf("Search(os only): %v", err)
	}
	if total != corpus {
		t.Errorf("total = %d for an os-only filter, want %d", total, corpus)
	}
	// Control proving that filter is actually applied rather than ignored.
	_, total, err = idx.Search(SearchOpts{OS: "plan9", Limit: corpus})
	if err != nil {
		t.Fatalf("Search(bogus os): %v", err)
	}
	if total != 0 {
		t.Errorf("total = %d for os=plan9, want 0; the os filter is being dropped", total)
	}

	// The ARCH arm of the same conjunction, with its own control. Previously only
	// the OS arm was exercised, so the arch clause could have been dropped entirely
	// without failing anything — the empty-query path AND-s both filters, and a
	// missing clause on a single-arch fixture is invisible from the OS side alone.
	_, total, err = idx.Search(SearchOpts{Arch: "amd64", Limit: corpus})
	if err != nil {
		t.Fatalf("Search(arch only): %v", err)
	}
	if total != corpus {
		t.Errorf("total = %d for an arch-only filter, want %d", total, corpus)
	}
	_, total, err = idx.Search(SearchOpts{Arch: "sparc64", Limit: corpus})
	if err != nil {
		t.Fatalf("Search(bogus arch): %v", err)
	}
	if total != 0 {
		t.Errorf("total = %d for arch=sparc64, want 0; the arch filter is being dropped",
			total)
	}
	// And both together, so the conjunction is proven to AND rather than OR: a real
	// OS paired with a bogus arch must match nothing. Under an OR this would return
	// the whole corpus.
	_, total, err = idx.Search(SearchOpts{OS: "ubuntu", Arch: "sparc64", Limit: corpus})
	if err != nil {
		t.Fatalf("Search(os+bogus arch): %v", err)
	}
	if total != 0 {
		t.Errorf("total = %d for os=ubuntu AND arch=sparc64, want 0; the two filters "+
			"must be AND-ed, not OR-ed", total)
	}
}

// TestSearchLimitDefaultAndCap fences both clamps against a corpus LARGER than
// either bound, which is the only way the assertions can fail for the right
// reason — against a 20-record fixture a cap of 50 and a cap of 5000 are
// indistinguishable.
//
// Limit<=0 → 50 is what the HTTP handler relies on when `limit` is absent;
// Limit>200 → 200 is the guard that stops `?limit=100000` from making the
// process marshal the entire corpus into one JSON response.
func TestSearchLimitDefaultAndCap(t *testing.T) {
	const n = 260 // must exceed BOTH 200 and 50
	dir := filepath.Join(t.TempDir(), "idx")
	idx, err := NewIndex(dir)
	if err != nil {
		t.Fatalf("NewIndex: %v", err)
	}
	defer idx.Close()
	if err := idx.IngestBatch(bulkCorpus(n)); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	if got := idx.DocCount(); got != n {
		t.Fatalf("DocCount = %d, want %d; the fixture must be bigger than the clamps", got, n)
	}

	for _, tc := range []struct {
		name  string
		limit int
		want  int
	}{
		{"absent (0) falls back to 50", 0, 50},
		{"negative falls back to 50", -1, 50},
		{"oversized is capped at 200", 100000, 200},
		{"just over the cap is capped", 201, 200},
		{"under the cap is honoured", 7, 7},
	} {
		hits, total, err := idx.Search(SearchOpts{Query: "filler", Limit: tc.limit})
		if err != nil {
			t.Fatalf("%s: Search: %v", tc.name, err)
		}
		if total != n {
			t.Errorf("%s: total = %d, want %d (the clamp must bound the PAGE, not the match count)",
				tc.name, total, n)
		}
		if len(hits) != tc.want {
			t.Errorf("%s: len(hits) = %d, want %d", tc.name, len(hits), tc.want)
		}
	}
}

// TestEqualScoresAreOrderedByDocID fences the secondary sort key. Bleve's
// collector orders equal-score hits by internal doc number, which changes
// whenever scorch merges segments — so with a score-only sort the order of a tie
// flaps between restarts and a user paging through results sees rows jump
// around for no reason. The records are ingested in DESCENDING name order so
// bleve's natural order is the opposite of the wanted one; a sort that does
// nothing cannot pass.
func TestEqualScoresAreOrderedByDocID(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "idx")
	idx, err := NewIndex(dir)
	if err != nil {
		t.Fatalf("NewIndex: %v", err)
	}
	defer idx.Close()

	recs := bulkCorpus(12)
	sort.Slice(recs, func(a, b int) bool { return recs[a].Name > recs[b].Name })
	if err := idx.IngestBatch(recs); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}

	hits, total, err := idx.Search(SearchOpts{Query: "filler", Limit: len(recs)})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != len(recs) || len(hits) != len(recs) {
		t.Fatalf("total=%d hits=%d, want %d of each", total, len(hits), len(recs))
	}
	// Precondition: the records are interchangeable, so every score must be
	// identical. If this ever stops holding the ordering assertion below would be
	// asserting something else entirely.
	for i, h := range hits {
		if h.Score != hits[0].Score {
			t.Fatalf("hit[%d] score %v != hit[0] score %v; the fixture is no longer a pure tie",
				i, h.Score, hits[0].Score)
		}
	}
	names := make([]string, 0, len(hits))
	for _, h := range hits {
		names = append(names, h.Record.Name)
	}
	if !sort.StringsAreSorted(names) {
		t.Errorf("tied hits came back as %v; equal scores must be ordered by DocID so the "+
			"response is a pure function of the candidate set", names)
	}
}

// ---------------------------------------------------------------------------
// recordFromDocID — the degraded fallback
// ---------------------------------------------------------------------------

// TestRecordFromDocID pins the reverse of DocID. It only runs when a document's
// _raw is missing or unparseable, so it is the last thing between a corrupt
// document and a /search response whose row count disagrees with its own total.
func TestRecordFromDocID(t *testing.T) {
	for _, tc := range []struct {
		name string
		id   string
		want schema.PackageRecord
	}{
		{
			name: "well-formed id maps to all five identity fields",
			id:   "ubuntu/noble/amd64/main/libssl-dev",
			want: schema.PackageRecord{
				OS: "ubuntu", Release: "noble", Arch: "amd64",
				Component: "main", Name: "libssl-dev",
			},
		},
		{
			// SplitN's limit of 5 keeps everything after the fourth separator in
			// the last field, so a name containing a slash survives intact
			// instead of being silently truncated at "weird".
			name: "extra separators stay inside the name",
			id:   "ubuntu/noble/amd64/main/weird/name",
			want: schema.PackageRecord{
				OS: "ubuntu", Release: "noble", Arch: "amd64",
				Component: "main", Name: "weird/name",
			},
		},
		{
			// Too few parts: there is nothing to attribute, so the whole id
			// becomes the name. A blank name would render an empty row in the
			// results list with nothing to click.
			name: "short id degrades to a name-only record",
			id:   "ubuntu/noble/amd64",
			want: schema.PackageRecord{Name: "ubuntu/noble/amd64"},
		},
		{
			name: "no separators at all",
			id:   "curl",
			want: schema.PackageRecord{Name: "curl"},
		},
		{
			name: "empty id",
			id:   "",
			want: schema.PackageRecord{Name: ""},
		},
	} {
		got := recordFromDocID(tc.id)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: recordFromDocID(%q) =\n\t%+v\nwant\n\t%+v", tc.name, tc.id, got, tc.want)
		}
	}

	// Round-trip against the real composer, so the two cannot drift apart.
	rec := fenceCorpus()[0]
	back := recordFromDocID(DocID(&rec))
	if back.OS != rec.OS || back.Release != rec.Release || back.Arch != rec.Arch ||
		back.Component != rec.Component || back.Name != rec.Name {
		t.Errorf("recordFromDocID(DocID(r)) = %+v, want the identity fields of %+v", back, rec)
	}
}

// TestSearchDegradesOnUnusableRaw is the integration half. Two damaged
// documents are written straight through the bleve handle — one with an
// unparseable _raw, one with no _raw at all — alongside a healthy one.
//
// What breaks if this regresses: dropping the damaged rows made len(hits)
// disagree with the reported total, so the UI showed "3 results" above a list of
// one, and its pager computed pages from a total it never received rows for.
// The healthy row is the control: it proves the index is fine and only the
// damaged documents take the fallback.
func TestSearchDegradesOnUnusableRaw(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "idx")
	idx, err := NewIndex(dir)
	if err != nil {
		t.Fatalf("NewIndex: %v", err)
	}
	defer idx.Close()

	healthy := schema.PackageRecord{
		OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
		Name: "damaged-healthy", Summary: "filler package intact",
	}
	if err := idx.IngestBatch([]schema.PackageRecord{healthy}); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}

	// _raw present but not JSON: json.Unmarshal fails.
	corruptID := "ubuntu/noble/amd64/main/damaged-corrupt"
	corrupt := schema.PackageRecord{
		OS: "ubuntu", Release: "noble", Arch: "amd64", Component: "main",
		Name: "damaged-corrupt", Summary: "filler package corrupt",
	}
	if err := idx.idx.Index(corruptID, indexDoc{PackageRecord: corrupt, Raw: "{ this is not json"}); err != nil {
		t.Fatalf("index corrupt doc: %v", err)
	}
	// No _raw field at all: what a document written by a pre-_raw binary looks
	// like. Indexed as a bare map so the field is genuinely absent rather than
	// present-and-empty.
	missingID := "ubuntu/noble/amd64/main/damaged-missing"
	if err := idx.idx.Index(missingID, map[string]any{
		"name":      "damaged-missing",
		"summary":   "filler package missing",
		"os":        "ubuntu",
		"release":   "noble",
		"arch":      "amd64",
		"component": "main",
	}); err != nil {
		t.Fatalf("index _raw-less doc: %v", err)
	}

	hits, total, err := idx.Search(SearchOpts{Query: "filler", Limit: 10})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != 3 {
		t.Fatalf("total = %d, want 3 (all three documents match \"filler\")", total)
	}
	if len(hits) != total {
		t.Fatalf("len(hits) = %d but total = %d; a document with an unusable %s must "+
			"still project a row", len(hits), total, FieldRaw)
	}

	byName := map[string]schema.PackageRecord{}
	for _, h := range hits {
		byName[h.Record.Name] = h.Record
	}
	for _, want := range []string{"damaged-healthy", "damaged-corrupt", "damaged-missing"} {
		if _, ok := byName[want]; !ok {
			t.Errorf("hit for %q is missing; got %v", want, byName)
		}
	}
	// The control: the intact document round-trips in full, so a failure of the
	// two below is about the fallback and not about the index.
	if byName["damaged-healthy"].Summary != "filler package intact" {
		t.Errorf("healthy record did not round-trip through %s: %+v", FieldRaw, byName["damaged-healthy"])
	}
	// The degraded rows carry the identity fields recovered from the DocID and
	// nothing more — enough for the UI to render a name and a link.
	for _, id := range []string{corruptID, missingID} {
		want := recordFromDocID(id)
		got := byName[want.Name]
		if !reflect.DeepEqual(got, want) {
			t.Errorf("degraded record for %q =\n\t%+v\nwant exactly the DocID fields\n\t%+v", id, got, want)
		}
	}

	// Get is deliberately STRICTER than Search: it has no total to keep honest,
	// so an unusable _raw is reported as a miss rather than as a hollow record
	// that a caller would mistake for real metadata.
	if rec, ok := idx.Get(corruptID); ok {
		t.Errorf("Get(%q) returned ok with an unparseable %s: %+v", corruptID, FieldRaw, rec)
	}
	if rec, ok := idx.Get(missingID); ok {
		t.Errorf("Get(%q) returned ok with no %s field: %+v", missingID, FieldRaw, rec)
	}
	if _, ok := idx.Get(DocID(&healthy)); !ok {
		t.Errorf("Get(%q) missed the healthy document; the two assertions above would "+
			"then be passing for the wrong reason", DocID(&healthy))
	}
}

// TestGetOnAnAbsentDocID covers the miss path. handler.handlePackage does up to
// 16 of these per request to resolve a package across suites, so a miss has to
// be a cheap false rather than an error the handler would turn into a 500.
func TestGetOnAnAbsentDocID(t *testing.T) {
	idx, _ := newFenceIndex(t)
	defer idx.Close()

	for _, id := range []string{
		"ubuntu/noble/amd64/main/no-such-package",
		"debian/trixie/arm64/main/curl", // right name, wrong suite
		"",
		"not-even-a-docid",
	} {
		if rec, ok := idx.Get(id); ok {
			t.Errorf("Get(%q) reported a hit: %+v", id, rec)
		}
	}
	// Control: the same call shape does find a document that exists, so the
	// misses above are not "Get is broken for everything".
	if _, ok := idx.Get("ubuntu/noble/amd64/main/curl"); !ok {
		t.Fatal("Get missed a document that is present; the miss assertions above prove nothing")
	}
}

// ---------------------------------------------------------------------------
// IngestBatch edges
// ---------------------------------------------------------------------------

// TestIngestBatchEmptyIsANoOpEvenWhenClosed pins the early return AHEAD of the
// closed-handle check. The crawler calls IngestBatch once per shard delta and
// most refreshes have no delta at all, so during shutdown the common case is an
// empty batch against a handle main.go has already closed. Returning an error
// there would log a scary "index closed" on every clean shutdown.
func TestIngestBatchEmptyIsANoOpEvenWhenClosed(t *testing.T) {
	idx, _ := newFenceIndex(t)
	before := idx.DocCount()
	if before == 0 {
		t.Fatal("fixture is empty; the DocCount assertion below would prove nothing")
	}
	if err := idx.IngestBatch(nil); err != nil {
		t.Errorf("IngestBatch(nil): %v", err)
	}
	if err := idx.IngestBatch([]schema.PackageRecord{}); err != nil {
		t.Errorf("IngestBatch(empty): %v", err)
	}
	if got := idx.DocCount(); got != before {
		t.Errorf("DocCount = %d after two empty batches, want %d", got, before)
	}

	if err := idx.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := idx.IngestBatch(nil); err != nil {
		t.Errorf("IngestBatch(nil) on a closed index: %v; an empty batch must "+
			"short-circuit before the closed-handle check", err)
	}
	// A non-empty batch against the same closed handle DOES error — the control
	// that shows the nil case above is short-circuiting rather than the closed
	// check being absent.
	err := idx.IngestBatch(fenceCorpus())
	if err == nil {
		t.Fatal("IngestBatch on a closed index returned nil; records would be silently dropped")
	}
	if !strings.Contains(err.Error(), "index closed") {
		t.Errorf("error = %v, want it to say the index is closed", err)
	}
}

// ---------------------------------------------------------------------------
// Failures coming back OUT of the bleve handle
// ---------------------------------------------------------------------------

// bleveIndex is an alias purely so the interface can be EMBEDDED without the
// field being named `Index`, which would collide with bleve.Index's own
// Index(id, data) method and leave the interface unsatisfied.
type bleveIndex = bleve.Index

// brokenIndex wraps a live bleve.Index and forces the chosen calls to fail. The
// embedded interface serves every other method, so the handle stays usable for
// setup and Close.
type brokenIndex struct {
	bleveIndex
	docCountErr error
	searchErr   error
	batchErr    error
	documentErr error
}

func (b brokenIndex) DocCount() (uint64, error) {
	if b.docCountErr != nil {
		return 0, b.docCountErr
	}
	return b.bleveIndex.DocCount()
}

func (b brokenIndex) Search(req *bleve.SearchRequest) (*bleve.SearchResult, error) {
	if b.searchErr != nil {
		return nil, b.searchErr
	}
	return b.bleveIndex.Search(req)
}

func (b brokenIndex) Batch(batch *bleve.Batch) error {
	if b.batchErr != nil {
		return b.batchErr
	}
	return b.bleveIndex.Batch(batch)
}

// Document returns the real document ALONGSIDE the error, deliberately. scorch
// builds the returned document by visiting stored fields as it reads them, so a
// failure part-way through hands back a partially-populated doc AND an error —
// which is precisely why Get must test err and not merely doc != nil. A stub
// that returned (nil, err) would let a `doc, _ :=` regression pass.
func (b brokenIndex) Document(id string) (bleveindex.Document, error) {
	doc, err := b.bleveIndex.Document(id)
	if b.documentErr != nil {
		return doc, b.documentErr
	}
	return doc, err
}

// TestUnderlyingIndexFailuresAreSurfaced covers what each caller does when
// scorch itself returns an error — a corrupt segment, an exhausted fd table, a
// full disk. Each of these paths is invisible in normal operation and each has a
// different contract:
//
//	DocCount → 0. main.go seeds the corpus when DocCount()==0, so a transient
//	           error here re-ingests the seed over a populated index. Pinned
//	           because it is a silent data event, not a crash.
//	Search   → a wrapped error, never a nil result the handler would range over.
//	Batch    → a wrapped error, so the crawler does not record the shard's hash
//	           as ingested and will retry it next refresh.
//	Document → a miss, so handlePackage 404s rather than 500s. Not merely
//	           doc==nil: scorch can hand back a HALF-BUILT document together
//	           with an error, and treating that as a hit would serve a record
//	           with fields silently missing.
func TestUnderlyingIndexFailuresAreSurfaced(t *testing.T) {
	boom := fmt.Errorf("synthetic scorch failure")

	t.Run("DocCount", func(t *testing.T) {
		idx, _ := newFenceIndex(t)
		defer idx.Close()
		if idx.DocCount() == 0 {
			t.Fatal("fixture is empty")
		}
		idx.idx = brokenIndex{bleveIndex: idx.idx, docCountErr: boom}
		if got := idx.DocCount(); got != 0 {
			t.Errorf("DocCount = %d when the handle errors, want 0", got)
		}
	})

	t.Run("Search", func(t *testing.T) {
		idx, _ := newFenceIndex(t)
		defer idx.Close()
		idx.idx = brokenIndex{bleveIndex: idx.idx, searchErr: boom}
		hits, total, err := idx.Search(SearchOpts{Query: "curl", Limit: 5})
		if err == nil {
			t.Fatalf("Search returned nil error; got %d hits total=%d", len(hits), total)
		}
		if !strings.Contains(err.Error(), "bleve search") || !strings.Contains(err.Error(), boom.Error()) {
			t.Errorf("error = %v, want the underlying failure wrapped and named", err)
		}
		if hits != nil || total != 0 {
			t.Errorf("Search returned hits=%v total=%d alongside an error", hits, total)
		}
	})

	t.Run("Batch", func(t *testing.T) {
		idx, _ := newFenceIndex(t)
		defer idx.Close()
		idx.idx = brokenIndex{bleveIndex: idx.idx, batchErr: boom}
		err := idx.IngestBatch(fenceCorpus()[:2])
		if err == nil {
			t.Fatal("IngestBatch returned nil when the commit failed; the crawler would " +
				"record the shard as ingested and never retry it")
		}
		if !strings.Contains(err.Error(), "batch commit") || !strings.Contains(err.Error(), boom.Error()) {
			t.Errorf("error = %v, want the commit failure wrapped and named", err)
		}
	})

	t.Run("Document", func(t *testing.T) {
		idx, _ := newFenceIndex(t)
		defer idx.Close()
		id := "ubuntu/noble/amd64/main/curl"
		if _, ok := idx.Get(id); !ok {
			t.Fatal("fixture does not contain curl")
		}
		idx.idx = brokenIndex{bleveIndex: idx.idx, documentErr: boom}
		if rec, ok := idx.Get(id); ok {
			t.Errorf("Get reported a hit when the handle errored: %+v", rec)
		}
	})
}
