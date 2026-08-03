import { useState } from 'react'
import { api } from '@/api/client'
import { useToast } from '@/store'
import type { Selection } from '@/store'

/**
 * The Build Image action: resolve the selection to a template, then dispatch it
 * to the Jenkins farm.
 *
 * TWO CALLS, ONE ACTION. `compose` is a read-only lookup that turns the six-field
 * selection into a full template YAML; `dispatchJenkins` fans that YAML out to a
 * random idle worker. The dispatch endpoint returns a buildId keyed off the SAME
 * tracker as the local-build path, which is why BuildView's log stream and
 * details panel work on a dispatched build without knowing it was dispatched.
 *
 * `busy` is the guard against a duplicate job: the footer button reads it and
 * disables, so a second click cannot queue a second Jenkins build for the same
 * selection.
 *
 * THIS is the path that raises a toast, and it is the only one — the live review
 * and the YAML preview both render their errors inline, because compose can fail
 * on any intermediate cascade state and a toast per keystroke would be noise. A
 * failed DISPATCH is a discrete user action that failed, so it gets a toast.
 *
 * Extracted verbatim from BasicPage in FE-7c.
 */
export function useDispatchBuild({
  complete,
  selection,
  onBuildStarted,
}: {
  complete: boolean
  selection: Selection
  onBuildStarted: (buildId: string, yaml?: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const toast = useToast()

const onBuild = async () => {
  if (!complete) return
  // Resolve the selection to a full template YAML (compose is a read-only
  // lookup), then fan the build out to a random idle worker in the Jenkins
  // farm. The dispatch endpoint returns a buildId keyed off the same
  // tracker as the local-build path, so the log stream + details panel
  // in BuildView work transparently.
  try {
    setBusy(true)
    const resolved = await api.compose(selection)
    const accepted = await api.dispatchJenkins(resolved.yaml)
    onBuildStarted(accepted.buildId, resolved.yaml)
  } catch (e) {
    toast.danger((e as Error).message, { title: 'Build failed to start' })
  } finally {
    setBusy(false)
  }
}

  return { busy, onBuild }
}
