// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// This package was at 0% coverage and it is the crawler's memory. Three
// behaviours here have bitten before or would bite silently:
//
//   - Open must distinguish MISSING (fine, first run) from CORRUPT (an error the
//     caller must see) — conflating them means a damaged state file gets
//     silently replaced and every shard re-downloads.
//   - Reset exists because the stored SHA256s describe what UPSTREAM looked like,
//     not what the index contains. Without it, rebuilding the Bleve index leaves
//     it PERMANENTLY EMPTY until upstream happens to publish a new Packages file.
//   - Save is a write-tmp/fsync/rename so a crash mid-write cannot truncate the
//     existing state.

func TestOpenMissingFileIsNotAnError(t *testing.T) {
	// First run. The caller gets a usable zero-valued store, not an error.
	path := filepath.Join(t.TempDir(), "nope", "state.json")
	st, err := Open(path)
	if err != nil {
		t.Fatalf("missing file must not error: %v", err)
	}
	if st == nil {
		t.Fatal("expected a usable store")
	}
	if st.s.Version != 1 {
		t.Errorf("Version = %d, want 1", st.s.Version)
	}
	if st.s.Shards == nil {
		t.Error("Shards must be an initialised map, not nil — Put would panic")
	}
}

func TestOpenEmptyFileIsNotAnError(t *testing.T) {
	// A zero-byte file is what you get if a previous run was killed between
	// create and write. Treated as "no state yet" rather than corruption.
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := Open(path)
	if err != nil {
		t.Fatalf("empty file must not error: %v", err)
	}
	if st.s.Shards == nil {
		t.Error("Shards must be initialised")
	}
}

func TestOpenCorruptFileIsAnError(t *testing.T) {
	// THE DISTINCTION THAT MATTERS. Malformed JSON must surface so the caller can
	// decide — log and bail, or delete and re-crawl. Silently starting fresh
	// would hide a disk or serialisation problem.
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := Open(path)
	if err == nil {
		t.Fatal("corrupt JSON must be an error")
	}
	if st != nil {
		t.Error("a failed Open must return a nil store, not a half-built one")
	}
}

func TestOpenRoundTripsAnExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	orig, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	when := time.Date(2026, 8, 2, 17, 52, 0, 0, time.UTC)
	orig.Put(ShardKey("ubuntu", "noble", "amd64", "main"), Shard{
		LastRefreshUTC: when,
		PackagesSHA256: "abc123",
		Docs:           4211,
		Extra:          map[string]string{"dep11": "build-7"},
	})
	if err := orig.Save(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	sh, ok := reopened.Get(ShardKey("ubuntu", "noble", "amd64", "main"))
	if !ok {
		t.Fatal("the saved shard did not survive the round trip")
	}
	if sh.PackagesSHA256 != "abc123" || sh.Docs != 4211 {
		t.Errorf("shard = %+v, want the saved values", sh)
	}
	if !sh.LastRefreshUTC.Equal(when) {
		t.Errorf("LastRefreshUTC = %v, want %v", sh.LastRefreshUTC, when)
	}
	if sh.Extra["dep11"] != "build-7" {
		t.Errorf("Extra = %v, want the free-form bag preserved", sh.Extra)
	}
}

func TestOpenTolerantOfNullShards(t *testing.T) {
	// `{"version":1,"shards":null}` is valid JSON that unmarshals to a nil map.
	// Open must re-initialise it or the first Put panics on assignment to a nil
	// map — a crash on the crawler's happy path.
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"shards":null}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.s.Shards == nil {
		t.Fatal("Shards must be re-initialised after unmarshalling null")
	}
	// Prove it: this would panic against a nil map.
	st.Put("k", Shard{Docs: 1})
	if _, ok := st.Get("k"); !ok {
		t.Error("Put after a null-shards load did not take effect")
	}
}

// --- ShardKey ---------------------------------------------------------------

func TestShardKeyShape(t *testing.T) {
	got := ShardKey("ubuntu", "noble", "amd64", "main")
	if want := "ubuntu-noble-amd64-main"; got != want {
		t.Errorf("ShardKey = %q, want %q", got, want)
	}
}

