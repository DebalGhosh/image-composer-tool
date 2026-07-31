// Round-trip between CoreV1 YAML documents and the Interactive tab's draft
// model. Two entry points:
//
//   parseYamlToDraft(yaml)   YAML → InteractiveDraft   (loading a seed)
//   applyOverrides(draft)    InteractiveDraft → YAML   (Build/Preview)
//
// Design notes:
//   * The Basic tab receives templates from api.compose() with user-authored
//     lowerCamelCase keys, but the same endpoint with `?form=merged` returns
//     a sigs.k8s.io/yaml-marshalled document that uses Go's exported field
//     names — i.e. PascalCase (`Image.Name`, `SystemConfig.Kernel.Cmdline`).
//     We tolerate BOTH shapes on the way in and always emit camelCase on the
//     way out to match what user-authored templates look like on disk.
//   * We stash the whole parsed doc as `draft.baseDoc` so applyOverrides can
//     preserve anything we don't yet surface in the form (extra keys, custom
//     stages, whatever) — the round-trip only overwrites fields we own.
//
// Nothing here mutates its inputs. All parsed values are defensively coerced
// (typeof-guards, Array.isArray) so a malformed seed produces a best-effort
// draft rather than crashing the Interactive tab.

import YAML from 'yaml'
import type { InteractiveDraft, Partition, UserConfig } from '../store'

/* ------------------------------------------------------------------------- *
 * Dual-key access
 * ------------------------------------------------------------------------- */

/**
 * Try each candidate key (in order) against `obj` and return the first
 * defined value. Used everywhere we need camelCase/PascalCase tolerance.
 */
function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    if (rec[k] !== undefined) return rec[k]
  }
  return undefined
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

/* ------------------------------------------------------------------------- *
 * Size parsing
 * ------------------------------------------------------------------------- */

/**
 * Parse a size literal into MiB.
 *
 * Unit semantics MUST match the Go build engine, which is the authority on what
 * a template means: internal/image/imagedisc/imagedisc.go:96-97 pairs
 * ["KiB","MiB","GiB","K","M","G","KB","MB","GB"] with
 * [1024, 1048576, 1073741824, 1024, 1048576, 1073741824, 1000, 1000000, 1000000000].
 * So the binary forms (KiB/MiB/GiB) and the bare shorthand (K/M/G) are powers
 * of two, while the SI forms (KB/MB/GB) are powers of ten.
 *
 * This previously treated MB as MiB "because the 4% error is acceptable for
 * disk-level authoring". It is not: ubuntu24-aarch64-minimal-raw.yml writes
 * `end: "513MB"`, and coercing that to 513MiB silently grew the ESP by ~1.3MB
 * and shifted every following partition. Anything unparsable returns 0.
 */
export function parseSizeToMiB(s: string): number {
  if (typeof s !== 'string') return 0
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return 0
  const unit = (m[2] || 'MiB').toLowerCase()
  const MIB = 1048576
  switch (unit) {
    // Binary (powers of two)
    case 'mib':
    case 'm':
      return n
    case 'gib':
    case 'g':
      return n * 1024
    case 'tib':
    case 't':
      return n * 1024 * 1024
    case 'kib':
    case 'k':
      return n / 1024
    // SI (powers of ten) — converted to MiB via exact byte counts.
    case 'kb':
      return (n * 1000) / MIB
    case 'mb':
      return (n * 1000000) / MIB
    case 'gb':
      return (n * 1000000000) / MIB
    case 'tb':
      return (n * 1000000000000) / MIB
    default:
      return 0
  }
}

export function parseSizeToGiB(s: string): number {
  return parseSizeToMiB(s) / 1024
}

/**
 * Format a GiB float back into an ICT size literal. Whole GiB come out as
 * "<n>GiB"; fractional sizes below 1 GiB emit MiB; fractional sizes above
 * 1 GiB round to the nearest 100 MiB and are emitted in MiB (so the round-
 * trip is exact and doesn't drift on subsequent parses).
 */
