import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  Combobox,
  type ComboboxItem,
} from './Combobox'
import {
  TextInput,
  fieldLabelClass,
  fieldLabelStyle,
} from './Select'
import { Collapsible } from './Collapsible'

/* ------------------------------------------------------------------------- *
 * Types & role presets
 * ------------------------------------------------------------------------- */

/**
 * Architectures we know how to map onto `linux-root-<arch>` GPT partition
 * types. Anything not in this table (armv7hl, etc.) falls back to plain
 * `linux` with no typeUUID — safe default, ICT builds still succeed.
 */
export type Arch = 'x86_64' | 'aarch64' | 'armv7hl'

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
  fillRemaining?: boolean
  type: string
  fsType: string
  fsLabel?: string
  mountPoint: string
  mountOptions?: string
  flags: string[]
  typeUUID?: string
}

/** Fixed defaults + guardrails per known role. */
interface RolePreset {
  label: string
  id: string
  name: string
  defaultSizeMiB: number
  /** UI slider floor. Ignored when the role has fillRemaining set. */
  minMiB: number
  /** UI slider ceiling. Roles with `null` accept any size up to disk. */
  maxMiB: number | null
  /** True when the widget should offer "Fill remaining" as an option. */
  supportsFill: boolean
  type: string
  fsType: string
  mountPoint: string
  flags: string[]
  typeUUID?: string
  /** Diagnostic swatch on the visual bar and role chip. */
  color: string
  /** Emoji-free glyph SVG name. */
  glyph: string
}

// GPT partition type UUIDs from
//   https://uapi-group.org/specifications/specs/discoverable_partitions_specification/
const UUID_ESP = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'
const UUID_BIOS_BOOT = '21686148-6449-6e6f-744e-656564454649'
const UUID_SWAP = '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f'
const UUID_ROOT_AMD64 = '4f68bce3-e8cd-4db1-96e7-fbcaf984b709'
const UUID_ROOT_ARM64 = 'b921b045-1df0-41c3-af44-4c6f280d3fae'

/** Per-role visual + default table. */
const ROLE_PRESETS: Record<Exclude<PartitionRole, 'custom'>, RolePreset> = {
  efi: {
    label: 'EFI',
    id: 'efi',
    name: 'EFI System',
    defaultSizeMiB: 100,
    minMiB: 100,
    maxMiB: 1024,
    supportsFill: false,
    type: 'esp',
    fsType: 'fat32',
    mountPoint: '/boot/efi',
    flags: ['esp', 'boot'],
    typeUUID: UUID_ESP,
    color: '#f59e0b',
    glyph: 'efi',
  },
  'bios-boot': {
    label: 'BIOS-Boot',
    id: 'bios-boot',
    name: 'BIOS Boot',
    defaultSizeMiB: 5,
    minMiB: 1,
    maxMiB: 5,
    supportsFill: false,
    type: 'bios-boot',
    fsType: '',
    mountPoint: 'none',
    flags: ['bios_grub'],
    typeUUID: UUID_BIOS_BOOT,
    color: '#ea580c',
    glyph: 'bios',
  },
  swap: {
    label: 'Swap',
    id: 'swap',
    name: 'Swap',
    defaultSizeMiB: 2048,
    minMiB: 512,
    maxMiB: 8192,
    supportsFill: false,
    type: 'linux-swap',
    fsType: 'linux-swap',
    mountPoint: 'none',
    flags: [],
    typeUUID: UUID_SWAP,
    color: '#8b5cf6',
    glyph: 'swap',
  },
  root: {
    label: 'Root',
    id: 'root',
    name: 'Root',
    defaultSizeMiB: 4096,
    minMiB: 1024,
    maxMiB: null,
    supportsFill: true,
    type: 'linux-root-amd64', // rewritten by rootTypeFor(arch) on add
    fsType: 'ext4',
    mountPoint: '/',
    flags: [],
    typeUUID: UUID_ROOT_AMD64,
    color: '#2563eb',
    glyph: 'root',
  },
  verity: {
    label: 'Verity',
    id: 'verity',
    name: 'Verity',
    defaultSizeMiB: 500,
    minMiB: 500,
    maxMiB: 500,
    supportsFill: false,
    type: 'linux',
    fsType: 'ext4',
    mountPoint: 'none',
    flags: [],
    color: '#0d9488',
    glyph: 'verity',
  },
  userdata: {
    label: 'Userdata',
    id: 'userdata',
    name: 'User Data',
    defaultSizeMiB: 1024,
    minMiB: 256,
    maxMiB: null,
    supportsFill: true,
    type: 'linux',
    fsType: 'ext4',
    mountPoint: '/opt',
    flags: [],
    color: '#16a34a',
    glyph: 'userdata',
  },
}

const CUSTOM_COLOR = '#64748b' // slate

/**
 * Filesystem picker options — the intersection of what ICT + osbuild accept.
 * We keep the raw select-value equal to the ICT string; the label is UI-only.
 */
const FS_TYPE_OPTIONS: ComboboxItem[] = [
  { value: '', label: '(none)' },
  { value: 'ext4', label: 'ext4' },
  { value: 'xfs', label: 'xfs' },
  { value: 'btrfs', label: 'btrfs' },
  { value: 'fat32', label: 'fat32 (vfat)' },
  { value: 'linux-swap', label: 'linux-swap' },
]

