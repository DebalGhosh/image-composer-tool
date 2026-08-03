/**
 * Disk geometry for the partition editor: allocation totals, the fill-remaining
 * computation, id assignment and the layout invariants. Pure — no React, no DOM.
 *
 * Extracted from SegmentedPartitionEditor.tsx, where this arithmetic was
 * interleaved with the component's hooks and therefore untestable.
 */
import type { Partition, PartitionRole } from '@/types/partition'
import { ROLE_PRESETS, rootTypeFor, type Arch } from './roles'

/** GiB from the disk slider -> whole MiB, floored at 1 so nothing divides by 0. */
export function diskMiBOf(diskSizeGiB: number): number {
  return Math.max(1, Math.round(diskSizeGiB * 1024))
}

export interface Allocation {
  /** Sum of every FIXED partition's size. Fill-remaining rows are excluded. */
  usedMiB: number
  /** How far past the disk the fixed sizes go. 0 when it fits. */
  overMiB: number
  /** True when some partition claims the remainder. */
  hasFill: boolean
}

/**
 * Total the fixed allocations.
 *
 * A fill-remaining partition contributes NOTHING to `usedMiB` — its width is
 * derived from what is left over, so counting it would double-count the disk.
 * Negative sizes are floored at 0 rather than subtracting from the total.
 */
export function allocationOf(parts: Partition[], diskMiB: number): Allocation {
  let used = 0
  let fill = false
  for (const p of parts) {
    if (p.fillRemaining) fill = true
    else used += Math.max(0, p.sizeMiB)
  }
  return {
    usedMiB: used,
    overMiB: Math.max(0, used - diskMiB),
    hasFill: fill,
  }
}

/**
 * Width the fill-remaining partition should render at.
 *
 * Clamps to 0 when the fixed partitions already exceed the disk — at that point
 * the over-allocation banner is what tells the user, and a negative width would
 * break the bar's flex layout.
 */
export function fillRemainingMiBOf(diskMiB: number, usedMiB: number): number {
  return Math.max(0, diskMiB - usedMiB)
}

/**
 * Size a partition should occupy on the visual bar: its own size, or the
 * remainder when it is the fill partition.
 */
export function renderMiBOf(p: Partition, fillRemainingMiB: number): number {
  return p.fillRemaining ? fillRemainingMiB : Math.max(0, p.sizeMiB)
}

/**
 * An id that does not collide with an existing partition.
 *
 * Tries `base`, then `base2`, `base3`, … The Date.now() tail is an
 * unreachable-in-practice backstop after 998 collisions; it is retained rather
 * than throwing because a duplicate id would break React keys and the FLIP
 * animation's row lookup, which is worse than an ugly id.
 */
export function uniqueId(base: string, parts: Partition[]): string {
  const taken = new Set(parts.map((p) => p.id))
  if (!taken.has(base)) return base
  for (let i = 2; i < 999; i++) {
    const candidate = `${base}${i}`
    if (!taken.has(candidate)) return candidate
  }
  return base + Date.now().toString(36)
}

/**
 * Roles the picker must disable.
 *
 * Two independent rules:
 *   - EFI and BIOS-Boot are single-instance; once present, they are disabled.
 *   - MBR caps primaries at 4, so at that length EVERY role is disabled. The
 *     user can still delete a row and pick differently — this only blocks
 *     appends.
 */
export function disabledRolesOf(
  parts: Partition[],
  partitionTableType: 'gpt' | 'mbr',
): Set<PartitionRole> {
  const s = new Set<PartitionRole>()
  if (partitionTableType === 'mbr' && parts.length >= 4) {
    ;(
      ['efi', 'bios-boot', 'swap', 'root', 'verity', 'userdata', 'custom'] as PartitionRole[]
    ).forEach((r) => s.add(r))
  }
  if (parts.some((p) => p.role === 'efi')) s.add('efi')
  if (parts.some((p) => p.role === 'bios-boot')) s.add('bios-boot')
  return s
}

