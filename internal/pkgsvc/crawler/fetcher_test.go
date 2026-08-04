// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package crawler

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ulikunitz/xz"
)

// HTTPFetcher was the last 0% file in the crawler and it is the microservice's
// only door to the outside world, so everything the index ever contains arrives
// through this one function. Two behaviours here are worth more than the rest:
//
//   - The CHECKSUM GATE. InRelease is the signed anchor; every Packages.xz and
//     dep11 hash comes from it. If Fetch ever returned bytes alongside
//     ErrChecksumMismatch, orchestrator.go's `if err == nil` guards would still
//     skip the refresh, but any future caller that logged-and-continued would
//     atomic-swap tampered or truncated metadata into the live index. Corrupt
//     package metadata is invisible in the UI — searches just return subtly
//     wrong versions and dependencies, with nothing in any log.
//
//   - DECOMPRESSION BY URL SUFFIX. Get it wrong and the parsers receive raw
//     compressed bytes; ParseDebPackages finds no stanzas, returns zero records,
//     and the refresh "succeeds" with an empty index. Package search then comes
//     back blank for every query. So the fixtures below are REAL gzip/xz streams
//     built with the same libraries production decodes with, and each case
//     guards that the wire bytes actually differ from the plaintext — otherwise
//     a decoder that echoed its input would pass.
//
// Nothing here touches the network: every test is an httptest.Server on
// loopback, or a stub RoundTripper for the two response shapes a real server
// cannot send.
//
// NOTE on HTTPFetcher.Timeout: Fetch never reads that field. It only feeds the
// default http.Client built by NewHTTPFetcher, which is what production uses
// (main.go passes a nil client), so the timeout tests below go through that
// path deliberately.

// NewHTTPFetcher returns the concrete type; cmd/ict-pkgsvc/main.go stores it in
// an Orchestrator's Fetcher field, so this assignability is load-bearing.
var _ Fetcher = (*HTTPFetcher)(nil)

// fxPlain is the plaintext every fixture below compresses: the shape the deb
// parser expects to find after decompression, and long enough that gzip/xz
// output is clearly not a copy of the input.
var fxPlain = []byte("Package: gcc\n" +
	"Version: 4:13.2.0-7ubuntu1\n" +
	"Architecture: amd64\n" +
	"Description: GNU C compiler\n" +
	" A dependency package for build environments.\n\n")