const MOUNT_POINT_PRESETS: ComboboxItem[] = [
  { value: 'none', label: '(unmounted)' },
  { value: '/', label: '/  (root)' },
  { value: '/boot', label: '/boot' },
  { value: '/boot/efi', label: '/boot/efi' },
  { value: '/home', label: '/home' },
  { value: '/opt', label: '/opt' },
  { value: '/var', label: '/var' },
  { value: '/tmp', label: '/tmp' },
  { value: '__other__', label: 'Other…' },
]

/** GPT flags the UI offers as one-click chips; free-form is not supported. */
const FLAG_CHOICES = ['boot', 'esp', 'bios_grub', 'legacy_boot', 'hidden']

/* ------------------------------------------------------------------------- *
 * Arch → root type + UUID
 * ------------------------------------------------------------------------- */

function rootTypeFor(arch: Arch): { type: string; typeUUID: string | undefined } {
  if (arch === 'x86_64') {
    return { type: 'linux-root-amd64', typeUUID: UUID_ROOT_AMD64 }
  }
  if (arch === 'aarch64') {
    return { type: 'linux-root-arm64', typeUUID: UUID_ROOT_ARM64 }
  }
  // armv7hl / other — no standard type UUID in the discoverable-partitions spec;
  // fall back to `linux`, which osbuild accepts.
  return { type: 'linux', typeUUID: undefined }
}

/* ------------------------------------------------------------------------- *
 * Public component
 * ------------------------------------------------------------------------- */

export interface SegmentedPartitionEditorProps {
  value: Partition[]
  diskSizeGiB: number
  arch: Arch
  partitionTableType: 'gpt' | 'mbr'
  onChange: (parts: Partition[]) => void
}