export function formatGiB(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0MiB'
  const totalMiB = n * 1024
  if (Number.isInteger(n) && n >= 1) return `${n}GiB`
  if (n < 1) {
    // Below 1 GiB — always emit MiB, rounded to whole MiB.
    return `${Math.max(1, Math.round(totalMiB))}MiB`
  }
  // Fractional but >= 1 GiB — snap to nearest 100 MiB for a clean literal.
  const snapped = Math.round(totalMiB / 100) * 100
  return `${snapped}MiB`
}

/* ------------------------------------------------------------------------- *
 * Partition inference
 * ------------------------------------------------------------------------- */

/**
 * Infer a Partition.role from a raw partition object. We check the strongest
 * hints first (explicit GPT type, flags) before falling back to mountPoint.
 * Anything we can't classify becomes 'custom' — the editor still lets the
 * operator adjust the fsType/mountPoint by hand.
 */
function inferRole(part: Record<string, unknown>): Partition['role'] {
  const type = asString(pick(part, 'type', 'Type')).toLowerCase()
  const fsType = asString(pick(part, 'fsType', 'FsType', 'FSType')).toLowerCase()
  const mount = asString(pick(part, 'mountPoint', 'MountPoint'))
  const flags = asStringArray(pick(part, 'flags', 'Flags')).map((f) =>
    f.toLowerCase(),
  )
  const name = asString(pick(part, 'name', 'Name', 'id', 'Id', 'ID')).toLowerCase()

  if (type === 'esp' || mount === '/boot/efi' || flags.includes('esp')) {
    return 'efi'
  }
  if (type === 'bios-boot' || flags.includes('bios_grub')) return 'bios-boot'
  if (type === 'linux-swap' || fsType === 'linux-swap' || fsType === 'swap') {
    return 'swap'
  }
  if (mount === '/') return 'root'
  if (mount === '/opt') return 'userdata'
  if (name.includes('verity') || type.includes('verity')) return 'verity'
  return 'custom'
}

/* ------------------------------------------------------------------------- *
 * parseYamlToDraft
 * ------------------------------------------------------------------------- */