func fxGzip(t *testing.T, plain []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(plain); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

func fxXz(t *testing.T, plain []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	xw, err := xz.NewWriter(&buf)
	if err != nil {
		t.Fatalf("xz writer: %v", err)
	}
	if _, err := xw.Write(plain); err != nil {
		t.Fatalf("xz write: %v", err)
	}
	if err := xw.Close(); err != nil {
		t.Fatalf("xz close: %v", err)
	}
	return buf.Bytes()
}

func fxSHA256(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// fxServe hands out `body` verbatim on every path, so the test can pick the
// URL suffix (and therefore the decoder) freely.
func fxServe(t *testing.T, body []byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// fxStubTransport fabricates a response without opening a socket. It exists for
// the two shapes httptest.Server will not produce: a sub-200 status line, and a
// body that fails part-way through Read.
type fxStubTransport struct {
	status int
	body   io.ReadCloser
}

func (s fxStubTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: s.status,
		Status:     fmt.Sprintf("%d Stub", s.status),
		Proto:      "HTTP/1.1",
		Header:     make(http.Header),
		Body:       s.body,
		Request:    r,
	}, nil
}

type fxResetBody struct{}

func (fxResetBody) Read([]byte) (int, error) {
	return 0, errors.New("stub: connection reset mid-body")
}
func (fxResetBody) Close() error { return nil }

// --- NewHTTPFetcher ----------------------------------------------------------

func TestNewHTTPFetcherDefaultsNonPositiveTimeout(t *testing.T) {
	// A zero timeout on the default client means "block forever". The crawler
	// runs on a ticker, so one hung mirror connection would wedge every later
	// refresh with no error and no log line — the index just stops updating.
	for _, in := range []time.Duration{0, -1 * time.Second} {
		f := NewHTTPFetcher(nil, in)
		if f.Timeout != 60*time.Second {
			t.Errorf("NewHTTPFetcher(nil, %v).Timeout = %v, want the 60s default", in, f.Timeout)
		}
		if f.Client == nil {
			t.Fatalf("NewHTTPFetcher(nil, %v) left Client nil — Fetch would nil-panic", in)
		}
		if f.Client.Timeout != 60*time.Second {
			t.Errorf("default Client.Timeout = %v, want 60s", f.Client.Timeout)
		}
	}
}

func TestNewHTTPFetcherBuildsClientCarryingTheTimeout(t *testing.T) {
	f := NewHTTPFetcher(nil, 7*time.Second)
	if f.Client == nil {
		t.Fatal("Client must be constructed when the caller passes nil")
	}
	if f.Client.Timeout != 7*time.Second {
		t.Errorf("Client.Timeout = %v, want the 7s we asked for", f.Client.Timeout)
	}
	if f.Timeout != 7*time.Second {
		t.Errorf("f.Timeout = %v, want 7s", f.Timeout)
	}
}

func TestFetchAppliesFTimeoutToACallerSuppliedClient(t *testing.T) {
	// f.Timeout used to be stored and never read: the deadline came only from the
	// client NewHTTPFetcher builds when passed nil. A caller supplying their own
	// client — which is the documented reason the parameter exists, for proxy and
	// TLS-pinning transports — therefore got a fetch with NO deadline at all, even
	// with f.Timeout set. A stalled mirror would pin a refresh goroutine forever and
	// the index would quietly stop updating.
	//
	// Fetch now derives a per-request context from f.Timeout, so the deadline holds
	// regardless of which client is in use.
	blocked := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // hold until the client gives up; no sleeps
		close(blocked)
	}))
	defer srv.Close()

	// A client with NO timeout of its own — the exact shape that used to hang.
	f := NewHTTPFetcher(&http.Client{}, 150*time.Millisecond)
	if f.Client.Timeout != 0 {
		t.Fatalf("fixture is wrong: the caller's client must have no timeout, got %v",
			f.Client.Timeout)
	}

	start := time.Now()
	_, err := f.Fetch(context.Background(), srv.URL+"/dists/noble/InRelease", "")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("Fetch returned nil error against a server that never responds")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("errors.Is(err, context.DeadlineExceeded) = false; err = %v. The "+
			"deadline must come from f.Timeout, not from the caller's client", err)
	}
	// Generous upper bound: the point is that it returns at all, promptly-ish.
	if elapsed > 5*time.Second {
		t.Errorf("Fetch took %v, want it bounded by the 150ms f.Timeout", elapsed)
	}
	<-blocked // the handler observed the cancellation, so nothing is left running
}

func TestFetchWithNoTimeoutDoesNotImposeOne(t *testing.T) {
	// Timeout <= 0 is only reachable by constructing HTTPFetcher directly (the
	// constructor substitutes 60s). It must mean "no deadline of our own" rather
	// than "a deadline of zero", which would cancel every request instantly.
	srv := fxServe(t, fxPlain)
	f := &HTTPFetcher{Client: srv.Client()} // Timeout deliberately zero
	got, err := f.Fetch(context.Background(), srv.URL+"/dists/noble/InRelease", "")
	if err != nil {
		t.Fatalf("Fetch with a zero Timeout: %v — zero must mean unbounded, not "+
			"already-expired", err)
	}
	if !bytes.Equal(got, fxPlain) {
		t.Errorf("body = %q, want the stanza", got)
	}
}

func TestNewHTTPFetcherKeepsTheCallerSuppliedClient(t *testing.T) {
	// Callers pass their own client for proxy/TLS-pinning transports. Silently
	// swapping it would drop those settings and the fetch would go direct.
	mine := &http.Client{Timeout: 3 * time.Second}
	f := NewHTTPFetcher(mine, 30*time.Second)
	if f.Client != mine {
		t.Fatalf("Client = %p, want the caller's %p", f.Client, mine)
	}
	if mine.Timeout != 3*time.Second {
		t.Errorf("caller's client was mutated: Timeout = %v, want 3s", mine.Timeout)
	}
}