/**
 * THE LAYOUT INVARIANT: only the LAST partition may claim the remainder.
 *
 * Clears `fillRemaining` on every row except the final one. Called after any
 * operation that can change which row is last (append, reorder) — otherwise two
 * partitions would both compute their width from the same leftover space and the
 * bar would overflow.
 */
export function repairFillInvariant(parts: Partition[]): Partition[] {
  const next = parts.slice()
  for (let i = 0; i < next.length - 1; i++) {
    if (next[i].fillRemaining) next[i] = { ...next[i], fillRemaining: false }
  }
  return next
}

/**
 * Build the partition a given role should add.
 *
 * Pure in (role, existing parts, arch). Two details are load-bearing:
 *
 *   - A `root` partition rewrites type/typeUUID from the ARCH on every add,
 *     because the GPT root type is arch-specific and the preset table can only
 *     carry one of them (it holds amd64).
 *   - A first-and-only fill-capable partition defaults to filling, so adding a
 *     single root to an empty layout claims the whole disk rather than sitting at
 *     its 4 GiB default on a 64 GiB disk.
 */
export function buildPartitionForRole(
  role: PartitionRole,
  parts: Partition[],
  arch: Arch,
): Partition {
  if (role === 'custom') {
    return {
      id: uniqueId('part', parts),
      name: 'Custom partition',
      role: 'custom',
      sizeMiB: 1024,
      type: 'linux',
      fsType: 'ext4',
      mountPoint: 'none',
      flags: [],
    }
  }
  const preset = ROLE_PRESETS[role]
  // Root partitions rewrite type/typeUUID from the arch on every add.
  const rootArchOverride = role === 'root' ? rootTypeFor(arch) : null
  const next: Partition = {
    id: uniqueId(preset.id, parts),
    name: preset.name,
    role,
    sizeMiB: preset.defaultSizeMiB,
    type: rootArchOverride?.type ?? preset.type,
    fsType: preset.fsType,
    mountPoint: preset.mountPoint,
    flags: [...preset.flags],
    typeUUID: rootArchOverride?.typeUUID ?? preset.typeUUID,
  }
  // For a first-and-only fill-supporting partition, default to filling.
  if (parts.length === 0 && preset.supportsFill) {
    next.fillRemaining = true
  }
  return next
}

/**
 * Append a partition, clearing `fillRemaining` on the row that was last.
 *
 * ⚠️ DELIBERATELY NOT `repairFillInvariant([...parts, next])`, and the
 * difference is observable. This clears the flag on the PREVIOUSLY-LAST row
 * only; repairFillInvariant clears it on every non-last row. When the incoming
 * layout already violates the invariant — a mid-list row carrying the flag,
 * which a hand-edited template can produce — the two disagree: this preserves
 * the stray flag, repairFillInvariant would silently strip it.
 *
 * Extracted with the narrower behaviour to keep the append path
 * behaviour-identical. Whether the stray flag SHOULD be repaired here is a
 * separate question from moving the code.
 */
export function appendPartition(parts: Partition[], next: Partition): Partition[] {
  const cleaned = parts.map((p, i) =>
    i === parts.length - 1 && p.fillRemaining ? { ...p, fillRemaining: false } : p,
  )
  return [...cleaned, next]
}

/**
 * Swap two partitions and repair the fill invariant.
 *
 * Out-of-range indices return the input UNCHANGED (not a copy) so callers can
 * cheaply detect the no-op, which is what stops the FLIP animation running for a
 * rejected move.
 */
export function swapPartitions(
  parts: Partition[],
  a: number,
  b: number,
): Partition[] {
  if (a < 0 || b < 0 || a >= parts.length || b >= parts.length) return parts
  const next = parts.slice()
  const tmp = next[a]
  next[a] = next[b]
  next[b] = tmp
  return repairFillInvariant(next)
}
