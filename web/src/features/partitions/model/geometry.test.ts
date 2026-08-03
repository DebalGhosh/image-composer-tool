import { describe, it, expect } from 'vitest'
import {
  diskMiBOf,
  allocationOf,
  fillRemainingMiBOf,
  renderMiBOf,
  uniqueId,
  disabledRolesOf,
  repairFillInvariant,
  swapPartitions,
  appendPartition,
  buildPartitionForRole,
} from './geometry'
import type { Partition, PartitionRole } from '@/types/partition'

/** Minimal partition factory — only the fields the geometry actually reads. */
function p(over: Partial<Partition> & { id: string }): Partition {
  return {
    name: over.id,
    role: 'custom',
    sizeMiB: 0,
    type: 'linux',
    fsType: 'ext4',
    mountPoint: 'none',
    flags: [],
    ...over,
  }
}

describe('diskMiBOf', () => {
  it('converts GiB to whole MiB', () => {
    expect(diskMiBOf(8)).toBe(8192)
    expect(diskMiBOf(0.5)).toBe(512)
  })

  it('rounds rather than truncates', () => {
    expect(diskMiBOf(1.0005)).toBe(1025) // 1024.512 -> 1025
  })

  it('floors at 1 so nothing downstream divides by zero', () => {
    // The drag handler computes barRect.width / diskMiB.
    expect(diskMiBOf(0)).toBe(1)
    expect(diskMiBOf(-5)).toBe(1)
  })
})

describe('allocationOf', () => {
  it('sums fixed sizes', () => {
    const parts = [p({ id: 'a', sizeMiB: 100 }), p({ id: 'b', sizeMiB: 200 })]
    expect(allocationOf(parts, 8192)).toEqual({
      usedMiB: 300,
      overMiB: 0,
      hasFill: false,
    })
  })

  it('EXCLUDES a fill-remaining partition from the total', () => {
    // Counting it would double-count the disk: its width is derived from what
    // is left after the fixed rows.
    const parts = [
      p({ id: 'a', sizeMiB: 100 }),
      p({ id: 'b', sizeMiB: 9999, fillRemaining: true }),
    ]
    expect(allocationOf(parts, 8192)).toEqual({
      usedMiB: 100,
      overMiB: 0,
      hasFill: true,
    })
  })

  it('reports over-allocation once the fixed rows exceed the disk', () => {
    const parts = [p({ id: 'a', sizeMiB: 9000 })]
    expect(allocationOf(parts, 8192)).toEqual({
      usedMiB: 9000,
      overMiB: 808,
      hasFill: false,
    })
  })

  it('floors negative sizes at 0 instead of subtracting', () => {
    const parts = [p({ id: 'a', sizeMiB: -500 }), p({ id: 'b', sizeMiB: 100 })]
    expect(allocationOf(parts, 8192).usedMiB).toBe(100)
  })

  it('handles an empty layout', () => {
    expect(allocationOf([], 8192)).toEqual({
      usedMiB: 0,
      overMiB: 0,
      hasFill: false,
    })
  })
})

describe('fillRemainingMiBOf', () => {
  it('returns what is left', () => {
    expect(fillRemainingMiBOf(8192, 2192)).toBe(6000)
  })

  it('clamps to 0 when over-allocated rather than going negative', () => {
    // A negative width would break the bar's flex layout; the banner reports
    // the over-allocation instead.
    expect(fillRemainingMiBOf(8192, 9000)).toBe(0)
  })

  it('is 0 when the disk is exactly full', () => {
    expect(fillRemainingMiBOf(8192, 8192)).toBe(0)
  })
})

describe('renderMiBOf', () => {
  it('uses the row size for a fixed partition', () => {
    expect(renderMiBOf(p({ id: 'a', sizeMiB: 512 }), 6000)).toBe(512)
  })

  it('uses the remainder for the fill partition, ignoring its stored size', () => {
    expect(renderMiBOf(p({ id: 'a', sizeMiB: 1, fillRemaining: true }), 6000)).toBe(6000)
  })

  it('floors a negative fixed size at 0', () => {
    expect(renderMiBOf(p({ id: 'a', sizeMiB: -10 }), 6000)).toBe(0)
  })
})

