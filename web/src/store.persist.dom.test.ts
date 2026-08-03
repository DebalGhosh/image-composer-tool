import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from '@/store'

/**
 * Characterisation tests for the store's PERSISTENCE CONTRACT.
 *
 * FE-7 splits store.ts by slice, and this contract is the thing most likely to
 * break silently while doing it. Two documented hazards:
 *
 *   1. PERSIST_VERSION is 2 with NO migrate(). zustand DISCARDS any persisted
 *      blob whose version is older — deliberately, because a stale
 *      InteractiveDraft lacking `baseYaml` cannot take the pristine-passthrough
 *      path in applyOverrides and would be reconstructed lossily on dispatch.
 *      So renaming or reshaping a persisted field REQUIRES bumping the version;
 *      forgetting to means stale drafts load into the new shape and get sent to
 *      the Jenkins farm.
 *   2. `partialize` deliberately persists only 5 of the state fields. theme
 *      lives under its own `ict.theme` key (hand-duplicated in index.html's
 *      anti-FOUC script); manifest is refetched; toasts are ephemeral.
 *      Accidentally widening partialize would persist a stale manifest and
 *      delay first paint with wrong data.
 *
 * PERSIST_KEY / PERSIST_VERSION / partialize are module-private, so these
 * assert the OBSERVABLE contract — what actually lands in localStorage — which
 * is the thing that has to survive the split anyway.
 */

const PERSIST_KEY = 'ict.store'

function readBlob(): { state: Record<string, unknown>; version: number } | null {
  const raw = window.localStorage.getItem(PERSIST_KEY)
  return raw ? JSON.parse(raw) : null
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('persist key and version', () => {
  it('writes under the exact key `ict.store`', () => {
    // ⚠️ Renaming this key discards every user's in-progress draft silently.
    useStore.getState().setAdvancedYaml('image:\n  name: probe\n')
    expect(window.localStorage.getItem(PERSIST_KEY)).not.toBeNull()
  })

  it('stamps the persisted blob with version 2', () => {
    // Bumped 1 -> 2 when InteractiveDraft.baseYaml was introduced. If a future
    // change reshapes a persisted field WITHOUT bumping this, stale drafts load
    // into the new shape instead of being discarded.
    useStore.getState().setAdvancedYaml('x')
    expect(readBlob()?.version).toBe(2)
  })
})

describe('partialize — exactly five fields persist', () => {
  it('persists only the draft/selection fields the user expects to survive reload', () => {
    useStore.getState().setAdvancedYaml('yaml-here')
    const keys = Object.keys(readBlob()?.state ?? {}).sort()
    expect(keys).toEqual([
      'advancedSeedPick',
      'advancedYaml',
      'interactiveDraft',
      'interactiveSeedPick',
      'selection',
    ])
  })

  it('does NOT persist theme — it has its own ict.theme key', () => {
    // theme is persisted independently AND duplicated in index.html's
    // anti-FOUC inline script. Persisting it here too would give two sources of
    // truth that can disagree on cold load.
    useStore.getState().setAdvancedYaml('x')
    expect(readBlob()?.state).not.toHaveProperty('theme')
  })

  it('does NOT persist manifest, toasts, or any ephemeral field', () => {
    useStore.getState().setAdvancedYaml('x')
    const state = readBlob()?.state ?? {}
    for (const k of ['manifest', 'toasts']) {
      expect(state).not.toHaveProperty(k)
    }
  })
})

describe('what round-trips through storage', () => {
  it('round-trips advancedYaml verbatim, including trailing newline', () => {
    // The YAML-integrity fence turns on byte-exactness; a persisted draft that
    // loses its trailing newline would break the pristine-passthrough path.
    const yaml = 'image:\n  name: keep-me\n\ntarget:\n  os: ubuntu\n'
    useStore.getState().setAdvancedYaml(yaml)
    expect((readBlob()?.state as { advancedYaml: string }).advancedYaml).toBe(yaml)
  })

  it('round-trips the seed picks', () => {
    useStore.getState().setAdvancedSeedPick('ubuntu24-x86_64-robotics-jazzy-iso.yml')
    expect(
      (readBlob()?.state as { advancedSeedPick: string }).advancedSeedPick,
    ).toBe('ubuntu24-x86_64-robotics-jazzy-iso.yml')
  })
})
