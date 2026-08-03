import YAML from 'yaml'

/**
 * YAML validation and the size cap for the Advanced tab's free-form buffer.
 *
 * PURE — no React. Extracted from AdvancedPage in FE-7d, where it sat above the
 * component and could not be tested without mounting the page.
 */

// Hard cap. buildRequest.YAML is written verbatim to workdir/template.yml; a
// runaway paste (a whole log, a binary blob) shouldn't quietly hit the server.
export const MAX_YAML_BYTES = 200 * 1024

// Parsed-YAML validity result. Structural failures block the build; empty and
// too-large are surfaced separately by their own gates.
export interface YamlValidity {
  ok: boolean
  message: string | null
  line: number | null
  col: number | null
}

export function validateYaml(text: string): YamlValidity {
  if (text.trim().length === 0) {
    // Empty is handled by the `empty` gate; not "invalid" per se.
    //
    // NOTE, from mutation-testing this function: deleting this branch breaks no
    // test, and that is not a coverage gap. `YAML.parse('')` returns null without
    // throwing, so the fall-through produces an identical result — the guard is a
    // clarity-and-cost choice (skip the parser for the commonest state), not a
    // correctness one. Kept, and kept documented.
    return { ok: true, message: null, line: null, col: null }
  }
  try {
    // parse (not parseDocument) throws on the first structural error, which is
    // exactly what we want to surface. It also enforces a valid YAML document.
    YAML.parse(text)
    return { ok: true, message: null, line: null, col: null }
  } catch (e) {
    const err = e as { name?: string; message?: string; linePos?: Array<{ line: number; col: number }> }
    const pos = err.linePos && err.linePos[0]
    return {
      ok: false,
      // Trim trailing "at line X, column Y" from the message — we render that ourselves.
      message: (err.message ?? 'YAML syntax error').replace(/\s*at line \d+, column \d+.*$/s, ''),
      line: pos?.line ?? null,
      col: pos?.col ?? null,
    }
  }
}
