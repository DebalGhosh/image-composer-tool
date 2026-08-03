import { describe, it, expect } from 'vitest'
import { diffChangedLines } from './yamlDiffHighlight'

/**
 * CHARACTERISATION tests for the line differ behind the Interactive tab's live
 * YAML preview flash. Every expected value below was computed BY HAND from the
 * LCS implementation, not from an opinion about what diffing ought to return —
 * several of them are surprising, and those are the ones worth pinning.
 *
 * The contract: return the 1-indexed line numbers IN `next` that are not on an
 * LCS pair with `prev`. Consequences that follow from that and look like bugs
 * until you know the contract:
 *   - a pure DELETION returns [] — there is no line in `next` to flash;
 *   - reordering two lines flags only ONE of them, because LCS keeps the other;
 *   - the first-ever render is suppressed entirely, deliberately.
 */

describe('diffChangedLines', () => {
  describe('the two short-circuits, which exist for real reasons', () => {
    it('returns [] for identical input without building the LCS grid', () => {
      expect(diffChangedLines('a\nb\nc', 'a\nb\nc')).toEqual([])
    })

    it('SUPPRESSES the flash entirely on the first render (prev === "")', () => {
      // Not an optimisation: highlighting all ~200 lines of a seed template on
      // the initial swap would flood the viewport. Subsequent edits diff
      // normally.
      expect(diffChangedLines('', 'a\nb\nc')).toEqual([])
      expect(diffChangedLines('', 'imageName: x\npackages:\n  - vim')).toEqual(
        [],
      )
    })

    it('returns [] when both sides are empty', () => {
      // Hits the `prev === next` branch first, not the `prev === ''` one.
      expect(diffChangedLines('', '')).toEqual([])
    })
  })

  describe('modification', () => {
    it('flags exactly the changed line', () => {
      expect(diffChangedLines('a\nb\nc', 'a\nX\nc')).toEqual([2])
    })

    it('flags every line when nothing survives', () => {
      expect(diffChangedLines('a\nb', 'x\ny')).toEqual([1, 2])
    })

    it('treats a whitespace-only change as a change', () => {
      // Trailing space. YAML-insignificant, but the differ is textual and the
      // operator did just cause it, so flashing it is correct.
      expect(diffChangedLines('a\nb', 'a\nb ')).toEqual([2])
    })

    it('treats an indent change as a change', () => {
      expect(diffChangedLines('key: 1', '  key: 1')).toEqual([1])
    })
  })

  describe('insertion', () => {
    it('flags the inserted line, not the lines it displaced', () => {
      expect(diffChangedLines('a\nb\nc', 'a\nNEW\nb\nc')).toEqual([2])
    })

    it('flags an append at the end', () => {
      expect(diffChangedLines('a\nb', 'a\nb\nc')).toEqual([3])
    })

    it('flags a prepend at the start', () => {
      expect(diffChangedLines('a\nb', 'z\na\nb')).toEqual([1])
    })

    it('flags the new trailing blank line when a newline is appended', () => {
      // 'a\nb\n'.split('\n') is ['a','b',''] — three lines, the third empty.
      expect(diffChangedLines('a\nb', 'a\nb\n')).toEqual([3])
    })
  })

  describe('deletion — returns [] and that is CORRECT, not a bug', () => {
    it('flags nothing when a line is removed', () => {
      // There is no line in `next` to decorate. The remaining lines are all on
      // the LCS, so none of them flash. A caller wanting "something changed"
      // must compare the strings itself.
      expect(diffChangedLines('a\nb\nc', 'a\nc')).toEqual([])
    })

    it('flags nothing when a trailing line is removed', () => {
      expect(diffChangedLines('a\nb\nc', 'a\nb')).toEqual([])
    })

    it('flags the one remaining empty line when everything is deleted', () => {
      // ''.split('\n') is [''] — one empty line, which is not on the LCS.
      expect(diffChangedLines('a\nb', '')).toEqual([1])
    })
  })

  describe('cases where LCS gives a non-obvious answer', () => {
    it('flags only ONE line when two lines are swapped', () => {
      // LCS('a\nb', 'b\na') has length 1 — it can keep 'a' OR 'b', not both.
      // The traceback keeps b's line 2 ('a'), so line 1 is reported.
      expect(diffChangedLines('a\nb', 'b\na')).toEqual([1])
    })

    it('picks a consistent survivor among duplicate lines', () => {
      // Three identical lines, middle one changed. LCS length 2; the traceback
      // pairs b's lines 1 and 3, leaving line 2.
      expect(diffChangedLines('x\nx\nx', 'x\nY\nx')).toEqual([2])
    })

    it('is asymmetric: swapping the arguments gives a different answer', () => {
      // Insertion flags the new line; the reverse (a deletion) flags nothing.
      expect(diffChangedLines('a\nc', 'a\nb\nc')).toEqual([2])
      expect(diffChangedLines('a\nb\nc', 'a\nc')).toEqual([])
    })
  })

  describe('realistic template edits', () => {
    const before = [
      'imageName: my-image',
      'imageVersion: 1.0.0',
      'target:',
      '  os: ubuntu',
      '  arch: x86_64',
      'packages:',
      '  - vim',
    ].join('\n')

    it('flags one line when a single scalar is edited', () => {
      const after = before.replace('arch: x86_64', 'arch: aarch64')
      expect(diffChangedLines(before, after)).toEqual([5])
    })

    it('flags one line when a package is appended to a list', () => {
      expect(diffChangedLines(before, before + '\n  - curl')).toEqual([8])
    })

    it('flags both when two separate scalars change in one dispatch', () => {
      const after = before
        .replace('my-image', 'other-image')
        .replace('1.0.0', '2.0.0')
      expect(diffChangedLines(before, after)).toEqual([1, 2])
    })

    it('returns ascending, 1-indexed, de-duplicated line numbers', () => {
      const after = before
        .replace('os: ubuntu', 'os: debian')
        .replace('- vim', '- nano')
      const out = diffChangedLines(before, after)
      expect(out).toEqual([4, 7])
      expect(out).toEqual([...out].sort((x, y) => x - y))
      expect(new Set(out).size).toBe(out.length)
      expect(Math.min(...out)).toBeGreaterThanOrEqual(1)
      expect(Math.max(...out)).toBeLessThanOrEqual(after.split('\n').length)
    })
  })

  it('never reports a line number outside 1..next.length', () => {
    // The consumer indexes doc.line(ln), which throws out of range. flash()
    // clamps its scroll target but the effect passes `lines` through as-is, so
    // the differ itself must not emit anything out of bounds.
    const pairs: [string, string][] = [
      ['a', ''],
      ['', 'a'],
      ['a\nb\nc\nd', 'd\nc\nb\na'],
      ['a\n\n\nb', '\n\na\nb\n'],
    ]
    for (const [p, n] of pairs) {
      const max = n.split('\n').length
      for (const ln of diffChangedLines(p, n)) {
        expect(ln).toBeGreaterThanOrEqual(1)
        expect(ln).toBeLessThanOrEqual(max)
      }
    }
  })
})