// --- decompressByExt, via Fetch ---------------------------------------------

func TestFetchDecompressesByURLExtension(t *testing.T) {
	gz := fxGzip(t, fxPlain)
	xzb := fxXz(t, fxPlain)

	cases := []struct {
		name string
		path string
		wire []byte
	}{
		{"plain", "/dists/noble/InRelease", fxPlain},
		{"gzip", "/dists/noble/main/binary-amd64/Packages.gz", gz},
		{"xz", "/dists/noble/main/binary-amd64/Packages.xz", xzb},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Control for the compressed cases: if the wire bytes equalled the
			// plaintext, a no-op "decoder" would satisfy the assertion below.
			if tc.name != "plain" && bytes.Equal(tc.wire, fxPlain) {
				t.Fatalf("%s fixture is not actually compressed", tc.name)
			}
			srv := fxServe(t, tc.wire)
			f := NewHTTPFetcher(srv.Client(), 5*time.Second)

			got, err := f.Fetch(context.Background(), srv.URL+tc.path, "")
			if err != nil {
				t.Fatalf("Fetch: %v", err)
			}
			if !bytes.Equal(got, fxPlain) {
				t.Errorf("body = %q, want the decompressed stanza %q", got, fxPlain)
			}
		})
	}
}

func TestFetchRoutesOnTheURLSUFFIXNotASubstring(t *testing.T) {
	// The routing contract is a trailing SUFFIX, and nothing above pins that: every
	// other URL in this file carries .xz/.gz only at the end, so relaxing both
	// HasSuffix calls to Contains survives the whole suite. Mutation-testing
	// confirmed it.
	//
	// The two shapes below are the ones that break under Contains and that a real
	// mirror actually serves:
	//
	//   Packages.gz.sig   — a detached signature. Under Contains it routes to the gzip
	//                       decoder, which fails on the signature bytes, so a
	//                       component errors out instead of the signature being read
	//                       as the opaque blob it is.
	//   Packages.xz?mirror=uk — a query string, which several CDN mirrors append.
	//                       Under Contains this routes to xz correctly by luck; under
	//                       HasSuffix it does NOT decompress, which is the current
	//                       (and arguably wrong, but pinned) behaviour.
	//
	// So this test asserts what the code does today and makes the suffix semantics
	// load-bearing. The second case is a latent defect recorded, not fixed: a mirror
	// URL with a query string silently skips decompression and hands the parser
	// compressed bytes.
	gz := fxGzip(t, fxPlain)

	t.Run("a .gz that is not the final suffix is NOT decompressed", func(t *testing.T) {
		// Serve the compressed bytes under a .gz.sig name. Because ".gz" is not the
		// suffix, the body must come back VERBATIM rather than decoded.
		srv := fxServe(t, gz)
		f := NewHTTPFetcher(srv.Client(), 5*time.Second)
		got, err := f.Fetch(context.Background(), srv.URL+"/dists/noble/Packages.gz.sig", "")
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if bytes.Equal(got, fxPlain) {
			t.Error("Packages.gz.sig was DECOMPRESSED; routing must key on the trailing " +
				"suffix, not on the extension appearing anywhere in the URL")
		}
		if !bytes.Equal(got, gz) {
			t.Errorf("body = %d bytes, want the %d wire bytes verbatim", len(got), len(gz))
		}
	})

	t.Run("a .xz that is not the final suffix is NOT decompressed", func(t *testing.T) {
		// The .xz branch needs its own fixture: the .gz case above leaves
		// `HasSuffix(url, ".xz") -> Contains(...)` alive, because a URL ending .gz.sig
		// never reaches the xz arm of the switch at all.
		xzb := fxXz(t, fxPlain)
		srv := fxServe(t, xzb)
		f := NewHTTPFetcher(srv.Client(), 5*time.Second)
		got, err := f.Fetch(context.Background(), srv.URL+"/dists/noble/Packages.xz.sig", "")
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if bytes.Equal(got, fxPlain) {
			t.Error("Packages.xz.sig was DECOMPRESSED; the xz arm must key on the " +
				"trailing suffix too")
		}
		if !bytes.Equal(got, xzb) {
			t.Errorf("body = %d bytes, want the %d wire bytes verbatim", len(got), len(xzb))
		}
	})

	t.Run("a query string defeats suffix matching", func(t *testing.T) {
		// ⚠️ Latent defect, pinned as current behaviour. Some CDN mirrors append a
		// query string; HasSuffix then misses and the caller receives compressed bytes
		// that the Packages parser cannot read. Recorded rather than fixed — this is a
		// test-coverage change.
		srv := fxServe(t, gz)
		f := NewHTTPFetcher(srv.Client(), 5*time.Second)
		got, err := f.Fetch(context.Background(),
			srv.URL+"/dists/noble/Packages.gz?mirror=uk", "")
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if bytes.Equal(got, fxPlain) {
			t.Error("a ?query URL WAS decompressed — if routing was made query-aware, " +
				"update this test and remove the latent-defect note")
		}
	})
}

