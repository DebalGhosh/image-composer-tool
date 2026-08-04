// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package webui

import (
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
)

// Six statements, and they decide whether the backend serves the SPA at all —
// internal/api/router.go:53 mounts `GET /` only when HasRealBuild() is true.
//
// The two failure modes are opposite and both bad:
//
//   - False negative (a real build embedded, HasRealBuild() says no): `GET /` is
//     never registered, so the production container 404s on every UI route while
//     the API answers fine. Looks like a routing bug, not a build bug.
//   - False positive (only the placeholder embedded, HasRealBuild() says yes):
//     `GET /` serves the "the UI has not been built into this binary" page as if
//     it were the app, and the SPA fallback means EVERY route returns it with a
//     200. No error surfaces anywhere.
//
// The committed tree embeds only the placeholder — a real build is copied in at
// release time — so these tests must work in BOTH states. Anything asserting a
// fixed answer from HasRealBuild() would fail on a release machine and get
// deleted, which is why the tests driving the embedded FS assert whichever
// direction this tree happens to be in.
//
// That alone left the false-negative direction untestable here, and it is the
// expensive one. So the rule is also driven directly through the
// `hasRealBuild(fs.FS)` seam with fstest.MapFS stand-ins, which pins BOTH answers
// regardless of what is embedded. Mutation-testing drove that split: "always
// return false" survived every conditional test on a placeholder tree.
//
// One branch is deliberately left uncovered. HasRealBuild's `fs.Sub` error path is
// unreachable: the argument is the constant "dist", and fs.Sub only fails on an
// invalid path, so no test can enter it and mutating its return value survives.
// Recorded here rather than papered over with a fake — the same reason applies to
// Assets(), which returns fs.Sub's error verbatim.

func TestAssetsIsRootedAtDist(t *testing.T) {
	// The sub-FS must expose dist's CONTENTS, not dist itself: the router hands
	// this straight to http.FileServer, so a wrongly-rooted FS would serve
	// /dist/index.html and nothing would resolve.
	assets, err := Assets()
	if err != nil {
		t.Fatalf("Assets: %v", err)
	}
	if _, err := fs.Stat(assets, "index.html"); err != nil {
		t.Errorf("index.html not at the root of the returned FS: %v", err)
	}
	if _, err := fs.Stat(assets, "dist"); err == nil {
		t.Error("the returned FS still contains a dist/ directory — it is not rooted inside dist")
	}
}

func TestAssetsAlwaysCarriesAnIndexHTML(t *testing.T) {
	// spaHandler's fallback rewrites any unknown path to "/" and lets
	// http.FileServer serve index.html. With no index.html the fallback 404s, so
	// every client-side route breaks on deep-link or refresh — and it would work
	// fine in dev, where Vite serves the UI.
	assets, err := Assets()
	if err != nil {
		t.Fatalf("Assets: %v", err)
	}
	data, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	if len(data) == 0 {
		t.Error("index.html is empty")
	}
	if !strings.Contains(strings.ToLower(string(data)), "<html") {
		t.Errorf("index.html does not look like HTML: %.80q", data)
	}
}

func TestAssetsIsIdempotent(t *testing.T) {
	// Called once per Router() construction. fs.Sub on an embed.FS is cheap and
	// stateless; pinned so a future caching rewrite cannot hand out a closed or
	// exhausted FS on the second call.
	for i := range 3 {
		assets, err := Assets()
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
		if _, err := fs.Stat(assets, "index.html"); err != nil {
			t.Errorf("call %d: index.html missing: %v", i, err)
		}
	}
}

func TestHasRealBuildTracksThePresenceOfAssets(t *testing.T) {
	// THE CONTRACT, asserted in whichever direction this tree happens to be in.
	// `assets/` is the right discriminator because Vite always emits hashed
	// bundles there and the placeholder is a lone index.html with no <script>.
	assets, err := Assets()
	if err != nil {
		t.Fatalf("Assets: %v", err)
	}
	entries, statErr := fs.ReadDir(assets, "assets")
	wantReal := statErr == nil && len(entries) > 0

	if got := HasRealBuild(); got != wantReal {
		t.Fatalf("HasRealBuild() = %v, but assets/ %s. The router mounts GET / on this "+
			"answer, so a mismatch either 404s the whole UI or serves the placeholder "+
			"as the app", got, describeAssetsDir(statErr, len(entries)))
	}

	// Cross-check against the OTHER observable signal: a real Vite index.html
	// references its hashed bundle, the placeholder does not.
	data, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	linksABundle := strings.Contains(string(data), "/assets/")
	if linksABundle != wantReal {
		t.Errorf("index.html %s a /assets/ bundle but assets/ %s — the embedded tree is "+
			"half-copied, which HasRealBuild() cannot detect",
			map[bool]string{true: "links", false: "does not link"}[linksABundle],
			describeAssetsDir(statErr, len(entries)))
	}
}

func describeAssetsDir(err error, n int) string {
	if err != nil {
		return "does not exist"
	}
	if n == 0 {
		return "exists but is empty"
	}
	return "exists with entries"
}

func TestHasRealBuildIsFalseForThePlaceholderTree(t *testing.T) {
	// The committed state. Skipped rather than inverted on a release machine,
	// where a real build has been copied in — asserting false unconditionally
	// would make `go test ./...` fail exactly when the artifact is correct.
	if _, err := fs.ReadDir(distFS, "dist/assets"); err == nil {
		t.Skip("a real build is embedded in this tree; the placeholder case cannot be " +
			"exercised without mutating the embedded FS")
	}
	if HasRealBuild() {
		t.Error("HasRealBuild() = true with no dist/assets — the router would mount the " +
			"placeholder page as the SPA and every route would 200 with it")
	}
}