func TestShardKeyDistinguishesEveryDimension(t *testing.T) {
	// All four fields participate. Collapsing any one would make two different
	// suites share a hash entry, so one would never refresh.
	base := ShardKey("ubuntu", "noble", "amd64", "main")
	others := []string{
		ShardKey("debian", "noble", "amd64", "main"),
		ShardKey("ubuntu", "jammy", "amd64", "main"),
		ShardKey("ubuntu", "noble", "arm64", "main"),
		ShardKey("ubuntu", "noble", "amd64", "universe"),
	}
	for _, o := range others {
		if o == base {
			t.Errorf("ShardKey collision: %q", o)
		}
	}
}

// --- Get / Put --------------------------------------------------------------

func TestGetMissingKey(t *testing.T) {
	st, _ := Open(filepath.Join(t.TempDir(), "s.json"))
	if _, ok := st.Get("absent"); ok {
		t.Error("expected ok=false for an absent key")
	}
}

func TestPutOverwrites(t *testing.T) {
	st, _ := Open(filepath.Join(t.TempDir(), "s.json"))
	st.Put("k", Shard{Docs: 1, PackagesSHA256: "first"})
	st.Put("k", Shard{Docs: 2, PackagesSHA256: "second"})
	sh, ok := st.Get("k")
	if !ok {
		t.Fatal("expected the key")
	}
	if sh.Docs != 2 || sh.PackagesSHA256 != "second" {
		t.Errorf("shard = %+v, want the second Put to win", sh)
	}
}

func TestGetReturnsACopy(t *testing.T) {
	// Shard is returned by value, so a caller mutating what it got must not
	// reach into the store. The Extra MAP is shared, though — documented below.
	st, _ := Open(filepath.Join(t.TempDir(), "s.json"))
	st.Put("k", Shard{Docs: 10})
	sh, _ := st.Get("k")
	sh.Docs = 999
	again, _ := st.Get("k")
	if again.Docs != 10 {
		t.Errorf("Docs = %d; mutating the returned value must not affect the store", again.Docs)
	}
}

func TestGetSharesTheExtraMap(t *testing.T) {
	// ⚠️ CURRENT BEHAVIOUR, pinned rather than endorsed. Shard is copied by value
	// but Extra is a map, so the copy shares the same backing store: a caller that
	// writes into sh.Extra mutates the stored shard. Harmless today because the
	// crawler only ever writes Extra as part of a fresh Put, but a future caller
	// that treats Get as read-only would be surprised. Recorded so a deep-copy
	// change is deliberate.
	st, _ := Open(filepath.Join(t.TempDir(), "s.json"))
	st.Put("k", Shard{Extra: map[string]string{"a": "1"}})
	sh, _ := st.Get("k")
	sh.Extra["a"] = "mutated"
	again, _ := st.Get("k")
	if again.Extra["a"] != "mutated" {
		t.Error("expected the Extra map to be shared with the stored shard " +
			"(shallow copy); if this now fails, Get deep-copies and this note is stale")
	}
}

// --- Reset ------------------------------------------------------------------

func TestResetDropsEveryShard(t *testing.T) {
	// ⚠️ WHY THIS EXISTS. The stored SHA256s describe UPSTREAM, not the index. When
	// the Bleve mapping changes and the index is rebuilt empty, the orchestrator's
	// "skip: hash unchanged" branch would otherwise leave it empty forever —
	// until upstream published a new Packages file, which could be weeks.
	st, _ := Open(filepath.Join(t.TempDir(), "s.json"))
	st.Put("a", Shard{Docs: 1})
	st.Put("b", Shard{Docs: 2})

	st.Reset()

	if n := len(st.Snapshot().Shards); n != 0 {
		t.Errorf("%d shards survived Reset, want 0", n)
	}
	if _, ok := st.Get("a"); ok {
		t.Error("shard 'a' survived Reset")
	}
	// Still usable afterwards — Reset must re-initialise, not nil out.
	st.Put("c", Shard{Docs: 3})
	if _, ok := st.Get("c"); !ok {
		t.Error("Put after Reset did not take effect; Reset must leave a live map")
	}
}

func TestResetDoesNotPersist(t *testing.T) {
	// Documented contract: Reset mutates memory only. A caller that forgets the
	// following Save() keeps the old on-disk hashes, which is exactly the bug
	// Reset exists to avoid — so this pins the surprising half.
	path := filepath.Join(t.TempDir(), "state.json")
	st, _ := Open(path)
	st.Put("a", Shard{Docs: 1})
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	st.Reset()

	onDisk, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := onDisk.Get("a"); !ok {
		t.Error("Reset persisted to disk; it must not until Save() is called")
	}
}