export function SegmentedPartitionEditor({
  value,
  diskSizeGiB,
  arch,
  partitionTableType,
  onChange,
}: SegmentedPartitionEditorProps) {
  const diskMiB = Math.max(1, Math.round(diskSizeGiB * 1024))

  /* ---------- Sum-of-sizes & over-allocation banner ---------- */
  const { usedMiB, overMiB, hasFill } = useMemo(() => {
    let used = 0
    let fill = false
    for (const p of value) {
      if (p.fillRemaining) fill = true
      else used += Math.max(0, p.sizeMiB)
    }
    return {
      usedMiB: used,
      overMiB: Math.max(0, used - diskMiB),
      hasFill: fill,
    }
  }, [value, diskMiB])

  /* ---------- Fill-remaining bookkeeping ----------
   * The last partition may set fillRemaining=true; its rendered size on the
   * bar equals diskMiB - sum(others). If diskMiB < sum(others), rendered
   * width clamps to 0 and the over-allocation banner takes over.
   */
  const fillRemainingMiB = Math.max(0, diskMiB - usedMiB)

  /** Compute the size a partition should render on the bar. */
  const renderMiBOf = (p: Partition) =>
    p.fillRemaining ? fillRemainingMiB : Math.max(0, p.sizeMiB)

  /* ---------- Add / delete / mutate helpers ---------- */

  const disabledRoles = useMemo(() => {
    const s = new Set<PartitionRole>()
    if (partitionTableType === 'mbr' && value.length >= 4) {
      // MBR primary limit — beyond this the widget refuses new appends.
      // (The user can still delete a row and try a different role.)
      ;(['efi', 'bios-boot', 'swap', 'root', 'verity', 'userdata', 'custom'] as PartitionRole[]).forEach(
        (r) => s.add(r),
      )
    }
    if (value.some((p) => p.role === 'efi')) s.add('efi')
    if (value.some((p) => p.role === 'bios-boot')) s.add('bios-boot')
    return s
  }, [value, partitionTableType])

  /** Assign an id that doesn't collide with an existing partition. */
  const uniqueId = useCallback(
    (base: string): string => {
      const taken = new Set(value.map((p) => p.id))
      if (!taken.has(base)) return base
      for (let i = 2; i < 999; i++) {
        const candidate = `${base}${i}`
        if (!taken.has(candidate)) return candidate
      }
      return base + Date.now().toString(36)
    },
    [value],
  )

  const addPartition = (role: PartitionRole) => {
    let next: Partition
    if (role === 'custom') {
      next = {
        id: uniqueId('part'),
        name: 'Custom partition',
        role: 'custom',
        sizeMiB: 1024,
        type: 'linux',
        fsType: 'ext4',
        mountPoint: 'none',
        flags: [],
      }
    } else {
      const preset = ROLE_PRESETS[role]
      // Root partitions rewrite type/typeUUID from the arch on every add.
      const rootArchOverride =
        role === 'root' ? rootTypeFor(arch) : null
      next = {
        id: uniqueId(preset.id),
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
      if (value.length === 0 && preset.supportsFill) {
        next.fillRemaining = true
      }
    }

    // Preserve invariant: only the LAST partition can have fillRemaining=true.
    // If an existing partition had it and we're appending after it, clear its
    // flag so the new partition becomes the fill target (or none is).
    const cleaned = value.map((p, i) =>
      i === value.length - 1 && p.fillRemaining ? { ...p, fillRemaining: false } : p,
    )
    onChange([...cleaned, next])
  }

  const removeAt = (idx: number) => {
    const next = value.filter((_, i) => i !== idx)
    onChange(next)
  }

  const updateAt = (idx: number, patch: Partial<Partition>) => {
    const next = value.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    onChange(next)
  }

  const swap = (a: number, b: number) => {
    if (a < 0 || b < 0 || a >= value.length || b >= value.length) return
    const next = value.slice()
    const tmp = next[a]
    next[a] = next[b]
    next[b] = tmp
    // Invariant repair: only the (new) last partition may keep fillRemaining.
    for (let i = 0; i < next.length - 1; i++) {
      if (next[i].fillRemaining) next[i] = { ...next[i], fillRemaining: false }
    }
    onChange(next)
  }

  /** Toggle fillRemaining on a partition (only allowed on the last row). */
  const setFillRemaining = (idx: number, on: boolean) => {
    if (idx !== value.length - 1) return
    updateAt(idx, { fillRemaining: on })
  }

  /* ---------- Divider drag ---------- */

  // The bar's DOM node — needed to translate pointer deltas to MiB.
  const barRef = useRef<HTMLDivElement>(null)

  /**
   * Kicks off a drag on the divider between partitions `i` and `i+1`. Left
   * partition takes the delta; right partition absorbs it (or is the fill
   * partition and simply gains/loses width from its computed remainder).
   */
  const beginDividerDrag = (i: number, ev: React.PointerEvent<HTMLDivElement>) => {
    if (!barRef.current) return
    ev.preventDefault()
    const barRect = barRef.current.getBoundingClientRect()
    const startX = ev.clientX
    const leftInitial = value[i].sizeMiB
    const rightInitial = value[i + 1]?.sizeMiB ?? 0
    const rightIsFill = value[i + 1]?.fillRemaining === true
    // Precompute constraints so we don't do it every pointermove tick.
    const leftPreset = presetFor(value[i].role)
    const rightPreset = presetFor(value[i + 1].role)
    const leftMin = leftPreset?.minMiB ?? 1
    const leftMax = leftPreset?.maxMiB ?? diskMiB
    const rightMin = rightPreset?.minMiB ?? 1
    const rightMax = rightPreset?.maxMiB ?? diskMiB
    // Other partitions total (used to bound left when right is fill-remaining
    // so we don't push it below zero).
    let others = 0
    for (let k = 0; k < value.length; k++) {
      if (k === i || k === i + 1) continue
      if (!value[k].fillRemaining) others += value[k].sizeMiB
    }

    // capture pointer so we get moves even outside the bar
    const target = ev.currentTarget
    try {
      target.setPointerCapture(ev.pointerId)
    } catch {
      /* browsers may reject in tests */
    }

    const onMove = (e: PointerEvent) => {
      const pxPerMiB = barRect.width / diskMiB
      const deltaPx = e.clientX - startX
      const deltaMiB = Math.round(deltaPx / pxPerMiB)
      let newLeft = leftInitial + deltaMiB
      let newRight = rightInitial - deltaMiB

      // Clamp left partition to its preset's min/max, snapping to 1 MiB.
      newLeft = clamp(newLeft, leftMin, leftMax)
      // Additionally, cap so we don't over-allocate the disk when adjusting.
      const maxLeftForDisk = rightIsFill
        ? Math.max(leftMin, diskMiB - others - rightMin)
        : diskMiB - (usedMiB - leftInitial - rightInitial) - Math.max(rightMin, 1)
      newLeft = Math.min(newLeft, Math.max(leftMin, maxLeftForDisk))

      if (rightIsFill) {
        // Right just absorbs — we only mutate the left partition; fill width
        // recomputes from remaining bytes on next render.
        updateAt(i, { sizeMiB: newLeft })
        return
      }
      // Right partition takes the equal-and-opposite change, clamped.
      newRight = clamp(rightInitial - (newLeft - leftInitial), rightMin, rightMax)
      // If the right partition can't absorb the full delta, back off left.
      const absorbed = rightInitial - newRight
      const effectiveLeft = leftInitial + absorbed
      // Apply both in one onChange to keep the render stable.
      const next = value.map((p, k) => {
        if (k === i) return { ...p, sizeMiB: effectiveLeft }
        if (k === i + 1) return { ...p, sizeMiB: newRight }
        return p
      })
      onChange(next)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /* ---------- Arch drift: keep root type/typeUUID in sync ---------- */
  const lastArch = useRef(arch)
  useEffect(() => {
    if (lastArch.current === arch) return
    lastArch.current = arch
    let dirty = false
    const next = value.map((p) => {
      if (p.role !== 'root') return p
      const ov = rootTypeFor(arch)
      if (p.type === ov.type && p.typeUUID === ov.typeUUID) return p
      dirty = true
      return { ...p, type: ov.type, typeUUID: ov.typeUUID }
    })
    if (dirty) onChange(next)
  }, [arch, value, onChange])

  /* ---------- FLIP animation on reorder ----------
   *
   * When a partition swaps places (via the up/down buttons), we want the
   * rows to slide to their new positions rather than snap. Classic FLIP:
   *
   *   1. Before the value change, capture each row's top offset by id.
   *   2. React commits the reorder — DOM nodes stay put (we key by id),
   *      only their DOM order changes so they naturally paint at the new
   *      positions.
   *   3. In useLayoutEffect (after DOM update, before paint), read each
   *      row's new offset and set `transform: translateY(oldTop - newTop)`
   *      inline. That places each row visually where it USED to be.
   *   4. Force a reflow, then clear the transform on the same frame with
   *      a CSS transition — rows glide from old→new.
   *
   * Rows carry `background: var(--section-background)` so they're
   * opaque during the transition; the parent stacking context is a plain
   * flex column so overlapping mid-animation rows stack cleanly by DOM
   * order (later rows paint on top). No transparency, no ghosting.
   */
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // Positions captured synchronously in the user-triggered move handler,
  // consumed by the useLayoutEffect right after React commits the swap.
  // Only populated when a move is genuinely requested — so the FLIP loop
  // below never runs for renders triggered by, e.g., typing a partition
  // size, resizing the disk slider, or the Card's expand animation.
  const pendingFlipRef = useRef<Map<string, number> | null>(null)

  const currentIds = value.map((p) => p.id)

  /**
   * Wrap `swap(...)` so we snapshot every row's current DOM top RIGHT
   * BEFORE the state update. This is the classic React FLIP pattern:
   * capture "First" positions from the DOM as it stands, dispatch the
   * state change, then in useLayoutEffect apply `translateY(dy)` +
   * transition-back-to-zero using the captured baseline.
   *
   * Doing the capture here instead of in a mount-time effect avoids
   * every source of baseline contamination we hit earlier: the Card's
   * initial expand animation, transforms applied by a previous FLIP,
   * viewport resizes, panel drags — none of them touch pendingFlipRef.
   * Only a real click captures, so only a real click animates.
   */
  const swapWithFlip = (a: number, b: number) => {
    const snap = new Map<string, number>()
    for (const id of currentIds) {
      const el = rowRefs.current[id]
      if (el) snap.set(id, el.getBoundingClientRect().top)
    }
    pendingFlipRef.current = snap
    swap(a, b)
  }

  useLayoutEffect(() => {
    const oldOffsets = pendingFlipRef.current
    // If there's no pending FLIP request, this render was triggered by
    // something OTHER than a user-clicked reorder (typing, size drag,
    // add/remove partition, Card expand tail). Do nothing.
    if (!oldOffsets) return
    pendingFlipRef.current = null

    // 1 px threshold filters subpixel reflow jitter — non-moving rows
    // can shift 0.6-0.9 px between renders due to font-metric rounding.
    const MIN_DELTA = 1
    for (const [id, oldTop] of oldOffsets) {
      const el = rowRefs.current[id]
      if (!el) continue
      const newTop = el.getBoundingClientRect().top
      const dy = oldTop - newTop
      if (Math.abs(dy) < MIN_DELTA) continue
      el.style.transition = 'none'
      el.style.transform = `translateY(${dy}px)`
      // Force a synchronous style flush so the browser paints the
      // first-frame transform before we schedule the transition.
      void el.offsetHeight
      el.style.transition =
        'transform 260ms cubic-bezier(0.22, 0.7, 0.32, 1)'
      el.style.transform = 'translateY(0)'
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIds.join('|')])

  /* ---------- Rendering ---------- */

  return (
    <div className="flex flex-col gap-4">
      <RolePicker
        onAdd={addPartition}
        disabled={disabledRoles}
        mbrLimit={partitionTableType === 'mbr' && value.length >= 4}
      />

      {overMiB > 0 && (
        <div
          role="alert"
          className="rounded-md border px-3 py-2 text-sm font-medium"
          style={{
            background:
              'color-mix(in srgb, var(--danger) 12%, var(--section-background))',
            borderColor:
              'color-mix(in srgb, var(--danger) 50%, transparent)',
            color: 'var(--danger-fg, var(--danger))',
          }}
        >
          Over-allocated by {overMiB.toLocaleString()} MiB — shrink a partition
          or grow the disk.
        </div>
      )}

      <DiskBar
        ref={barRef}
        parts={value}
        diskMiB={diskMiB}
        renderMiBOf={renderMiBOf}
        onDividerDown={beginDividerDrag}
        hasFill={hasFill}
      />

      <div ref={listRef} className="flex flex-col gap-3">
        {value.map((p, idx) => (
          // Key by partition id ONLY (not id+idx) so React reconciles by
          // identity across reorders — rows keep their DOM nodes across a
          // swap, which is what makes the FLIP animation below possible.
          // The ref-wrapping div lets us measure each row's position
          // before and after `value` changes and animate the delta.
          <div
            key={p.id}
            ref={(el) => {
              rowRefs.current[p.id] = el
            }}
            style={{
              // Solid background so mid-animation rows never render as
              // see-through over their sibling. Deliberately no
              // `willChange: transform` here — promoting every row to
              // its own compositor layer introduced subpixel drift that
              // tripped the FLIP delta threshold on rows that weren't
              // supposed to move.
              background: 'var(--section-background)',
              borderRadius: 8,
            }}
          >
            <PartitionRow
              index={idx}
              partition={p}
              isLast={idx === value.length - 1}
              diskMiB={diskMiB}
              usedByOthersMiB={usedMiB - (p.fillRemaining ? 0 : p.sizeMiB)}
              onChange={(patch) => updateAt(idx, patch)}
              onDelete={() => removeAt(idx)}
              onMoveUp={idx > 0 ? () => swapWithFlip(idx, idx - 1) : undefined}
              onMoveDown={
                idx < value.length - 1
                  ? () => swapWithFlip(idx, idx + 1)
                  : undefined
              }
              onToggleFill={(on) => setFillRemaining(idx, on)}
            />
          </div>
        ))}
      </div>

      <style>{`
        .segpart-stripe {
          background-image: repeating-linear-gradient(
            135deg,
            transparent 0px, transparent 6px,
            rgba(255,255,255,0.14) 6px, rgba(255,255,255,0.14) 12px
          );
        }
        .segpart-divider {
          position: absolute;
          top: 0; bottom: 0;
          width: 8px;
          margin-left: -4px;
          cursor: ew-resize;
          touch-action: none;
          z-index: 2;
        }
        .segpart-divider::before {
          content: '';
          position: absolute;
          left: 3px; top: 8px; bottom: 8px;
          width: 2px;
          background: rgba(255,255,255,0.55);
          border-radius: 1px;
          transition: background 140ms ease, box-shadow 140ms ease;
        }
        .segpart-divider:hover::before,
        .segpart-divider:focus-visible::before {
          background: rgba(255,255,255,0.95);
          box-shadow: 0 0 0 2px var(--classic-blue);
        }
      `}</style>
    </div>
  )
}

/* ------------------------------------------------------------------------- *
 * Sub-components
 * ------------------------------------------------------------------------- */

function RolePicker({
  onAdd,
  disabled,
  mbrLimit,
}: {
  onAdd: (r: PartitionRole) => void
  disabled: Set<PartitionRole>
  mbrLimit: boolean
}) {
  const roles: PartitionRole[] = [
    'efi',
    'bios-boot',
    'swap',
    'root',
    'verity',
    'userdata',
    'custom',
  ]
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className="mr-1 text-sm font-semibold"
        style={{ color: 'var(--title-text)' }}
      >
        + Add partition:
      </span>
      {roles.map((r) => {
        const preset = r === 'custom' ? null : ROLE_PRESETS[r]
        const color = preset?.color ?? CUSTOM_COLOR
        const isDisabled = disabled.has(r)
        const title =
          mbrLimit && isDisabled
            ? 'MBR only supports 4 primary partitions'
            : isDisabled
              ? `Only one ${r === 'efi' ? 'EFI' : 'BIOS-Boot'} partition allowed`
              : `Add a ${preset?.label ?? 'Custom'} partition`
        return (
          <button
            key={r}
            type="button"
            disabled={isDisabled}
            onClick={() => onAdd(r)}
            title={title}
            className="group inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--classic-blue)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: isDisabled
                ? 'var(--input-background)'
                : `color-mix(in srgb, ${color} 12%, var(--section-background))`,
              borderColor: `color-mix(in srgb, ${color} 55%, var(--border-color))`,
              color: 'var(--font-color)',
            }}
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: color }}
            />
            {preset?.label ?? 'Custom'}
          </button>
        )
      })}
    </div>
  )
}

