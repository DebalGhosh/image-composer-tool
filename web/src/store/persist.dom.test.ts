import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * The persistence contract, pinned because FE-7b split store.ts and a
 * persisted-shape change here is SILENT AND DESTRUCTIVE.
 *
 * `PERSIST_VERSION` is 2 and there is NO `migrate()`. That means:
 *   - a stored blob whose version does not match is DISCARDED by Zustand;
 *   - a stored blob whose version DOES match is rehydrated as-is, even if the
 *     field shapes have since changed.
 * Either way, an operator with a half-built image config loses it on reload —
 * and nothing in tsc, the build, or the fidelity gate would notice.
 *
 * So these tests assert on the exact storage KEY, the exact VERSION, and the
 * exact SET of partialized fields. They are deliberately about the wire format
 * rather than about behaviour.
 */

const PERSISTED_FIELDS = [
  'interactiveDraft',
  'interactiveSeedPick',
  'advancedYaml',
  'advancedSeedPick',
  'selection',
] as const

/** Re-import the store fresh so module-level bootstrap re-runs per test. */
async function freshStore() {
  vi.resetModules()
  return await import('@/store')
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
})
afterEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('the persisted store blob', () => {
  it('writes under exactly "ict.store"', async () => {
    const { useStore } = await freshStore()
    useStore.getState().setAdvancedYaml('imageName: x')
    expect(localStorage.getItem('ict.store')).not.toBeNull()
    // No other key was invented by the split.
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('ict.'))
    expect(keys).toEqual(['ict.store'])
  })

  it('stamps version 2', async () => {
    const { useStore } = await freshStore()
    useStore.getState().setAdvancedYaml('x')
    const blob = JSON.parse(localStorage.getItem('ict.store')!)
    expect(blob.version).toBe(2)
  })

  it('persists EXACTLY the five partialized fields, no more and no fewer', async () => {
    const { useStore } = await freshStore()
    useStore.getState().setAdvancedYaml('x')
    const blob = JSON.parse(localStorage.getItem('ict.store')!)
    expect(Object.keys(blob.state).sort()).toEqual([...PERSISTED_FIELDS].sort())
  })

  it('does NOT persist the manifest, the toasts, or the theme', async () => {
    // Manifest is refetched at boot; toasts are ephemeral; theme has its own
    // key so index.html's anti-FOUC script can read it before any module loads.
    const { useStore } = await freshStore()
    useStore.getState().setManifest({ combinations: [], options: {} } as never)
    useStore.getState().pushToast({ variant: 'info', message: 'hi' })
    useStore.getState().setAdvancedYaml('x')
    const blob = JSON.parse(localStorage.getItem('ict.store')!)
    expect(blob.state.manifest).toBeUndefined()
    expect(blob.state.toasts).toBeUndefined()
    expect(blob.state.theme).toBeUndefined()
  })

  it('rehydrates a draft written by the PRE-SPLIT shape', async () => {
    // The regression that matters. This blob is the literal wire format a v2
    // store wrote before FE-7b touched anything; if the split changed a field
    // name or nesting, the draft below would not come back.
    localStorage.setItem(
      'ict.store',
      JSON.stringify({
        version: 2,
        state: {
          advancedYaml: 'imageName: from-storage',
          advancedSeedPick: 'seed-a',
          interactiveSeedPick: 'seed-b',
          selection: {
            vertical: 'industrial',
            sku: 'sku-9',
            platform: 'x86_64-generic',
            os: 'ubuntu24',
            kernel: '6.8.0',
            imageType: 'iso',
          },
          interactiveDraft: {
            imageName: 'my-image',
            imageVersion: '1.2.0',
            target: {
              os: 'ubuntu',
              dist: 'ubuntu24',
              arch: 'x86_64',
              imageType: 'raw',
            },
            disk: { sizeGiB: 20, partitionTableType: 'gpt', partitions: [] },
            packages: ['vim', 'curl'],
            hostname: 'ict-host',
          },
        },
      }),
    )
    const { useStore } = await freshStore()
    const s = useStore.getState()
    expect(s.advancedYaml).toBe('imageName: from-storage')
    expect(s.advancedSeedPick).toBe('seed-a')
    expect(s.interactiveSeedPick).toBe('seed-b')
    expect(s.selection.vertical).toBe('industrial')
    expect(s.selection.imageType).toBe('iso')
    expect(s.interactiveDraft?.imageName).toBe('my-image')
    expect(s.interactiveDraft?.disk.sizeGiB).toBe(20)
    expect(s.interactiveDraft?.packages).toEqual(['vim', 'curl'])
  })

  it('DISCARDS a v1 blob rather than rehydrating the wrong shape', async () => {
    // No migrate() is a deliberate choice, not an oversight: a v1 draft's shape
    // is not readable as a v2 draft. Pinned so nobody "fixes" the absence by
    // bumping the version without writing the migration.
    localStorage.setItem(
      'ict.store',
      JSON.stringify({
        version: 1,
        state: { advancedYaml: 'should-be-discarded' },
      }),
    )
    const { useStore } = await freshStore()
    expect(useStore.getState().advancedYaml).toBe('')
  })
})

describe('the theme key, which is separate on purpose', () => {
  it('lives under "ict.theme", not inside the store blob', async () => {
    const { useStore } = await freshStore()
    useStore.getState().setTheme('light')
    expect(localStorage.getItem('ict.theme')).toBe('light')
    const blob = localStorage.getItem('ict.store')
    if (blob) expect(JSON.parse(blob).state.theme).toBeUndefined()
  })

  it('defaults to dark when nothing is stored', async () => {
    // Dark is the product default. The OS prefers-color-scheme hint is
    // deliberately NOT consulted — see store/theme.ts.
    const { useStore } = await freshStore()
    expect(useStore.getState().theme).toBe('dark')
  })

  it('only an explicit "light" opts out of the default', async () => {
    localStorage.setItem('ict.theme', 'light')
    const { useStore } = await freshStore()
    expect(useStore.getState().theme).toBe('light')
  })

  it('treats a corrupt value as the default rather than reverting to light', async () => {
    localStorage.setItem('ict.theme', 'chartreuse')
    const { useStore } = await freshStore()
    expect(useStore.getState().theme).toBe('dark')
  })

  it('puts the .dark class on <html> at module load, before React paints', async () => {
    await freshStore()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('removes the .dark class when the stored theme is light', async () => {
    localStorage.setItem('ict.theme', 'light')
    await freshStore()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