func TestFetchRejectsBodyInvalidForItsClaimedExtension(t *testing.T) {
	// A mirror serving an HTML error page (or a proxy interstitial) under a
	// .xz/.gz name must be an error, not zero packages: the orchestrator's
	// `err == nil` path would otherwise store an empty component.
	html := []byte("<html><body>404 not found</body></html>\n")
	for _, tc := range []struct {
		name, path, wantErr string
	}{
		{"xz", "/dists/noble/main/binary-amd64/Packages.xz", "xz open"},
		{"gzip", "/dists/noble/main/binary-amd64/Packages.gz", "gzip open"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := fxServe(t, html)
			f := NewHTTPFetcher(srv.Client(), 5*time.Second)

			got, err := f.Fetch(context.Background(), srv.URL+tc.path, "")
			if err == nil {
				t.Fatalf("Fetch returned %q and no error for a non-%s body", got, tc.name)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("err = %v, want it to name the failing decoder (%q)", err, tc.wantErr)
			}
			if len(got) != 0 {
				t.Errorf("got %d bytes with the error, want none", len(got))
			}
		})
	}
}

func TestFetchRejectsTruncatedCompressedBody(t *testing.T) {
	// A connection cut mid-transfer is the realistic mirror failure and the
	// nastiest: the container header decodes, so a decoder that only checked
	// NewReader's error would report success on a half file. The indexer would
	// then atomic-swap a component missing its tail — packages that silently
	// vanish from search with nothing logged.
	//
	// Now asserted as NO BYTES on both paths, which was not always true. The .gz
	// branch used to return the bytes io.ReadAll had managed to decode alongside
	// its error — "135 valid bytes plus unexpected EOF" — while .xz happened to
	// return none. Both callers check err first, so nothing was broken, but the
	// asymmetric contract meant a future `body, _ := Fetch(...)` would index a
	// Packages file missing its tail, and those packages just disappear from search
	// after the atomic swap with nothing logged.
	gz := fxGzip(t, fxPlain)
	xzb := fxXz(t, fxPlain)
	for _, tc := range []struct {
		name, path string
		full       []byte
		wire       []byte
	}{
		{"gzip", "/Packages.gz", gz, gz[:len(gz)-6]},
		{"xz", "/Packages.xz", xzb, xzb[:len(xzb)/2]},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if len(tc.wire) == 0 || len(tc.wire) >= len(tc.full) {
				t.Fatalf("truncated %s fixture is %d of %d bytes — not a truncation",
					tc.name, len(tc.wire), len(tc.full))
			}
			srv := fxServe(t, tc.wire)
			f := NewHTTPFetcher(srv.Client(), 5*time.Second)
			partial, err := f.Fetch(context.Background(), srv.URL+tc.path, "")
			if err == nil {
				t.Fatalf("truncated %s stream decoded without error", tc.name)
			}
			// Fail CLOSED: a partially-decoded stream must yield nothing, so no
			// caller can index a component missing its tail even by ignoring err.
			if len(partial) != 0 {
				t.Errorf("truncated %s returned %d bytes alongside its error; partially "+
					"decoded repository data must never escape", tc.name, len(partial))
			}

			// Control: the UNtruncated stream at the same URL succeeds, so the
			// error above is the missing tail and not the fixture or the path.
			ctl := fxServe(t, tc.full)
			got, err := f.Fetch(context.Background(), ctl.URL+tc.path, "")
			if err != nil {
				t.Fatalf("control: intact %s stream failed: %v", tc.name, err)
			}
			if !bytes.Equal(got, fxPlain) {
				t.Errorf("control: body = %q, want the full stanza", got)
			}
		})
	}
}

