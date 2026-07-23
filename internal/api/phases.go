// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0

package api

import "strings"

// buildPhase is a coarse, ordered stage of an ICT image build, derived by
// matching milestone strings in the build's log output. It drives the UI's
// progress stepper. These are best-effort: ICT has no structured progress
// signal, so we classify from log lines emitted by the dispatcher, the
// ephemeral ict-builder container's entrypoint, and shared (OS-independent)
// ICT code.
//
// This is our fork's extended variant of upstream's phases.go. Upstream ships
// 5 phases keyed to a local `./image-composer-tool build ...` invocation;
// our runtime path also involves a Jenkins dispatch and an Artifactory
// publish, so we've added `dispatching` at the front and `publishing`
// between `generating` and `done`. If a future dispatch mode omits Jenkins,
// the `dispatching` phase simply never trips a marker and the stepper opens
// straight on "Preparing".
type buildPhase int

const (
	phaseDispatching buildPhase = iota // waiting for a Jenkins worker slot / pulling ict-builder image
	phasePreparing                     // config load / provider init inside the container
	phasePackages                      // resolve + download packages AND build chroot env
	phaseInstalling                    // installing packages into the image
	phaseGenerating                    // ukify / SBOM / bootloader assembly
	phasePublishing                    // Jenkins staging + Artifactory upload
	phaseDone                          // build finished successfully
)

// phaseNames maps each phase to a stable id sent to the UI (also used as the
// stepper's ordered key list).
var phaseNames = map[buildPhase]string{
	phaseDispatching: "dispatching",
	phasePreparing:   "preparing",
	phasePackages:    "packages",
	phaseInstalling:  "installing",
	phaseGenerating:  "generating",
	phasePublishing:  "publishing",
	phaseDone:        "done",
}

// phaseMarkers maps a phase to case-insensitive substrings; if any is present
// in a log line, the build has reached at least that phase. Ordered earliest
// to latest so detectPhase can take the max reached.
//
// ICT's flow is NOT linear and offers no clean milestone between "all packages
// downloaded" and "installation begins": package resolve+download runs THREE
// interleaved times (image packages, chroot packages, then — after the chroot
// is built — initrd packages), so "chroot done" is NOT a safe step boundary
// (more downloads follow it). To guarantee a step never turns green while its
// own logs are still streaming, everything up to installation is one "packages"
// phase (resolve + download + chroot build). It advances to "installing" only
// at the authoritative "Installing package X/Y" marker.
//
// The generating phase spans everything from UKI setup through SBOM copy;
// "Building image:" is deliberately NOT a marker for it because that line
// fires BEFORE the install loop.
//
// The publishing phase is our fork-specific addition: after the ICT container
// exits, Jenkins runs a `stage-artefacts` step that copies the artifacts out
// of the container workspace, and then the PUBLISH pipeline stage pushes them
// to Artifactory (typically 1–2 minutes for our images). Without this phase
// the stepper jumps from "Generating" straight to "Done" while the user is
// still watching the log scroll past the upload.
var phaseMarkers = []struct {
	phase   buildPhase
	substrs []string
}{
	{phaseDispatching, []string{
		"[dispatcher] picked worker",
		"executing as build",
		"pulling from ",
		"status: downloaded newer image",
	}},
	{phasePreparing, []string{
		"[entrypoint] stage=ict-build",
		"successfully created merged configuration",
		"initialized ubuntu provider",
		"initialized debian",
		"repositories for package download",
	}},
	{phasePackages, []string{
		"fetching packages from user package list",
		"resolving dependencies for",
		"all downloads complete",
		"chroot environment build completed successfully",
		// The bare word "downloaded" would collide with docker's
		// "Status: Downloaded newer image for …" line during dispatch;
		// require the ICT-specific suffix so this only fires for
		// per-repo package download completion.
		"downloaded newer packages",
		"packages for chroot environment",
	}},
	{phaseInstalling, []string{
		"image package installation",
		"installing package ",
	}},
	{phaseGenerating, []string{
		"configuring uki",
		"successfully built uki",
		"copied \"/usr/lib/systemd/boot/efi/",
		"successfully copied sbom",
		"installing bootloader",
		"creating iso",
		"iso creation completed",
	}},
	{phasePublishing, []string{
		"[entrypoint] stage=stage-artefacts",
		"[entrypoint] stage=handoff",
		"[pipeline] { (publish)",
		"uploading to artifactory",
	}},
	{phaseDone, []string{
		"image build completed successfully",
	}},
}

// detectPhase returns the id of the furthest phase reached across all log
// lines. Defaults to "dispatching" before any marker appears — that's the
// state during the initial Jenkins queue wait, before even the first
// dispatcher log line has fired.
func detectPhase(logs []string) string {
	reached := phaseDispatching
	for _, line := range logs {
		lower := strings.ToLower(line)
		for _, m := range phaseMarkers {
			if m.phase <= reached {
				continue
			}
			for _, sub := range m.substrs {
				if strings.Contains(lower, sub) {
					reached = m.phase
					break
				}
			}
		}
	}
	return phaseNames[reached]
}

// installProgress extracts the most recent "Installing package X/Y" counter
// from the logs, returning done/total (0,0 if none seen). Lets the UI show a
// real per-package counter during the install phase, which is by far the
// longest stretch of the build (5–8 minutes for our templates).
func installProgress(logs []string) (done, total int) {
	const marker = "installing package "
	for _, line := range logs {
		lower := strings.ToLower(line)
		i := strings.Index(lower, marker)
		if i < 0 {
			continue
		}
		// Parse "X/Y" immediately after the marker, e.g. "Installing package 42/270: efibootmgr".
		rest := line[i+len(marker):]
		slash := strings.IndexByte(rest, '/')
		if slash < 0 {
			continue
		}
		d := atoiSafe(rest[:slash])
		// Total runs until a non-digit (colon, space, etc.).
		tEnd := slash + 1
		for tEnd < len(rest) && rest[tEnd] >= '0' && rest[tEnd] <= '9' {
			tEnd++
		}
		t := atoiSafe(rest[slash+1 : tEnd])
		if d > 0 && t > 0 {
			done, total = d, t
		}
	}
	return done, total
}

// atoiSafe parses a leading integer from s, returning 0 on any junk.
func atoiSafe(s string) int {
	s = strings.TrimSpace(s)
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0
		}
		n = n*10 + int(s[i]-'0')
	}
	return n
}