export function parseYamlToDraft(yaml: string): InteractiveDraft {
  let doc: unknown = null
  try {
    doc = YAML.parse(yaml)
  } catch {
    // Malformed input — surface an empty draft with the raw text discarded.
    // Callers can detect this by inspecting draft.baseDoc === null.
    doc = null
  }

  const image = pick(doc, 'image', 'Image') as Record<string, unknown> | undefined
  const target = pick(doc, 'target', 'Target') as
    | Record<string, unknown>
    | undefined
  const disk = pick(doc, 'disk', 'Disk') as Record<string, unknown> | undefined
  const sysCfg = pick(doc, 'systemConfig', 'SystemConfig') as
    | Record<string, unknown>
    | undefined
  const kernel = pick(sysCfg, 'kernel', 'Kernel') as
    | Record<string, unknown>
    | undefined
  const users = pick(sysCfg, 'users', 'Users') as unknown[] | undefined
  const repos = pick(doc, 'packageRepositories', 'PackageRepositories')
  const configurations = pick(sysCfg, 'configurations', 'Configurations')

  const diskSizeRaw = asString(pick(disk, 'size', 'Size'))
  const sizeGiB = diskSizeRaw ? parseSizeToGiB(diskSizeRaw) : 8
  const diskMiB = Math.max(1, Math.round(sizeGiB * 1024))

  // Partitions: convert start/end pairs into sizeMiB, tag the fill partition.
  const rawParts = pick(disk, 'partitions', 'Partitions')
  const partitions: Partition[] = []
  if (Array.isArray(rawParts)) {
    let cursorMiB = 0
    for (let i = 0; i < rawParts.length; i++) {
      const p = rawParts[i]
      if (!p || typeof p !== 'object') continue
      const rec = p as Record<string, unknown>
      const startRaw = asString(pick(rec, 'start', 'Start'))
      const endRaw = asString(pick(rec, 'end', 'End'))
      const startMiB = startRaw ? parseSizeToMiB(startRaw) : cursorMiB
      const isLast = i === rawParts.length - 1
      const endsAtZero = endRaw === '0' || endRaw === '0MiB' || endRaw === ''
      let sizeMiB = 0
      let fill = false
      if (isLast && endsAtZero) {
        fill = true
        sizeMiB = Math.max(0, diskMiB - startMiB)
      } else {
        const endMiB = endRaw ? parseSizeToMiB(endRaw) : startMiB
        sizeMiB = Math.max(0, endMiB - startMiB)
      }
      const role = inferRole(rec)
      const flags = asStringArray(pick(rec, 'flags', 'Flags'))
      const id =
        asString(pick(rec, 'id', 'Id', 'ID')) ||
        asString(pick(rec, 'name', 'Name')) ||
        `part${i + 1}`
      const part: Partition = {
        id,
        name: asString(pick(rec, 'name', 'Name'), id),
        role,
        sizeMiB,
        type: asString(pick(rec, 'type', 'Type'), 'linux'),
        fsType: asString(pick(rec, 'fsType', 'FsType', 'FSType')),
        mountPoint: asString(pick(rec, 'mountPoint', 'MountPoint'), 'none'),
        flags,
      }
      if (fill) part.fillRemaining = true
      // Capture the first partition's absolute start so the serializer can
      // reproduce the template's alignment offset (usually 1MiB) instead of
      // restarting the layout at 0MiB. See Partition.startOffsetMiB.
      if (i === 0 && startMiB > 0) part.startOffsetMiB = startMiB
      const fsLabel = asString(pick(rec, 'fsLabel', 'FsLabel', 'FSLabel'))
      if (fsLabel) part.fsLabel = fsLabel
      const mountOptions = asString(pick(rec, 'mountOptions', 'MountOptions'))
      if (mountOptions) part.mountOptions = mountOptions
      const typeUUID = asString(pick(rec, 'typeUUID', 'TypeUUID', 'typeUuid'))
      if (typeUUID) part.typeUUID = typeUUID
      partitions.push(part)
      cursorMiB = startMiB + sizeMiB
    }
  }

  // First user only for v1 — the editor exposes a single UserConfig row.
  let user: UserConfig | null = null
  if (Array.isArray(users) && users.length > 0) {
    const u = users[0]
    if (u && typeof u === 'object') {
      const rec = u as Record<string, unknown>
      user = {
        name: asString(pick(rec, 'name', 'Name')),
        password: asString(pick(rec, 'password', 'Password')),
        // Accept every casing the schema and older templates might use:
        //   `hash_algo` (canonical schema key), `hashAlgo` (older UI
        //   emit before the schema-matching fix), `HashAlgo` (Go
        //   PascalCase from a marshaled ImageTemplate). Any of these
        //   round-trip cleanly now that the writer emits `hash_algo`.
        hashAlgo:
          asString(pick(rec, 'hash_algo', 'hashAlgo', 'HashAlgo'), 'sha512') ===
          'bcrypt'
            ? 'bcrypt'
            : 'sha512',
        groups: asStringArray(pick(rec, 'groups', 'Groups')),
        sudo: asBool(pick(rec, 'sudo', 'Sudo')),
        home: asString(pick(rec, 'home', 'Home')),
        shell: asString(pick(rec, 'shell', 'Shell')),
      }
    }
  }

  // Inherited configurations: normalize into { cmd } objects if we can.
  const inheritedConfigurations: { cmd: string }[] = Array.isArray(configurations)
    ? configurations
        .map((c) => {
          if (typeof c === 'string') return { cmd: c }
          if (c && typeof c === 'object') {
            const cmd = asString(pick(c, 'cmd', 'Cmd', 'command', 'Command'))
            return cmd ? { cmd } : null
          }
          return null
        })
        .filter((x): x is { cmd: string } => x !== null)
    : []

  const partitionTableTypeRaw = asString(
    pick(disk, 'partitionTableType', 'PartitionTableType'),
    'gpt',
  ).toLowerCase()
  const partitionTableType: 'gpt' | 'mbr' =
    partitionTableTypeRaw === 'mbr' ? 'mbr' : 'gpt'

  return {
    imageName: asString(pick(image, 'name', 'Name')),
    imageVersion: asString(pick(image, 'version', 'Version')),
    target: {
      os: asString(pick(target, 'os', 'OS', 'Os'), 'ubuntu'),
      dist: asString(pick(target, 'dist', 'Dist'), 'ubuntu24'),
      arch: asString(pick(target, 'arch', 'Arch'), 'x86_64'),
      imageType: asString(pick(target, 'imageType', 'ImageType'), 'raw'),
    },
    disk: {
      sizeGiB: sizeGiB > 0 ? sizeGiB : 8,
      partitionTableType,
      partitions,
    },
    kernel: {
      version: asString(pick(kernel, 'version', 'Version')),
      cmdline: asString(pick(kernel, 'cmdline', 'Cmdline', 'cmdLine')),
      packages: asStringArray(pick(kernel, 'packages', 'Packages')),
      enableExtraModules: asString(
        pick(kernel, 'enableExtraModules', 'EnableExtraModules'),
      ),
      uki: asBool(pick(kernel, 'uki', 'Uki', 'UKI')),
    },
    packages: asStringArray(pick(sysCfg, 'packages', 'Packages')),
    hostname: asString(pick(sysCfg, 'hostname', 'HostName', 'Hostname')),
    user,
    inheritedConfigurations,
    inheritedRepositories: Array.isArray(repos) ? (repos as unknown[]) : [],
    baseDoc: doc ?? null,
    // Keep the seed text so an unedited draft can be dispatched verbatim
    // rather than re-serialized. See InteractiveDraft.baseYaml.
    baseYaml: doc ? yaml : null,
  }
}

