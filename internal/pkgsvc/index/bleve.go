// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Package index wraps Bleve for the ict-pkgsvc microservice: analyzer chain,
// field mapping, atomic index swap under RWMutex, and query builder with the
// boost table from the plan.
package index

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/blevesearch/bleve/v2"
	// Blank-import the custom analyzer package so its init() registers
	// the "custom" analyzer type with the global registry; without this
	// AddCustomAnalyzer("custom", …) errors at index-open time with
	// "no analyzer with name or type 'custom' registered".
	_ "github.com/blevesearch/bleve/v2/analysis/analyzer/custom"
	"github.com/blevesearch/bleve/v2/analysis/analyzer/keyword"
	"github.com/blevesearch/bleve/v2/analysis/analyzer/standard"
	"github.com/blevesearch/bleve/v2/analysis/lang/en"
	"github.com/blevesearch/bleve/v2/analysis/token/edgengram"
	"github.com/blevesearch/bleve/v2/analysis/token/lowercase"
	"github.com/blevesearch/bleve/v2/analysis/tokenizer/single"
	"github.com/blevesearch/bleve/v2/analysis/tokenizer/unicode"
	"github.com/blevesearch/bleve/v2/mapping"
	"github.com/blevesearch/bleve/v2/search/query"
	bleveindex "github.com/blevesearch/bleve_index_api"
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// Custom analyzer names, registered once per IndexMapping.
//
//	pkg_edge_ngram   — unicode tokenize → lowercase → edge_ngram(1,15).
//	                   INDEX side of name.ngram + keywords.ngram.
//	pkg_keyword_lc   — single tokenize → lowercase. name.exact, so a whole
//	                   hyphenated/dotted name stays ONE term.
//	pkg_unicode_lc   — unicode tokenize → lowercase, no gramming. QUERY side
//	                   of name.ngram; see buildQuery for why it must differ
//	                   from the index analyzer.
//	pkg_whole_prefix — single tokenize → lowercase → edge_ngram(1,15).
//	                   name.prefix: grams anchored to the start of the WHOLE
//	                   name, so "which names begin with X" is a term lookup.
//
// min is 1, not 2: at 2 the index contained no single-character gram at all
// ("curl" → [cu, cur, curl]), so every one-letter query matched nothing.
// Measured cost of 2→1 over 2,889 real records: +2.7% on disk, no latency
// change.
const (
	analyzerEdgeNgram = "pkg_edge_ngram"
	analyzerKeywordLC = "pkg_keyword_lc"
	analyzerUnicodeLC = "pkg_unicode_lc"
	analyzerWholePre  = "pkg_whole_prefix"
)

// FieldRaw is the stored-but-not-indexed field carrying the canonical JSON
// encoding of the whole PackageRecord. Search() and Get() reconstruct records
// from it, which is what makes hits survive a process restart: there is no
// in-memory side map to lose.
const FieldRaw = "_raw"

// docFormatVersion covers on-disk changes that are NOT visible in the index
// mapping — chiefly the addition of FieldRaw's *contents* and any future change
// to how a record is encoded into it. Bump it when a new binary cannot
// correctly read documents written by the old one.
//
// It is a SALT on the fingerprint below, and it works only because the
// fingerprint is PERSISTED rather than recomputed from the on-disk mapping on
// both sides of the comparison. Recomputing both sides would shift them
// identically and make the salt inert.
const docFormatVersion = 2

// indexStampKey is the bleve internal-KV key holding the stamp written by
// stampIndex. Internal KV lives in the index's own store, so it is atomic with
// respect to the index it describes — unlike a sidecar file, it cannot be left
// behind by a partial delete or copied to the wrong directory.
var indexStampKey = []byte("ict.pkgsvc.indexStamp")

// mappingFingerprint hashes the serialized IndexMapping together with
// docFormatVersion. Any analyzer, tokenizer, token-filter, field-name or
// boost-relevant mapping edit changes the JSON and therefore the hash, so a
// developer cannot forget to invalidate a stale index the way a hand-maintained
// integer can be forgotten.
//
// bleve's mapping JSON round-trips byte-stably (verified: an in-memory
// NewMapping() and the same mapping read back out of bleve.Open() marshal
// identically, and repeated marshals are stable — no map-iteration
// nondeterminism), so this is safe to compare across process boundaries.
func mappingFingerprint(m mapping.IndexMapping) (string, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("marshal mapping: %w", err)
	}
	h := sha256.New()
	fmt.Fprintf(h, "v%d\n", docFormatVersion)
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))[:32], nil
}

