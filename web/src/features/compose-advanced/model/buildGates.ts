import { MAX_YAML_BYTES, type YamlValidity } from './validateYaml'

/**
 * The six independent reasons the Advanced tab may refuse to dispatch a build.
 *
 * PURE — no React, no store. Extracted from AdvancedPage in FE-7d, where the
 * gates were six inline `const`s feeding one six-term `&&` chain. That shape was
 * the bulk of the component's complexity-42 score, and none of it could be tested
 * without a mounted page and a populated store.
 *
 * WHY A STRUCT AND NOT JUST A BOOLEAN: the UI needs each flag individually, not
 * merely the conjunction. `empty` greys the button silently, `tooLarge` and
 * `invalid` each render their own inline banner, and `blockedByPlaceholders`
 * renders a banner WITH an override checkbox. Collapsing them would lose the
 * ability to say why.
 *
 * ⚠️ `invalid` IS `!empty && !validity.ok`, NOT simply `!validity.ok`. An empty
 * buffer parses as valid YAML (validateYaml short-circuits on it), so without the
 * `!empty` guard the two states would be indistinguishable — and an operator who
 * has just cleared the editor would see a syntax-error banner rather than the
 * quiet disabled button that is correct there.
 */
export interface BuildGates {
  /** Nothing typed yet. Silently disables; renders no banner. */
  empty: boolean
  /** Over MAX_YAML_BYTES. buildRequest.YAML is written verbatim to disk. */
  tooLarge: boolean
  /** Structurally broken YAML — but only when there IS something to break. */
  invalid: boolean
  /** Unreplaced <PLACEHOLDER> tokens remain and the operator has not overridden. */
  blockedByPlaceholders: boolean
  /** All six gates open. */
  canBuild: boolean
}

export function computeBuildGates({
  yaml,
  byteLen,
  validity,
  placeholderCount,
  override,
  busy,
  seedBusy,
}: {
  yaml: string
  byteLen: number
  validity: YamlValidity
  placeholderCount: number
  /** The operator ticked "build anyway" on the placeholder banner. */
  override: boolean
  /** A dispatch is in flight. */
  busy: boolean
  /** A seed template is being fetched. */
  seedBusy: boolean
}): BuildGates {
  const empty = yaml.trim().length === 0
  const tooLarge = byteLen > MAX_YAML_BYTES
  const invalid = !empty && !validity.ok
  const blockedByPlaceholders = placeholderCount > 0 && !override

  return {
    empty,
    tooLarge,
    invalid,
    blockedByPlaceholders,
    canBuild:
      !empty &&
      !tooLarge &&
      !invalid &&
      !blockedByPlaceholders &&
      !busy &&
      !seedBusy,
  }
}
