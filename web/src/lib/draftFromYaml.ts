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
 * Parse a size literal into MiB. Accepts the ICT-preferred binary units
 * ('8GiB', '3500MiB'), the shorter 'G'/'M' shorthand, and the SI-ish
 * 'GB'/'MB' form (treated as binary for our purposes — the 4% error is
 * acceptable for disk-level authoring). Anything unparsable returns 0.
 */
export function parseSizeToMiB(s: string): number {
  if (typeof s !== 'string') return 0
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return 0
  const unit = (m[2] || 'MiB').toLowerCase()
  switch (unit) {
    case 'mib':
    case 'mb':
    case 'm':
      return n
    case 'gib':
    case 'gb':
    case 'g':
      return n * 1024
    case 'tib':
    case 'tb':
    case 't':
      return n * 1024 * 1024
    case 'kib':
    case 'kb':
    case 'k':
      return n / 1024
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

/** Ensure `obj[key]` is a plain object, replacing non-objects, and return it. */
function ensureObj(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const cur = obj[key]
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    return cur as Record<string, unknown>
  }
  const next: Record<string, unknown> = {}
  obj[key] = next
  return next
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

/** Convert a Partition[] back into the CoreV1 start/end representation. */
function partitionsToYaml(
  parts: Partition[],
  diskMiB: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let cursor = 0
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

export function applyOverrides(draft: InteractiveDraft): string {
  // Deep-clone so callers can keep using the original baseDoc — YAML.stringify
  // is fine with either mutated or fresh objects, but leaving baseDoc alone
  // means subsequent applyOverrides calls remain idempotent.
  const doc: Record<string, unknown> =
    draft.baseDoc && typeof draft.baseDoc === 'object' && !Array.isArray(draft.baseDoc)
      ? (deepClone(draft.baseDoc) as Record<string, unknown>)
      : {}

  // image
  const image = ensureObj(doc, 'image')
  image.name = draft.imageName
  image.version = draft.imageVersion
  // Drop any leftover PascalCase keys so we emit a clean camelCase document.
  delete image.Name
  delete image.Version

  // target
  const target = ensureObj(doc, 'target')
  target.os = draft.target.os
  target.dist = draft.target.dist
  target.arch = draft.target.arch
  target.imageType = draft.target.imageType
  delete target.OS
  delete target.Os
  delete target.Dist
  delete target.Arch
  delete target.ImageType

  // disk
  const disk = ensureObj(doc, 'disk')
  disk.size = formatGiB(draft.disk.sizeGiB)
  disk.partitionTableType = draft.disk.partitionTableType
  const diskMiB = Math.max(1, Math.round(draft.disk.sizeGiB * 1024))
  disk.partitions = partitionsToYaml(draft.disk.partitions, diskMiB)
  delete disk.Size
  delete disk.PartitionTableType
  delete disk.Partitions

  // systemConfig
  const sysCfg = ensureObj(doc, 'systemConfig')
  // The Name mirrors imageName when unset — matches how templates on disk
  // (which lean on Cocoon's ${...} substitution) are typically authored.
  sysCfg.name =
    asString(sysCfg.name) || asString(sysCfg.Name) || draft.imageName
  if (draft.hostname) sysCfg.hostname = draft.hostname
  delete sysCfg.Name
  delete sysCfg.HostName
  delete sysCfg.Hostname

  const kernel = ensureObj(sysCfg, 'kernel')
  kernel.version = draft.kernel.version
  kernel.cmdline = draft.kernel.cmdline
  kernel.packages = draft.kernel.packages
  kernel.enableExtraModules = draft.kernel.enableExtraModules
  kernel.uki = draft.kernel.uki
  delete kernel.Version
  delete kernel.Cmdline
  delete kernel.Packages
  delete kernel.EnableExtraModules
  delete kernel.Uki
  delete kernel.UKI
  delete sysCfg.Kernel

  sysCfg.packages = draft.packages
  delete sysCfg.Packages

  if (draft.user) {
    sysCfg.users = [singleUserFrom(draft.user)]
  } else if (sysCfg.Users !== undefined && sysCfg.users === undefined) {
    // Preserve PascalCase-only user block by remapping it.
    sysCfg.users = sysCfg.Users
  }
  delete sysCfg.Users

  sysCfg.configurations = draft.inheritedConfigurations
  delete sysCfg.Configurations

  // packageRepositories at the top level.
  doc.packageRepositories = draft.inheritedRepositories
  delete doc.PackageRepositories

  return YAML.stringify(doc)
}