/* ------------------------------------------------------------------------- *
 * applyOverrides
 * ------------------------------------------------------------------------- */

/**
 * Deep-clone via structuredClone when available (it preserves Maps/Sets/etc.
 * which YAML.parse never emits, but also handles cycles safely) and fall
 * back to JSON round-trip for older runtimes.
 */
function deepClone<T>(x: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(x)
    } catch {
      /* structuredClone rejects functions; fall through. */
    }
  }
  return JSON.parse(JSON.stringify(x)) as T
}

/**
 * Serialize a single UserConfig back into the shape sigs.k8s.io/yaml + our
 * CoreV1 parser accept. Only non-empty fields are emitted so the diff on a
 * round-trip stays minimal.
 */
function singleUserFrom(u: UserConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { name: u.name }
  if (u.password) out.password = u.password
  // The schema (internal/config/schema/os-image-template.schema.json) is
  // inconsistent about casing here: most user fields are camelCase
  // (passwordMaxAge, startupScript) but hash-algo is snake_case
  // (`hash_algo`). Emitting camelCase `hashAlgo` trips
  // additionalProperties:false and fails validation at build time. Match
  // the schema exactly for this one key.
  if (u.hashAlgo) out.hash_algo = u.hashAlgo
  if (u.groups && u.groups.length > 0) out.groups = u.groups
  if (u.sudo) out.sudo = u.sudo
  if (u.home) out.home = u.home
  if (u.shell) out.shell = u.shell
  return out
}

/**
 * Structural equality over the user-editable half of an InteractiveDraft.
 *
 * `baseDoc` and `baseYaml` are provenance, not user state, so they're excluded
 * — otherwise a draft would never compare equal to one re-derived from its own
 * seed. Everything else is compared by value via JSON, which is sufficient
 * because a draft is plain data (strings, numbers, booleans, arrays, and plain
 * objects) with no undefined-vs-missing subtleties that matter here.
 */