// --- Snapshot ---------------------------------------------------------------

func TestSnapshotIsDecoupledFromTheStore(t *testing.T) {
	st, _ := Open(filepath.Join(t.TempDir(), "s.json"))
	st.Put("a", Shard{Docs: 1})

	snap := st.Snapshot()
	st.Put("b", Shard{Docs: 2}) // added after the snapshot
	delete(snap.Shards, "a")    // mutate the snapshot

	if len(snap.Shards) != 0 {
		t.Errorf("snapshot has %d shards after deletion, want 0", len(snap.Shards))
	}
	if _, ok := st.Get("a"); !ok {
		t.Error("deleting from the snapshot removed it from the store; the map must be copied")
	}
	if len(st.Snapshot().Shards) != 2 {
		t.Error("the post-snapshot Put is missing from a fresh snapshot")
	}
}

func TestSnapshotCarriesTheVersion(t *testing.T) {
	// /health surfaces this; a downgraded binary uses it to refuse a newer file.
	st, _ := Open(filepath.Join(t.TempDir(), "s.json"))
	if got := st.Snapshot().Version; got != 1 {
		t.Errorf("Version = %d, want 1", got)
	}
}

// --- Save -------------------------------------------------------------------

func TestSaveCreatesParentDirectories(t *testing.T) {
	// The crawler's state path is under a data dir that may not exist on a fresh
	// deployment. Save must not fail on that.
	path := filepath.Join(t.TempDir(), "deep", "nested", "state.json")
	st, _ := Open(path)
	st.Put("a", Shard{Docs: 1})
	if err := st.Save(); err != nil {
		t.Fatalf("Save must create parent dirs: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("state file not written: %v", err)
	}
}

func TestSaveLeavesNoTempFile(t *testing.T) {
	// Write-tmp-then-rename. A leftover .tmp means the rename did not happen and
	// the next Open reads stale state.
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	st, _ := Open(path)
	st.Put("a", Shard{Docs: 1})
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("a .tmp file survived Save; the rename did not complete")
	}
}

func TestSaveWritesIndentedJSON(t *testing.T) {
	// SetIndent is deliberate: the file is meant to be diffable by hand when
	// debugging why a shard did or did not refresh.
	path := filepath.Join(t.TempDir(), "state.json")
	st, _ := Open(path)
	st.Put(ShardKey("ubuntu", "noble", "amd64", "main"), Shard{Docs: 7})
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(data) {
		t.Fatal("Save wrote invalid JSON")
	}
	if !bytes.Contains(data, []byte("\n  ")) {
		t.Error("expected two-space indentation for hand-diffability")
	}
}

func TestSaveIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	st, _ := Open(path)
	st.Put("a", Shard{Docs: 1})
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Error("two Saves of unchanged state produced different bytes")
	}
}

// --- concurrency ------------------------------------------------------------

func TestConcurrentPutGetSnapshot(t *testing.T) {
	// The store advertises itself as safe for concurrent Save/Get. Under
	// `go test -race` this is the assertion that backs that claim.
	st, _ := Open(filepath.Join(t.TempDir(), "state.json"))
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(3)
		go func(i int) {
			defer wg.Done()
			st.Put(ShardKey("os", "rel", "arch", string(rune('a'+i%26))), Shard{Docs: i})
		}(i)
		go func() { defer wg.Done(); st.Get("os-rel-arch-a") }()
		go func() { defer wg.Done(); _ = st.Snapshot() }()
	}
	wg.Wait()
}

// --- error paths ------------------------------------------------------------
//
// Everything above exercises the happy paths. The rest of this file covers what
// happens when the filesystem says no, which is where a silent failure would
// hurt most: state.json is the crawler's only memory, so a Save error that is
// swallowed means the next boot re-downloads and re-ingests every shard, and an
// Open error that is swallowed means the same thing plus a lost record of what
// upstream looked like.