describe('uniqueId', () => {
  it('returns the base when free', () => {
    expect(uniqueId('root', [])).toBe('root')
    expect(uniqueId('root', [p({ id: 'efi' })])).toBe('root')
  })

  it('appends 2, then 3, … on collision', () => {
    expect(uniqueId('root', [p({ id: 'root' })])).toBe('root2')
    expect(uniqueId('root', [p({ id: 'root' }), p({ id: 'root2' })])).toBe('root3')
  })

  it('skips gaps rather than reusing a freed id', () => {
    // 'root2' is taken but 'root3' is free, so it lands on root3 — it does not
    // try to reclaim a deleted middle id.
    expect(uniqueId('root', [p({ id: 'root' }), p({ id: 'root2' })])).toBe('root3')
  })

  it('never returns an id already present', () => {
    const parts = Array.from({ length: 50 }, (_, i) =>
      p({ id: i === 0 ? 'part' : `part${i + 1}` }),
    )
    const id = uniqueId('part', parts)
    expect(parts.map((x) => x.id)).not.toContain(id)
  })
})

describe('disabledRolesOf', () => {
  it('disables nothing for an empty GPT layout', () => {
    expect(disabledRolesOf([], 'gpt').size).toBe(0)
  })

  it('disables efi once one exists — single-instance role', () => {
    const s = disabledRolesOf([p({ id: 'efi', role: 'efi' })], 'gpt')
    expect(s.has('efi')).toBe(true)
    expect(s.has('root')).toBe(false)
  })

  it('disables bios-boot once one exists', () => {
    const s = disabledRolesOf([p({ id: 'bb', role: 'bios-boot' })], 'gpt')
    expect(s.has('bios-boot')).toBe(true)
  })

  it('allows multiple root / userdata / swap / verity / custom rows', () => {
    const parts = [
      p({ id: 'r1', role: 'root' }),
      p({ id: 'r2', role: 'root' }),
      p({ id: 'u1', role: 'userdata' }),
    ]
    const s = disabledRolesOf(parts, 'gpt')
    expect(s.has('root')).toBe(false)
    expect(s.has('userdata')).toBe(false)
  })

  it('disables EVERY role at the MBR 4-primary limit', () => {
    const parts = Array.from({ length: 4 }, (_, i) => p({ id: `p${i}` }))
    const s = disabledRolesOf(parts, 'mbr')
    for (const r of [
      'efi',
      'bios-boot',
      'swap',
      'root',
      'verity',
      'userdata',
      'custom',
    ] as PartitionRole[]) {
      expect(s.has(r), r).toBe(true)
    }
  })

  it('does not apply the 4-primary cap to GPT', () => {
    const parts = Array.from({ length: 6 }, (_, i) => p({ id: `p${i}` }))
    expect(disabledRolesOf(parts, 'gpt').size).toBe(0)
  })

  it('applies the MBR cap at 4, not at 3', () => {
    const three = Array.from({ length: 3 }, (_, i) => p({ id: `p${i}` }))
    expect(disabledRolesOf(three, 'mbr').size).toBe(0)
  })
})

describe('repairFillInvariant', () => {
  it('clears fillRemaining on every row except the last', () => {
    const parts = [
      p({ id: 'a', fillRemaining: true }),
      p({ id: 'b', fillRemaining: true }),
      p({ id: 'c', fillRemaining: true }),
    ]
    const out = repairFillInvariant(parts)
    expect(out.map((x) => x.fillRemaining)).toEqual([false, false, true])
  })

  it('leaves a correct layout untouched in value', () => {
    const parts = [p({ id: 'a' }), p({ id: 'b', fillRemaining: true })]
    expect(repairFillInvariant(parts)).toEqual(parts)
  })

  it('is a no-op for 0 or 1 partitions', () => {
    expect(repairFillInvariant([])).toEqual([])
    const one = [p({ id: 'a', fillRemaining: true })]
    expect(repairFillInvariant(one)).toEqual(one)
  })

  it('does not mutate the input array or its rows', () => {
    const parts = [p({ id: 'a', fillRemaining: true }), p({ id: 'b' })]
    const snapshot = JSON.parse(JSON.stringify(parts))
    repairFillInvariant(parts)
    expect(parts).toEqual(snapshot)
  })
})

