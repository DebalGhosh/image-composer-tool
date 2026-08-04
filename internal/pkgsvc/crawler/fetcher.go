// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

// Package crawler fetches upstream package metadata for the ict-pkgsvc
// microservice — Debian/Ubuntu Packages.xz, dep11 AppStream, and popcon.
//
// The Fetcher interface exists so tests can inject a httptest.Server-backed
// impl and never hit archive.ubuntu.com from CI. Production wiring in
// cmd/ict-pkgsvc/main.go constructs HTTPFetcher; unit tests construct a stub.
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
	"strings"
	"time"

	"github.com/ulikunitz/xz"
)

// Fetcher retrieves a URL and returns its uncompressed body. `checksum` is
// the expected hex-encoded SHA256 the caller wants verified before returning
// bytes; empty means don't verify (used only for InRelease itself, which is
// signature-anchored — v2 will add clearsign verification).
type Fetcher interface {
	Fetch(ctx context.Context, url, checksum string) ([]byte, error)
}

// HTTPFetcher is the production Fetcher. It decompresses transparently based
// on the URL extension: .xz, .gz, and plain paths are supported. If a
// checksum is passed and mismatches, Fetch returns ErrChecksumMismatch and
// no bytes.
type HTTPFetcher struct {
	Client  *http.Client
	Timeout time.Duration
}

// NewHTTPFetcher builds a Fetcher with sane timeouts. Callers pass their
// own http.Client if they need custom transport (proxy, TLS pinning); nil
// falls back to a fresh one with the given timeout.
func NewHTTPFetcher(client *http.Client, timeout time.Duration) *HTTPFetcher {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	return &HTTPFetcher{Client: client, Timeout: timeout}
}

// ErrChecksumMismatch is returned when the fetched (decompressed) body's
// SHA256 doesn't match the caller's expected value. Callers should log and
// SKIP the refresh — never atomic-swap partial data.
var ErrChecksumMismatch = errors.New("fetcher: SHA256 checksum mismatch")

// Fetch pulls url and returns the uncompressed body. Behaviour:
//
//   - Compression is inferred from the URL suffix: .xz -> xz decode, .gz ->
//     gzip decode, anything else -> pass-through.
//   - Checksum, when non-empty, is validated against the RAW (compressed)
//     body — that's what Debian InRelease publishes SHA256 for. We then
//     decompress in memory.
//   - Non-2xx responses become errors carrying the status code.
func (f *HTTPFetcher) Fetch(ctx context.Context, url, checksum string) ([]byte, error) {
	// Enforce Timeout on the REQUEST rather than relying on the client's own.
	// NewHTTPFetcher only sets a client timeout when it builds the client itself, so
	// a caller passing their own client (for a proxy or TLS pinning) previously got a
	// fetch with NO deadline even though f.Timeout was set — a stalled mirror would
	// hold a refresh goroutine forever and the index would quietly stop updating.
	if f.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, f.Timeout)
		defer cancel()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "ict-pkgsvc/0.1 (+https://github.com/DebalGhosh/image-composer-tool)")

	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http get %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("http get %s: status %d", url, resp.StatusCode)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", url, err)
	}

	if checksum != "" {
		sum := sha256.Sum256(raw)
		got := hex.EncodeToString(sum[:])
		if !strings.EqualFold(got, checksum) {
			return nil, fmt.Errorf("%w: url=%s want=%s got=%s",
				ErrChecksumMismatch, url, checksum, got)
		}
	}

	return decompressByExt(url, raw)
}

// decompressByExt looks at the URL suffix and applies the right decoder.
// Kept URL-based (rather than sniffing magic bytes) so tests can force a
// specific decoder path by naming the fixture file.
func decompressByExt(url string, body []byte) ([]byte, error) {
	// readAll discards whatever was decoded when the stream fails.
	//
	// io.ReadAll returns the bytes it managed to read ALONGSIDE the error, so a
	// truncated .gz used to come back as "135 valid bytes plus unexpected EOF".
	// Both current call sites check err first, but that made the contract "bytes
	// plus error" on one path and "no bytes" on the other, and a future
	// `body, _ := Fetch(...)` would silently index a Packages file missing its
	// tail — those packages just vanish from search after the atomic swap.
	// Failing closed is the only safe shape for partially-decoded repository data.
	readAll := func(r io.Reader, kind string) ([]byte, error) {
		out, err := io.ReadAll(r)
		if err != nil {
			return nil, fmt.Errorf("%s read %s: %w", kind, url, err)
		}
		return out, nil
	}
	switch {
	case strings.HasSuffix(url, ".xz"):
		r, err := xz.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("xz open %s: %w", url, err)
		}
		return readAll(r, "xz")
	case strings.HasSuffix(url, ".gz"):
		r, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("gzip open %s: %w", url, err)
		}
		defer r.Close()
		return readAll(r, "gzip")
	default:
		return body, nil
	}
}