interface DiskBarProps {
  parts: Partition[]
  diskMiB: number
  renderMiBOf: (p: Partition) => number
  onDividerDown: (i: number, ev: React.PointerEvent<HTMLDivElement>) => void
  hasFill: boolean
}

const DiskBar = ({
  parts,
  diskMiB,
  renderMiBOf,
  onDividerDown,
  hasFill,
  ref,
}: DiskBarProps & { ref: React.RefObject<HTMLDivElement | null> }) => {
  // Cumulative positions in %, used both for the segment left/width and to
  // place each divider handle at the boundary.
  const positions = useMemo(() => {
    const pcts: number[] = []
    let cursor = 0
    for (const p of parts) {
      const miB = renderMiBOf(p)
      pcts.push(cursor)
      cursor += Math.max(0, miB)
    }
    pcts.push(cursor)
    return pcts.map((c) => (c / diskMiB) * 100)
  }, [parts, diskMiB, renderMiBOf])

  if (parts.length === 0) {
    return (
      <div
        className="relative w-full rounded-md border text-xs"
        style={{
          height: 72,
          borderColor: 'var(--border-color)',
          background: 'var(--input-background)',
          color: 'var(--muted-color)',
        }}
      >
        <div className="absolute inset-0 flex items-center justify-center">
          Empty disk — add a partition above.
        </div>
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className="relative w-full overflow-hidden rounded-md border"
      style={{
        height: 72,
        borderColor: 'var(--border-color)',
        background: 'var(--input-background)',
      }}
      aria-label={`Disk map, ${parts.length} partitions${hasFill ? ' (last fills remaining)' : ''}`}
    >
      {parts.map((p, i) => {
        const leftPct = positions[i]
        const widthPct = Math.max(0, positions[i + 1] - positions[i])
        const preset = presetFor(p.role)
        const color = preset?.color ?? CUSTOM_COLOR
        return (
          <div
            key={p.id + ':' + i}
            className={
              'absolute inset-y-0 flex flex-col justify-center overflow-hidden px-2 text-xs font-semibold text-white ' +
              (p.fillRemaining ? 'segpart-stripe ' : '')
            }
            style={{
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              background: color,
              borderRight:
                i < parts.length - 1
                  ? '1px solid rgba(0,0,0,0.35)'
                  : undefined,
            }}
            title={`${p.name || p.id} — ${formatSize(renderMiBOf(p))}${p.fillRemaining ? ' (fills remaining)' : ''}`}
          >
            <SegmentLabel
              name={p.name || p.id}
              size={renderMiBOf(p)}
              glyph={preset?.glyph ?? 'custom'}
              enoughRoom={widthPct >= 10}
            />
          </div>
        )
      })}
      {/* Dividers */}
      {parts.slice(0, -1).map((_p, i) => (
        <div
          key={'div-' + i}
          className="segpart-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize between partition ${i + 1} and ${i + 2}`}
          style={{ left: `${positions[i + 1]}%` }}
          onPointerDown={(ev) => onDividerDown(i, ev)}
        />
      ))}
    </div>
  )
}

function SegmentLabel({
  name,
  size,
  glyph,
  enoughRoom,
}: {
  name: string
  size: number
  glyph: string
  enoughRoom: boolean
}) {
  if (!enoughRoom) {
    // Segment is too narrow for text — hide the label rather than render an
    // unreadable clipped mess.
    return null
  }
  return (
    <>
      <div className="flex items-center gap-1.5">
        <RoleGlyph name={glyph} />
        <span className="truncate">{name}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] font-normal opacity-90">
        {formatSize(size)}
      </div>
    </>
  )
}

