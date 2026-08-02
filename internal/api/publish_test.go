// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// publishConsoleBlock is the PUBLISH stage's console output, verbatim from a
// worker-03 run: artifactory-upload.sh's header/target/per-file/footer echoes
// followed by ictBuild.groovy's trailing "Artefacts published to:" line.
//
// These are the only lines in the whole build where the image filename appears
// machine-readably — the pipeline archives just UPLOAD-MANIFEST.txt and
// image-composer-tool.log with Jenkins, so the multi-GB image is invisible to
// the artifacts REST API.
var publishConsoleBlock = []string{
	"==> Publishing 6 file(s) from /home/jenkins/workspace/worker-03/upload",
	"==> Target:      https://af01p-png.devtools.intel.com/artifactory/core-os-yocto-png-local/worker-03/20260802-1750/",
	"  + minimal-desktop-ubuntu-24.04.raw.gz (3663831040 bytes, sha256=9f2c1b0d4e7a8351cd62f04b9a7e5316c8d0f2a4b6e91735d84c02af5b6e73d1)",
	"  + spdx_manifest.json (412887 bytes, sha256=1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809)",
	"  + image-composer-tool.log (2884411 bytes, sha256=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0)",
	"  + chrootpkgs-ubuntu.dot (75210 bytes, sha256=abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd)",
	"  + UPLOAD-MANIFEST.txt (1044 bytes, sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef)",
	"  + debug-state.tar.gz (18446 bytes, sha256=cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe)",
	"==> Publish complete.",
	"Artefacts published to: https://af01p-png.devtools.intel.com/artifactory/core-os-yocto-png-local/worker-03/20260802-1750/",
}

// timestamped mirrors what Jenkins' `options { timestamps() }` does to every
// console line (ictBuild.groovy) — the reason none of the publish regexes may
// be ^-anchored.
func timestamped(lines []string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = "[2026-08-02T17:52:1" + string(rune('0'+i%10)) + ".402Z] " + l
	}
	return out
}

const wantDir = "https://af01p-png.devtools.intel.com/artifactory/core-os-yocto-png-local/worker-03/20260802-1750/"

// TestCaptureArtifactoryLines feeds the real console block through the scraper,
// with and without Jenkins' timestamp prefix, and asserts the upload directory
// is captured once (first match wins) and every uploaded file is collected with
// its exact byte count.
func TestCaptureArtifactoryLines(t *testing.T) {
	for _, tc := range []struct {
		name  string
		lines []string
	}{
		{"raw console", publishConsoleBlock},
		{"timestamps() prefixed", timestamped(publishConsoleBlock)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{}
			b := &build{Jenkins: &jenkinsMeta{}}
			for _, line := range tc.lines {
				s.captureArtifactoryLines(b, line)
			}

			if b.Jenkins.ArtifactoryURL != wantDir {
				t.Errorf("ArtifactoryURL = %q, want %q", b.Jenkins.ArtifactoryURL, wantDir)
			}
			if got := len(b.Jenkins.Published); got != 6 {
				t.Fatalf("captured %d published file(s), want 6: %+v", got, b.Jenkins.Published)
			}
			want := []publishedFile{
				{Name: "minimal-desktop-ubuntu-24.04.raw.gz", Size: 3663831040},
				{Name: "spdx_manifest.json", Size: 412887},
				{Name: "image-composer-tool.log", Size: 2884411},
				{Name: "chrootpkgs-ubuntu.dot", Size: 75210},
				{Name: "UPLOAD-MANIFEST.txt", Size: 1044},
				{Name: "debug-state.tar.gz", Size: 18446},
			}
			for i, w := range want {
				got := b.Jenkins.Published[i]
				if got.Name != w.Name || got.Size != w.Size {
					t.Errorf("Published[%d] = {%s %d}, want {%s %d}", i, got.Name, got.Size, w.Name, w.Size)
				}
				if len(got.SHA256) != 64 {
					t.Errorf("Published[%d].SHA256 = %q, want 64 hex digits", i, got.SHA256)
				}
			}
		})
	}
}

