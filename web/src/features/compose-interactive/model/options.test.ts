import { describe, it, expect } from 'vitest'
import {
  OS_OPTIONS,
  DIST_BY_OS,
  ARCH_OPTIONS,
  IMAGE_TYPE_OPTIONS,
  KERNEL_VERSIONS_BY_DIST,
  KERNEL_PACKAGES_BY_DIST,
  IMAGE_NAME_RE,
} from './options'

/**
 * These tables are DATA the UI offers and the build engine must accept. A silent
 * change here dispatches a template the CLI rejects minutes later inside the
 * worker container, so each is pinned literally rather than by shape.
 */

describe('OS_OPTIONS', () => {
  it('pins the six provider OsName values exactly', () => {
    // ⚠️ These are `target.os` / provider OsName values, NOT the
    // internal/provider directory names (azl, emt, elxr, rcd). AGENTS.md is
    // explicit that templates use the former.
    expect(OS_OPTIONS.map((o) => o.value)).toEqual([
      'ubuntu',
      'debian',
      'azure-linux',
      'edge-microvisor-toolkit',
      'wind-river-elxr',
      'redhat-compatible-distro',
    ])
  })

  it('never offers a provider DIRECTORY name by mistake', () => {
    const dirNames = ['azl', 'emt', 'elxr', 'rcd', 'debian13', 'ubuntu24']
    for (const v of OS_OPTIONS.map((o) => o.value)) {
      expect(dirNames, v).not.toContain(v)
    }
  })

  it('gives every OS a human label distinct from its value', () => {
    for (const o of OS_OPTIONS) {
      expect(o.label, o.value).toBeTruthy()
    }
    // Only the two whose brand name IS the value would collide; neither does.
    expect(OS_OPTIONS.find((o) => o.value === 'ubuntu')?.label).toBe('Ubuntu')
    expect(OS_OPTIONS.find((o) => o.value === 'azure-linux')?.label).toBe('Azure Linux')
  })
})

