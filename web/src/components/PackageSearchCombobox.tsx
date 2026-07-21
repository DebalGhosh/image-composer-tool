import { useEffect, useMemo, useRef, useState } from 'react'
import MiniSearch from 'minisearch'
import { api } from '../api/client'
import type { PackageEntry } from '../api/types'
import { MultiCombobox, type MultiComboboxOption } from './MultiCombobox'

/**
 * PackageSearchCombobox — server-hit fuzzy package picker.
 *
 * Wraps MultiCombobox with:
 *   - a debounced 200 ms fetch against /api/v1/packages keyed on (os, arch, q),
 *   - a MiniSearch index over the returned entries so scoring/fuzzy/prefix
 *     matching happens client-side (the server sort is name-only),
 *   - a groupBy heuristic that clusters common OS/kernel/AI packages under
 *     sticky headers,
 *   - a "user-added" escape hatch surfaced when the server has no index yet
 *     for the current OS (so the user can still add a verbatim package name).
 *
 * The parent (InteractivePage) owns the `values[]` list of selected package
 * names and drops this widget into its own Card — this component intentionally
 * renders nothing else besides the banner + MultiCombobox.
 */

export interface PackageSearchComboboxProps {
  values: string[]
  onChange: (values: string[]) => void
  /** Matches Manifest.Targets[].id, e.g. 'ubuntu24', 'ebs12'. */
  os: string
  /** UI-side arch label — normalized to the backend's Debian-style name below. */
  arch: string
  disabled?: boolean
}

// Backend package indices key on Debian-style arch names ('amd64', 'arm64',
// 'armhf'). The rest of the UI speaks the ICT canonical labels ('x86_64',
// 'aarch64', 'armv7hl'); translate here so callers don't have to care.
const ARCH_MAP: Record<string, string> = {
  x86_64: 'amd64',
  aarch64: 'arm64',
  armv7hl: 'armhf',
}

function normalizeArch(arch: string): string {
  return ARCH_MAP[arch] ?? arch
}

// Package name grammar: begins with an alnum, then any of Debian's allowed
// name characters plus a couple of glob metacharacters so users can add
// wildcarded matches (apt-supported via apt install 'foo*'). Kept intentionally
// permissive — the server rejects anything genuinely malformed at build time.
const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+_.:*?[\]-]*$/

// Debounce window before firing a fetch on query/os/arch change. 200 ms is the
// tail of "feels instant" but coalesces bursts from held-down keys.
const DEBOUNCE_MS = 200

// Server cap for the fetch. The list is grouped client-side so ~100 entries is
// plenty to populate every bucket without visibly truncating any.
const SEARCH_LIMIT = 100

// Group buckets. Order matters — first match wins in `groupFor`, and
// MultiCombobox preserves insertion order for headers.
type GroupKey =
  | 'Base'
  | 'Boot & kernel'
  | 'Firmware'
  | 'AI & Media (Intel)'
  | 'ROS 2'
  | 'Other'

// Prefix/exact classifiers per group. Each entry is checked in order; the
// first hit assigns the group. Kept as regex so we can express "starts with"
// and "equals" without a growing chain of if/else.
const GROUP_RULES: Array<{ re: RegExp; group: GroupKey }> = [
  // AI & Media stack first — some Intel packages match the generic "linux-*"
  // rule below (e.g. intel-driver-* provides linux compat shims) so keep this
  // ahead of the boot group.
  {
    re: /^(openvino|intel-oneapi-|libze|libigfx|intel-npu-|intel-driver-|intel-media-|librealsense)/,
    group: 'AI & Media (Intel)',
  },
  { re: /^ros-/, group: 'ROS 2' },
  {
    re: /^(linux-image|linux-headers|grub-|grub2-|systemd-boot|dracut|cryptsetup|efibootmgr)/,
    group: 'Boot & kernel',
  },
  // linux-firmware overlaps both "linux-" and "firmware" — send it to Firmware.
  { re: /^(firmware-|linux-firmware)/, group: 'Firmware' },
  {
    re: /^(ubuntu-|apt$|bash$|sudo$|systemd$|systemd-|openssh-|debconf|debconf-|gnupg$|lsb-release$|software-properties-|debian-)/,
    group: 'Base',
  },
]