// TestCaptureArtifactoryLines_TargetWinsOverTrailingEcho pins the "first
// non-empty directory wins" rule: artifactory-upload.sh's "==> Target:" echo
// lands a minute or two before the pipeline's trailing "Artefacts published to:"
// line, so the /details endpoint surfaces the link sooner. A later differing
// echo must not clobber it.
func TestCaptureArtifactoryLines_TargetWinsOverTrailingEcho(t *testing.T) {
	s := &Server{}
	b := &build{Jenkins: &jenkinsMeta{}}
	s.captureArtifactoryLines(b, "==> Target:      "+wantDir)
	s.captureArtifactoryLines(b, "Artefacts published to: https://example.invalid/artifactory/other/")
	if b.Jenkins.ArtifactoryURL != wantDir {
		t.Errorf("ArtifactoryURL = %q, want the first (Target) match %q", b.Jenkins.ArtifactoryURL, wantDir)
	}
}

// TestCaptureArtifactoryLines_Noise verifies the scraper ignores lines that
// merely look publish-adjacent — no directory, no phantom files. The mixed-case
// "Published To:" case is the one the old case-sensitive early-out dropped.
func TestCaptureArtifactoryLines_Noise(t *testing.T) {
	s := &Server{}
	b := &build{Jenkins: &jenkinsMeta{}}
	for _, line := range []string{
		"INFO    imageos/imageos.go    Installing package 42/270: efibootmgr",
		"  + something (not bytes)",
		"sha256=tooshort",
		"==> Publishing 6 file(s) from /home/jenkins/workspace/worker-03/upload",
	} {
		s.captureArtifactoryLines(b, line)
	}
	if b.Jenkins.ArtifactoryURL != "" {
		t.Errorf("ArtifactoryURL = %q, want empty", b.Jenkins.ArtifactoryURL)
	}
	if len(b.Jenkins.Published) != 0 {
		t.Errorf("Published = %+v, want empty", b.Jenkins.Published)
	}

	// Mixed-case spelling still resolves — the regexes are case-insensitive
	// and the early-out lowercases before matching, so a pipeline that ever
	// capitalises its echo (or switches to the American spelling) keeps working.
	s.captureArtifactoryLines(b, "Artifact Published To: "+wantDir)
	if b.Jenkins.ArtifactoryURL != wantDir {
		t.Errorf("mixed-case echo: ArtifactoryURL = %q, want %q", b.Jenkins.ArtifactoryURL, wantDir)
	}
}