// --- checksum verification ---------------------------------------------------

func TestFetchChecksumMismatchReturnsSentinelAndNoBytes(t *testing.T) {
	// The security-relevant assertion in this file. errors.Is must hold so
	// callers can distinguish "mirror served junk" from "network blip", and the
	// byte slice must be empty so no caller can accidentally index unverified
	// content.
	srv := fxServe(t, fxPlain)
	f := NewHTTPFetcher(srv.Client(), 5*time.Second)
	wrong := fxSHA256([]byte("some other file entirely"))

	got, err := f.Fetch(context.Background(), srv.URL+"/dists/noble/InRelease", wrong)
	if err == nil {
		t.Fatal("Fetch accepted a body whose SHA256 does not match the expected value")
	}
	if !errors.Is(err, ErrChecksumMismatch) {
		t.Errorf("errors.Is(err, ErrChecksumMismatch) = false; err = %v", err)
	}
	if len(got) != 0 {
		t.Errorf("Fetch returned %d bytes on a checksum failure, want 0 — partial "+
			"content here is how tampered metadata reaches the index", len(got))
	}
	// The refresh log is the only place an operator sees this, so both digests
	// have to be in the message to be actionable.
	if actual := fxSHA256(fxPlain); !strings.Contains(err.Error(), actual) ||
		!strings.Contains(err.Error(), wrong) {
		t.Errorf("err = %v, want it to carry want=%s and got=%s", err, wrong, actual)
	}
}

func TestFetchComparesTheWHOLEDigestNotAPrefix(t *testing.T) {
	// ⚠️ THE ASSERTION THE MISMATCH TEST ABOVE CANNOT MAKE, and the reason this
	// exists as its own test.
	//
	// Every mismatch fixture elsewhere in this file is a "far miss" — a digest of
	// different content, which in practice differs from the correct one at hex index
	// 0. So those tests only ever prove the gate distinguishes digests by their
	// FIRST character. Mutation-testing confirmed the hole: narrowing the comparison
	// to got[:1], to got[:32] (half the digest ignored), or to a HasPrefix match
	// (under which a caller-supplied truncated digest verifies) all survived the
	// suite untouched.
	//
	// That matters because this is the integrity gate on downloaded repository
	// metadata. A gate that compares a prefix accepts a body whose digest merely
	// starts the same, which is exactly the property an attacker with a mirror would
	// grind against.
	//
	// The fixtures below are therefore NEAR misses, constructed by editing the
	// correct digest so the difference sits deliberately late in the string.
	srv := fxServe(t, fxPlain)
	f := NewHTTPFetcher(srv.Client(), 5*time.Second)
	correct := fxSHA256(fxPlain)

	// flipHex returns `correct` with the hex digit at index i changed.
	flipHex := func(s string, i int) string {
		b := []byte(s)
		if b[i] == '0' {
			b[i] = '1'
		} else {
			b[i] = '0'
		}
		return string(b)
	}

	cases := map[string]string{
		"differs in the LAST hex digit":   flipHex(correct, len(correct)-1),
		"differs one char before the end": flipHex(correct, len(correct)-2),
		"differs in the second half":      flipHex(correct, 40),
		"differs just past the midpoint":  flipHex(correct, 32),
		// A truncation, not a substitution: a correct PREFIX and nothing else. Under a
		// HasPrefix gate this verifies successfully, which is the worst of the
		// surviving mutations.
		"a correct 32-char prefix only": correct[:32],
		"a correct 63-char prefix only": correct[:len(correct)-1],
	}
	for name, bad := range cases {
		t.Run(name, func(t *testing.T) {
			if bad == correct {
				t.Fatalf("fixture is not actually a mismatch: %q", bad)
			}
			got, err := f.Fetch(context.Background(), srv.URL+"/x/InRelease", bad)
			if err == nil {
				t.Fatalf("Fetch ACCEPTED a body against digest %q (correct is %q); the "+
					"comparison must cover the whole digest", bad, correct)
			}
			if !errors.Is(err, ErrChecksumMismatch) {
				t.Errorf("errors.Is(err, ErrChecksumMismatch) = false; err = %v", err)
			}
			if len(got) != 0 {
				t.Errorf("returned %d bytes on a checksum failure, want 0", len(got))
			}
		})
	}
}

