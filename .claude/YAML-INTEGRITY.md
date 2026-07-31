# YAML integrity — the UI → farm handoff

> Read this before touching `web/src/lib/draftFromYaml.ts`, `web/src/store.ts`,
> `internal/api/jenkins.go`, or the template schema. It documents a real
> production incident, its nine root causes, and the four layers that now
> prevent a recurrence.

## The incident

Three builds were dispatched from the web UI to the Jenkins farm. All three
received **corrupted `TEMPLATE_YAML`**:

| Template | Dispatched | On disk | Outcome |
|---|---|---|---|
| `generic-handheld-os-template` (raw) | 18,398 B | 22,607 B | **FAILED** |
| `debian13-x86_64-desktop-virtualization-iso` | 3,229 B | 12,306 B | green, **wrong image** |
| `ubuntu24-x86_64-robotics-jazzy-iso` | 5,018 B | 10,055 B | green, **wrong image** |

The failure chain on the raw build:

1. The template sets `systemConfig.bootloader.provider: grub`.
2. The UI dropped that key while re-serializing.
3. With no override, the ubuntu24 raw default `provider: systemd-boot` won the
   defaults merge.
4. `internal/image/imageos/imageos.go:1380` therefore took the systemd-boot
   branch and looked for `/usr/lib/systemd/boot/efi/systemd-bootx64.efi`.
5. The same template **deliberately purges systemd-boot** (its postinst
   `bootctl install` fails inside a chroot), so the file was gone:
   `cp: cannot stat …` → `failed to configure UKI`.
6. The build died *after* installing all 270/270 packages.

The two green builds are the more dangerous result: they published images to
Artifactory that did not match the template the operator selected, and nothing
surfaced. **A silently-wrong green build is worse than a red one.**

## Nine root causes, all silent

Measured by round-tripping every file in `image-templates/` through
`parseYamlToDraft` → `applyOverrides`: **46 of 59 templates were altered**, and
**0 of 59** came back byte-identical.

| # | Defect | Blast radius |
|---|---|---|
| 1 | 6 `systemConfig` keys dropped (`bootloader`, `additionalFiles`, `description`, `immutability`, `initramfs`, `network`) | all templates that set them |
| 2 | 4 `disk` keys dropped (`artifacts`, `extendLastPartitionToFillDisk`, `path`, `selectionPolicy`) | `artifacts` alone: 34 templates |
| 3 | `disk.path: ""` erased — the emptiness is load-bearing, it enables `selectionPolicy` disk selection | 1 template |
| 4 | `systemConfig.name` overwritten with `image.name` — it selects which named system config the merge applies | 42 templates |
| 5 | `disk.name` overwritten with `image.name` — its own identifier (`Minimal_Raw`, `Default_ISO`) | 31 templates |
| 6 | Partition boundaries shifted 1 MiB: the reader computed `sizeMiB = end - start` and discarded `start`; the writer restarted at 0 | 34 templates |
| 7 | `MB` parsed as `MiB`. `internal/image/imagedisc/imagedisc.go:96-97` maps `MB`→1e6, `MiB`→1048576 | `end: "513MB"` grew the ESP ~1.3 MB |
| 8 | Multi-user templates emitted only `users[0]` — `azl3-x86_64-edge-raw`'s three accounts became one, silently deleting sudo users. Also lost `users[].startupScript` and empty `flags: []` | 3+ templates |
| 9 | `kernel` block fabricated when the source had none, overriding OSV defaults; and the schema's wsl2 conditional violated (it forbids `kernel`, `partitions`, `partitionTableType` and pins `disk` to `{name, artifacts}`) | wsl2 template emitted schema-INVALID YAML |

## Why per-field patching cannot fix this

The Interactive form models a **subset** of the schema. Anything it doesn't
represent is lost the moment YAML is rebuilt from the draft — and every new
schema field silently reopens the hole. Two rounds of field-by-field fixes each
looked complete and each missed more.

## The four layers now in place

### 1. Raw-template seeding (`InteractivePage.tsx`, `loadSeed`)

