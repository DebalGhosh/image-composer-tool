import { describe, it, expect } from 'vitest'
import { validateYaml, MAX_YAML_BYTES } from './validateYaml'

/**
 * CHARACTERISATION tests. Every expectation was taken by running the real `yaml`
 * parser against the input and recording what it did — not from an opinion about
 * what "invalid YAML" ought to mean. Several results are surprising.
 */

describe('validateYaml', () => {
  describe('the empty short-circuit', () => {
    it('reports OK for an empty string', () => {
      // NOT "invalid" — the caller has a separate `empty` gate for this, which
      // greys the button silently instead of showing a syntax-error banner.
      expect(validateYaml('')).toEqual({
        ok: true,
        message: null,
        line: null,
        col: null,
      })
    })

    it('reports OK for whitespace only', () => {
      expect(validateYaml('   \n  \n\t').ok).toBe(true)
    })

    it('short-circuits BEFORE parsing, so whitespace never reaches the parser', () => {
      // Matters because the trim() check is what makes `invalid` in buildGates
      // (`!empty && !validity.ok`) meaningful: both conditions agree that an
      // empty buffer is not a syntax error.
      expect(validateYaml('\n\n\n').message).toBeNull()
    })
  })

  describe('things that ARE valid YAML but look like they should not be', () => {
    it('accepts a bare scalar', () => {
      // A single unquoted word is a complete YAML document.
      expect(validateYaml('just a string').ok).toBe(true)
    })

    it('accepts a bare number', () => {
      expect(validateYaml('42').ok).toBe(true)
    })

    it('accepts a comment-only buffer', () => {
      // Parses to null. Structurally fine; the build would fail downstream, but
      // that is not this function's job.
      expect(validateYaml('# nothing here').ok).toBe(true)
    })

    it('accepts a realistic template', () => {
      expect(
        validateYaml('imageName: x\nimageVersion: 1.0\npackages:\n  - vim').ok,
      ).toBe(true)
    })
  })

  describe('structural failures, with position', () => {
    it('rejects tab indentation and reports line 2 col 1', () => {
      const r = validateYaml('a:\n\tb: 1')
      expect(r.ok).toBe(false)
      expect(r.message).toBe('Tabs are not allowed as indentation')
      expect(r.line).toBe(2)
      expect(r.col).toBe(1)
    })

    it('rejects a nested mapping in a compact mapping', () => {
      const r = validateYaml('a: b: c')
      expect(r.ok).toBe(false)
      expect(r.message).toBe(
        'Nested mappings are not allowed in compact mappings',
      )
      expect(r.line).toBe(1)
      expect(r.col).toBe(4)
    })

    it('rejects a duplicate key', () => {
      const r = validateYaml('a: 1\na: 2')
      expect(r.ok).toBe(false)
      expect(r.message).toBe('Map keys must be unique')
      expect(r.line).toBe(2)
    })

    it('rejects an unclosed flow sequence', () => {
      const r = validateYaml('a: [1, 2')
      expect(r.ok).toBe(false)
      expect(r.line).toBe(1)
      expect(r.col).toBe(9)
    })
  })

  describe('the message is stripped of its trailing position', () => {
    it('removes "at line X, column Y" — the UI renders that itself', () => {
      const r = validateYaml('a:\n\tb: 1')
      expect(r.message).not.toContain('at line')
      expect(r.message).not.toContain('column')
      // But the position survives in its own fields.
      expect(r.line).toBe(2)
      expect(r.col).toBe(1)
    })

    it('strips across newlines — the regex uses the s flag', () => {
      // yaml's messages can carry a multi-line code frame after the position.
      const r = validateYaml('a: [1, 2')
      expect(r.message).not.toMatch(/at line \d+/)
    })
  })

  it('tolerates an error carrying NO position at all', () => {
    // An unresolved alias throws without linePos. Both fields must come back
    // null rather than undefined, or the UI would render "line undefined".
    const r = validateYaml('a: *missing')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('Unresolved alias')
    expect(r.line).toBeNull()
    expect(r.col).toBeNull()
  })

  it('never throws, whatever it is handed', () => {
    const nasty = [
      '\0',
      '}]{[',
      '- - - -',
      '?: ?: ?',
      'a'.repeat(10_000),
      '\u{1F600}: emoji key',
    ]
    for (const t of nasty) {
      expect(() => validateYaml(t)).not.toThrow()
    }
  })
})

describe('MAX_YAML_BYTES', () => {
  it('is 200 KiB', () => {
    // buildRequest.YAML is written verbatim to workdir/template.yml, so a
    // runaway paste — a whole build log, a binary blob — must not reach the
    // server quietly.
    expect(MAX_YAML_BYTES).toBe(204_800)
    expect(MAX_YAML_BYTES).toBe(200 * 1024)
  })
})