func TestFetchVerifiesChecksumAgainstTheCompressedWireBytes(t *testing.T) {
	// Debian's InRelease publishes SHA256 over the file as transferred, so the
	// digest must be taken BEFORE decompression. If this flipped to hashing the
	// decompressed body, every real Packages.xz would fail verification and the
	// crawler would skip every component — an index frozen at whatever the seed
	// loaded, with only per-source warnings to show it.
	gz := fxGzip(t, fxPlain)
	srv := fxServe(t, gz)
	f := NewHTTPFetcher(srv.Client(), 5*time.Second)
	u := srv.URL + "/dists/noble/main/binary-amd64/Packages.gz"

	t.Run("digest of wire bytes accepted", func(t *testing.T) {
		got, err := f.Fetch(context.Background(), u, fxSHA256(gz))
		if err != nil {
			t.Fatalf("Fetch with the compressed digest: %v", err)
		}
		if !bytes.Equal(got, fxPlain) {
			t.Errorf("body = %q, want the decompressed stanza", got)
		}
	})
	t.Run("digest of decompressed bytes rejected", func(t *testing.T) {
		// Control proving the digest above was really the compressed one.
		if _, err := f.Fetch(context.Background(), u, fxSHA256(fxPlain)); !errors.Is(err, ErrChecksumMismatch) {
			t.Errorf("err = %v, want ErrChecksumMismatch: the plaintext digest must NOT verify", err)
		}
	})
}

func TestFetchAcceptsChecksumInEitherCase(t *testing.T) {
	// dep11/Packages hashes are lowercase in InRelease, but the comparison is
	// EqualFold on purpose so a hand-configured or uppercase source does not
	// look like tampering.
	srv := fxServe(t, fxPlain)
	f := NewHTTPFetcher(srv.Client(), 5*time.Second)
	upper := strings.ToUpper(fxSHA256(fxPlain))
	if upper == fxSHA256(fxPlain) {
		t.Fatal("digest has no hex letters to upper-case — pick a different fixture")
	}

	got, err := f.Fetch(context.Background(), srv.URL+"/InRelease", upper)
	if err != nil {
		t.Fatalf("Fetch with an upper-case digest: %v", err)
	}
	if !bytes.Equal(got, fxPlain) {
		t.Errorf("body = %q, want the served bytes", got)
	}
}

func TestFetchEmptyChecksumSkipsVerification(t *testing.T) {
	// InRelease itself is fetched with "" — it is the anchor, so there is no
	// prior hash to check it against. If "" ever started being compared, the
	// crawler would fail at its very first request and no source would refresh.
	srv := fxServe(t, fxPlain)
	f := NewHTTPFetcher(srv.Client(), 5*time.Second)
	u := srv.URL + "/dists/noble/InRelease"

	got, err := f.Fetch(context.Background(), u, "")
	if err != nil {
		t.Fatalf("Fetch with an empty checksum: %v", err)
	}
	if !bytes.Equal(got, fxPlain) {
		t.Errorf("body = %q, want the served bytes", got)
	}
	// Control: the same URL and bytes DO get rejected when a digest is supplied,
	// so the success above is the empty-string branch and not a dead check.
	if _, err := f.Fetch(context.Background(), u, fxSHA256([]byte("mismatch"))); !errors.Is(err, ErrChecksumMismatch) {
		t.Errorf("control fetch err = %v, want ErrChecksumMismatch", err)
	}
}

