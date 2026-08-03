import { useState } from 'react'
import { api } from '@/api/client'
import { useToast } from '@/store'

/**
 * Dispatches the pasted YAML straight to a Jenkins worker.
 *
 * NO `compose` STEP, unlike the Basic tab. Advanced hands the operator's buffer to
 * the builder verbatim — that is the entire point of the tab, and it is why the
 * caveats Card and the size cap exist. The dispatch endpoint is the same one, so a
 * build started here streams logs and details through BuildView identically.
 *
 * `busy` gates the footer button against a duplicate job AND is re-tested inside
 * `onBuild`, since this hook is the only place that knows it. The `canBuild` prop
 * carries the caller's CONTENT gates only.
 *
 * Extracted verbatim from AdvancedPage in FE-7d.
 */
export function useDispatchYaml({
  canBuild,
  yaml,
  onBuildStarted,
}: {
  canBuild: boolean
  yaml: string
  onBuildStarted: (buildId: string, yaml?: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const onBuild = async () => {
    // `busy` is checked HERE rather than folded into the caller's `canBuild`,
    // because this hook owns it. The caller's flag covers only the CONTENT gates
    // (empty / too large / invalid / placeholders); re-entrancy is ours. Without
    // this test a second activation while a dispatch is in flight would queue a
    // duplicate Jenkins job — the footer button is disabled, but a keyboard
    // Enter on an already-focused button is a real sequence.
    if (!canBuild || busy) return
    // Fan the pasted YAML out to a random idle Jenkins worker. Same dispatch
    // endpoint as the Basic tab -- the server picks the worker and returns a
    // buildId that BuildView keys off for logs + details.
    try {
      setBusy(true)
      const accepted = await api.dispatchJenkins(yaml)
      onBuildStarted(accepted.buildId, yaml)
    } catch (e) {
      toast.danger((e as Error).message, { title: 'Build failed to start' })
    } finally {
      setBusy(false)
    }
  }

  return { busy, onBuild }
}
