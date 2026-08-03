import { describe, it, expect } from 'vitest'
import type { Partition, PartitionRole } from '@/types/partition'
import type { BuildStatus } from '@/types/build'
import type { BuildHistoryStatus } from '@/lib/buildHistory'

/**
 * Contract tests for the shared types extracted in FE-1.
 *
 * Types vanish at runtime, so these use compile-time assertions (a failing one
 * is a `tsc -b` error, which the gate already runs) plus a few runtime checks on
 * the members. The point is to catch the two silent failure modes the
 * de-duplication was done to prevent:
 *
 *   1. `Partition` losing `startOffsetMiB` again. It was absent from the
 *      editor's copy, and dropping it shifted every partition boundary down by
 *      1 MiB on 34 of 59 templates.
 *   2. `BuildStatus` and the PERSISTED `BuildHistoryStatus` drifting apart.
 *      They are separate types on purpose (one is a UI type, one is a
 *      localStorage schema) but they must stay assignable in both directions,
 *      because App.tsx feeds history entries into the header indicator.
 */

/** Compile-time equality: fails `tsc -b` if A and B differ in either direction. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const assertExact = <T extends true>(_: T = true as T) => undefined

describe('Partition', () => {
  it('keeps startOffsetMiB — the field whose absence shifted 34 templates', () => {
    // A Partition literal WITHOUT the field must still typecheck (it is
            // optional), and one WITH it must also typecheck. If a future edit
    // removes the field from the interface, the second object errors.
    const withOffset: Partition = {
      id: 'p1',
      name: 'esp',
      role: 'efi',
      sizeMiB: 512,
      startOffsetMiB: 1,
      type: 'esp',
      fsType: 'vfat',
      mountPoint: '/boot/efi',
      flags: ['boot', 'esp'],
    }
    expect(withOffset.startOffsetMiB).toBe(1)

    const withoutOffset: Partition = {
      id: 'p2',
      name: 'root',
      role: 'root',
      sizeMiB: 4096,
      type: 'linux',
      fsType: 'ext4',
      mountPoint: '/',
      flags: [],
    }
    expect(withoutOffset.startOffsetMiB).toBeUndefined()
  })

  it('names the role union rather than inlining it', () => {
    // store.ts used to inline the seven role strings while the editor exported
    // PartitionRole. Both now reference the same alias.
    const roles: PartitionRole[] = [
      'efi',
      'bios-boot',
      'swap',
      'root',
      'verity',
      'userdata',
      'custom',
    ]
    expect(roles).toHaveLength(7)
    // Pin the exact member set: a preset table is keyed on
    // Exclude<PartitionRole, 'custom'>, so adding a role without a preset is a
    // compile error there — but REMOVING one would silently orphan a preset.
    assertExact<
      Exact<
        PartitionRole,
        'efi' | 'bios-boot' | 'swap' | 'root' | 'verity' | 'userdata' | 'custom'
      >
    >()
  })

  it('re-exports identically from store and from the editor', async () => {
    // Both modules re-export the canonical type so existing importers are
    // unaffected. These are type-only re-exports, so the runtime check is just
    // that importing the modules does not throw.
    const store = await import('@/store')
    const editor = await import('@/features/partitions/SegmentedPartitionEditor')
    expect(store).toBeDefined()
    expect(editor).toBeDefined()
  })
})

describe('BuildStatus', () => {
  it('pins the exact five-member lifecycle', () => {
    assertExact<
      Exact<BuildStatus, 'idle' | 'running' | 'success' | 'failed' | 'cancelled'>
    >()
    const all: BuildStatus[] = ['idle', 'running', 'success', 'failed', 'cancelled']
    expect(new Set(all).size).toBe(5)
  })

  it('stays mutually assignable with the persisted BuildHistoryStatus', () => {
    // Deliberately two types — one UI, one localStorage schema — but App.tsx
    // passes history statuses to the header indicator, so a divergence would be
    // a type error there rather than here. Assert both directions now so the
    // failure surfaces in this file with an explanation instead.
    assertExact<Exact<BuildStatus, BuildHistoryStatus>>()
  })

  it('is NOT the same as BuildView’s internal Status', () => {
    // BuildView has 'cancelling' and no 'idle'. Documented as deliberately
    // separate; this test exists so nobody "finishes the job" by merging them.
    type BuildViewStatus =
      | 'running'
      | 'cancelling'
      | 'cancelled'
      | 'success'
      | 'failed'
    assertExact<Exact<Exact<BuildStatus, BuildViewStatus>, false>>()
  })
})