// --- request shape and status handling --------------------------------------

func TestFetchSendsGETWithAnIdentifyingUserAgent(t *testing.T) {
	// Ubuntu/Debian mirrors and CDN front-ends rate-limit or 403 blank agents.
	// Losing the UA would show up as sporadic non-200s from production mirrors
	// only — never in CI.
	var gotMethod, gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotUA = r.Method, r.Header.Get("User-Agent")
		_, _ = w.Write(fxPlain)
	}))
	t.Cleanup(srv.Close)

	f := NewHTTPFetcher(srv.Client(), 5*time.Second)
	if _, err := f.Fetch(context.Background(), srv.URL+"/InRelease", ""); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if gotMethod != http.MethodGet {
		t.Errorf("method = %q, want GET", gotMethod)
	}
	if !strings.HasPrefix(gotUA, "ict-pkgsvc/") {
		t.Errorf("User-Agent = %q, want an ict-pkgsvc/<version> identifier", gotUA)
	}
}

func TestFetchRejectsNon2xxStatus(t *testing.T) {
	// 300 is the upper boundary: it is NOT a redirect Go follows, so it reaches
	// this check and must be refused like any other non-2xx.
	for _, status := range []int{300, 404, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write(fxPlain)
			}))
			t.Cleanup(srv.Close)
			f := NewHTTPFetcher(srv.Client(), 5*time.Second)

			got, err := f.Fetch(context.Background(), srv.URL+"/InRelease", "")
			if err == nil {
				t.Fatalf("status %d accepted, returned %d bytes", status, len(got))
			}
			if !strings.Contains(err.Error(), fmt.Sprintf("status %d", status)) {
				t.Errorf("err = %v, want the status code in the message", err)
			}
			if len(got) != 0 {
				t.Errorf("got %d bytes for status %d, want none", len(got), status)
			}
		})
	}
}

func TestFetchRejectsInformationalStatus(t *testing.T) {
	// Lower boundary of the accepted window. A stub transport is the only way
	// to deliver a 1xx as a final response — net/http's server treats
	// WriteHeader(1xx) as an interim header.
	f := NewHTTPFetcher(&http.Client{Transport: fxStubTransport{
		status: 199,
		body:   io.NopCloser(bytes.NewReader(fxPlain)),
	}}, 5*time.Second)

	got, err := f.Fetch(context.Background(), "http://mirror.invalid/InRelease", "")
	if err == nil {
		t.Fatalf("status 199 accepted, returned %d bytes", len(got))
	}
	if !strings.Contains(err.Error(), "status 199") {
		t.Errorf("err = %v, want the status code in the message", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d bytes, want none", len(got))
	}
}

func TestFetchAcceptsNon200Success(t *testing.T) {
	// The check is a 2xx RANGE, not equality with 200. A mirror answering 206
	// (or an appliance answering 203) still carries usable metadata.
	for _, status := range []int{201, 206} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write(fxPlain)
			}))
			t.Cleanup(srv.Close)
			f := NewHTTPFetcher(srv.Client(), 5*time.Second)

			got, err := f.Fetch(context.Background(), srv.URL+"/InRelease", "")
			if err != nil {
				t.Fatalf("status %d rejected: %v", status, err)
			}
			if !bytes.Equal(got, fxPlain) {
				t.Errorf("body = %q, want the served bytes", got)
			}
		})
	}
}

// --- transport-level failures -----------------------------------------------