// indexDoc is what is actually handed to bleve's Batch.Index. PackageRecord is
// embedded ANONYMOUSLY and is a struct, so bleve's walkDocument elides the type
// name: every existing json path ("name", "summary", "popularity.inst",
// "provides.binary", …) is byte-identical to before this field existed. Raw
// adds exactly one new top-level path, "_raw".
type indexDoc struct {
	schema.PackageRecord
	Raw string `json:"_raw"`
}

// NewMapping builds the Bleve IndexMapping for PackageRecord. Field-level
// analyzers align with §5 of the plan:
//
//	name.exact         : keyword lowercased
//	name.ngram         : lowercase + edge_ngram(1,15), tokenized first
//	name.prefix        : lowercase + edge_ngram(1,15) over the WHOLE name
//	summary/description: standard (unicode tokenizer + lowercase + stop)
//	tags/categories/section/provides.*: keyword lowercased (faceted)
//	keywords           : standard analyzer + edge_ngram side-field
//
// A single mapping is safe to reuse across multiple Open() calls — but NOT
// across a mapping change: bleve.Open() reloads the mapping that was persisted
// when the dir was created and ignores this function entirely. See
// mappingFingerprint / NewIndex for how a changed mapping is detected.
func NewMapping() (mapping.IndexMapping, error) {
	m := bleve.NewIndexMapping()

	// --- custom analyzers ---
	if err := m.AddCustomTokenFilter("pkg_edge_ngram_filter", map[string]any{
		"type": edgengram.Name,
		"min":  1.0,
		"max":  15.0,
	}); err != nil {
		return nil, fmt.Errorf("edge_ngram filter: %w", err)
	}
	if err := m.AddCustomAnalyzer(analyzerEdgeNgram, map[string]any{
		"type":      "custom",
		"tokenizer": unicode.Name,
		"token_filters": []any{
			lowercase.Name,
			"pkg_edge_ngram_filter",
		},
	}); err != nil {
		return nil, fmt.Errorf("edge_ngram analyzer: %w", err)
	}
	// Query-side counterpart to analyzerEdgeNgram: unicode tokenizer +
	// lowercase, but NO edge_ngram filter. See buildQuery for why the
	// query side must not re-gram.
	if err := m.AddCustomAnalyzer(analyzerUnicodeLC, map[string]any{
		"type":          "custom",
		"tokenizer":     unicode.Name,
		"token_filters": []any{lowercase.Name},
	}); err != nil {
		return nil, fmt.Errorf("unicode_lc analyzer: %w", err)
	}
	// Whole-name prefix grams: single tokenizer (do NOT split on - or .)
	// + lowercase + edge_ngram. Anchored to the start of the ENTIRE package
	// name, so a term lookup answers "which names start with X" without
	// walking the term dictionary the way a PrefixQuery does.
	if err := m.AddCustomAnalyzer(analyzerWholePre, map[string]any{
		"type":      "custom",
		"tokenizer": single.Name,
		"token_filters": []any{
			lowercase.Name,
			"pkg_edge_ngram_filter",
		},
	}); err != nil {
		return nil, fmt.Errorf("whole_prefix analyzer: %w", err)
	}
	// name.exact wants keyword-tokenized-then-lowercased. Bleve's built-in
	// `keyword` analyzer emits the input verbatim; we compose it with
	// lowercase for case-insensitive exact match.
	if err := m.AddCustomAnalyzer(analyzerKeywordLC, map[string]any{
		"type":          "custom",
		"tokenizer":     single.Name,
		"token_filters": []any{lowercase.Name},
	}); err != nil {
		return nil, fmt.Errorf("keyword_lc analyzer: %w", err)
	}

	// --- document mapping ---
	doc := bleve.NewDocumentMapping()

	// name — one struct field ("name" via json tag) mapped to TWO
	// indexed fields via FieldMapping.Name overrides. Bleve indexes
	// the same source value under both aliases so query boosts can
	// target them independently. Without the .Name overrides both
	// mappings would collide on the same field name and the second
	// would win, losing one analyzer.
	nameExact := bleve.NewTextFieldMapping()
	nameExact.Name = "name.exact"
	nameExact.Analyzer = analyzerKeywordLC
	nameExact.Store = true

	nameNgram := bleve.NewTextFieldMapping()
	nameNgram.Name = "name.ngram"
	nameNgram.Analyzer = analyzerEdgeNgram
	nameNgram.Store = false
	nameNgram.IncludeTermVectors = false
	namePrefix := bleve.NewTextFieldMapping()
	namePrefix.Name = "name.prefix"
	namePrefix.Analyzer = analyzerWholePre
	namePrefix.Store = false
	namePrefix.IncludeTermVectors = false
	doc.AddFieldMappingsAt("name", nameExact, nameNgram, namePrefix)

	// Human descriptions — standard analyzer.
	summaryFM := bleve.NewTextFieldMapping()
	summaryFM.Analyzer = standard.Name
	summaryFM.Store = true
	doc.AddFieldMappingsAt("summary", summaryFM)

	descFM := bleve.NewTextFieldMapping()
	descFM.Analyzer = en.AnalyzerName
	descFM.Store = false // long body; retrieved from stored PackageRecord not from index
	doc.AddFieldMappingsAt("description", descFM)

	// Keyword-analyzer faceted fields.
	kwFM := func() *mapping.FieldMapping {
		f := bleve.NewTextFieldMapping()
		f.Analyzer = keyword.Name
		f.Store = true
		f.IncludeInAll = false
		return f
	}
	doc.AddFieldMappingsAt("tags", kwFM())
	doc.AddFieldMappingsAt("categories", kwFM())
	doc.AddFieldMappingsAt("section", kwFM())
	doc.AddFieldMappingsAt("os", kwFM())
	doc.AddFieldMappingsAt("release", kwFM())
	doc.AddFieldMappingsAt("arch", kwFM())
	doc.AddFieldMappingsAt("component", kwFM())

	// keywords — dual analyzer under one struct path: standard for
	// keyword matching, edge-ngram for the suggest cheap-path. Same
	// two-fields-one-source trick as name above.
	kwStd := bleve.NewTextFieldMapping()
	kwStd.Name = "keywords"
	kwStd.Analyzer = standard.Name
	kwStd.Store = true

	kwNgram := bleve.NewTextFieldMapping()
	kwNgram.Name = "keywords.ngram"
	kwNgram.Analyzer = analyzerEdgeNgram
	kwNgram.Store = false
	kwNgram.IncludeTermVectors = false
	doc.AddFieldMappingsAt("keywords", kwStd, kwNgram)

	// Provides sub-object → indexed as separate keyword fields so a
	// query like "provides.binary:python3" facets cleanly.
	providesDoc := bleve.NewDocumentMapping()
	for _, k := range []string{"binary", "library", "mimetype", "dbus", "python", "font", "firmware"} {
		providesDoc.AddFieldMappingsAt(k, kwFM())
	}
	doc.AddSubDocumentMapping("provides", providesDoc)

	// Popularity: NOT indexed for search — used only as a stored
	// tiebreak multiplier fetched at hit time. Store integer fields so
	// hit.Fields carries them back.
	popDoc := bleve.NewDocumentMapping()
	popInst := bleve.NewNumericFieldMapping()
	popInst.Store = true
	popInst.Index = false
	popDoc.AddFieldMappingsAt("inst", popInst)
	doc.AddSubDocumentMapping("popularity", popDoc)

	// _raw — the canonical PackageRecord as JSON, STORED but NOT indexed and
	// excluded from _all. This is what makes search results survive a restart:
	// Search() asks for it in SearchRequest.Fields and unmarshals straight out
	// of hit.Fields, so there is no in-memory mirror to lose.
	//
	// All four of Index/IncludeInAll/IncludeTermVectors/DocValues must be
	// turned OFF explicitly — NewTextFieldMapping() defaults every one of them
	// to true. With Index=false, FieldMapping.Options() omits IndexField, so
	// scorch's analyze() never tokenizes the blob: zero postings, zero
	// analysis cost, only the zap segment's stored-fields section grows.
	rawFM := bleve.NewTextFieldMapping()
	rawFM.Name = FieldRaw
	rawFM.Store = true
	rawFM.Index = false
	rawFM.IncludeInAll = false
	rawFM.IncludeTermVectors = false
	rawFM.DocValues = false
	doc.AddFieldMappingsAt(FieldRaw, rawFM)

	m.DefaultMapping = doc
	return m, nil
}

