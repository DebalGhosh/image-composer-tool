package shell

import "testing"

func TestCommandMapContainsCrossBuildDependencies(t *testing.T) {
	tests := []struct {
		name          string
		minPathCount  int
		mustHavePaths []string
	}{
		{
			name:          "update-binfmts",
			minPathCount:  1,
			mustHavePaths: []string{"/usr/sbin/update-binfmts", "/usr/bin/update-binfmts"},
		},
		{
			name:         "apt-get",
			minPathCount: 1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			paths, ok := commandMap[tc.name]
			if !ok {
				t.Fatalf("expected command %q to exist in commandMap", tc.name)
			}
			if len(paths) < tc.minPathCount {
				t.Fatalf("expected at least %d path entries for %q, got %d", tc.minPathCount, tc.name, len(paths))
			}

			for _, must := range tc.mustHavePaths {
				found := false
				for _, p := range paths {
					if p == must {
						found = true
						break
					}
				}
				if !found {
					t.Fatalf("expected path %q in commandMap[%q], got %v", must, tc.name, paths)
				}
			}
		})
	}
}