// TestSelectPublishedImage covers every image shape ICT writes, plus the
// non-images that share the upload directory with it. Largest-wins is only a
// tie-break; the extension filter does the real work, which is why
// debug-state.tar.gz (a .tar.gz that is emphatically not an image) and the SBOM
// have to be rejected by name rather than by size.
func TestSelectPublishedImage(t *testing.T) {
	cases := []struct {
		name  string
		files []publishedFile
		want  string // "" means expect ok=false
	}{
		{
			name: "realistic upload dir picks the raw.gz",
			files: []publishedFile{
				{Name: "spdx_manifest.json", Size: 412887},
				{Name: "image-composer-tool.log", Size: 2884411},
				{Name: "minimal-desktop-ubuntu-24.04.raw.gz", Size: 3663831040},
				{Name: "UPLOAD-MANIFEST.txt", Size: 1044},
				{Name: "chrootpkgs-ubuntu.dot", Size: 75210},
				{Name: "debug-state.tar.gz", Size: 18446},
			},
			want: "minimal-desktop-ubuntu-24.04.raw.gz",
		},
		{
			name: "uncompressed iso",
			files: []publishedFile{
				{Name: "UPLOAD-MANIFEST.txt", Size: 1044},
				{Name: "robotics-amr-ubuntu-24.04.iso", Size: 2415919104},
			},
			want: "robotics-amr-ubuntu-24.04.iso",
		},
		{
			name: "initrd img, xz-compressed",
			files: []publishedFile{
				{Name: "edge-initrd-debian-13.img.xz", Size: 734003200},
				{Name: "image-composer-tool.log", Size: 2884411},
			},
			want: "edge-initrd-debian-13.img.xz",
		},
		{
			name: "wsl2 tarball beats the debug bundle despite both being .tar.gz",
			files: []publishedFile{
				{Name: "debug-state.tar.gz", Size: 18446},
				{Name: "dev-wsl2-ubuntu-24.04.tar.gz", Size: 1288490188},
			},
			want: "dev-wsl2-ubuntu-24.04.tar.gz",
		},
		{
			name: "vhdx conversion, zstd-compressed",
			files: []publishedFile{
				{Name: "retail-dv-ubuntu-24.04.vhdx.zst", Size: 4294967296},
				{Name: "spdx_manifest.json", Size: 412887},
			},
			want: "retail-dv-ubuntu-24.04.vhdx.zst",
		},
		{
			// A huge SBOM must never win: classifyArtifact rejects it
			// before size is even considered.
			name: "sbom is never the image, however large",
			files: []publishedFile{
				{Name: "huge-sbom.spdx.json", Size: 9663676416},
				{Name: "UPLOAD-MANIFEST.txt", Size: 1044},
			},
			want: "",
		},
		{
			name: "no image published falls back",
			files: []publishedFile{
				{Name: "UPLOAD-MANIFEST.txt", Size: 1044},
				{Name: "image-composer-tool.log", Size: 2884411},
			},
			want: "",
		},
		{
			name:  "empty list falls back",
			files: nil,
			want:  "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := selectPublishedImage(tc.files)
			if tc.want == "" {
				if ok {
					t.Fatalf("selectPublishedImage() = %q, ok=true; want ok=false", got.Name)
				}
				return
			}
			if !ok {
				t.Fatalf("selectPublishedImage() ok=false, want %q", tc.want)
			}
			if got.Name != tc.want {
				t.Errorf("selectPublishedImage() = %q, want %q", got.Name, tc.want)
			}
		})
	}
}

// TestArtifactoryArtifact checks the composed single-row artifact: the full
// download URL, the repo-relative Path an operator pastes into jf/curl, and the
// provenance the UI keys the directory-row suppression off.
func TestArtifactoryArtifact(t *testing.T) {
	img := publishedFile{Name: "minimal-desktop-ubuntu-24.04.raw.gz", Size: 3663831040}
	a, ok := artifactoryArtifact(wantDir, img)
	if !ok {
		t.Fatal("artifactoryArtifact() ok=false, want true")
	}
	wantURL := wantDir + "minimal-desktop-ubuntu-24.04.raw.gz"
	if a.URL != wantURL {
		t.Errorf("URL = %q, want %q", a.URL, wantURL)
	}
	wantPath := "core-os-yocto-png-local/worker-03/20260802-1750/minimal-desktop-ubuntu-24.04.raw.gz"
	if a.Path != wantPath {
		t.Errorf("Path = %q, want %q", a.Path, wantPath)
	}
	if a.Name != img.Name || a.Type != "image" || a.Source != "artifactory" || a.Size != img.Size {
		t.Errorf("artifact = %+v, want name/type/source/size = %s/image/artifactory/%d", a, img.Name, img.Size)
	}
}

// TestArtifactoryArtifact_EdgeCases pins the fallbacks: a missing directory or
// filename must return ok=false (caller lists the Jenkins artifacts instead),
// spaces in the filename must be percent-escaped so the href is valid, and an
// Artifactory URL without the conventional "/artifactory/" segment must still
// yield a copyable Path rather than a sliced-off string.
func TestArtifactoryArtifact_EdgeCases(t *testing.T) {
	if _, ok := artifactoryArtifact("", publishedFile{Name: "x.raw.gz"}); ok {
		t.Error("empty dir: ok=true, want false")
	}
	if _, ok := artifactoryArtifact(wantDir, publishedFile{}); ok {
		t.Error("empty name: ok=true, want false")
	}

	a, ok := artifactoryArtifact(wantDir, publishedFile{Name: "my image #1.raw.gz", Size: 10})
	if !ok {
		t.Fatal("escaped name: ok=false, want true")
	}
	if want := wantDir + "my%20image%20%231.raw.gz"; a.URL != want {
		t.Errorf("URL = %q, want %q", a.URL, want)
	}

	// No "/artifactory/" segment — Path falls back to the whole URL.
	a, ok = artifactoryArtifact("https://files.example.com/repo/build-7/", publishedFile{Name: "a.iso", Size: 1})
	if !ok {
		t.Fatal("non-standard host: ok=false, want true")
	}
	if a.Path != a.URL {
		t.Errorf("Path = %q, want the full URL %q", a.Path, a.URL)
	}
}

