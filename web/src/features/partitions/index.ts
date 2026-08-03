/**
 * partitions — the segmented disk-layout editor.
 *
 * `Arch` travels with the component because the caller must pass it: the
 * root-partition GPT type UUID is arch-dependent.
 */
export { SegmentedPartitionEditor, type Arch } from './SegmentedPartitionEditor'