func TestOpenReadErrorIsNotMistakenForAMissingFile(t *testing.T) {
	// A DIRECTORY at the state path. This is the shape a bad volume mount takes in
	// the container: `-v foo:/var/lib/pkgsvc/state.json` makes Docker create a
	// directory. ReadFile then fails with EISDIR, which is neither fs.ErrNotExist
	// nor a parse error — if that fell through to the "missing file, first run"
	// branch the crawler would start from scratch on every single boot and never
	// once persist its state, with nothing in the log to say why.
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	st, err := Open(path)
	if err == nil {
		t.Fatal("a directory at the state path must be an error, not a silent fresh start")
	}
	if errors.Is(err, fs.ErrNotExist) {
		t.Errorf("error = %v, want something other than ErrNotExist", err)
	}
	if !strings.Contains(err.Error(), "state.Open") {
		t.Errorf("error = %v, want it prefixed with state.Open", err)
	}
	if st != nil {
		t.Error("a failed Open must return a nil store, not a half-built one")
	}
}

func TestSaveMkdirFailureIsReported(t *testing.T) {
	// The state directory is a DANGLING symlink — the shape a moved or unmounted
	// data volume leaves behind. MkdirAll sees the link, finds it is not a real
	// directory, and fails with EEXIST.
	//
	// Save must report that rather than return nil: the crawler treats a nil Save
	// as "state persisted" and moves on, so a swallowed error costs a full re-crawl
	// on every boot with nothing in the log to explain it.
	//
	// A dangling symlink rather than a chmod 0555 parent, deliberately: permission
	// tricks are inert when the suite runs as root (in CI containers it usually
	// does), and a test that silently skips there is a test that does not exist.
	root := t.TempDir()
	parent := filepath.Join(root, "pkgsvc")
	if err := os.Symlink(filepath.Join(root, "gone", "target"), parent); err != nil {
		t.Fatal(err)
	}
	st, err := Open(filepath.Join(parent, "state.json"))
	if err != nil {
		t.Fatalf("Open of a not-yet-existing path must succeed: %v", err)
	}
	st.Put("a", Shard{Docs: 1})
	err = st.Save()
	if err == nil {
		t.Fatal("Save must report a failure to create its parent directory")
	}
	if !strings.Contains(err.Error(), "mkdir") {
		t.Errorf("error = %v, want it to name the mkdir step", err)
	}
}

func TestSaveTempOpenFailureIsReported(t *testing.T) {
	// Something already occupies <path>.tmp and is not a regular file. In practice
	// this is a leftover from a botched manual recovery; the point is that Save
	// reports it instead of silently not persisting.
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.Mkdir(path+".tmp", 0o755); err != nil {
		t.Fatal(err)
	}
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	st.Put("a", Shard{Docs: 1})
	err = st.Save()
	if err == nil {
		t.Fatal("Save must report that it could not open its temp file")
	}
	if !strings.Contains(err.Error(), "open tmp") {
		t.Errorf("error = %v, want it to name the temp-open step", err)
	}
	// The real file was never created, so the previous state (here: none) stands.
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Errorf("Save created %s despite failing; a failed Save must leave the on-disk file untouched", path)
	}
}

// symlinkTmpTo points <path>.tmp at a character device so Save's OpenFile
// follows the link and inherits the device's write/fsync semantics. This is the
// only way to make the encode and fsync branches fail without a filesystem that
// can actually fill up.
func symlinkTmpTo(t *testing.T, path, dev string) {
	t.Helper()
	if _, err := os.Stat(dev); err != nil {
		t.Skipf("%s is unavailable: %v", dev, err)
	}
	if err := os.Symlink(dev, path+".tmp"); err != nil {
		t.Fatalf("symlink %s -> %s: %v", path+".tmp", dev, err)
	}
}

func TestSaveEncodeFailureCleansUpAndReports(t *testing.T) {
	// /dev/full accepts an open and then fails every write with ENOSPC — a disk
	// that filled up between the open and the write, which is exactly what happens
	// when a small state volume runs out mid-crawl. The contract: report it, remove
	// the partial temp file, and leave the previously-saved state intact. Leaving
	// the truncated temp behind would be a trap for the next recovery attempt.
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	// Establish a good on-disk state first, so "left untouched" is verifiable
	// rather than vacuous.
	seed, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	seed.Put("keeper", Shard{Docs: 42, PackagesSHA256: "sha-of-record"})
	if err := seed.Save(); err != nil {
		t.Fatal(err)
	}

	symlinkTmpTo(t, path, "/dev/full")
	seed.Put("newer", Shard{Docs: 99})
	err = seed.Save()
	if err == nil {
		t.Fatal("Save must report a write failure (ENOSPC)")
	}
	if !strings.Contains(err.Error(), "encode") {
		t.Errorf("error = %v, want it to name the encode step", err)
	}
	if _, statErr := os.Lstat(path + ".tmp"); !os.IsNotExist(statErr) {
		t.Errorf("the temp file survived a failed encode (%v); Save must clean it up", statErr)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("the previously-saved state is no longer readable: %v", err)
	}
	sh, ok := reopened.Get("keeper")
	if !ok || sh.Docs != 42 || sh.PackagesSHA256 != "sha-of-record" {
		t.Errorf("on-disk shard = %+v (ok=%v), want the pre-failure values; a failed "+
			"Save must not damage what was already persisted", sh, ok)
	}
	if _, ok := reopened.Get("newer"); ok {
		t.Error("the failed Save's new shard reached disk")
	}
}

