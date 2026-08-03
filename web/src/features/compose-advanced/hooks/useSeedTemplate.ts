import { useState } from 'react'
import { api } from '@/api/client'
import { useStore, useToast } from '@/store'
import type { ComposeRequest, Manifest } from '@/api/types'

/**
 * Prefilling the Advanced editor from a seed template.
 *
 * `seedPick` is PERSISTED (`advancedSeedPick` in the store, and one of the five
 * fields in the persist partialize), so a reload remembers which template the
 * operator started from even though the YAML buffer is what actually matters.
 *
 * ⚠️ `setOverride(false)` ON EVERY SUCCESSFUL LOAD IS LOAD-BEARING. The override
 * checkbox means "I know there are unreplaced placeholders, build anyway". A
 * fresh seed brings a fresh set of placeholders, so carrying the old consent
 * forward would let an operator dispatch a template full of literal
 * `<PLACEHOLDER>` tokens they never looked at.
 *
 * The confirm() prompt guards against silently destroying hand-written YAML. It
 * is skipped when the buffer is empty, since there is nothing to lose.
 *
 * Extracted verbatim from AdvancedPage in FE-7d.
 */
export function useSeedTemplate({
  manifest,
  yaml,
  setYaml,
  setOverride,
}: {
  /**
   * NULLABLE, because this hook is called ABOVE the page's `if (!manifest)`
   * early return — hooks must be unconditional. `loadSeed` already bails when
   * the combination lookup misses, and with a null manifest the seed dropdown
   * is not rendered at all, so no handler here can fire. Typing it non-null
   * would only have forced a `!` at the call site, which asserts something the
   * control flow does not actually guarantee at that point.
   */
  manifest: Manifest | null
  /** Current buffer — read only to decide whether to confirm before replacing. */
  yaml: string
  setYaml: (next: string) => void
  setOverride: (next: boolean) => void
}) {
  const seedPick = useStore((s) => s.advancedSeedPick)
  const setSeedPick = useStore((s) => s.setAdvancedSeedPick)
  const [seedBusy, setSeedBusy] = useState(false)
  const toast = useToast()

  /**
   * Load (or reload) the seed template at index `idx`.
   *
   * Split from onChange so the same-seed-twice case can call it explicitly via
   * the Reload button without going through the dropdown's onChange (which
   * would be a no-op because the value hasn't changed).
   */
  const loadSeed = async (idx: number, confirmReplace: boolean) => {
    const combo = manifest?.combinations[idx]
    if (!combo) return

    if (
      confirmReplace &&
      yaml.trim().length > 0 &&
      !window.confirm('Replace the current YAML with the seed template?')
    ) {
      return
    }

    const req: ComposeRequest = {
      vertical: combo.vertical,
      sku: combo.sku,
      platform: combo.platform,
      os: combo.os,
      kernel: combo.kernel,
      imageType: combo.imageType,
    }
    try {
      setSeedBusy(true)
      const resp = await api.compose(req)
      setYaml(resp.yaml)
      setOverride(false)
    } catch (e) {
      toast.danger((e as Error).message, { title: 'Failed to load seed template' })
    } finally {
      setSeedBusy(false)
    }
  }

  const onSeedChange = async (raw: string) => {
    if (!raw) {
      // User cleared the dropdown ("-- Pick a template to prefill --" chosen).
      setSeedPick('')
      return
    }
    setSeedPick(raw)
    await loadSeed(Number(raw), /* confirmReplace= */ true)
  }

  const onReloadSeed = async () => {
    if (!seedPick) return
    await loadSeed(Number(seedPick), /* confirmReplace= */ true)
  }

  return { seedPick, seedBusy, onSeedChange, onReloadSeed }
}