describe('DIST_BY_OS', () => {
  it('has an entry for EVERY OS option — an OS with no dists is a dead dropdown', () => {
    for (const o of OS_OPTIONS) {
      expect(DIST_BY_OS[o.value], o.value).toBeDefined()
      expect(DIST_BY_OS[o.value].length, o.value).toBeGreaterThan(0)
    }
  })

  it('has no dists for an OS that is not offered', () => {
    const offered = new Set(OS_OPTIONS.map((o) => o.value))
    for (const k of Object.keys(DIST_BY_OS)) {
      expect(offered, k).toContain(k)
    }
  })

  it('pins the exact dist list per OS', () => {
    expect(DIST_BY_OS.ubuntu.map((d) => d.value)).toEqual(['ubuntu24', 'ubuntu26'])
    expect(DIST_BY_OS.debian.map((d) => d.value)).toEqual(['debian13'])
    expect(DIST_BY_OS['azure-linux'].map((d) => d.value)).toEqual(['azl3'])
    expect(DIST_BY_OS['edge-microvisor-toolkit'].map((d) => d.value)).toEqual(['emt3'])
    expect(DIST_BY_OS['wind-river-elxr'].map((d) => d.value)).toEqual(['elxr12', 'elxr13'])
    expect(DIST_BY_OS['redhat-compatible-distro'].map((d) => d.value)).toEqual(['rcd10'])
  })

  it('uses value === label for dists — they are identifiers, not brand names', () => {
    for (const dists of Object.values(DIST_BY_OS)) {
      for (const d of dists) expect(d.label, d.value).toBe(d.value)
    }
  })

  it('has globally unique dist ids across every OS', () => {
    // A dist appearing under two OSes would make the cascade ambiguous.
    const all = Object.values(DIST_BY_OS).flatMap((ds) => ds.map((d) => d.value))
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('ARCH_OPTIONS', () => {
  it('pins the three architectures', () => {
    expect(ARCH_OPTIONS.map((a) => a.value)).toEqual(['x86_64', 'aarch64', 'armv7hl'])
  })

  it('matches the Arch type the partitions feature exports', () => {
    // The partition editor's rootTypeFor(arch) switches on exactly these; a
    // fourth value here would silently fall through to its `linux` default.
    expect(ARCH_OPTIONS).toHaveLength(3)
  })
})

describe('IMAGE_TYPE_OPTIONS', () => {
  it('pins the four image types the CLI can build', () => {
    // rawmaker / initrdmaker / isomaker / wsl2maker.
    expect(IMAGE_TYPE_OPTIONS.map((t) => t.value)).toEqual(['raw', 'img', 'iso', 'wsl2'])
  })
})

describe('KERNEL_VERSIONS_BY_DIST', () => {
  it('pins the per-dist version presets', () => {
    expect(KERNEL_VERSIONS_BY_DIST.ubuntu24).toEqual(['6.8', '6.11', '6.12', '7.0'])
    expect(KERNEL_VERSIONS_BY_DIST.debian13).toEqual(['6.12'])
    expect(KERNEL_VERSIONS_BY_DIST.azl3).toEqual(['6.6'])
    expect(KERNEL_VERSIONS_BY_DIST.emt3).toEqual(['6.12'])
    expect(KERNEL_VERSIONS_BY_DIST.elxr12).toEqual(['6.1', '6.12'])
    expect(KERNEL_VERSIONS_BY_DIST.rcd10).toEqual(['6.12'])
  })

  it('keys only on dists that DIST_BY_OS actually offers', () => {
    const dists = new Set(
      Object.values(DIST_BY_OS).flatMap((ds) => ds.map((d) => d.value)),
    )
    for (const k of Object.keys(KERNEL_VERSIONS_BY_DIST)) {
      expect(dists, k).toContain(k)
    }
  })

  it('has NO entry for ubuntu26 or elxr13 — absence means "nothing to suggest"', () => {
    // Pinned so nobody "fills the gaps" with invented versions. An absent key is
    // a deliberate empty suggestion list, not an oversight.
    expect(KERNEL_VERSIONS_BY_DIST.ubuntu26).toBeUndefined()
    expect(KERNEL_VERSIONS_BY_DIST.elxr13).toBeUndefined()
  })
})

describe('KERNEL_PACKAGES_BY_DIST', () => {
  it('pins the ubuntu24 package list, including the Intel kernels', () => {
    expect(KERNEL_PACKAGES_BY_DIST.ubuntu24).toEqual([
      'linux-image-generic',
      'linux-headers-generic',
      'linux-image-generic-hwe-24.04',
      'linux-image-6.12-intel',
      'linux-headers-6.12-intel',
    ])
  })

  it('pins debian13 and covers only those two dists', () => {
    expect(KERNEL_PACKAGES_BY_DIST.debian13).toEqual([
      'linux-image-amd64',
      'linux-image-arm64',
    ])
    expect(Object.keys(KERNEL_PACKAGES_BY_DIST).sort()).toEqual(['debian13', 'ubuntu24'])
  })

  it('keys only on offered dists', () => {
    const dists = new Set(
      Object.values(DIST_BY_OS).flatMap((ds) => ds.map((d) => d.value)),
    )
    for (const k of Object.keys(KERNEL_PACKAGES_BY_DIST)) {
      expect(dists, k).toContain(k)
    }
  })
})

describe('IMAGE_NAME_RE', () => {
  it('accepts alnum names', () => {
    for (const n of ['a', 'A1', 'myimage', 'image42']) {
      expect(IMAGE_NAME_RE.test(n), n).toBe(true)
    }
  })

  it('accepts hyphens and underscores in the MIDDLE', () => {
    for (const n of ['my-image', 'my_image', 'a-b_c-1', 'debian13-x86_64-desktop']) {
      expect(IMAGE_NAME_RE.test(n), n).toBe(true)
    }
  })

  it('requires the FIRST and LAST character to be alphanumeric', () => {
    for (const n of ['-lead', '_lead', 'trail-', 'trail_', '-both-', '_both_']) {
      expect(IMAGE_NAME_RE.test(n), n).toBe(false)
    }
  })

  it('rejects empty, whitespace, dots and other punctuation', () => {
    for (const n of ['', ' ', 'has space', 'dot.ted', 'sla/sh', 'pl+us', 'col:on', 'a b']) {
      expect(IMAGE_NAME_RE.test(n), n).toBe(false)
    }
  })

  it('accepts a single alnum character — the optional group allows length 1', () => {
    // ^[alnum]([alnum-_]*[alnum])?$ — the whole tail is optional.
    expect(IMAGE_NAME_RE.test('x')).toBe(true)
    expect(IMAGE_NAME_RE.test('7')).toBe(true)
  })

  it('rejects a two-character name that ends in punctuation', () => {
    expect(IMAGE_NAME_RE.test('a-')).toBe(false)
    expect(IMAGE_NAME_RE.test('a_')).toBe(false)
  })

  it('is anchored at both ends', () => {
    expect(IMAGE_NAME_RE.test('good\nbad')).toBe(false)
    expect(IMAGE_NAME_RE.source.startsWith('^')).toBe(true)
    expect(IMAGE_NAME_RE.source.endsWith('$')).toBe(true)
  })

  it('has no global flag, so repeated .test() calls do not drift', () => {
    expect(IMAGE_NAME_RE.flags).not.toContain('g')
    expect(IMAGE_NAME_RE.test('myimage')).toBe(true)
    expect(IMAGE_NAME_RE.test('myimage')).toBe(true)
  })
})