func TestSaveFsyncFailureCleansUpAndReports(t *testing.T) {
	// /dev/null takes the write happily and then fails fsync with EINVAL, which
	// isolates the fsync branch from the encode branch above. fsync is the whole
	// reason this is a tmp+rename: without a successful flush the rename could
	// publish a file whose contents are not yet on the platter, so a power loss
	// straight after a "successful" Save would leave a zero-length state.json.
	// Bailing here is what keeps that from being reported as success.
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	symlinkTmpTo(t, path, "/dev/null")

	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	st.Put("a", Shard{Docs: 1})
	err = st.Save()
	if err == nil {
		t.Fatal("Save must report an fsync failure rather than claim success")
	}
	if !strings.Contains(err.Error(), "fsync") {
		t.Errorf("error = %v, want it to name the fsync step (encode succeeded here)", err)
	}
	if _, statErr := os.Lstat(path + ".tmp"); !os.IsNotExist(statErr) {
		t.Errorf("the temp file survived a failed fsync (%v); Save must clean it up", statErr)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Error("Save renamed an unflushed temp file into place")
	}
}

// Save's `close tmp` branch is deliberately left uncovered. Reaching it needs
// close(2) to fail on a regular file whose Sync has ALREADY succeeded — on a
// local filesystem that combination does not occur, and the devices used above
// fail Sync first. Covering it would mean adding a seam to state.go, which a
// coverage change must not do.

func TestSaveRenameFailureIsReported(t *testing.T) {
	// A non-empty DIRECTORY at the state path: everything up to the rename
	// succeeds, then rename fails with EISDIR. This is the last step, so it is the
	// one where "returned nil anyway" would be most convincing and most wrong —
	// the caller would believe the state was published when the file it wrote is
	// still sitting under a .tmp name.
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "occupant"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Open() would reject the directory; the store under test is constructed
	// directly so the failure lands on Save's rename rather than earlier.
	st := &Store{path: path, s: State{Version: 1, Shards: map[string]Shard{"a": {Docs: 1}}}}
	err := st.Save()
	if err == nil {
		t.Fatal("Save must report a failed rename")
	}
	if !strings.Contains(err.Error(), "rename") {
		t.Errorf("error = %v, want it to name the rename step", err)
	}
	// ⚠️ CURRENT BEHAVIOUR, pinned rather than endorsed: unlike the encode and
	// fsync branches, the rename branch does NOT unlink the temp file, so a fully
	// written <path>.tmp is left behind. Harmless (the next Save truncates it) and
	// arguably useful for forensics, but recorded here so a future cleanup is a
	// deliberate choice and TestSaveLeavesNoTempFile's guarantee is understood to
	// apply to the SUCCESS path only.
	if _, statErr := os.Stat(path + ".tmp"); statErr != nil {
		t.Errorf("expected the temp file to be left behind after a failed rename (%v); "+
			"if Save now cleans it up, this note is stale", statErr)
	}
}

func TestOpenRejectsWellFormedJSONOfTheWrongShape(t *testing.T) {
	// Valid JSON, wrong type for `shards`. Distinct from TestOpenCorruptFileIsAnError,
	// which feeds syntactically broken bytes: this is the shape a genuine schema
	// change produces, and it must reach the caller as an error rather than yield a
	// store with an empty shard map that then re-crawls everything.
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"shards":["not","a","map"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := Open(path)
	if err == nil {
		t.Fatalf("want an error for a type-mismatched shards field; got %+v", st.Snapshot())
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("error = %v, want it to name the offending file so an operator can find it", err)
	}
	if st != nil {
		t.Error("a failed Open must return a nil store")
	}
}