func TestFetchRejectsUnparseableURL(t *testing.T) {
	// Source URLs come from config; a typo must fail loudly at request build
	// time rather than being sent somewhere unexpected.
	got, err := fxNoServer().Fetch(context.Background(), "http://%zz/dists/noble/InRelease", "")
	if err == nil {
		t.Fatalf("malformed URL accepted, returned %d bytes", len(got))
	}
	if !strings.Contains(err.Error(), "build request") {
		t.Errorf("err = %v, want it wrapped as a build-request failure", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d bytes, want none", len(got))
	}
}

func TestFetchSurfacesTransportErrors(t *testing.T) {
	// Unsupported scheme fails inside the transport before any dial, so this
	// exercises the Client.Do error wrap without touching the network.
	got, err := fxNoServer().Fetch(context.Background(), "ftp://mirror.invalid/dists/noble/InRelease", "")
	if err == nil {
		t.Fatalf("ftp:// accepted, returned %d bytes", len(got))
	}
	if !strings.Contains(err.Error(), "http get") {
		t.Errorf("err = %v, want it wrapped with the failing URL", err)
	}
}

func TestFetchSurfacesBodyReadErrors(t *testing.T) {
	// A 200 header followed by a reset connection is the nastiest mirror
	// failure: the status says fine, the bytes are incomplete. Returning
	// whatever arrived would silently shrink the index.
	f := NewHTTPFetcher(&http.Client{Transport: fxStubTransport{
		status: http.StatusOK,
		body:   fxResetBody{},
	}}, 5*time.Second)

	got, err := f.Fetch(context.Background(), "http://mirror.invalid/InRelease", "")
	if err == nil {
		t.Fatalf("mid-body read failure ignored, returned %d bytes", len(got))
	}
	if !strings.Contains(err.Error(), "read ") {
		t.Errorf("err = %v, want it wrapped as a read failure", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d bytes, want none", len(got))
	}
}

func TestFetchHonoursTheClientTimeout(t *testing.T) {
	// The whole reason NewHTTPFetcher puts a timeout on its default client:
	// crawler refreshes run on a ticker, and a mirror that accepts the
	// connection then stalls would otherwise hold the refresh goroutine (and
	// the source's slot) forever, with the index quietly never updating.
	//
	// The handler blocks until this test tears down, so the client deadline is
	// the only possible outcome — no sleep, no race with a slow CI box. Fetch
	// runs on a goroutine purely so a regression that DROPS the deadline shows
	// up as a named failure in ~1s instead of wedging the package's `go test`
	// until the binary-wide timeout kills it.
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	defer srv.Close()
	defer close(block) // must release the handler before Close waits on it

	f := NewHTTPFetcher(nil, 25*time.Millisecond) // nil client == production wiring
	type result struct {
		body []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		b, err := f.Fetch(context.Background(), srv.URL+"/dists/noble/InRelease", "")
		done <- result{b, err}
	}()

	select {
	case r := <-done:
		if r.err == nil {
			t.Fatalf("stalled request returned %d bytes instead of timing out", len(r.body))
		}
		var ue *url.Error
		if !errors.As(r.err, &ue) || !ue.Timeout() {
			t.Errorf("err = %v, want a timeout error from the client's deadline", r.err)
		}
		if len(r.body) != 0 {
			t.Errorf("got %d bytes, want none", len(r.body))
		}
	case <-time.After(time.Second):
		t.Fatal("Fetch did not return 40x its 25ms timeout — the client has no deadline, " +
			"so a stalled mirror would hang the refresh goroutine forever")
	}
}

func TestFetchPropagatesContextCancellation(t *testing.T) {
	// Orchestrator refreshes take the server's shutdown context. If Fetch
	// ignored it, ict-pkgsvc would hang on SIGTERM until the mirror answered.
	srv := fxServe(t, fxPlain)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	got, err := NewHTTPFetcher(srv.Client(), 5*time.Second).Fetch(ctx, srv.URL+"/InRelease", "")
	if err == nil {
		t.Fatalf("cancelled context ignored, returned %d bytes", len(got))
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want it to wrap context.Canceled", err)
	}
}

// fxNoServer builds a fetcher for the two tests whose request never
// reaches a listener.
func fxNoServer() *HTTPFetcher { return NewHTTPFetcher(nil, 5*time.Second) }
