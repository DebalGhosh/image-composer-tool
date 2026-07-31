// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import "testing"

// minimalValid is the smallest template the UserTemplate schema accepts. Used
// as the baseline that the negative cases below mutate.
const minimalValid = `image:
  name: guard-test
  version: "1.0.0"
target:
  os: ubuntu
  dist: ubuntu24
  arch: x86_64
  imageType: raw
disk:
  name: guard-test
systemConfig:
  name: guard-test
`

// TestValidateDispatchYAML covers the gate that stands between the browser and
// a Jenkins worker slot. Before it existed, handleJenkinsDispatch checked only
// that the body was non-empty, so unparseable or schema-invalid YAML reached a
// worker and failed minutes later inside the container.
func TestValidateDispatchYAML(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		yaml    string
		wantErr bool
	}{
		{
			name: "minimal valid template passes",
			yaml: minimalValid,
		},
		{
			name:    "unparseable yaml is rejected",
			yaml:    "not: yaml: [at all",
			wantErr: true,
		},
		{
			name:    "missing required image.name is rejected",
			yaml:    "image:\n  version: \"1.0.0\"\n",
			wantErr: true,
		},
		{
			name:    "unknown top-level key is rejected (additionalProperties:false)",
			yaml:    minimalValid + "bogusKey: 1\n",
			wantErr: true,
		},
		{
			// The schema's wsl2 conditional sets disk.partitions to `false`.
			// A UI that emits a partition table for a wsl2 image produces a
			// template the farm cannot build; catch it here, not on a worker.
			name: "wsl2 with forbidden partition table is rejected",
			yaml: `image:
  name: wsl-test
  version: "1.0.0"
target:
  os: ubuntu
  dist: ubuntu24
  arch: x86_64
  imageType: wsl2
disk:
  name: wsl-test
  partitionTableType: gpt
  artifacts:
    - type: tar
      compression: gz
systemConfig:
  name: wsl-test
`,
			wantErr: true,
		},
		{
			// Same wsl2 image without the forbidden keys must still pass, so
			// the guard doesn't block legitimate WSL2 dispatches.
			name: "wsl2 without partition table passes",
			yaml: `image:
  name: wsl-test
  version: "1.0.0"
target:
  os: ubuntu
  dist: ubuntu24
  arch: x86_64
  imageType: wsl2
disk:
  name: wsl-test
  artifacts:
    - type: tar
      compression: gz
systemConfig:
  name: wsl-test
`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := validateDispatchYAML(tt.yaml)
			if tt.wantErr && err == nil {
				t.Fatalf("expected an error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}
