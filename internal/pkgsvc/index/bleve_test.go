// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package index

import (
	"path/filepath"
	"testing"

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