// Index wraps a live *bleve.Index behind an RWMutex so the crawler can atomic-
// swap a freshly-built index in without pausing the search path.
//
// Concurrent search callers RLock while executing a Search(); the swapper
// takes Lock only to replace the pointer (fast). Old bleve.Index is closed
// AFTER the pointer flip completes.
type Index struct {
	mu  sync.RWMutex
	idx bleve.Index
	dir string // active on-disk index directory

	// rebuilt is true when NewIndex found a stale on-disk index (mapping
	// fingerprint mismatch), moved it aside, and started from an empty one.
	// main.go MUST consult this via WasRebuilt() and reset the crawler's
	// state.json: the orchestrator skips any shard whose PackagesSHA256 still
	// matches upstream, so a rebuild without a reset strands the empty index
	// until upstream happens to change.
	rebuilt bool

	// stale is the path the previous index dir was moved to, if any. Logged so
	// an operator can either roll back or reclaim the space.
	stale string
}

// WasRebuilt reports whether the on-disk index was discarded and recreated at
// open time because it was built by an incompatible mapping.
func (i *Index) WasRebuilt() bool {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.rebuilt
}

// StaleDir returns the path the superseded index dir was moved to, or "" if
// nothing was moved aside. Nothing is ever deleted, so this directory persists
// until an operator prunes it.
func (i *Index) StaleDir() string {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.stale
}

