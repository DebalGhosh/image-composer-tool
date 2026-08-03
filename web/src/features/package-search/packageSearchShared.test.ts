import { describe, it, expect } from 'vitest'
import {
  ARCH_MAP,
  normalizeArch,
  PKG_NAME_RE,
  DEBOUNCE_MS,
  SEARCH_LIMIT,
  GROUP_RULES,
  groupFor,
  MINISEARCH_OPTIONS,
  type GroupKey,
} from './packageSearchShared'

/**
 * Characterisation tests for packageSearchShared.
 *
 * This module is already the shape the rest of the decomposition is aiming at:
 * pure data + tiny pure functions, no React, extracted precisely so the inline
 * PackageSearchCombobox and the expanded PackageSearchDialog cannot diverge.
 * Phase FE-4 will EXTEND it rather than duplicate it into model/, so pinning it
 * first protects both consumers at once.
 *
 * These assert what the code does TODAY, quirks included. Where a value looks
 * surprising, the surprise is the point — see the ordering and round-trip
 * blocks below.
 */

describe('normalizeArch', () => {
  it('maps the three ICT canonical labels to Debian-style names', () => {
    expect(normalizeArch('x86_64')).toBe('amd64')
    expect(normalizeArch('aarch64')).toBe('arm64')
    expect(normalizeArch('armv7hl')).toBe('armhf')
  })

  it('passes unknown arch through unchanged rather than throwing or defaulting', () => {
    // ?? arch — deliberately permissive so a new arch reaches the backend and
    // fails there with a real message, instead of being silently rewritten.
    expect(normalizeArch('riscv64')).toBe('riscv64')
    expect(normalizeArch('')).toBe('')
  })

  it('is not reflexive on already-Debian names — they are not keys', () => {
    // 'amd64' is a VALUE in ARCH_MAP, not a key, so it falls through the ??.
    // It happens to round-trip correctly, but by pass-through, not by mapping.
    expect(normalizeArch('amd64')).toBe('amd64')
    expect(ARCH_MAP.amd64).toBeUndefined()
  })

  it('has exactly the three documented mappings', () => {
    expect(Object.keys(ARCH_MAP).sort()).toEqual(['aarch64', 'armv7hl', 'x86_64'])
  })
})

describe('PKG_NAME_RE', () => {
  it('accepts ordinary Debian package names', () => {
    for (const n of ['apt', 'linux-image-generic', 'libssl3', 'g++', 'python3.12', 'a']) {
      expect(PKG_NAME_RE.test(n)).toBe(true)
    }
  })

  it('accepts the glob metacharacters that make the "+ Add" escape hatch work', () => {
    // Users add wildcarded matches, e.g. apt install 'ros-jazzy-*'.
    for (const n of ['ros-jazzy-*', 'linux-image-?', 'foo[abc]', 'pkg:amd64']) {
      expect(PKG_NAME_RE.test(n)).toBe(true)
    }
  })

  it('requires an alphanumeric FIRST character', () => {
    // The leading class is [A-Za-z0-9] with no punctuation, so these fail even
    // though the same characters are legal later in the name.
    for (const n of ['-leading-dash', '+plus', '.dot', '_underscore', '*star']) {
      expect(PKG_NAME_RE.test(n)).toBe(false)
    }
  })

  it('rejects empty, whitespace and clearly malformed names', () => {
    for (const n of ['', ' ', 'has space', 'tab\t', 'new\nline', 'paren(s)', 'sla/sh']) {
      expect(PKG_NAME_RE.test(n)).toBe(false)
    }
  })

  it('is anchored at both ends, so a valid substring does not pass', () => {
    expect(PKG_NAME_RE.test('good name')).toBe(false)
    expect(PKG_NAME_RE.test('apt\n')).toBe(false)
  })

  it('has no global flag, so repeated .test() calls do not drift', () => {
    // A /g regex reused across calls carries lastIndex and would alternate
    // true/false on the same input. Guard against someone adding the flag.
    expect(PKG_NAME_RE.flags).not.toContain('g')
    expect(PKG_NAME_RE.test('apt')).toBe(true)
    expect(PKG_NAME_RE.test('apt')).toBe(true)
  })
})

describe('tuning constants', () => {
  it('pins the debounce window and server cap', () => {
    // 200ms is the same beat as LiveYamlPreview and BasicPage's review fetch;
    // SEARCH_LIMIT 100 is chosen to populate every group without truncating.
    expect(DEBOUNCE_MS).toBe(200)
    expect(SEARCH_LIMIT).toBe(100)
  })
})

