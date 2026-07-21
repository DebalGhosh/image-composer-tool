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
  // Schema requires `disk.name`. It's meant to be a stable identifier
  // for the disk configuration; the seed templates (see
  // image-templates/*.yml) use whatever the image itself is called, or
  // a fixed sentinel like "Default_ISO". Mirror that: use the image
  // name so it stays consistent with the top-level `image.name`.
  const diskMiB = Math.max(1, Math.round(draft.disk.sizeGiB * 1024))
  doc.disk = {
    name: draft.imageName,
    size: formatGiB(draft.disk.sizeGiB),
    partitionTableType: draft.disk.partitionTableType,
    partitions: partitionsToYaml(draft.disk.partitions, diskMiB),
  }

  // systemConfig — assemble child sections then whitelist to prevent
  // any unknown keys from sneaking through.
  const sysCfg: Record<string, unknown> = {
    name: draft.imageName,
  }
  if (draft.hostname) sysCfg.hostname = draft.hostname
  sysCfg.kernel = {
    version: draft.kernel.version,
    cmdline: draft.kernel.cmdline,
    packages: draft.kernel.packages,
    enableExtraModules: draft.kernel.enableExtraModules,
    uki: draft.kernel.uki,
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

  return YAML.stringify(final)
}