function RoleGlyph({ name }: { name: string }) {
  // Tiny inline SVGs — flat, monochrome-white so they read on the colored
  // segment. Keeping them here avoids adding an icon dep just for six shapes.
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 20 20',
    fill: 'currentColor',
    'aria-hidden': true as const,
  }
  switch (name) {
    case 'efi':
      // "chip" glyph
      return (
        <svg {...common}>
          <rect x="4" y="4" width="12" height="12" rx="1.5" />
          <path d="M2 7h2v1H2zM2 12h2v1H2zM16 7h2v1h-2zM16 12h2v1h-2zM7 2h1v2H7zM12 2h1v2h-1zM7 16h1v2H7zM12 16h1v2h-1z" />
        </svg>
      )
    case 'bios':
      return (
        <svg {...common}>
          <path d="M3 5h14v10H3z" opacity=".4" />
          <path d="M5 8h4v1H5zM5 10h6v1H5zM5 12h3v1H5z" />
        </svg>
      )
    case 'swap':
      return (
        <svg {...common}>
          <path d="M4 6h9l-2-2 1-1 4 4-4 4-1-1 2-2H4zM16 14H7l2 2-1 1-4-4 4-4 1 1-2 2h9z" />
        </svg>
      )
    case 'root':
      return (
        <svg {...common}>
          <path d="M10 2l7 4v8l-7 4-7-4V6z" opacity=".4" />
          <path d="M10 5.5L14.5 8 10 10.5 5.5 8z" />
        </svg>
      )
    case 'verity':
      return (
        <svg {...common}>
          <path d="M10 2l6 3v5c0 4-3 7-6 8-3-1-6-4-6-8V5z" />
        </svg>
      )
    case 'userdata':
      return (
        <svg {...common}>
          <path d="M3 6h6l1 1h7v9H3z" opacity=".5" />
          <path d="M3 6h6l1 1H3z" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="4" />
        </svg>
      )
  }
}