describe('groupFor', () => {
  it('assigns each documented bucket', () => {
    const expectations: Array<[string, GroupKey]> = [
      ['openvino-runtime', 'AI & Media (Intel)'],
      ['intel-oneapi-mkl', 'AI & Media (Intel)'],
      ['libze-intel-gpu', 'AI & Media (Intel)'],
      ['librealsense2', 'AI & Media (Intel)'],
      ['ros-jazzy-desktop', 'ROS 2'],
      ['linux-image-generic', 'Boot & kernel'],
      ['grub-efi-amd64', 'Boot & kernel'],
      ['systemd-boot', 'Boot & kernel'],
      ['dracut', 'Boot & kernel'],
      ['cryptsetup', 'Boot & kernel'],
      ['efibootmgr', 'Boot & kernel'],
      ['firmware-linux-free', 'Firmware'],
      ['linux-firmware', 'Firmware'],
      ['ubuntu-minimal', 'Base'],
      ['apt', 'Base'],
      ['bash', 'Base'],
      ['sudo', 'Base'],
      ['systemd', 'Base'],
      ['openssh-server', 'Base'],
      ['debconf', 'Base'],
      ['debian-archive-keyring', 'Base'],
    ]
    for (const [name, group] of expectations) {
      expect(groupFor(name), name).toBe(group)
    }
  })

  it('falls back to Other for anything unmatched', () => {
    for (const n of ['vim', 'curl', 'nginx', '']) {
      expect(groupFor(n)).toBe('Other')
    }
  })

  /**
   * RULE ORDER IS LOAD-BEARING. groupFor returns on the FIRST matching rule, so
   * reordering GROUP_RULES silently re-buckets packages. Each case below is a
   * name that matches TWO rules; the assertion pins which one wins.
   */
  describe('first-match-wins ordering', () => {
    it('sends intel-driver-* to AI & Media, not Boot & kernel', () => {
      // The source comment says intel-driver-* provides linux compat shims and
      // would otherwise hit the generic linux-* boot rule.
      expect(groupFor('intel-driver-compute')).toBe('AI & Media (Intel)')
    })

    it('sends linux-firmware to Firmware, not Boot & kernel', () => {
      // 'linux-firmware' does NOT match ^linux-image/^linux-headers, so it
      // reaches the Firmware rule. Pinned because a broadened boot rule
      // (e.g. ^linux-) would silently steal it.
      expect(groupFor('linux-firmware')).toBe('Firmware')
    })

    it('sends systemd-boot to Boot & kernel even though Base has systemd-', () => {
      // Boot & kernel is rule index 2, Base is index 4 — Boot wins.
      expect(groupFor('systemd-boot')).toBe('Boot & kernel')
      // ...while a different systemd- package falls through to Base.
      expect(groupFor('systemd-resolved')).toBe('Base')
    })

    it('keeps AI & Media as the first rule', () => {
      expect(GROUP_RULES[0].group).toBe('AI & Media (Intel)')
    })

    it('pins the exact rule order', () => {
      expect(GROUP_RULES.map((r) => r.group)).toEqual([
        'AI & Media (Intel)',
        'ROS 2',
        'Boot & kernel',
        'Firmware',
        'Base',
      ])
    })
  })

  describe('anchoring and exact-match rules', () => {
    it('anchors every rule at the start, so a mid-name match does not count', () => {
      for (const rule of GROUP_RULES) {
        expect(rule.re.source.startsWith('^')).toBe(true)
      }
      expect(groupFor('my-openvino-fork')).toBe('Other')
      expect(groupFor('not-ros-related')).toBe('Other')
    })

    it('honours the $-anchored exact entries in the Base rule', () => {
      // apt$ / bash$ / sudo$ / systemd$ / gnupg$ / lsb-release$ are exact, so a
      // longer name with the same prefix is NOT Base.
      expect(groupFor('apt')).toBe('Base')
      expect(groupFor('apt-utils')).toBe('Other')
      expect(groupFor('bash')).toBe('Base')
      expect(groupFor('bash-completion')).toBe('Other')
      expect(groupFor('gnupg')).toBe('Base')
      expect(groupFor('gnupg2')).toBe('Other')
    })

    it('treats debconf as a prefix, not exact — both forms are Base', () => {
      // The rule lists both `debconf` and `debconf-`; the bare form is
      // unanchored at the end, so anything starting with it matches.
      expect(groupFor('debconf')).toBe('Base')
      expect(groupFor('debconf-utils')).toBe('Base')
    })
  })

  it('returns a GroupKey for every rule, and Other is not itself a rule', () => {
    const groups = new Set(GROUP_RULES.map((r) => r.group))
    expect(groups.has('Other' as GroupKey)).toBe(false)
  })
})

describe('MINISEARCH_OPTIONS', () => {
  it('pins the searchable fields and their boosts', () => {
    // Both surfaces reindex each server response with these options so relative
    // ordering agrees. A change here reorders results in one surface only if
    // the other stops sharing this object.
    expect(MINISEARCH_OPTIONS.fields).toEqual(['name', 'description', 'provides'])
    expect(MINISEARCH_OPTIONS.searchOptions.boost).toEqual({
      name: 3,
      description: 1,
      provides: 2,
    })
    expect(MINISEARCH_OPTIONS.searchOptions.fuzzy).toBe(0.2)
    expect(MINISEARCH_OPTIONS.searchOptions.prefix).toBe(true)
  })

  it('stores every field the result rows and detail pane render', () => {
    expect(MINISEARCH_OPTIONS.storeFields).toEqual([
      'name',
      'version',
      'description',
      'arch',
      'section',
      'repository',
      'type',
      'provides',
    ])
  })

  it('boosts only fields it actually indexes', () => {
    for (const f of Object.keys(MINISEARCH_OPTIONS.searchOptions.boost)) {
      expect(MINISEARCH_OPTIONS.fields).toContain(f)
    }
  })
})
