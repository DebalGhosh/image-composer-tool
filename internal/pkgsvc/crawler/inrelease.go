// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package crawler

import (
	"bufio"
	"bytes"
	"strings"
)

// InRelease is the parsed subset of a Debian InRelease file we care about:
// the SHA256 section, which maps each file under `dists/<suite>/` to its
// SHA256 + size. That's what lets us skip refreshes when nothing has moved
// upstream since our last recorded state.
//
// InRelease is clearsign-wrapped in production. v1 doesn't verify the
// signature — that's a v2 hardening item once we settle on a keyring
// distribution story (the openpgp lib is already in go.mod so it's small
// work when we get there).
type InRelease struct {
	// SHA256 maps repo-relative path (e.g. "main/binary-amd64/Packages.xz")
	// to its hex digest. Empty when the file lacks a SHA256: section
	// (very old repos publish only MD5Sum: — we don't support those).
	SHA256 map[string]string
}

// ParseInRelease reads the clearsigned body verbatim, extracts the SHA256:
// block, and returns the hash map. The clearsign header + trailing PGP
// signature are ignored; we key purely off the SHA256: paragraph.
//
// Format sample (relevant lines):
//
//	SHA256:
//	 abcdef… 1234 main/binary-amd64/Packages.xz
//	 fedcba… 5678 main/dep11/Components-noble-amd64.yml.gz
func ParseInRelease(body []byte) (*InRelease, error) {
	ir := &InRelease{SHA256: map[string]string{}}
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	inSHA256 := false
	for scanner.Scan() {
		line := scanner.Text()
		// Section headers are unindented; hash entries are indented
		// by one space.
		if !strings.HasPrefix(line, " ") {
			inSHA256 = strings.HasPrefix(line, "SHA256:")
			continue
		}
		if !inSHA256 {
			continue
		}
		// "<hash> <size> <path>" — split on whitespace.
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		hash := fields[0]
		path := fields[len(fields)-1]
		ir.SHA256[path] = hash
	}
	return ir, scanner.Err()
}