// NewIndex opens or creates a Bleve index at dir with the standard mapping.
// If dir doesn't exist it's created; if it exists but wasn't a valid Bleve
// dir, NewIndex returns the error verbatim so the caller can log and skip.
//
// Mapping drift is handled here, and it has to be: bleve.Open() reloads the
// mapping persisted when the dir was CREATED and ignores NewMapping() entirely
// ("The mapping used when it was created will be used for all Index/Search
// operations" — OpenUsing's own doc comment). So editing an analyzer or the
// edge_ngram min silently does nothing to an existing dir, and the process
// keeps serving the old behaviour with new code. NewIndex compares a
// fingerprint of the current mapping against the one stamped into the dir and,
// on mismatch, MOVES the old dir aside to `<dir>.stale-<unix>` and starts a
// fresh one.
//
// Move aside, never delete: refilling a fully crawled index means re-fetching
// every mirror, so the old data stays recoverable and an operator prunes it
// deliberately. Nor does drift refuse to start — pkgsvc runs under
// `restart: unless-stopped`, so returning an error on a mapping change would
// turn a routine binary upgrade into a crash loop.
//
// bleve.OpenUsing(dir, {"updated_mapping": …}) is deliberately NOT used: in
// v2.6.0 it hard-errors "token filters cannot be changed" for exactly this kind
// of edit, and the failing path leaks the bbolt flock, wedging every subsequent
// open. Even on success it only adjusts field flags — it never re-analyzes
// existing documents, so old docs would keep their old postings.
func NewIndex(dir string) (*Index, error) {
	m, err := NewMapping()
	if err != nil {
		return nil, err
	}
	want, err := mappingFingerprint(m)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir index parent: %w", err)
	}

	newStamped := func() (bleve.Index, error) {
		idx, err := bleve.New(dir, m)
		if err != nil {
			return nil, fmt.Errorf("bleve.New(%s): %w", dir, err)
		}
		if err := idx.SetInternal(indexStampKey, []byte(want)); err != nil {
			_ = idx.Close()
			return nil, fmt.Errorf("stamp index %s: %w", dir, err)
		}
		return idx, nil
	}

	if _, statErr := os.Stat(dir); os.IsNotExist(statErr) {
		idx, err := newStamped()
		if err != nil {
			return nil, err
		}
		return &Index{idx: idx, dir: dir}, nil
	}

	idx, err := bleve.Open(dir)
	if err != nil {
		return nil, fmt.Errorf("bleve.Open(%s): %w", dir, err)
	}
	got, gerr := idx.GetInternal(indexStampKey)
	if gerr == nil && string(got) == want {
		return &Index{idx: idx, dir: dir}, nil
	}

	// No stamp, or a stamp that doesn't match. An unstamped dir predates this
	// guard, so fall back to the dir's OWN persisted mapping as the
	// authoritative check — that lets a healthy pre-guard index self-heal
	// (stamp it and carry on) instead of being needlessly rebuilt. Note this
	// comparison is between the on-disk mapping and the in-memory one; the
	// docFormatVersion salt shifts BOTH sides equally and so is deliberately
	// not the deciding factor here. A bump of the salt is caught by the stamp
	// comparison above, which is why the stamp is stored rather than recomputed.
	if len(got) == 0 {
		if onDisk, ferr := mappingFingerprint(idx.Mapping()); ferr == nil && onDisk == want {
			if serr := idx.SetInternal(indexStampKey, []byte(want)); serr == nil {
				return &Index{idx: idx, dir: dir}, nil
			}
		}
	}

	if err := idx.Close(); err != nil {
		return nil, fmt.Errorf("close stale index %s: %w", dir, err)
	}
	stale := fmt.Sprintf("%s.stale-%d", dir, time.Now().UTC().Unix())
	if err := os.Rename(dir, stale); err != nil {
		return nil, fmt.Errorf("move aside stale index %s -> %s: %w", dir, stale, err)
	}
	idx, err = newStamped()
	if err != nil {
		return nil, err
	}
	return &Index{idx: idx, dir: dir, rebuilt: true, stale: stale}, nil
}

