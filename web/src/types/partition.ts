/**
 * The canonical Partition model — one source of truth for the disk layout the
 * Interactive tab edits and the YAML serializer emits.
 *
 * WHY THIS FILE EXISTS
 *
 * `Partition` used to be declared TWICE, and the copies differed:
 *
 *   - `store.ts` had `startOffsetMiB?: number`
 *   - `SegmentedPartitionEditor.tsx` did NOT
 *
 * They coexisted only because `InteractivePage` passed the store's partitions
 * to the editor through an `as Partition[]` cast, and the editor mutates rows by
 * spread (`{ ...p, ...patch }`) throughout — so the extra field survived a round
 * trip through a type that did not admit it. Silent, and load-bearing: dropping
 * `startOffsetMiB` shifted every partition boundary down by 1 MiB on 34 of the
 * 59 shipped templates (see .claude/YAML-INTEGRITY.md). Canonicalising on the
 * wider version removes both the divergence and the cast that hid it.
 */

/**
 * Fixed roles a partition can take. Each drives a preset (size guardrails, fs
 * type, mount point, GPT type UUID) in the partitions feature's role table;
 * 'custom' opts out of every preset and lets the user set the fields directly.
 */
export type PartitionRole =
  | 'efi'
  | 'bios-boot'
  | 'swap'
  | 'root'
  | 'verity'
  | 'userdata'
  | 'custom'

export interface Partition {
  /** Stable identifier — auto-populated from role on add; unique per template. */
  id: string
  name: string
  role: PartitionRole
  /** Parsed size in MiB. Ignored (visually) when fillRemaining=true. */
  sizeMiB: number
  /**
   * Absolute start offset of the FIRST partition, in MiB, as written by the
   * source template. Only meaningful on partitions[0]; later partitions are
   * always packed end-to-end from the previous one.
   *
   * Templates conventionally start at 1MiB for alignment
   * (`start: "1MiB"`, `end: "513MiB"`). The draft models partitions by SIZE,
   * so without capturing this the serializer restarted at 0MiB and shifted
   * every boundary down by 1MiB — silently changing the disk layout of 34 of
   * the 59 shipped templates. Stored so an untouched round-trip reproduces the
   * source byte-for-byte.
   */
  startOffsetMiB?: number
  fillRemaining?: boolean
  type: string
  fsType: string
  fsLabel?: string
  mountPoint: string
  mountOptions?: string
  flags: string[]
  typeUUID?: string
}