func TestHasRealBuildRuleAgainstAStandInFS(t *testing.T) {
	// Drives the rule through the `hasRealBuild(fs.FS)` seam, which is the only way
	// to reach the "a real build IS embedded" answer from a tree that embeds just
	// the placeholder. The false-negative direction is the expensive one: `GET /`
	// never gets mounted, so production 404s the whole UI while the API is fine.
	//
	// A real Vite build is index.html plus hashed bundles under assets/; the
	// placeholder is index.html alone.
	realBuild := fstest.MapFS{
		"index.html":                {Data: []byte(`<script src="/assets/index-a1b2.js">`)},
		"assets/index-a1b2c3d4.js":  {Data: []byte("console.log(1)")},
		"assets/index-e5f6a7b8.css": {Data: []byte("body{}")},
		"assets/logo-1234abcd.svg":  {Data: []byte("<svg/>")},
	}
	placeholder := fstest.MapFS{
		"index.html": {Data: []byte("<html><body>not built</body></html>")},
	}

	if !hasRealBuild(realBuild) {
		t.Error("hasRealBuild = false for a tree with hashed bundles under assets/; " +
			"router.go would never mount GET / and every UI route would 404")
	}
	if hasRealBuild(placeholder) {
		t.Error("hasRealBuild = true for a placeholder-only tree; router.go would serve " +
			"the \"not built\" page as the SPA, and the fallback means EVERY route 200s with it")
	}
	// An assets/ path that is a FILE rather than a directory: ReadDir must error,
	// so the answer is false. Cannot arise from a Vite build, but it is what
	// distinguishes "read a directory" from "does the name exist".
	if hasRealBuild(fstest.MapFS{"assets": {Data: []byte("not a directory")}}) {
		t.Error("hasRealBuild = true when assets is a regular file")
	}
	// A single asset is enough — nothing here should require a minimum count.
	if !hasRealBuild(fstest.MapFS{"assets/only-one.js": {Data: []byte("x")}}) {
		t.Error("hasRealBuild = false with one asset; the rule is non-empty, not a quota")
	}
}

func TestHasRealBuildRejectsAnEmptyAssetsDir(t *testing.T) {
	// `len(entries) > 0` rather than a bare `err == nil`. The two conditions are
	// NOT redundant, but proving it needs a stand-in FS: via //go:embed the
	// toolchain does not capture empty directories at all, so an empty assets/ on
	// disk is simply absent from distFS and ReadDir ERRORS rather than returning
	// zero entries. (Verified by experiment, not assumed — and it is why mutating
	// `> 0` to `>= 0` survived every test that went through the embedded FS.)
	//
	// A MapFS entry with fs.ModeDir and no children is the state //go:embed cannot
	// reach, so this is the only place the length check is observable.
	emptyDir := fstest.MapFS{
		"assets":     {Mode: fs.ModeDir},
		"index.html": {Data: []byte("x")},
	}
	entries, err := fs.ReadDir(emptyDir, "assets")
	if err != nil || len(entries) != 0 {
		t.Fatalf("fixture is wrong: ReadDir(assets) err=%v entries=%d, want a present but "+
			"empty directory", err, len(entries))
	}
	if hasRealBuild(emptyDir) {
		t.Error("hasRealBuild = true for an assets/ that exists but is empty; `err == nil` " +
			"alone is not sufficient, the directory must have contents")
	}

	// And the neighbouring cases, so the boundary is pinned from both sides.
	if !hasRealBuild(fstest.MapFS{"assets/.keep": {Data: []byte("")}}) {
		t.Error("a directory with one entry must count as real")
	}
	if hasRealBuild(fstest.MapFS{"index.html": {Data: []byte("x")}}) {
		t.Error("hasRealBuild = true with no assets/ at all")
	}
}

func TestHasRealBuildIsIdempotent(t *testing.T) {
	// Router() calls it once, but it is exported and cheap enough that a caller
	// may poll. It must be a pure read of the embedded FS.
	first := HasRealBuild()
	for i := range 3 {
		if got := HasRealBuild(); got != first {
			t.Fatalf("call %d returned %v, first call returned %v", i, got, first)
		}
	}
}

func TestEmbeddedTreeHasNoStrayFiles(t *testing.T) {
	// `//go:embed all:dist` — the `all:` prefix deliberately includes dotfiles,
	// which is what a Vite build needs. The risk is the opposite one: a stale
	// artifact left in internal/webui/dist/ from a previous copy-in ships inside
	// the binary and is served publicly. Sourcemaps are the concrete worry —
	// they embed original TypeScript sources.
	for _, bad := range []string{"dist/.env", "dist/.env.local", "dist/.git"} {
		if _, err := fs.Stat(distFS, bad); err == nil {
			t.Errorf("%s is embedded in the binary and would be served at /; `all:dist` "+
				"includes dotfiles, so nothing sensitive may sit in internal/webui/dist/", bad)
		}
	}
	err := fs.WalkDir(distFS, "dist", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(p, ".map") {
			t.Errorf("%s is a sourcemap embedded in the binary; it would expose original "+
				"sources at a public URL", p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk dist: %v", err)
	}
}
