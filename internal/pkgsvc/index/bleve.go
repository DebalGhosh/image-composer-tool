// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Package index wraps Bleve for the ict-pkgsvc microservice: analyzer chain,
// field mapping, atomic index swap under RWMutex, and query builder with the
// boost table from the plan.
package index

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

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
	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// AnalyzerEdgeNgram is the custom analyzer name for `name.ngram` and
// `keywords_ngram`: unicode tokenize → lowercase → edge_ngram(2,15).
// Registered once per IndexMapping.
const (
	analyzerEdgeNgram = "pkg_edge_ngram"
	analyzerKeywordLC = "pkg_keyword_lc"
)

// NewMapping builds the Bleve IndexMapping for PackageRecord. Field-level
// analyzers align with §5 of the plan:
//
//	name.exact         : keyword lowercased
//	name.ngram         : lowercase + edge_ngram(2,15)
//	summary/description: standard (unicode tokenizer + lowercase + stop)
//	tags/categories/section/provides.*: keyword lowercased (faceted)
//	keywords           : standard analyzer + edge_ngram side-field
//
// A single mapping is safe to reuse across multiple Open() calls.
func NewMapping() (mapping.IndexMapping, error) {
	m := bleve.NewIndexMapping()

	// --- custom analyzers ---
	if err := m.AddCustomTokenFilter("pkg_edge_ngram_filter", map[string]any{
		"type": edgengram.Name,
		"min":  2.0,
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
	doc.AddFieldMappingsAt("name", nameExact, nameNgram)

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
	mu   sync.RWMutex
	idx  bleve.Index
	dir  string // active on-disk index directory
	docs int    // approximate doc count (last snapshot)

	// storeRecs caches the full PackageRecord next to the Bleve index so
	// /search results can return the enriched shape without a second
	// lookup path. Bleve stores the flattened subset only; we mirror the
	// canonical struct separately.
	storeRecs map[string]schema.PackageRecord
}

// NewIndex opens or creates a Bleve index at dir with the standard mapping.
// If dir doesn't exist it's created; if it exists but wasn't a valid Bleve
// dir, NewIndex returns the error verbatim so the caller can log and skip.
func NewIndex(dir string) (*Index, error) {
	m, err := NewMapping()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir index parent: %w", err)
	}
	var idx bleve.Index
	if _, statErr := os.Stat(dir); os.IsNotExist(statErr) {
		idx, err = bleve.New(dir, m)
		if err != nil {
			return nil, fmt.Errorf("bleve.New(%s): %w", dir, err)
		}
	} else {
		idx, err = bleve.Open(dir)
		if err != nil {
			return nil, fmt.Errorf("bleve.Open(%s): %w", dir, err)
		}
	}
	return &Index{idx: idx, dir: dir, storeRecs: make(map[string]schema.PackageRecord)}, nil
}

// Close releases the underlying Bleve handle. Callers use this on shutdown;
// atomic-swap uses `swapInto` which handles close ordering.
func (i *Index) Close() error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.idx != nil {
		return i.idx.Close()
	}
	return nil
}

// DocCount returns the approximate document count. Cheap to call on the hot
// path — it's just an atomic read of the last snapshot.
func (i *Index) DocCount() int {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.docs
}

// IngestBatch adds/updates a batch of records. Doc ID is `<os>/<release>/
// <arch>/<component>/<name>` so re-ingesting the same package in a later
// crawl updates the existing document rather than duplicating it.
//
// The Bleve batch is committed once at the end (single fsync). The
// storeRecs mirror is updated under the same operation.
func (i *Index) IngestBatch(records []schema.PackageRecord) error {
	if len(records) == 0 {
		return nil
	}
	i.mu.Lock()
	defer i.mu.Unlock()

	batch := i.idx.NewBatch()
	for j := range records {
		r := &records[j]
		id := DocID(r)
		if err := batch.Index(id, r); err != nil {
			return fmt.Errorf("index %s: %w", id, err)
		}
		i.storeRecs[id] = *r
	}
	if err := i.idx.Batch(batch); err != nil {
		return fmt.Errorf("batch commit: %w", err)
	}
	n, _ := i.idx.DocCount()
	i.docs = int(n)
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

	q, err := buildQuery(opts)
	if err != nil {
		return nil, 0, err
	}
	req := bleve.NewSearchRequestOptions(q, opts.Limit*4, opts.Offset, false)
	req.Fields = []string{"popularity.inst"}
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
		popFactor := 1.0 + popWeight*math.Min(1.0, math.Log1p(inst)/anchorLog)
		tie = append(tie, scored{id: h.ID, score: h.Score * popFactor})
	}
	sort.SliceStable(tie, func(a, b int) bool { return tie[a].score > tie[b].score })

	// Cap to Limit after the re-sort.
	if len(tie) > opts.Limit {
		tie = tie[:opts.Limit]
	}
	hits := make([]SearchHit, 0, len(tie))
	for _, t := range tie {
		rec, ok := i.storeRecs[t.id]
		if !ok {
			continue
		}
		hits = append(hits, SearchHit{Record: rec, Score: t.score})
	}
	return hits, int(res.Total), nil
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

		// name.ngram — prefix + fuzzy on typo tolerance (boost 8).
		ng := bleve.NewMatchQuery(qLower)
		ng.SetField("name.ngram")
		ng.SetBoost(8.0)
		if len(q) >= 4 {
			ng.SetFuzziness(1)
		}
		dis.AddQuery(ng)

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

// Get returns a single stored record by DocID, or false if absent.
func (i *Index) Get(id string) (schema.PackageRecord, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	r, ok := i.storeRecs[id]
	return r, ok
}