describe('buildPartitionForRole', () => {
  it('builds a custom partition with the generic defaults', () => {
    const out = buildPartitionForRole('custom', [], 'x86_64')
    expect(out).toEqual({
      id: 'part',
      name: 'Custom partition',
      role: 'custom',
      sizeMiB: 1024,
      type: 'linux',
      fsType: 'ext4',
      mountPoint: 'none',
      flags: [],
    })
    // Custom is never auto-fill, even as the first partition.
    expect(out.fillRemaining).toBeUndefined()
  })

  it('takes id / name / size / mount from the preset', () => {
    const out = buildPartitionForRole('efi', [], 'x86_64')
    expect(out.id).toBe('efi')
    expect(out.name).toBe('EFI System')
    expect(out.sizeMiB).toBe(100)
    expect(out.mountPoint).toBe('/boot/efi')
    expect(out.fsType).toBe('fat32')
    expect(out.flags).toEqual(['esp', 'boot'])
  })

  it('rewrites a root partition’s type + UUID from the ARCH', () => {
    // The preset table can only carry one root type (amd64), so the arch
    // override is what makes aarch64 correct. Getting this wrong yields an
    // image that builds and then does not boot.
    const amd = buildPartitionForRole('root', [], 'x86_64')
    expect(amd.type).toBe('linux-root-amd64')
    expect(amd.typeUUID).toBe('4f68bce3-e8cd-4db1-96e7-fbcaf984b709')

    const arm = buildPartitionForRole('root', [], 'aarch64')
    expect(arm.type).toBe('linux-root-arm64')
    expect(arm.typeUUID).toBe('b921b045-1df0-41c3-af44-4c6f280d3fae')

    const v7 = buildPartitionForRole('root', [], 'armv7hl')
    expect(v7.type).toBe('linux')
    // ⚠️ LATENT DEFECT, pinned as-is rather than fixed.
    //
    // rootTypeFor('armv7hl') returns { type: 'linux', typeUUID: undefined }, but
    // the builder reads `rootArchOverride?.typeUUID ?? preset.typeUUID`, and `??`
    // treats undefined as "absent" — so the AMD64 UUID from the preset SURVIVES.
    // An armv7 root therefore gets type `linux` paired with an x86_64 root GUID.
    //
    // This predates the refactor (the expression is verbatim from the original)
    // and a refactor diff must not carry behaviour fixes, so the test documents
    // the current output. Reported as follow-up work.
    expect(v7.typeUUID).toBe('4f68bce3-e8cd-4db1-96e7-fbcaf984b709')
  })

  it('does NOT arch-rewrite a non-root role', () => {
    const efiArm = buildPartitionForRole('efi', [], 'aarch64')
    expect(efiArm.type).toBe('esp')
    expect(efiArm.typeUUID).toBe('c12a7328-f81f-11d2-ba4b-00a0c93ec93b')
  })

  it('auto-fills a first-and-only fill-capable partition', () => {
    // Otherwise a lone root sits at its 4 GiB default on a 64 GiB disk.
    expect(buildPartitionForRole('root', [], 'x86_64').fillRemaining).toBe(true)
    expect(buildPartitionForRole('userdata', [], 'x86_64').fillRemaining).toBe(true)
  })

  it('does NOT auto-fill when a partition already exists', () => {
    const existing = [p({ id: 'efi', role: 'efi' })]
    expect(buildPartitionForRole('root', existing, 'x86_64').fillRemaining).toBeUndefined()
  })

  it('does NOT auto-fill a role that cannot fill, even when first', () => {
    for (const role of ['efi', 'bios-boot', 'swap', 'verity'] as PartitionRole[]) {
      expect(buildPartitionForRole(role, [], 'x86_64').fillRemaining, role).toBeUndefined()
    }
  })

  it('assigns a non-colliding id', () => {
    const existing = [p({ id: 'root', role: 'root' })]
    expect(buildPartitionForRole('root', existing, 'x86_64').id).toBe('root2')
  })

  it('copies the preset flags rather than sharing the array', () => {
    // A shared reference would let one partition's flag edit mutate the preset
    // table and leak into every later add.
    const a = buildPartitionForRole('efi', [], 'x86_64')
    a.flags.push('hidden')
    const b = buildPartitionForRole('efi', [], 'x86_64')
    expect(b.flags).toEqual(['esp', 'boot'])
  })
})

