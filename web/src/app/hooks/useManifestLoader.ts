import { useCallback, useEffect, useState } from 'react'
import { api } from '@/api/client'
import { useStore, useToast } from '@/store'

type LoadState = 'loading' | 'ready' | 'error'

/**
 * Fetches the combination manifest and tracks the three states the shell renders.
 *
 * ⚠️ THIS TOAST IS `duration: 0` — it never auto-dismisses. Correct here and
 * nowhere else in the app: without a manifest there is no cascade, no seed list
 * and no build, so the failure is not something the operator should be allowed to
 * miss while looking away. The `retry` handle is what makes an undismissable
 * toast acceptable.
 *
 * `load` is exposed so the error screen can retry without a page reload, which is
 * also why it is a useCallback rather than an inline effect body.
 *
 * Extracted verbatim from App in FE-7d.
 */
export function useManifestLoader() {
  const setManifest = useStore((s) => s.setManifest)
  const toast = useToast()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setState('loading')
    setError(null)
    api
      .getManifest()
      .then((m) => {
        setManifest(m)
        setState('ready')
      })
      .catch((e) => {
        const msg = (e as Error).message
        setError(msg)
        setState('error')
        toast.danger(msg, {
          title: 'Failed to load configuration',
          duration: 0,
        })
      })
  }, [setManifest, toast])

  useEffect(load, [load])

  return { state, error, retry: load }
}