function draftsEqual(a: InteractiveDraft, b: InteractiveDraft): boolean {
  const strip = (d: InteractiveDraft) => {
    const { baseDoc: _doc, baseYaml: _yaml, ...rest } = d
    return rest
  }
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

/** Convert a Partition[] back into the CoreV1 start/end representation. */
function partitionsToYaml(
  parts: Partition[],
  diskMiB: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  // Honour the source layout's leading alignment gap (see
  // Partition.startOffsetMiB). Starting at 0 shifted every boundary down by
  // 1MiB relative to the template.
  let cursor = parts.length > 0 ? (parts[0].startOffsetMiB ?? 0) : 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const isLast = i === parts.length - 1
    const startMiB = cursor
    const fill = isLast && p.fillRemaining === true
    const sizeMiB = fill ? Math.max(0, diskMiB - startMiB) : Math.max(0, p.sizeMiB)
    const endMiB = startMiB + sizeMiB
    const entry: Record<string, unknown> = {
      id: p.id,
      name: p.name || p.id,
      type: p.type,
      start: `${startMiB}MiB`,
      end: fill ? '0' : `${endMiB}MiB`,
    }
    if (p.fsType) entry.fsType = p.fsType
    if (p.fsLabel) entry.fsLabel = p.fsLabel
    if (p.mountPoint) entry.mountPoint = p.mountPoint
    if (p.mountOptions) entry.mountOptions = p.mountOptions
    if (p.flags && p.flags.length > 0) entry.flags = p.flags
    if (p.typeUUID) entry.typeUUID = p.typeUUID
    out.push(entry)
    cursor = endMiB
  }
  return out
}

/**
 * Whitelist of the top-level keys the UserTemplate schema accepts. Every
 * other key at the doc root is rejected via additionalProperties:false,
 * and the merged doc we hydrate the draft from contains many Go-internal
 * fields (`extends`, `PathList`, `BootloaderPkgList`, `DotFilePath`, …)
 * plus the Go-marshaled PascalCase equivalents of every section
 * (`Image`, `Target`, `Disk`, `SystemConfig`, …). Emitting those would
 * fail validation at Jenkins build time. So we build a fresh output doc
 * containing only the whitelisted keys and preserve the schema-known
 * passthrough sections from the source when present.
 */
const ALLOWED_TOP_LEVEL_KEYS: readonly string[] = [
  'extends',
  'metadata',
  'image',
  'target',
  'baseline',
  'overlayPolicy',
  'disk',
  'systemConfig',
  'sbomPackageMetadata',
  'packageRepositories',
]

/**
 * systemConfig children that are schema-legal but not editable in the
 * Interactive form. They are carried over verbatim from the seed template so a
 * round-trip through the form doesn't silently discard them.
 *
 * The form owns `name`, `hostname`, `kernel`, `packages`, `users`, and
 * `configurations`; everything else the UserTemplate schema permits is listed
 * here. Keep this list + the six form-owned keys equal to the schema's
 * systemConfig properties — it is `additionalProperties: false`, so a key
 * absent from both sets is a silent data loss and a key not in the schema is a
 * hard validation failure.
 */
const PASSTHROUGH_SYSCFG_KEYS: readonly string[] = [
  'bootloader',
  'additionalFiles',
  'description',
  'immutability',
  'initramfs',
  'network',
]

/**
 * Same contract as PASSTHROUGH_SYSCFG_KEYS, one level down: `disk` children the
 * form doesn't edit. The form owns `name`, `size`, `partitionTableType`, and
 * `partitions`; the schema permits eight.
 *
 * `artifacts` alone appears in 34 of the 59 shipped templates, and
 * `extendLastPartitionToFillDisk` changes the on-disk layout — dropping either
 * silently produces an image that differs from the template the user picked.
 */
const PASSTHROUGH_DISK_KEYS: readonly string[] = [
  'artifacts',
  'extendLastPartitionToFillDisk',
  'path',
  'selectionPolicy',
]

/**
 * Map the Go-side PascalCase package-repository shape back to the
 * camelCase keys the UserTemplate schema requires. Anything not on the
 * schema (`id`, `preseeds`, …) is dropped. Only non-empty values are
 * emitted so `additionalProperties:false` doesn't reject a stray "".
 */
