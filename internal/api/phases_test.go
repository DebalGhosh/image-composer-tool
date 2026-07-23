// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import "testing"

// TestDetectPhase feeds real log-line samples from prior worker runs and
// verifies detectPhase locks onto the intended phase. Each sub-case is a
// slice of representative lines from the corresponding pipeline segment
// — if any of these strings stops appearing in ICT / entrypoint / Jenkins
// output the corresponding test will break and force us to update the
// marker set alongside the log-format change.
func TestDetectPhase(t *testing.T) {
	cases := []struct {
		name string
		logs []string
		want string
	}{
		{
			name: "empty log defaults to dispatching",
			logs: []string{},
			want: "dispatching",
		},
		{
			name: "dispatcher output only",
			logs: []string{
				"[dispatcher] Picked worker: worker-06",
				"[dispatcher] Executing as build #4 — https://…",
				"20260723_1608: Pulling from esc-devops/…",
				"Status: Downloaded newer image for amr-registry.caas.intel.com/…",
			},
			want: "dispatching",
		},
		{
			name: "entrypoint has entered ict-build but no packages yet",
			logs: []string{
				"[dispatcher] Picked worker: worker-06",
				"2026-07-23T08:57:43Z [entrypoint] stage=ict-build",
				"INFO    config/merge.go    Successfully created merged configuration",
				"INFO    ubuntu/ubuntu.go   Initialized ubuntu provider with 12 repositories",
			},
			want: "preparing",
		},
		{
			name: "resolving packages",
			logs: []string{
				"[entrypoint] stage=ict-build",
				"INFO    debutils/download.go    fetching packages from user package list",
				"INFO    debutils/download.go    resolving dependencies for 286 DEBIANs",
			},
			want: "packages",
		},
		{
			name: "chroot finished — still in packages (initrd downloads may follow)",
			logs: []string{
				"[entrypoint] stage=ict-build",
				"fetching packages from user package list",
				"all downloads complete",
				"Chroot environment build completed successfully",
			},
			want: "packages",
		},
		{
			name: "install phase — X/Y counter",
			logs: []string{
				"[entrypoint] stage=ict-build",
				"fetching packages from user package list",
				"Image installation pre-processing…",
				"INFO    imageos/imageos.go    Installing package 42/270: efibootmgr",
			},
			want: "installing",
		},
		{
			name: "generating (uki + sbom)",
			logs: []string{
				"Installing package 270/270: dracut-core",
				"Configuring UKI",
				"Successfully built UKI",
				`Copied "/usr/lib/systemd/boot/efi/systemd-bootx64.efi" to "/boot/efi/EFI/BOOT/BOOTX64.EFI"`,
				"INFO    manifest/manifest.go    Successfully copied SBOM",
			},
			want: "generating",
		},
		{
			name: "publishing — jenkins staging",
			logs: []string{
				"Successfully copied SBOM",
				"2026-07-23T08:07:05Z [entrypoint] stage=stage-artefacts",
				"2026-07-23T08:07:05Z [entrypoint] stage=handoff",
			},
			want: "publishing",
		},
		{
			name: "done marker overrides all preceding stages",
			logs: []string{
				"Installing package 270/270: dracut-core",
				"Configuring UKI",
				"[entrypoint] stage=handoff",
				"image build completed successfully",
			},
			want: "done",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := detectPhase(tc.logs)
			if got != tc.want {
				t.Errorf("detectPhase() = %q, want %q\n\nlogs:\n%v", got, tc.want, tc.logs)
			}
		})
	}
}

// TestInstallProgress verifies we pick up the most recent counter (i.e. we
// don't get stuck on the first "Installing package 1/270:" line).
func TestInstallProgress(t *testing.T) {
	logs := []string{
		"INFO    imageos/imageos.go    Installing package 1/270: gcc-14-base",
		"INFO    imageos/imageos.go    Installing package 42/270: efibootmgr",
		"INFO    imageos/imageos.go    Installing package 269/270: systemd-boot",
	}
	done, total := installProgress(logs)
	if done != 269 || total != 270 {
		t.Errorf("installProgress() = %d/%d, want 269/270", done, total)
	}
}

// TestInstallProgress_NoMarker returns 0/0 when the install phase hasn't
// been reached yet — the UI treats that as "no counter available".
func TestInstallProgress_NoMarker(t *testing.T) {
	logs := []string{
		"[entrypoint] stage=ict-build",
		"resolving dependencies for 286 DEBIANs",
	}
	done, total := installProgress(logs)
	if done != 0 || total != 0 {
		t.Errorf("installProgress() = %d/%d, want 0/0", done, total)
	}
}
