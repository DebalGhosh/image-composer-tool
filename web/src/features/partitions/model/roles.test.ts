import { describe, it, expect } from 'vitest'
import {
  ROLE_PRESETS,
  CUSTOM_COLOR,
  FS_TYPE_OPTIONS,
  MOUNT_POINT_PRESETS,
  FLAG_CHOICES,
  rootTypeFor,
  presetFor,
  type Arch,
} from './roles'
import type { PartitionRole } from '@/types/partition'

/**
 * Constants that MUST NOT DRIFT.
 *
 * The GPT type UUIDs come from the freedesktop Discoverable Partitions
 * Specification. A wrong one yields an image that BUILDS SUCCESSFULLY and then
 * fails to boot — invisible to every other gate in this repo, and exactly the
 * class of silent-wrong-image failure that `.claude/YAML-INTEGRITY.md` was
 * written about. So each string is asserted literally rather than by shape.
 */

const UUID_ESP = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'
const UUID_BIOS_BOOT = '21686148-6449-6e6f-744e-656564454649'
const UUID_SWAP = '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f'
const UUID_ROOT_AMD64 = '4f68bce3-e8cd-4db1-96e7-fbcaf984b709'
const UUID_ROOT_ARM64 = 'b921b045-1df0-41c3-af44-4c6f280d3fae'

describe('GPT type UUIDs', () => {
  it('pins every UUID exactly', () => {
    expect(ROLE_PRESETS.efi.typeUUID).toBe(UUID_ESP)
    expect(ROLE_PRESETS['bios-boot'].typeUUID).toBe(UUID_BIOS_BOOT)
    expect(ROLE_PRESETS.swap.typeUUID).toBe(UUID_SWAP)
    expect(ROLE_PRESETS.root.typeUUID).toBe(UUID_ROOT_AMD64)
  })

  it('leaves verity and userdata WITHOUT a typeUUID', () => {
    // Neither has a standard type in the discoverable-partitions spec, so the
    // preset omits it and osbuild falls back to a generic linux type. Asserted
    // so nobody "completes the table" with an invented UUID.
    expect(ROLE_PRESETS.verity.typeUUID).toBeUndefined()
    expect(ROLE_PRESETS.userdata.typeUUID).toBeUndefined()
  })

  it('uses well-formed lowercase UUIDs', () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    for (const u of [UUID_ESP, UUID_BIOS_BOOT, UUID_SWAP, UUID_ROOT_AMD64, UUID_ROOT_ARM64]) {
      expect(u).toMatch(re)
    }
  })
})

describe('rootTypeFor', () => {
  it('maps x86_64 to the amd64 root type + UUID', () => {
    expect(rootTypeFor('x86_64')).toEqual({
      type: 'linux-root-amd64',
      typeUUID: UUID_ROOT_AMD64,
    })
  })

  it('maps aarch64 to the arm64 root type + UUID', () => {
    expect(rootTypeFor('aarch64')).toEqual({
      type: 'linux-root-arm64',
      typeUUID: UUID_ROOT_ARM64,
    })
  })

  it('falls back to plain linux with NO UUID for armv7hl', () => {
    // No standard type in the spec; `linux` is what osbuild accepts. The
    // undefined typeUUID is deliberate — emitting the amd64 one here would
    // produce a mislabelled partition.
    expect(rootTypeFor('armv7hl')).toEqual({ type: 'linux', typeUUID: undefined })
  })

  it('falls back for an unknown arch rather than throwing', () => {
    expect(rootTypeFor('riscv64' as Arch)).toEqual({
      type: 'linux',
      typeUUID: undefined,
    })
  })

  it('never returns the arm64 UUID for an x86 arch, or vice versa', () => {
    // The one substitution that would silently produce an unbootable image.
    expect(rootTypeFor('x86_64').typeUUID).not.toBe(UUID_ROOT_ARM64)
    expect(rootTypeFor('aarch64').typeUUID).not.toBe(UUID_ROOT_AMD64)
  })
})