describe('appendPartition', () => {
  it('appends to the end', () => {
    const parts = [p({ id: 'a' })]
    expect(appendPartition(parts, p({ id: 'b' })).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('clears fillRemaining on the row that WAS last', () => {
    const parts = [p({ id: 'a' }), p({ id: 'b', fillRemaining: true })]
    const out = appendPartition(parts, p({ id: 'c', fillRemaining: true }))
    expect(out.map((x) => x.fillRemaining)).toEqual([undefined, false, true])
  })

  it('leaves a STRAY mid-list flag alone — narrower than repairFillInvariant', () => {
    // This is the observable difference between the two, and it is deliberate:
    // the append path only ever touched the previously-last row. A hand-edited
    // template with a mid-list flag keeps it here, whereas repairFillInvariant
    // would strip it. Pinned so the two are not "unified" by accident.
    const parts = [p({ id: 'a', fillRemaining: true }), p({ id: 'b' })]
    const out = appendPartition(parts, p({ id: 'c' }))
    expect(out.map((x) => x.fillRemaining)).toEqual([true, undefined, undefined])
    // repairFillInvariant on the same input WOULD clear it:
    expect(repairFillInvariant(out).map((x) => x.fillRemaining)).toEqual([
      false,
      undefined,
      undefined,
    ])
  })

  it('appends to an empty layout', () => {
    expect(appendPartition([], p({ id: 'a' })).map((x) => x.id)).toEqual(['a'])
  })

  it('does not mutate the input', () => {
    const parts = [p({ id: 'a', fillRemaining: true })]
    const snapshot = JSON.parse(JSON.stringify(parts))
    appendPartition(parts, p({ id: 'b' }))
    expect(parts).toEqual(snapshot)
  })
})

describe('swapPartitions', () => {
  it('swaps two rows', () => {
    const parts = [p({ id: 'a' }), p({ id: 'b' }), p({ id: 'c' })]
    expect(swapPartitions(parts, 0, 2).map((x) => x.id)).toEqual(['c', 'b', 'a'])
  })

  it('repairs the fill invariant after the swap', () => {
    // 'b' held fill and moves to index 0, so it must lose the flag.
    const parts = [p({ id: 'a' }), p({ id: 'b', fillRemaining: true })]
    const out = swapPartitions(parts, 0, 1)
    expect(out.map((x) => x.id)).toEqual(['b', 'a'])
    expect(out.map((x) => x.fillRemaining)).toEqual([false, undefined])
  })

  it('returns the SAME array reference for an out-of-range index', () => {
    // Reference identity is the cheap no-op signal that stops the FLIP
    // animation running for a rejected move.
    const parts = [p({ id: 'a' }), p({ id: 'b' })]
    expect(swapPartitions(parts, -1, 0)).toBe(parts)
    expect(swapPartitions(parts, 0, 5)).toBe(parts)
    expect(swapPartitions(parts, 2, 0)).toBe(parts)
  })

  it('does not mutate the input', () => {
    const parts = [p({ id: 'a' }), p({ id: 'b' })]
    const snapshot = JSON.parse(JSON.stringify(parts))
    swapPartitions(parts, 0, 1)
    expect(parts).toEqual(snapshot)
  })
})
