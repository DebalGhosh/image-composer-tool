// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Package state persists the crawler's cross-refresh bookkeeping to
// /var/lib/pkgsvc/state.json: per-shard timestamps and the SHA256 hashes
// last observed in each suite's InRelease file. Comparing on-disk state to
// the freshly-fetched InRelease is how we skip refreshes when nothing
// upstream has changed since last time.
//
// Writes are atomic (temp file + rename) so a mid-write crash never leaves a
// half-written state.json that would confuse the next boot.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// State is the top-level document. Version is a schema version — bumped
// when the shard entry layout changes so a downgraded binary can refuse to
// consume a newer state.json rather than corrupt it.
type State struct {
	Version int              `json:"version"`
	Shards  map[string]Shard `json:"shards"` // key: "<os>-<release>-<arch>-<component>"
}

// Shard captures what we last saw for one suite × component × arch.
type Shard struct {
	LastRefreshUTC   time.Time         `json:"lastRefreshUtc"`
	PackagesSHA256   string            `json:"packagesSha256"`
	AppStreamSHA256  string            `json:"appstreamSha256,omitempty"`
	PopconSHA256     string            `json:"popconSha256,omitempty"`
	Docs             int               `json:"docs"`
	// Extra is a free-form bag for whatever the crawler wants to remember
	// (dep11 build ids, popcon rotate dates, etc.). Kept as string→string
	// so the schema stays trivially JSON-diffable.
	Extra map[string]string `json:"extra,omitempty"`
}

// Store persists State to a JSON file. Safe for concurrent Save() / Get().
type Store struct {
	mu   sync.Mutex
	path string
	s    State
}

// Open loads a State from `path`. A missing file is not an error — the
// caller gets a zero-valued Store ready to be populated. A corrupted file
// is an error; the caller should log it and either bail or blow away the
// file and start fresh.
func Open(path string) (*Store, error) {
	st := &Store{path: path, s: State{Version: 1, Shards: map[string]Shard{}}}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return nil, fmt.Errorf("state.Open: %w", err)
	}
	if len(data) == 0 {
		return st, nil
	}
	if err := json.Unmarshal(data, &st.s); err != nil {
		return nil, fmt.Errorf("state.Open: parse %s: %w", path, err)
	}
	if st.s.Shards == nil {
		st.s.Shards = map[string]Shard{}
	}
	return st, nil
}

// ShardKey builds the map key used inside State.Shards.
func ShardKey(os, release, arch, component string) string {
	return os + "-" + release + "-" + arch + "-" + component
}

// Get returns a copy of the shard entry (ok=false if absent). Concurrent-safe.
func (s *Store) Get(key string) (Shard, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sh, ok := s.s.Shards[key]
	return sh, ok
}

// Put replaces (or inserts) a shard entry. Does NOT persist to disk;
// callers should batch multiple puts and then Save() once.
func (s *Store) Put(key string, sh Shard) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.s.Shards[key] = sh
}

// Snapshot returns a shallow copy of the whole state (helpful for /health).
func (s *Store) Snapshot() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := State{Version: s.s.Version, Shards: make(map[string]Shard, len(s.s.Shards))}
	for k, v := range s.s.Shards {
		out.Shards[k] = v
	}
	return out
}

// Save atomically persists the current state. Write to <path>.tmp, fsync,
// then rename over. On any error the on-disk file is left untouched.
func (s *Store) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("open tmp: %w", err)
	}
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(&s.s); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("encode: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("fsync: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close tmp: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}