interface PartitionRowProps {
  index: number
  partition: Partition
  isLast: boolean
  diskMiB: number
  usedByOthersMiB: number
  onChange: (patch: Partial<Partition>) => void
  onDelete: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  onToggleFill: (on: boolean) => void
}

function PartitionRow({
  index,
  partition,
  isLast,
  diskMiB,
  usedByOthersMiB,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  onToggleFill,
}: PartitionRowProps) {
  const [expanded, setExpanded] = useState(false)
  const preset = presetFor(partition.role)
  const color = preset?.color ?? CUSTOM_COLOR

  // For the slider, upper bound is min(role.max, diskMiB - usedByOthersMiB).
  const roleMin = preset?.minMiB ?? 1
  const roleMax = preset?.maxMiB ?? diskMiB
  const roomLeft = Math.max(roleMin, diskMiB - usedByOthersMiB)
  const sliderMax = Math.min(roleMax, roomLeft)
  const sliderDisabled = partition.fillRemaining === true

  // Mount point: if the current value isn't one of our presets, we're in
  // "Other…" mode with a free-form text input beside the picker.
  const isPresetMount = MOUNT_POINT_PRESETS.some(
    (o) => o.value === partition.mountPoint && o.value !== '__other__',
  )
  const [otherMode, setOtherMode] = useState<boolean>(!isPresetMount)

  const rowStyle: CSSProperties = {
    background: 'var(--section-background)',
    borderColor: 'var(--border-color)',
    color: 'var(--font-color)',
  }

  return (
    <div className="rounded-lg border p-4" style={rowStyle}>
      {/* Header row: index, role chip, name, reorder, delete */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-xs font-semibold"
          style={{
            background: 'color-mix(in srgb, var(--font-color) 10%, transparent)',
            color: 'var(--font-color)',
          }}
        >
          {index + 1}
        </span>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold"
          style={{
            background: `color-mix(in srgb, ${color} 18%, var(--section-background))`,
            color: 'var(--font-color)',
            border: `1px solid color-mix(in srgb, ${color} 50%, var(--border-color))`,
          }}
        >
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: color }}
          />
          {preset?.label ?? 'Custom'}
        </span>

        <TextInput
          value={partition.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Name (optional)"
          aria-label={`Partition ${index + 1} name`}
          className="!w-auto flex-1 !py-1.5 !text-sm"
        />

        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label="Move up"
            onClick={onMoveUp}
            disabled={!onMoveUp}
          >
            <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden fill="currentColor">
              <path d="M10 5l-5 6h10z" />
            </svg>
          </IconButton>
          <IconButton
            label="Move down"
            onClick={onMoveDown}
            disabled={!onMoveDown}
          >
            <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden fill="currentColor">
              <path d="M10 15l5-6H5z" />
            </svg>
          </IconButton>
          <IconButton
            label={`Delete partition ${index + 1}`}
            onClick={onDelete}
            danger
          >
            <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden fill="currentColor">
              <path d="M7 3h6l1 2h3v2H3V5h3zM5 8h10l-1 9H6z" />
            </svg>
          </IconButton>
        </div>
      </div>

      {/* Main grid: size slider | fsType | mountPoint | flags */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        {/* Size slider */}
        <div>
          <label
            className={fieldLabelClass}
            style={fieldLabelStyle}
            htmlFor={`p-${partition.id}-size`}
          >
            Size
            {sliderDisabled ? (
              <span className="ml-2 font-normal opacity-70">
                (fills remaining)
              </span>
            ) : (
              <EditableSize
                valueMiB={partition.sizeMiB}
                min={roleMin}
                max={sliderMax}
                onChange={(miB) => onChange({ sizeMiB: miB })}
              />
            )}
          </label>
          <input
            id={`p-${partition.id}-size`}
            type="range"
            min={roleMin}
            max={Math.max(roleMin, sliderMax)}
            step={1}
            disabled={sliderDisabled}
            value={Math.min(sliderMax, Math.max(roleMin, partition.sizeMiB))}
            onChange={(e) => onChange({ sizeMiB: Number(e.target.value) })}
            className="w-full accent-[var(--classic-blue)]"
            style={{
              accentColor: 'var(--classic-blue)',
            }}
          />
          <div className="mt-1 flex justify-between text-[11px] opacity-60">
            <span>{formatSize(roleMin)}</span>
            <span>{formatSize(sliderMax)}</span>
          </div>
        </div>

        {/* Filesystem type */}
        <div>
          <label className={fieldLabelClass} style={fieldLabelStyle}>
            Filesystem
          </label>
          <Combobox
            value={partition.fsType}
            items={FS_TYPE_OPTIONS}
            placeholder="—"
            onChange={(v) => onChange({ fsType: v })}
          />
        </div>

        {/* Mount point */}
        <div>
          <label className={fieldLabelClass} style={fieldLabelStyle}>
            Mount point
          </label>
          <Combobox
            value={otherMode ? '__other__' : partition.mountPoint}
            items={MOUNT_POINT_PRESETS}
            placeholder="—"
            onChange={(v) => {
              if (v === '__other__') {
                setOtherMode(true)
                // Keep whatever the user had, or start with a helpful stub.
                if (!partition.mountPoint || partition.mountPoint === 'none') {
                  onChange({ mountPoint: '/mnt/custom' })
                }
              } else {
                setOtherMode(false)
                onChange({ mountPoint: v })
              }
            }}
          />
          {otherMode && (
            <TextInput
              className="mt-2 !text-sm"
              value={partition.mountPoint}
              onChange={(e) => onChange({ mountPoint: e.target.value })}
              placeholder="/mnt/custom"
            />
          )}
        </div>

        {/* Flags */}
        <div>
          <label className={fieldLabelClass} style={fieldLabelStyle}>
            Flags
          </label>
          <FlagChips
            value={partition.flags}
            onChange={(next) => onChange({ flags: next })}
          />
        </div>
      </div>

      {/* Fill-remaining toggle — only offered on the last row. */}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        {isLast && preset?.supportsFill && (
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={partition.fillRemaining === true}
              onChange={(e) => onToggleFill(e.target.checked)}
            />
            <span>Fill remaining disk space</span>
          </label>
        )}
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 text-xs font-semibold hover:underline"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <svg
            viewBox="0 0 20 20"
            width="10"
            height="10"
            aria-hidden
            fill="currentColor"
            style={{
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 180ms ease',
            }}
          >
            <path d="M6 4l8 6-8 6z" />
          </svg>
          Advanced
        </button>
      </div>

      <Collapsible open={expanded} className="mt-3">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className={fieldLabelClass} style={fieldLabelStyle}>
              Filesystem label
            </label>
            <TextInput
              value={partition.fsLabel ?? ''}
              onChange={(e) =>
                onChange({ fsLabel: e.target.value || undefined })
              }
              placeholder="(optional)"
            />
          </div>
          <div>
            <label className={fieldLabelClass} style={fieldLabelStyle}>
              Mount options
            </label>
            <TextInput
              value={partition.mountOptions ?? ''}
              onChange={(e) =>
                onChange({ mountOptions: e.target.value || undefined })
              }
              placeholder="defaults,noatime"
            />
          </div>
          <div>
            <label className={fieldLabelClass} style={fieldLabelStyle}>
              Type UUID
              <span className="ml-1 text-[10px] font-normal opacity-60">
                (derived)
              </span>
            </label>
            <div
              className="rounded-md border px-3 py-2.5 font-mono text-[11px]"
              style={{
                background: 'var(--input-background)',
                borderColor: 'var(--border-color)',
                color: 'var(--muted-color)',
              }}
            >
              {partition.typeUUID ?? '—'}
            </div>
          </div>
        </div>
      </Collapsible>
    </div>
  )
}

function FlagChips({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (flag: string) => {
    const set = new Set(value)
    if (set.has(flag)) set.delete(flag)
    else set.add(flag)
    // Preserve FLAG_CHOICES order so serialized output is stable.
    onChange(FLAG_CHOICES.filter((f) => set.has(f)))
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {FLAG_CHOICES.map((f) => {
        const on = value.includes(f)
        return (
          <button
            key={f}
            type="button"
            onClick={() => toggle(f)}
            className="cursor-pointer rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--classic-blue)]"
            style={{
              background: on
                ? 'color-mix(in srgb, var(--classic-blue) 22%, var(--section-background))'
                : 'var(--input-background)',
              borderColor: on
                ? 'color-mix(in srgb, var(--classic-blue) 60%, var(--border-color))'
                : 'var(--border-color)',
              color: 'var(--font-color)',
            }}
            aria-pressed={on}
          >
            {f}
          </button>
        )
      })}
    </div>
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--classic-blue)] disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: 'var(--input-background)',
        borderColor: 'var(--border-color)',
        color: danger ? 'var(--danger, #b91c1c)' : 'var(--font-color)',
      }}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------------- *
 * Utilities
 * ------------------------------------------------------------------------- */