// TestBuildLogsStream_DoneArrivesWithArtifacts is the end-to-end assertion for
// the reported bug: the stepper's last step must not conclude before the image
// links exist. It drives the real SSE handler over a log buffer that contains
// ICT's own "image build completed successfully" line plus the whole PUBLISH
// block, and checks the wire output:
//
//   - no `"phase":"done"` is emitted from the log-derived stream (the last
//     log-derived phase is "publishing");
//   - `phase: done` appears exactly once, and only in the terminal frame;
//   - it is IMMEDIATELY followed by the `complete` event carrying the
//     Artifactory image URL, i.e. both land in the same flush.
func TestBuildLogsStream_DoneArrivesWithArtifacts(t *testing.T) {
	s := newTestServer(t)
	b := &build{ID: "b-pub", done: make(chan struct{})}
	s.tracker.add(b)

	logs := append([]string{
		"[dispatcher] Picked worker: worker-03",
		"[entrypoint] stage=ict-build",
		"INFO    imageos/imageos.go    Installing package 270/270: dracut-core",
		"INFO    manifest/manifest.go    Successfully copied SBOM",
		// The line that used to conclude the stepper, minutes early.
		"image build completed successfully",
		"[entrypoint] stage=stage-artefacts",
	}, publishConsoleBlock...)
	for _, l := range logs {
		b.appendLog(l)
	}

	img := publishedFile{Name: "minimal-desktop-ubuntu-24.04.raw.gz", Size: 3663831040}
	art, ok := artifactoryArtifact(wantDir, img)
	if !ok {
		t.Fatal("artifactoryArtifact() ok=false")
	}
	b.finish(statusSuccess, []artifact{art}, "")
	// Already-terminal: the handler replays history, then takes its <-b.done
	// branch and returns, so this exercises the real ordering without racing
	// a goroutine.
	close(b.done)

	req := httptest.NewRequest("GET", "/api/v1/builds/b-pub/logs", nil)
	req.SetPathValue("id", "b-pub")
	rr := httptest.NewRecorder()
	s.handleBuildLogs(rr, req)

	body := rr.Body.String()

	if n := strings.Count(body, `"phase":"done"`); n != 1 {
		t.Fatalf(`"phase":"done" appears %d time(s), want exactly 1`+"\n\n%s", n, body)
	}
	doneAt := strings.Index(body, `"phase":"done"`)
	completeAt := strings.Index(body, "event: complete")
	if completeAt < 0 {
		t.Fatalf("no complete event\n\n%s", body)
	}
	if doneAt > completeAt {
		t.Errorf("phase:done at %d is AFTER complete at %d; want done first", doneAt, completeAt)
	}
	// Nothing but the terminal `phase` frame may sit between them — proves
	// they're in the same flush rather than separated by further log events.
	between := body[doneAt:completeAt]
	if strings.Contains(between, "event: log") {
		t.Errorf("log event between phase:done and complete:\n%s", between)
	}
	if !strings.Contains(body, art.URL) {
		t.Errorf("complete payload is missing the image URL %q\n\n%s", art.URL, body)
	}
	// The last log-derived phase before the terminal frame must be publishing.
	if before := body[:doneAt]; !strings.Contains(before, `"phase":"publishing"`) {
		t.Errorf("no phase:publishing before the terminal frame\n\n%s", before)
	}
}
