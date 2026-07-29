// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package crawler

import "testing"

// TestParsePopcon exercises the by_inst format with a comment header, a
// couple of real-shape entries, and a trailing summary line the parser
// must skip (starts with a non-numeric rank).
func TestParsePopcon(t *testing.T) {
	body := `# Format: rank  name  inst  vote  old recent  no-files (maintainer)
# generated 2026-07-01
1  libc6           1500000  900000  400000  200000  0  Ubuntu Developers
2  gcc              132891    4211      12     812  3  Ubuntu Developers
3  vim              89000    50000    5000    2000  0  Debian Developers
Total: 3 packages
`
	p := ParsePopcon([]byte(body))
	if len(p) != 3 {
		t.Fatalf("parsed %d, want 3: %+v", len(p), p)
	}
	if got := p["gcc"]; got.Inst != 132891 || got.Vote != 4211 || got.Recent != 812 {
		t.Errorf("gcc = %+v, want Inst=132891 Vote=4211 Recent=812", got)
	}
	if _, ok := p["Total:"]; ok {
		t.Errorf("summary line leaked into map")
	}
}