function clamp(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return Math.min(hi, Math.max(lo, n))
}

function presetFor(role: PartitionRole): RolePreset | null {
  if (role === 'custom') return null
  return ROLE_PRESETS[role]
}

/**
 * Inline editable size label. Renders identically to a passive span
 * (`ml-2 font-normal opacity-70`) but on focus turns into a bare text
 * input — no border, no bg, just a blinking caret — matching the
 * "look the exact same" requirement. Commits on blur / Enter, escapes
 * on Escape, and clamps to [min, max] on commit.
 */
function EditableSize({
  valueMiB,
  min,
  max,
  onChange,
}: {
  valueMiB: number
  min: number
  max: number
  onChange: (miB: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const displayed = formatSize(valueMiB)
  // Keep the draft in lockstep with the value while NOT editing so slider
  // drags always reflect in the field. Once the user focuses, the draft
  // stops tracking so their in-flight edits aren't clobbered by parent
  // re-renders from adjacent slider movement.
  useEffect(() => {
    if (!editing) setDraft(displayed)
  }, [displayed, editing])

  // Debounced push while typing. 400 ms after the last keystroke, if the
  // draft parses cleanly, push a clamped MiB value upstream so the
  // partition bar / YAML preview / other cards update without waiting on
  // Enter / blur. On blur / Enter we do a final canonical commit that
  // rewrites the displayed draft ("4096" → "4 GiB").
  const debounceRef = useRef<number | null>(null)
  const cancelDebounce = () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }
  useEffect(() => cancelDebounce, [])

  const scheduleDebouncedPush = (nextDraft: string) => {
    cancelDebounce()
    debounceRef.current = window.setTimeout(() => {
      const parsed = parseSize(nextDraft)
      if (parsed === null) return
      const clamped = Math.min(max, Math.max(min, parsed))
      if (clamped !== valueMiB) onChange(clamped)
    }, 400)
  }

  const commit = () => {
    cancelDebounce()
    const parsed = parseSize(draft)
    if (parsed !== null) {
      const clamped = Math.min(max, Math.max(min, parsed))
      if (clamped !== valueMiB) onChange(clamped)
      setDraft(formatSize(clamped))
    } else {
      // Roll back an unparseable / empty entry to the last good value.
      setDraft(formatSize(valueMiB))
    }
    setEditing(false)
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="text"
      value={editing ? draft : displayed}
      // Size scales to content so the field visually replaces the span
      // exactly, no wider or narrower.
      size={Math.max(1, (editing ? draft : displayed).length)}
      aria-label={`Size (editable) — currently ${displayed}`}
      // Bare-cursor styling: no border, no bg, no ring. The label's own
      // opacity-70 keeps the color muted-matching-the-original.
      className="ml-2 cursor-text border-0 bg-transparent p-0 text-inherit font-normal opacity-70 outline-none focus:opacity-100"
      onFocus={(e) => {
        setDraft(displayed)
        setEditing(true)
        // Select all so first keystroke replaces the value (matches the
        // slider's numeric-readout affordance in Slider.tsx).
        e.currentTarget.select()
      }}
      onChange={(e) => {
        setDraft(e.target.value)
        scheduleDebouncedPush(e.target.value)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
          inputRef.current?.blur()
        } else if (e.key === 'Escape') {
          cancelDebounce()
          setDraft(displayed)
          setEditing(false)
          inputRef.current?.blur()
        }
      }}
    />
  )
}

