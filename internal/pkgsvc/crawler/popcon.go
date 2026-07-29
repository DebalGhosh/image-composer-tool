// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package crawler

import (
	"bufio"
	"bytes"
	"strconv"
	"strings"

	"github.com/open-edge-platform/image-composer-tool/internal/pkgsvc/schema"
)

// ParsePopcon reads an already-decompressed popcon `by_inst` file and
// returns a map keyed by package name. Popcon's format is documented at
// https://popcon.debian.org/README — the shape is:
//
//	rank   name       inst   vote   old   recent   no-files   (maintainer)
//
// with a header block of `#`-prefixed comment lines the parser skips. Each
// column is whitespace-separated; the trailing maintainer field may contain
// spaces so we parse the first six numeric-ish columns and stop.
//
// Debian and Ubuntu popcon share this format identically; the same parser
// serves both.
func ParsePopcon(body []byte) map[string]schema.Popularity {
	out := make(map[string]schema.Popularity, 128*1024)
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 0, 8*1024), 128*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) == 0 || line[0] == '#' {
			continue
		}
		// Split on any whitespace, keeping the first 7 fields (the
		// 7th is `no-files`, everything after may be a multi-word
		// maintainer).
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		// Skip trailing summary line that starts with `Total` etc.
		if _, err := strconv.Atoi(fields[0]); err != nil {
			continue
		}
		name := fields[1]
		if name == "" {
			continue
		}
		out[name] = schema.Popularity{
			Inst:   atoiSafe(fields[2]),
			Vote:   atoiSafe(fields[3]),
			Old:    atoiSafe(fields[4]),
			Recent: atoiSafe(fields[5]),
		}
	}
	return out
}

// ApplyPopcon folds a popcon map onto an already-parsed record set. Missing
// packages remain at Popularity{} (all zeroes) — a valid signal that the
// package has no install data and should sort below anything with real
// numbers under the log1p(inst) tiebreak.
func ApplyPopcon(records []schema.PackageRecord, popcon map[string]schema.Popularity) {
	if len(popcon) == 0 {
		return
	}
	for i := range records {
		r := &records[i]
		if p, ok := popcon[r.Name]; ok {
			r.Popularity = p
		}
	}
}

// atoiSafe parses an integer and returns 0 on any junk. popcon files
// occasionally have "?" or missing columns; we treat those as "no data".
func atoiSafe(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}