describe('ROLE_PRESETS', () => {
  it('covers every role except custom', () => {
    expect(Object.keys(ROLE_PRESETS).sort()).toEqual([
      'bios-boot',
      'efi',
      'root',
      'swap',
      'userdata',
      'verity',
    ])
  })

  it('pins the default / min / max sizes that drive the sliders', () => {
    const sizes = Object.fromEntries(
      Object.entries(ROLE_PRESETS).map(([k, v]) => [
        k,
        [v.defaultSizeMiB, v.minMiB, v.maxMiB],
      ]),
    )
    expect(sizes).toEqual({
      efi: [100, 100, 1024],
      'bios-boot': [5, 1, 5],
      swap: [2048, 512, 8192],
      root: [4096, 1024, null],
      verity: [500, 500, 500],
      userdata: [1024, 256, null],
    })
  })

  it('offers Fill remaining only for root and userdata', () => {
    const fillable = Object.entries(ROLE_PRESETS)
      .filter(([, v]) => v.supportsFill)
      .map(([k]) => k)
      .sort()
    expect(fillable).toEqual(['root', 'userdata'])
  })

  it('gives every fill-capable role an unbounded max', () => {
    // A role that can fill must not also carry a ceiling, or the two rules
    // contradict each other when the disk is larger than maxMiB.
    for (const [role, p] of Object.entries(ROLE_PRESETS)) {
      if (p.supportsFill) expect(p.maxMiB, role).toBeNull()
    }
  })

  it('keeps default within [min, max] for every role', () => {
    for (const [role, p] of Object.entries(ROLE_PRESETS)) {
      expect(p.defaultSizeMiB, role).toBeGreaterThanOrEqual(p.minMiB)
      if (p.maxMiB !== null) {
        expect(p.defaultSizeMiB, role).toBeLessThanOrEqual(p.maxMiB)
      }
    }
  })

  it('pins mount points and flags', () => {
    expect(ROLE_PRESETS.efi.mountPoint).toBe('/boot/efi')
    expect(ROLE_PRESETS.efi.flags).toEqual(['esp', 'boot'])
    expect(ROLE_PRESETS['bios-boot'].flags).toEqual(['bios_grub'])
    expect(ROLE_PRESETS.root.mountPoint).toBe('/')
    expect(ROLE_PRESETS.userdata.mountPoint).toBe('/opt')
    // 'none' — not '' and not undefined — is the unmounted sentinel.
    expect(ROLE_PRESETS.swap.mountPoint).toBe('none')
    expect(ROLE_PRESETS.verity.mountPoint).toBe('none')
  })

  it('pins the filesystem types, including bios-boot having none', () => {
    expect(ROLE_PRESETS.efi.fsType).toBe('fat32')
    expect(ROLE_PRESETS.root.fsType).toBe('ext4')
    expect(ROLE_PRESETS.swap.fsType).toBe('linux-swap')
    // BIOS boot is a raw region with no filesystem; '' is meaningful here.
    expect(ROLE_PRESETS['bios-boot'].fsType).toBe('')
  })

  it('gives every role a distinct colour, and custom its own', () => {
    const colors = Object.values(ROLE_PRESETS).map((p) => p.color)
    expect(new Set(colors).size).toBe(colors.length)
    expect(colors).not.toContain(CUSTOM_COLOR)
    expect(CUSTOM_COLOR).toBe('#64748b')
  })

  it('gives every role a glyph name', () => {
    for (const [role, p] of Object.entries(ROLE_PRESETS)) {
      expect(p.glyph, role).toBeTruthy()
    }
  })
})

describe('presetFor', () => {
  it('returns the preset for every non-custom role', () => {
    for (const role of Object.keys(ROLE_PRESETS) as PartitionRole[]) {
      expect(presetFor(role)).toBe(ROLE_PRESETS[role as keyof typeof ROLE_PRESETS])
    }
  })

  it('returns null for custom — the caller must supply its own guardrails', () => {
    expect(presetFor('custom')).toBeNull()
  })
})

describe('option tables', () => {
  it('pins the filesystem picker, including the empty (none) entry', () => {
    expect(FS_TYPE_OPTIONS.map((o) => o.value)).toEqual([
      '',
      'ext4',
      'xfs',
      'btrfs',
      'fat32',
      'linux-swap',
    ])
    // The VALUE must equal the ICT string; only the label is UI-only.
    expect(FS_TYPE_OPTIONS.find((o) => o.value === 'fat32')?.label).toBe('fat32 (vfat)')
  })

  it('pins the mount-point presets and the Other… sentinel', () => {
    expect(MOUNT_POINT_PRESETS.map((o) => o.value)).toEqual([
      'none',
      '/',
      '/boot',
      '/boot/efi',
      '/home',
      '/opt',
      '/var',
      '/tmp',
      '__other__',
    ])
    // '__other__' switches the row to a free-text input; renaming it silently
    // turns the sentinel into a literal mount path.
    expect(MOUNT_POINT_PRESETS.at(-1)?.value).toBe('__other__')
  })

  it('pins the GPT flag chips', () => {
    expect(FLAG_CHOICES).toEqual(['boot', 'esp', 'bios_grub', 'legacy_boot', 'hidden'])
  })

  it('offers every flag any preset uses', () => {
    for (const [role, p] of Object.entries(ROLE_PRESETS)) {
      for (const f of p.flags) expect(FLAG_CHOICES, `${role}:${f}`).toContain(f)
    }
  })

  it('offers every mount point any preset uses', () => {
    const values = MOUNT_POINT_PRESETS.map((o) => o.value)
    for (const [role, p] of Object.entries(ROLE_PRESETS)) {
      expect(values, role).toContain(p.mountPoint)
    }
  })

  it('offers every fsType any preset uses', () => {
    const values = FS_TYPE_OPTIONS.map((o) => o.value)
    for (const [role, p] of Object.entries(ROLE_PRESETS)) {
      expect(values, role).toContain(p.fsType)
    }
  })
})