/** Compact human-readable size — MiB, GiB, TiB — for labels on the bar and
 *  slider bounds. Uses 1024-based units to match how ICT reports sizes. */
function formatSize(miB: number): string {
  if (miB < 1024) return `${miB} MiB`
  const gib = miB / 1024
  if (gib < 1024) {
    return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GiB`
  }
  return `${(gib / 1024).toFixed(2)} TiB`
}

/**
 * Parse a human-typed size string back to MiB. Accepts:
 *   "100"          → 100 MiB   (bare number defaults to MiB)
 *   "100 MiB"      → 100 MiB
 *   "2G", "2 GiB"  → 2048 MiB
 *   "0.5 TiB"      → 524288 MiB
 * Case-insensitive; trailing "B"/"iB" tolerated (GB and GiB both work).
 * Returns null when the string doesn't parse (caller rolls back to previous
 * value on null).
 */
function parseSize(raw: string): number | null {
  const s = raw.trim().toUpperCase()
  if (!s) return null
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:I?B)?$/.exec(s)
  if (!m) return null
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n) || n < 0) return null
  const unit = m[2]
  // Everything scales to MiB (1024-based). Bare number = MiB. "K" = KiB
  // so 1024 K = 1 MiB → n/1024. G/T = ×1024, ×1024² respectively.
  switch (unit) {
    case '':
    case 'M':
      return Math.round(n)
    case 'K':
      return Math.max(0, Math.round(n / 1024))
    case 'G':
      return Math.round(n * 1024)
    case 'T':
      return Math.round(n * 1024 * 1024)
  }
  return null
}