function repoFromAny(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  // Field-by-field remap: preferred camelCase first, then Go PascalCase
  // fallbacks. Empty strings and null/undefined are omitted.
  const takeStr = (dst: string, ...keys: string[]) => {
    for (const k of keys) {
      const v = r[k]
      if (typeof v === 'string' && v.length > 0) {
        out[dst] = v
        return
      }
    }
  }
  const takeAny = (dst: string, ...keys: string[]) => {
    for (const k of keys) {
      const v = r[k]
      if (v === null || v === undefined) continue
      if (Array.isArray(v) && v.length === 0) continue
      out[dst] = v
      return
    }
  }
  takeStr('codename', 'codename', 'Codename')
  takeStr('url', 'url', 'URL', 'Url')
  takeStr('path', 'path', 'Path')
  takeAny('packages', 'packages', 'Packages')
  takeStr('pkey', 'pkey', 'PKey', 'Pkey')
  takeAny('pkeys', 'pkeys', 'PKeys', 'Pkeys')
  takeStr('component', 'component', 'Component')
  takeAny('allowPackages', 'allowPackages', 'AllowPackages')
  // priority: numeric — 0 is a legal minimum, so only omit when unset.
  {
    const v = r.priority ?? r.Priority
    if (typeof v === 'number' && Number.isFinite(v)) out.priority = v
  }
  // insecureSkipVerify: emit only when true (default is false anyway).
  {
    const v = r.insecureSkipVerify ?? r.InsecureSkipVerify
    if (v === true) out.insecureSkipVerify = true
  }
  return out
}

/**
 * Filter the current user object to the fields the Users schema allows.
 * Everything else (Go-side `PasswordMaxAge: 0`, empty `StartupScript`,
 * lingering `HashAlgo` casing) has been handled elsewhere in the
 * serialization, but this belt-and-braces filter guarantees no unknown
 * top-level keys ever land on a user entry.
 */
const ALLOWED_USER_KEYS: readonly string[] = [
  'name',
  'password',
  'hash_algo',
  'passwordMaxAge',
  'startupScript',
  'groups',
  'sudo',
  'home',
  'shell',
]

function whitelistKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of allowed) {
    if (obj[k] !== undefined) out[k] = obj[k]
  }
  return out
}