function groupFor(name: string): GroupKey {
  for (const rule of GROUP_RULES) if (rule.re.test(name)) return rule.group
  return 'Other'
}

// The MiniSearch document type. We copy every field from PackageEntry we might
// want to display back on the row, plus a stable `id` (== name) so MiniSearch
// dedupes correctly when the server returns two arches or two repositories
// carrying the same package name.
interface PackageDoc extends PackageEntry {
  id: string
}

function toDoc(e: PackageEntry): PackageDoc {
  return { ...e, id: e.name }
}

// Build the description line shown under each option label. Trimmed so long
// upstream descriptions don't overflow the row (MultiCombobox truncates too,
// but truncation on a shorter string looks intentional rather than clipped).
function describe(version: string, description: string): string {
  const desc = (description ?? '').trim()
  if (!desc) return version
  return version + ' — ' + desc
}

export function PackageSearchCombobox({
  values,
  onChange,
  os,
  arch,
  disabled,
}: PackageSearchComboboxProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [entries, setEntries] = useState<PackageEntry[]>([])
  const [indexMissing, setIndexMissing] = useState(false)
  // `loading` isn't rendered directly yet — kept for future spinner wiring so
  // the placeholder reflects "searching…" state without another prop dance.
  const [, setLoading] = useState(false)

  // Ignore stale fetch responses when os/arch/query change faster than the
  // server can answer. Each effect increments the counter and pins the ref
  // value at start-of-fetch; when it comes back, we discard if the ref has
  // moved on. Cheaper than AbortController and works across React strict-mode
  // double-invocation.
  const fetchIdRef = useRef(0)

  useEffect(() => {
    // Fire an immediate fetch when os/arch changes (query change is debounced
    // separately below). Empty q returns the initial listing; the server
    // sorts alphabetically and caps at SEARCH_LIMIT so this doubles as our
    // "does the index exist at all?" probe on mount.
    if (!os) {
      setEntries([])
      setIndexMissing(false)
      return
    }
    const q = searchQuery.trim()
    const id = ++fetchIdRef.current
    setLoading(true)
    // Reset the banner state at the start of each fetch so a stale-true from
    // a previous different-os probe can't linger while the new request is in
    // flight. The response handler below latches the definitive value.
    setIndexMissing(false)
    const handle = window.setTimeout(() => {
      api
        .searchPackages({ os, arch: normalizeArch(arch), q, limit: SEARCH_LIMIT })
        .then((res) => {
          if (id !== fetchIdRef.current) return
          setEntries(res.packages ?? [])
          // Empty-query zero-total is the only reliable signal we have — the
          // /packages endpoint doesn't expose the X-Package-Index-Missing
          // header through jsonFetch. A non-empty query that legitimately
          // returns 0 shouldn't flip the banner (that's just "no matches").
          setIndexMissing(q.length === 0 && (res.total ?? 0) === 0)
          setLoading(false)
        })
        .catch((err) => {
          if (id !== fetchIdRef.current) return
          // Network / server failure — treat as "index is available but this
          // request failed", not "index missing". The user gets an empty list
          // and the console message; a toast would be too loud for keystroke
          // errors on a stale fetch.
          console.warn('[PackageSearchCombobox] search failed:', err)
          setEntries([])
          setIndexMissing(false)
          setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [searchQuery, os, arch])

  // Rebuild the MiniSearch index whenever the server hand-off changes. This
  // is cheap for our SEARCH_LIMIT-sized batches (index build is O(n·tokens)
  // and n <= 100), and avoids the bookkeeping of add/remove diffs.
  const miniSearch = useMemo(() => {
    const ms = new MiniSearch<PackageDoc>({
      fields: ['name', 'description', 'provides'],
      storeFields: [
        'name',
        'version',
        'description',
        'arch',
        'section',
        'repository',
        'type',
        'provides',
      ],
      searchOptions: {
        boost: { name: 3, description: 1, provides: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
      // MiniSearch tokenizes strings by default; provides is an array so give
      // it a hint to flatten it before tokenizing.
      extractField: (doc, fieldName) => {
        const raw = (doc as unknown as Record<string, unknown>)[fieldName]
        if (Array.isArray(raw)) return raw.join(' ')
        return raw == null ? '' : String(raw)
      },
    })
    ms.addAll(entries.map(toDoc))
    return ms
  }, [entries])

  // Compose the option list shown in the menu:
  //   1. If the user has typed >= 2 chars, run the MiniSearch query and
  //      surface only its hits (mapped back to labels/descriptions).
  //   2. Otherwise show every entry the server returned.
  //   3. If the index is missing AND the query looks like a valid package
  //      name, prepend a synthetic "+ Add …" row so the user can drop
  //      something in without a matching index.
  const options = useMemo<MultiComboboxOption[]>(() => {
    const q = searchQuery.trim()
    let base: MultiComboboxOption[]
    if (q.length >= 2 && entries.length > 0) {
      // Preserve the description/version by looking each hit back up on the
      // entries array — MiniSearch returns storeFields, but keying by name
      // means we don't have to double-cast on every field.
      const byName = new Map(entries.map((e) => [e.name, e]))
      base = miniSearch
        .search(q)
        .map((r): MultiComboboxOption | null => {
          const e = byName.get(r.id as string)
          if (!e) return null
          return {
            value: e.name,
            label: e.name,
            description: describe(e.version, e.description),
          }
        })
        .filter((x): x is MultiComboboxOption => x !== null)
    } else {
      base = entries.map((e) => ({
        value: e.name,
        label: e.name,
        description: describe(e.version, e.description),
      }))
    }
    // User-added escape hatch — only when the index is missing (so the user
    // can't rely on the server-side list) and the typed value looks like a
    // real package name. Also suppress when the value is already selected
    // (would show as a duplicate row) or already in `base` (server has it).
    if (
      indexMissing &&
      q.length > 0 &&
      PKG_NAME_RE.test(q) &&
      !values.includes(q) &&
      !base.some((o) => o.value === q)
    ) {
      base = [
        {
          value: q,
          label: '+ Add "' + q + '"',
          description: 'User-added — will be included verbatim',
        },
        ...base,
      ]
    }
    return base
  }, [entries, searchQuery, miniSearch, indexMissing, values])

  // groupBy handler — MultiCombobox invokes this for every option to build
  // sticky headers. We short-circuit user-added rows to 'Other' so the "+ Add"
  // row doesn't spawn its own bucket header.
  const groupBy = (opt: MultiComboboxOption): string => {
    if (opt.label.startsWith('+ Add "')) return 'User-added'
    return groupFor(opt.value)
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Only surface the empty-index banner when we truly have nothing to
          show — a non-empty entries list means the fetch succeeded and the
          user can search normally, so the banner would be actively wrong. */}
      {indexMissing && entries.length === 0 && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{
            background:
              'color-mix(in srgb, var(--warning) 10%, var(--section-background))',
            borderColor:
              'color-mix(in srgb, var(--warning) 55%, transparent)',
            color: 'var(--font-color)',
          }}
          role="status"
        >
          No packages available for os=<code>{os}</code>. The index isn't built
          yet — you can still type a package name to add it manually.
        </div>
      )}
      <MultiCombobox
        ariaLabel="Additional packages"
        values={values}
        onChange={onChange}
        options={options}
        placeholder={
          disabled
            ? 'Select an OS to search packages…'
            : indexMissing
              ? 'Type a package name to add…'
              : 'Search packages…'
        }
        disabled={disabled}
        groupBy={groupBy}
        onSearchChange={setSearchQuery}
        searchValue={searchQuery}
      />
    </div>
  )
}