`loadSeed` used to fetch only `compose?form=merged`. That endpoint returns a
**Go-marshalled dump** — PascalCase keys (`Image`, `SystemConfig`, `Disk`) plus
internals (`FullPkgList`, `DotFilePath`, `InspectEnabled`) — which is *not* a
valid user template. Reading it with camelCase accessors finds nothing, so the
dispatched document had `systemConfig`, `disk` and `bootloader` entirely absent.

It now fetches **both** forms and hydrates from the RAW template, keeping
`raw.yaml` as the passthrough reference. Previewing one document while building
another is precisely what shipped the wrong images.

### 2. Pristine passthrough (`draftFromYaml.ts`, `applyOverrides`)

The seed's original text lives on `InteractiveDraft.baseYaml`. On serialize, a
draft re-derived from that seed is compared against the current draft; if the
user changed nothing the form can express, **the original bytes are returned**.

Compare **draft-to-draft, not output-to-seed** — the latter would never match for
exactly the templates whose reconstruction is imperfect, i.e. the ones that need
it most.

`PERSIST_VERSION` was bumped 1 → 2 because `baseYaml` is new: a draft persisted
by an older build has none, so the passthrough could not fire. There is no
`migrate()`, so zustand discards stale state — cheap to reload, expensive to
dispatch wrong.

### 3. Backend schema guard (`internal/api/jenkins.go`)

`handleJenkinsDispatch` previously validated **only** `TrimSpace(yaml) == ""`.
Any string reached a worker. It now calls `validate.ValidateUserTemplateJSON`
(the same validator the `validate` subcommand uses) and returns
**400 `INVALID_TEMPLATE`**.

**Know its limit.** The 3,229-byte payload that broke the farm is
**schema-VALID** — verified directly against the captured payload — because
nearly every schema field is optional. Schema validation stops garbage and
malformed documents; it cannot detect silent loss of optional fields. Fidelity is
the client's job. This guard is the floor, not the ceiling.

### 4. Regression gate

    cd web && npm run test:fidelity

`web/src/lib/draftFromYaml.fidelity.test.mjs` asserts three invariants over
every shipped template:

1. **Untouched round-trip is byte-identical.** The invariant that would have
   caught the incident.
2. **An EDITED draft still reconstructs** and preserves `bootloader`,
   `additionalFiles`, `immutability`, `configurations`, `disk.artifacts`,
   `packageRepositories`. Guards against "fixing" case 1 by always passing
   through.
3. **Unit parsing matches the Go table** (`MB`≠`MiB`).

Mutation-tested: disabling the passthrough fails 59/59 with exact byte deltas;
restored, passes 59/59.

## Which tabs were affected

| Tab | Path | Verdict |
|---|---|---|
| **Basic** | `api.compose()` server-side, dispatched verbatim | always correct |
| **Advanced** | editor buffer dispatched verbatim (syntax-checked only, no schema check) | always correct |
| **Interactive** | reconstructed from the form model | **was the sole source of corruption** |

## Verification after the fix

Nine UI dispatches, SHA-256 compared against the reference templates:

    719ac23a22e5c92e  10055 B  ubuntu24-x86_64-robotics-jazzy-iso          (4 dispatches)
    e65969499e11c947  12306 B  debian13-x86_64-desktop-virtualization-iso  (3 dispatches)
    0bb74ed0c8736533  22607 B  generic-handheld-os-template                (2 dispatches)

**9/9 hash-identical to the on-disk templates. Zero deltas.**

## Rules

1. **Never widen the form model without updating the passthrough key lists.**
   `PASSTHROUGH_SYSCFG_KEYS` + `PASSTHROUGH_DISK_KEYS` plus the form-owned keys
   must together equal the schema's properties. The schema is
   `additionalProperties: false`, so a key in neither set is silent data loss and
   a key not in the schema is a hard validation failure.
2. **Run `npm run test:fidelity`** after any change to `draftFromYaml.ts`,
   `store.ts`, the schema, or `image-templates/`.
3. **When triaging a farm failure, diff the job's `TEMPLATE_YAML` parameter
   against the on-disk template FIRST.** Job status tells you nothing about
   payload integrity — this incident was diagnosed only after a build failed,
   despite the corrupted payloads being visible in the same API response that
   was already being polled.
4. **Unit semantics live in Go.** `internal/image/imagedisc/imagedisc.go:96-97`
   is the authority; the frontend must match it, not approximate it.
