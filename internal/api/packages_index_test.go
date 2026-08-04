// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"sync"
	"testing"
)

// BE-0 coverage work, part three. packageIndex.find and .isKnown were both at 0%.
//
// Their whole reason for existing is a DISTINCTION the search endpoint depends on:
// "we advertise this (os, arch) but its shard failed to load" is a server-side
// problem worth a soft warning header, while "nobody has ever heard of this key"
// is operator error. Collapse the two and the endpoint either hides a real load
// failure or cries wolf on a typo.
//
// Both are also nil-receiver-safe, because packageIndex is nil when no packages
// are configured at all. That is easy to lose in a refactor and panics the
// endpoint when it goes.

func testIndex() *packageIndex {
	return &packageIndex{
		shards: map[string]*packageIndexShard{
			"ubuntu24-amd64": {OS: "ubuntu24", Arch: "amd64"},
		},
		knownOS: map[string]struct{}{
			"ubuntu24-amd64": {},
			// Advertised in index.yaml but its shard is absent from `shards` —
			// i.e. the file failed to load. This is the case the two functions
			// exist to tell apart.
			"debian13-arm64": {},
		},
	}
}

// --- find -------------------------------------------------------------------

func TestPackageIndexFindReturnsLoadedShard(t *testing.T) {
	got := testIndex().find("ubuntu24", "amd64")
	if got == nil {
		t.Fatal("expected the loaded shard")
	}
	if got.OS != "ubuntu24" || got.Arch != "amd64" {
		t.Errorf("got shard %s-%s, want ubuntu24-amd64", got.OS, got.Arch)
	}
}

func TestPackageIndexFindReturnsNilForAdvertisedButUnloadedShard(t *testing.T) {
	// debian13-arm64 IS known but has no shard. find must report nil — and
	// isKnown must still say true. That pair is the distinction.
	pi := testIndex()
	if got := pi.find("debian13", "arm64"); got != nil {
		t.Errorf("find returned %+v, want nil for an advertised-but-unloaded shard", got)
	}
	if !pi.isKnown("debian13", "arm64") {
		t.Error("isKnown must still be true for an advertised key whose shard failed to load")
	}
}

func TestPackageIndexFindReturnsNilForUnknownKey(t *testing.T) {
	pi := testIndex()
	for _, c := range []struct{ os, arch string }{
		{"fedora42", "amd64"},
		{"ubuntu24", "riscv64"},
		{"", ""},
		{"ubuntu24", ""},
	} {
		if got := pi.find(c.os, c.arch); got != nil {
			t.Errorf("find(%q, %q) = %+v, want nil", c.os, c.arch, got)
		}
	}
}

func TestPackageIndexKeySchemeIsUnambiguous(t *testing.T) {
	// The map key is os+"-"+arch. I initially assumed that concatenation was
	// ambiguous — that ("ubuntu24-amd", "64") would collide with
	// ("ubuntu24", "amd64") — and wrote a test asserting the collision. It failed,
	// because the separator is ALWAYS inserted: the first pair keys
	// "ubuntu24-amd-64", the second "ubuntu24-amd64". No collision. Keeping the
	// corrected assertion, because "these two must stay distinct" is worth
	// pinning even though the current scheme gets it right for free.
	pi := &packageIndex{
		shards: map[string]*packageIndexShard{
			"ubuntu24-amd64": {OS: "ubuntu24", Arch: "amd64"},
		},
		knownOS: map[string]struct{}{"ubuntu24-amd64": {}},
	}
	if pi.find("ubuntu24", "amd64") == nil {
		t.Fatal("the straightforward lookup must work")
	}
	if got := pi.find("ubuntu24-amd", "64"); got != nil {
		t.Errorf("find(\"ubuntu24-amd\", \"64\") = %+v, want nil: a differently-split "+
			"pair must not reach another shard", got)
	}
	if pi.isKnown("ubuntu24-amd", "64") {
		t.Error("isKnown must not match a differently-split pair either")
	}
}

func TestPackageIndexFindOnNilReceiver(t *testing.T) {
	// packageIndex is nil when the server runs with no packages configured. The
	// handler calls find() unconditionally, so a nil deref here would 500 every
	// package request instead of returning an empty result.
	var pi *packageIndex
	if got := pi.find("ubuntu24", "amd64"); got != nil {
		t.Errorf("nil receiver returned %+v, want nil", got)
	}
}

func TestPackageIndexFindOnEmptyIndex(t *testing.T) {
	pi := &packageIndex{
		shards:  map[string]*packageIndexShard{},
		knownOS: map[string]struct{}{},
	}
	if got := pi.find("ubuntu24", "amd64"); got != nil {
		t.Errorf("empty index returned %+v, want nil", got)
	}
}

// --- isKnown ----------------------------------------------------------------

func TestPackageIndexIsKnown(t *testing.T) {
	pi := testIndex()
	cases := []struct {
		os, arch string
		want     bool
	}{
		{"ubuntu24", "amd64", true},  // advertised and loaded
		{"debian13", "arm64", true},  // advertised, shard missing
		{"fedora42", "amd64", false}, // never advertised
		{"ubuntu24", "riscv64", false},
		{"", "", false},
	}
	for _, c := range cases {
		if got := pi.isKnown(c.os, c.arch); got != c.want {
			t.Errorf("isKnown(%q, %q) = %v, want %v", c.os, c.arch, got, c.want)
		}
	}
}

func TestPackageIndexIsKnownOnNilReceiver(t *testing.T) {
	var pi *packageIndex
	if pi.isKnown("ubuntu24", "amd64") {
		t.Error("nil receiver must report nothing as known")
	}
}

func TestPackageIndexIsKnownIsIndependentOfShards(t *testing.T) {
	// isKnown reads knownOS ONLY. Wiring it to `shards` instead would make the
	// two functions synonyms and destroy the distinction they exist for.
	pi := &packageIndex{
		shards:  map[string]*packageIndexShard{}, // nothing loaded
		knownOS: map[string]struct{}{"ubuntu24-amd64": {}},
	}
	if !pi.isKnown("ubuntu24", "amd64") {
		t.Error("isKnown must consult knownOS, not shards")
	}
	if pi.find("ubuntu24", "amd64") != nil {
		t.Error("find must consult shards, not knownOS")
	}
}

// --- concurrency ------------------------------------------------------------

func TestPackageIndexConcurrentReads(t *testing.T) {
	// Both take pi.mu.RLock. Run under `go test -race` this catches a future
	// refactor that drops the lock while a loader mutates the maps.
	pi := testIndex()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); pi.find("ubuntu24", "amd64") }()
		go func() { defer wg.Done(); pi.isKnown("debian13", "arm64") }()
	}
	wg.Wait()
}