export function applyOverrides(draft: InteractiveDraft): string {
  // Snapshot of the source doc — needed to preserve `extends`, `metadata`,
  // `baseline`, and `overlayPolicy` (schema-allowed passthrough fields
  // that the Interactive form doesn't edit but the seed may have set).
  const src: Record<string, unknown> =
    draft.baseDoc && typeof draft.baseDoc === 'object' && !Array.isArray(draft.baseDoc)
      ? (deepClone(draft.baseDoc) as Record<string, unknown>)
      : {}

  // Build the output from scratch so no Go-marshaled fields leak through.
  // Every section is populated fresh from the draft below.
  const doc: Record<string, unknown> = {}

  // Passthrough sections that the Interactive form doesn't touch. Preserve
  // them from the merged seed doc if present, drop everything else.
  for (const k of ['extends', 'metadata', 'baseline', 'overlayPolicy'] as const) {
    // Accept both camelCase (already-mapped) and PascalCase (raw Go marshal).
    const val =
      (src as Record<string, unknown>)[k] ??
      (src as Record<string, unknown>)[k.charAt(0).toUpperCase() + k.slice(1)]
    if (val !== undefined && val !== null && val !== '') {
      doc[k] = val
    }
  }

  // image
  doc.image = {
    name: draft.imageName,
    version: draft.imageVersion,
  }

  // target
  doc.target = {
    os: draft.target.os,
    dist: draft.target.dist,
    arch: draft.target.arch,
    imageType: draft.target.imageType,
  }

  // disk
  //
  // WSL2 images have no partition table and no kernel of their own — they run
  // on the host's. The schema enforces this with a conditional branch: when
  // `target.imageType == "wsl2"`, `disk.partitionTableType`, `disk.partitions`
  // and `systemConfig.kernel` are each `false` (forbidden outright). Emitting
  // them anyway produces a schema-INVALID template that the farm rejects only
  // after a worker has been queued, so gate them here.
  const isWsl2 = draft.target.imageType === 'wsl2'

  const diskMiB = Math.max(1, Math.round(draft.disk.sizeGiB * 1024))
  const srcDisk = pick(src, 'disk', 'Disk') as Record<string, unknown> | undefined
  // For wsl2 the schema pins `disk` to exactly {name, artifacts} with
  // additionalProperties:false — `size`, `partitionTableType` and `partitions`
  // are all rejected. Everything else gets the normal shape.
  //
  // disk.name is its OWN identifier, not the image name. Templates use values
  // like "Minimal_Raw" or "Default_ISO" and reuse them across images; the
  // defaults merge keys the disk config off it. Overwriting it with
  // draft.imageName silently renamed the disk config in 31 of 59 templates.
  // Preserve the source value; fall back to the image name only when the
  // source genuinely has none (schema requires disk.name).
  const srcDiskName = asString(pick(srcDisk, 'name', 'Name'))
  const diskOut: Record<string, unknown> = {
    name: srcDiskName || draft.imageName,
  }
  if (!isWsl2) {
    diskOut.size = formatGiB(draft.disk.sizeGiB)
    diskOut.partitionTableType = draft.disk.partitionTableType
    diskOut.partitions = partitionsToYaml(draft.disk.partitions, diskMiB)
  }
  // Passthrough disk children the form doesn't edit — see
  // PASSTHROUGH_DISK_KEYS. Booleans are preserved even when false, since
  // `extendLastPartitionToFillDisk: false` is a meaningful override of a
  // default-true OSV config.
  //
  // Unlike the systemConfig loop, an EMPTY STRING is preserved here: an
  // explicit `disk.path: ""` is load-bearing. ubuntu24-x86_64-minimal-
  // unattended-iso.yml sets it deliberately ("Keep path empty to enable
  // policy-based disk selection at install time") and pairs it with
  // selectionPolicy. Dropping the key would let a non-empty OSV default win
  // and pin the install to a fixed device, defeating the policy.
  for (const k of PASSTHROUGH_DISK_KEYS) {
    if (diskOut[k] !== undefined) continue
    const val = pick(srcDisk, k, k.charAt(0).toUpperCase() + k.slice(1))
    if (val !== undefined && val !== null) {
      diskOut[k] = val
    }
  }
  // Only emit `disk` when the seed actually had one, or the operator supplied
  // partitions of their own.
  //
  // 24 of the 59 shipped templates (every ISO and initrd variant) declare no
  // disk block at all and inherit the OSV default. Emitting one unconditionally
  // fabricated `{name, size: "8GiB", partitionTableType: "gpt", partitions: []}`
  // out of the form's initial state, which then OVERRIDES that default. The
  // result is schema-valid, so neither the backend guard nor `validate` can
  // catch it — the same silent-wrong-image shape as the original bootloader
  // incident. The pristine passthrough hides this while nothing is edited; this
  // gate is what protects the edited path.
  if (srcDisk !== undefined || draft.disk.partitions.length > 0) {
    doc.disk = diskOut
  }

  // systemConfig — assemble child sections then whitelist to prevent
  // any unknown keys from sneaking through.
  const srcSysCfg = pick(src, 'systemConfig', 'SystemConfig') as
    | Record<string, unknown>
    | undefined
  // systemConfig.name selects which named system config the defaults merge
  // applies (templates use "minimal", "edge", "robotics-jazzy", …), so it is
  // NOT the image name. Overwriting it changed the resolved config in 42 of 59
  // templates. Preserve the source; fall back to the image name only when
  // absent.
  const srcSysName = asString(pick(srcSysCfg, 'name', 'Name'))
  const sysCfg: Record<string, unknown> = {
    name: srcSysName || draft.imageName,
  }
  if (draft.hostname) sysCfg.hostname = draft.hostname
  // Forbidden for wsl2 (see isWsl2 above). Also skipped when the source had no
  // kernel block at all and the form collected nothing: emitting
  // `{version:"",cmdline:"",packages:[],enableExtraModules:"",uki:false}` would
  // invent empty values that override the OSV defaults the template meant to
  // inherit.
  const srcKernel = pick(srcSysCfg, 'kernel', 'Kernel')
  const kernelHasContent =
    !!draft.kernel.version ||
    !!draft.kernel.cmdline ||
    (draft.kernel.packages && draft.kernel.packages.length > 0) ||
    !!draft.kernel.enableExtraModules ||
    draft.kernel.uki === true
  if (!isWsl2 && (srcKernel !== undefined || kernelHasContent)) {
    sysCfg.kernel = {
      version: draft.kernel.version,
      cmdline: draft.kernel.cmdline,
      packages: draft.kernel.packages,
      enableExtraModules: draft.kernel.enableExtraModules,
      uki: draft.kernel.uki,
    }
  }
  sysCfg.packages = draft.packages
  if (draft.user) {
    sysCfg.users = [
      whitelistKeys(singleUserFrom(draft.user), ALLOWED_USER_KEYS),
    ]
  }
  if (draft.inheritedConfigurations.length > 0) {
    sysCfg.configurations = draft.inheritedConfigurations
  }

  // Passthrough systemConfig children the Interactive form doesn't edit.
  //
  // Without this, a seed template's `bootloader` (and friends) were silently
  // dropped on the way to Jenkins, so the OSV default won the defaults merge
  // instead of the template's own value. That is not cosmetic: the ubuntu24
  // raw default is `provider: systemd-boot`, while templates such as
  // generic-handheld-os-template.yml set `provider: grub` AND purge the
  // systemd-boot package (its postinst `bootctl install` fails in a chroot).
  // Losing the override sent imageos down the systemd-boot branch looking for
  // /usr/lib/systemd/boot/efi/systemd-bootx64.efi — a file the template had
  // just purged — failing the build at "failed to configure UKI" after every
  // package was already installed.
  //
  // Mirrors the top-level passthrough loop above: preserve from the seed doc
  // when present, accept either camelCase or Go PascalCase, drop empties.
  // Only schema-known keys (UserTemplate.systemConfig) are eligible, so this
  // cannot reintroduce an additionalProperties:false rejection.
  for (const k of PASSTHROUGH_SYSCFG_KEYS) {
    if (sysCfg[k] !== undefined) continue // form-owned value wins
    const val = pick(srcSysCfg, k, k.charAt(0).toUpperCase() + k.slice(1))
    if (val !== undefined && val !== null && val !== '') {
      sysCfg[k] = val
    }
  }

  doc.systemConfig = sysCfg

  // packageRepositories: whitelist each entry to schema keys, drop the
  // Go-only IDs and empty-string placeholders.
  if (draft.inheritedRepositories.length > 0) {
    const mapped = (draft.inheritedRepositories as unknown[])
      .map((r) => repoFromAny(r))
      .filter((x): x is Record<string, unknown> => x !== null && Object.keys(x).length > 0)
    if (mapped.length > 0) doc.packageRepositories = mapped
  }

  // Belt-and-braces: ensure only whitelisted top-level keys land in the
  // output. If a future draft field grows a new top-level section, this
  // fails fast and gives us a chance to update ALLOWED_TOP_LEVEL_KEYS
  // rather than shipping a schema-invalid template silently.
  const final: Record<string, unknown> = {}
  for (const k of ALLOWED_TOP_LEVEL_KEYS) {
    if (doc[k] !== undefined) final[k] = doc[k]
  }

  // PRISTINE PASSTHROUGH.
  //
  // Reconstructing from the form model can only ever be as faithful as the
  // model is complete, and it isn't: the form holds one user (templates ship
  // three), no per-partition start offsets, no `flags: []`, no startupScript.
  // Cycling templates in a dropdown without touching a single control must not
  // change the template — so when the rebuilt doc is semantically equal to the
  // seed, dispatch the seed's ORIGINAL bytes instead of our re-serialization.
  //
  // "Untouched" is decided by re-deriving a draft from the seed and comparing
  // it to the CURRENT draft — not by comparing the reconstruction to the seed.
  // The latter would never match for exactly the templates whose
  // reconstruction is imperfect, which are the ones that need this most.
  // Comparing draft-to-draft asks the right question: has the user changed
  // anything the form can express? If not, the seed is authoritative.
  //
  // The re-derivation is cheap (a YAML parse plus field copies) and runs only
  // on dispatch/preview, not per keystroke.
  if (draft.baseYaml) {
    try {
      const pristine = parseYamlToDraft(draft.baseYaml)
      if (draftsEqual(pristine, draft)) {
        return draft.baseYaml
      }
    } catch {
      // Unparseable seed: fall through to the reconstruction.
    }
  }

  return YAML.stringify(final)
}