// Close releases the underlying Bleve handle. Callers use this on shutdown;
// atomic-swap uses `swapInto` which handles close ordering.
//
// Idempotent by design: main.go both `defer idx.Close()`s and can Close on an
// error path, and scorch panics with "close of closed channel" on a double
// Close, so the handle is nil'd out once released.
func (i *Index) Close() error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.idx == nil {
		return nil
	}
	idx := i.idx
	i.idx = nil
	return idx.Close()
}

// DocCount returns the document count straight from Bleve, so it is correct
// after reopening a populated dir. The previous implementation returned a
// cached field that was only ever assigned in IngestBatch, so it read 0 on
// every restart — which silently made main.go's `if DocCount() == 0` seed guard
// re-ingest the seed corpus over whatever was already there on every boot.
//
// scorch answers this from the in-memory root snapshot (no disk I/O), so it
// stays cheap enough for the /health and /search hot paths.
func (i *Index) DocCount() int {
	i.mu.RLock()
	defer i.mu.RUnlock()
	if i.idx == nil {
		return 0
	}
	n, err := i.idx.DocCount()
	if err != nil {
		return 0
	}
	return int(n)
}

// IngestBatch adds/updates a batch of records. Doc ID is `<os>/<release>/
// <arch>/<component>/<name>` so re-ingesting the same package in a later
// crawl updates the existing document rather than duplicating it.
//
// The Bleve batch is committed once at the end (single fsync). Each record is
// also JSON-marshalled into the _raw stored field, which is the only copy
// Search()/Get() read back — there is no in-memory mirror.
func (i *Index) IngestBatch(records []schema.PackageRecord) error {
	if len(records) == 0 {
		return nil
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.idx == nil {
		return fmt.Errorf("index closed")
	}

	batch := i.idx.NewBatch()
	for j := range records {
		r := &records[j]
		id := DocID(r)
		raw, err := json.Marshal(r)
		if err != nil {
			return fmt.Errorf("marshal %s: %w", id, err)
		}
		if err := batch.Index(id, indexDoc{PackageRecord: *r, Raw: string(raw)}); err != nil {
			return fmt.Errorf("index %s: %w", id, err)
		}
	}
	if err := i.idx.Batch(batch); err != nil {
		return fmt.Errorf("batch commit: %w", err)
	}
	return nil
}

// DocID composes the stable document id for a record.
func DocID(r *schema.PackageRecord) string {
	return r.OS + "/" + r.Release + "/" + r.Arch + "/" + r.Component + "/" + r.Name
}

// SearchOpts controls the query builder. Fuzziness kicks in only when
// Query length >= 4 and only against name.ngram + keywords (never against
// description — Levenshtein on long text is expensive and noisy).
type SearchOpts struct {
	Query  string
	OS     string
	Arch   string
	Limit  int
	Offset int
}

// SearchHit pairs a stored PackageRecord with its rank score.
type SearchHit struct {
	Record schema.PackageRecord
	Score  float64
}

// Search runs a fuzzy multi-field query with the boost table from §5 of the
// plan and applies the log1p(popcon.inst) popularity tiebreak. Returns hits
// slice ordered best-first plus the total-matches count (post-filter).
//
// Optional os/arch narrow the search via keyword filters — cheaper than
// re-indexing per-suite.
func (i *Index) Search(opts SearchOpts) ([]SearchHit, int, error) {
	if opts.Limit <= 0 {
		opts.Limit = 50
	}
	if opts.Limit > 200 {
		opts.Limit = 200
	}

	i.mu.RLock()
	defer i.mu.RUnlock()
	if i.idx == nil {
		return nil, 0, fmt.Errorf("index closed")
	}

	q, err := buildQuery(opts)
	if err != nil {
		return nil, 0, err
	}
	req := bleve.NewSearchRequestOptions(q, opts.Limit*4, opts.Offset, false)
	req.Fields = []string{"popularity.inst", FieldRaw}
	res, err := i.idx.Search(req)
	if err != nil {
		return nil, 0, fmt.Errorf("bleve search: %w", err)
	}

	// Re-score with popularity tiebreak. Bleve's own score is
	// TF-IDF-ish; per the plan we multiply by (1 + POP_WEIGHT *
	// log1p(inst)/log1p(POP_ANCHOR)) so a match on "gcc" with 132k
	// installs floats above an equally-scoring match on some ghost
	// package with 0 installs — but the multiplier is bounded so it
	// CANNOT outrank a legitimate name.exact hit against a
	// description-only hit. The naïve `score * log1p(inst)` had a
	// ~13× spread at popcon.inst=500k which trivially beat the 20× vs.
	// 1× field boost separation. Cap the popularity factor to ≤ 1.5×.
	//
	// POP_ANCHOR is calibrated to Ubuntu's noble popcon median for a
	// well-installed package (~100k); packages an order of magnitude
	// more popular than that saturate the multiplier at 1.5×.
	type scored struct {
		id    string
		raw   string
		score float64
	}
	const (
		popWeight = 0.5    // max additional multiplier (0.5 → up to 1.5×)
		popAnchor = 100000 // inst count that yields the full popWeight
	)
	anchorLog := math.Log1p(popAnchor)
	tie := make([]scored, 0, len(res.Hits))
	for _, h := range res.Hits {
		inst := 0.0
		if raw, ok := h.Fields["popularity.inst"]; ok {
			// Bleve returns numeric fields as float64.
			if f, ok := raw.(float64); ok {
				inst = f
			}
		}
		raw, _ := h.Fields[FieldRaw].(string)
		popFactor := 1.0 + popWeight*math.Min(1.0, math.Log1p(inst)/anchorLog)
		tie = append(tie, scored{id: h.ID, raw: raw, score: h.Score * popFactor})
	}
	// Secondary key = DocID. Bleve's collector orders equal-score hits by
	// internal doc number, which changes when scorch merges segments, so a
	// score-only sort makes the order of a tie flap across restarts for no
	// user-visible reason. Sorting ties by id makes the response a pure
	// function of the candidate set.
	sort.SliceStable(tie, func(a, b int) bool {
		if tie[a].score != tie[b].score {
			return tie[a].score > tie[b].score
		}
		return tie[a].id < tie[b].id
	})

	// Cap to Limit after the re-sort.
	if len(tie) > opts.Limit {
		tie = tie[:opts.Limit]
	}
	hits := make([]SearchHit, 0, len(tie))
	for _, t := range tie {
		// Reconstruct from the stored _raw field. This is the whole point of
		// the design: with no in-memory mirror, a reopened index returns
		// exactly the hits it returned before the restart. Previously the
		// mirror was populated only by IngestBatch and never rebuilt on open,
		// so after a restart every hit was dropped by the `!ok` branch and
		// /search returned total>0 with zero rows.
		//
		// An absent or unparseable _raw means a corrupt document; degrade to
		// the identity fields recoverable from the DocID rather than dropping
		// the row, which is what let len(hits) disagree with the reported total.
		var rec schema.PackageRecord
		if t.raw != "" {
			if err := json.Unmarshal([]byte(t.raw), &rec); err != nil {
				rec = recordFromDocID(t.id)
			}
		} else {
			rec = recordFromDocID(t.id)
		}
		hits = append(hits, SearchHit{Record: rec, Score: t.score})
	}
	return hits, int(res.Total), nil
}

// recordFromDocID reverses DocID into its five identity fields. Only used as
// the degraded fallback when a document's _raw field is missing or corrupt, so
// /search still returns a usable name instead of silently dropping the row.
func recordFromDocID(id string) schema.PackageRecord {
	parts := strings.SplitN(id, "/", 5)
	if len(parts) != 5 {
		return schema.PackageRecord{Name: id}
	}
	return schema.PackageRecord{
		OS:        parts[0],
		Release:   parts[1],
		Arch:      parts[2],
		Component: parts[3],
		Name:      parts[4],
	}
}

// buildQuery constructs the boolean/disjunction stack. Fields not present
// in a document simply contribute zero to the score — Bleve handles the
// missing-field case silently.
func buildQuery(opts SearchOpts) (query.Query, error) {
	q := strings.TrimSpace(opts.Query)
	if q == "" && opts.OS == "" && opts.Arch == "" {
		return bleve.NewMatchAllQuery(), nil
	}

	dis := bleve.NewDisjunctionQuery()

	if q != "" {
		qLower := strings.ToLower(q)

		// name.exact (boost 20).
		term := bleve.NewTermQuery(qLower)
		term.SetField("name.exact")
		term.SetBoost(20.0)
		dis.AddQuery(term)

		// name.prefix (boost 12) — a TRUE leading-edge match on the whole
		// package name, ranked between name.exact's 20 and name.ngram's 8.
		//
		// Needed because name.ngram is TOKENIZED before gramming: the unicode
		// tokenizer splits "gcc-doc" into [gcc, doc] and gramming "doc" emits
		// "do", so "gcc-doc" is a legitimate name.ngram match for q="do" and
		// competes with packages actually starting "do". Measured over 2,889
		// real records with name.ngram alone, q="do" put 0 true prefixes in
		// the top ten (gcc-doc, mcpp-doc, libzt-doc, …); q="op" 3/10, q="gr"
		// 3/10. For a typeahead that is backwards.
		//
		// This is a TermQuery against pre-computed whole-name grams, NOT a
		// PrefixQuery. Both rank correctly, but PrefixQuery walks the term
		// dictionary and was measured 5-6x slower on broad single letters —
		// q="l" 8.23ms vs 1.56ms, q="li" 7.99ms vs 1.34ms on this corpus,
		// and that gap scales with corpus size. A term lookup is O(1)-ish
		// and costs only the extra postings on disk.
		pre := bleve.NewTermQuery(qLower)
		pre.SetField("name.prefix")
		pre.SetBoost(12.0)
		dis.AddQuery(pre)

		// name.ngram — substring recall + fuzzy typo tolerance (boost 8).
		//
		// The explicit Analyzer is load-bearing, not decoration. Bleve
		// resolves a query's analyzer from the DOCUMENT MAPPING path, and
		// there is no property named "name.ngram" — the field exists only
		// via a FieldMapping.Name override — so AnalyzerNameForPath falls
		// through to the index default, "standard". The standard analyzer
		// carries an English STOP-WORD filter, which reduced whole queries
		// to zero tokens: "do", "io", "is", "it", "no", "or", "to", "be",
		// "by", "an", "at", "so" and "of" all analyzed to [] and therefore
		// matched NOTHING, while "doc" and "su" worked. Live symptom before
		// this line: q="do" returned 0 results even though docker.io was
		// indexed; after, 112.
		//
		// pkg_unicode_lc is deliberately NOT the indexing analyzer
		// (pkg_edge_ngram). Re-gramming the query would OR every prefix of
		// it, so "curl" would also match "cups" through the shared "cu"
		// gram. It is also NOT pkg_keyword_lc: single-tokenizing the query
		// leaves "linux-image-amd64" as one term that can never match grams
		// built from the tokenized ["linux","image","amd64"] — measured, that
		// choice made q="curl" miss curl and q="vim" return 0 hits.
		// unicode+lowercase mirrors the index analyzer's tokenization
		// exactly and stops one step short of the ngram filter, which is
		// precisely what a query side needs.
		//
		// The AND operator is equally load-bearing, and it became REQUIRED by
		// dropping the gram min to 1. A MatchQuery defaults to OR over its
		// analyzed tokens, so "libssl-d" tokenizes to [libssl, d] and any
		// document matching EITHER qualifies. At min=2 no single-character gram
		// existed, so the "d" token silently matched nothing and OR was
		// harmless; at min=1 "d" matches every package with a d-initial token.
		// Measured on 2,889 real records: with OR, q="libssl-d", "python3-d"
		// and "openssh-s" each returned total=2889 — the ENTIRE corpus — and
		// "libsl-dev" returned 836. With AND: 1, 39, 1 and 2. AND costs nothing
		// on the single-token queries that dominate typeahead ("curl", "do",
		// "c" and "l" return byte-identical totals either way), because there
		// is only one clause to combine.
		ng := bleve.NewMatchQuery(qLower)
		ng.SetField("name.ngram")
		ng.Analyzer = analyzerUnicodeLC
		ng.SetOperator(query.MatchQueryOperatorAnd)
		ng.SetBoost(8.0)
		dis.AddQuery(ng)

		if len(q) >= 4 {
			fz := bleve.NewFuzzyQuery(qLower)
			fz.SetField("name.exact")
			fz.SetFuzziness(1)
			fz.SetBoost(5.0)
			dis.AddQuery(fz)
		}

		// provides.binary (boost 6).
		pb := bleve.NewTermQuery(qLower)
		pb.SetField("provides.binary")
		pb.SetBoost(6.0)
		dis.AddQuery(pb)

		// keywords (boost 4). Uses standard analyzer.
		kw := bleve.NewMatchQuery(q)
		kw.SetField("keywords")
		kw.SetBoost(4.0)
		dis.AddQuery(kw)

		// tags (boost 3).
		tg := bleve.NewTermQuery(qLower)
		tg.SetField("tags")
		tg.SetBoost(3.0)
		dis.AddQuery(tg)

		// summary (boost 2).
		sm := bleve.NewMatchQuery(q)
		sm.SetField("summary")
		sm.SetBoost(2.0)
		dis.AddQuery(sm)

		// categories (boost 1.5).
		cat := bleve.NewTermQuery(qLower)
		cat.SetField("categories")
		cat.SetBoost(1.5)
		dis.AddQuery(cat)

		// description (boost 1).
		desc := bleve.NewMatchQuery(q)
		desc.SetField("description")
		desc.SetBoost(1.0)
		dis.AddQuery(desc)
	}

	if opts.OS == "" && opts.Arch == "" {
		return dis, nil
	}

	// AND-together the disjunction with the OS/arch filters via a
	// ConjunctionQuery. If the query was empty, the disjunction was
	// MatchAll — same math.
	conj := bleve.NewConjunctionQuery()
	if q != "" {
		conj.AddQuery(dis)
	}
	if opts.OS != "" {
		f := bleve.NewTermQuery(strings.ToLower(opts.OS))
		f.SetField("os")
		conj.AddQuery(f)
	}
	if opts.Arch != "" {
		f := bleve.NewTermQuery(strings.ToLower(opts.Arch))
		f.SetField("arch")
		conj.AddQuery(f)
	}
	return conj, nil
}

// Get returns a single stored record by DocID, or false if absent. Reads the
// _raw stored field out of the Bleve document, so it works on a reopened index
// where the old in-memory mirror would have been empty.
//
// Cost is one scorch Document() lookup — a term-dict seek on _id plus a
// stored-fields read, measured at ~17 µs on a hit and ~2 µs on a miss, so
// handler.handlePackage's 16-lookup worst case is well under a millisecond.
func (i *Index) Get(id string) (schema.PackageRecord, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	if i.idx == nil {
		return schema.PackageRecord{}, false
	}
	doc, err := i.idx.Document(id)
	if err != nil || doc == nil {
		return schema.PackageRecord{}, false
	}
	var raw []byte
	doc.VisitFields(func(f bleveindex.Field) {
		if f.Name() == FieldRaw {
			raw = f.Value()
		}
	})
	if len(raw) == 0 {
		return schema.PackageRecord{}, false
	}
	var rec schema.PackageRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return schema.PackageRecord{}, false
	}
	return rec, true
}
