import { useCallback, useRef, useState } from 'react'
import { api } from '@/api/client'
import { useToast } from '@/store'
import { useBuildHistory } from '@/lib/buildHistory'
import type { BuildStatus } from '@/types/build'
import type { View } from '@/lib/urlState'

/**
 * Everything about a build's life from the App shell's point of view: dispatch,
 * Jenkins metadata arriving, status transitions, cancel, and retry.
 *
 * THEY BELONG TOGETHER because they all write the same two things — the persisted
 * history list (`ict.buildHistory.v1`) and the header's status pill — and three of
 * them need `selectedBuildId ?? liveBuildId` to decide WHICH row to write.
 *
 * ⚠️ `selectedBuildId ?? liveBuildId` IS THE ORDER THAT MATTERS, in that order.
 * The user may dispatch a build and then click an older history row; the child
 * BuildView then streams the SELECTED build, not the live one, so status updates
 * must land on the row being watched. Falling back to `liveBuildId` covers the
 * case where nothing is selected yet. Reversing the two would make a
 * freshly-dispatched build overwrite the status of whatever the operator had
 * chosen to look at.
 *
 * `lastYamlRef` is a ref rather than state because retry reads it at click time
 * and nothing renders from it. It is populated by every dispatch, which is why
 * BuildView can safely surface Retry only in a terminal state.
 *
 * Extracted verbatim from App in FE-7d.
 */
export function useBuildLifecycle({ setView }: { setView: (v: View) => void }) {
  const toast = useToast()
  const [retrying, setRetrying] = useState(false)
  const [buildStatus, setBuildStatus] = useState<BuildStatus>('idle')
  // The build this shell most recently dispatched, as opposed to whichever
  // history row the user currently has selected.
  const [liveBuildId, setLiveBuildId] = useState<string | null>(null)
  const lastYamlRef = useRef<string | null>(null)

  const {
    entries,
    addEntry,
    updateEntry,
    deleteEntry,
    clearAll,
    selectedBuildId,
    setSelectedBuildId,
  } = useBuildHistory()

  const onBuildStarted = (id: string, yaml?: string) => {
    lastYamlRef.current = yaml ?? null
    addEntry({
      buildId: id,
      worker: null,
      buildNo: null,
      startedAt: Date.now(),
      status: 'running',
      jenkinsBuildUrl: null,
      jenkinsJobUrl: null,
    })
    setLiveBuildId(id)
    setSelectedBuildId(id)
    setBuildStatus('running')
    setView('builds')
  }

  // BuildImagePage calls this when its active BuildView first observes
  // populated jenkins.worker/buildNumber. We patch the corresponding
  // history entry.
  const onBuildJenkinsMetaReady = useCallback(
    (
      buildId: string,
      worker: string,
      buildNo: number,
      buildUrl: string | null,
    ) => {
      updateEntry(buildId, { worker, buildNo, jenkinsBuildUrl: buildUrl })
    },
    [updateEntry],
  )

  // Status transitions from the active BuildView. We patch the entry
  // matching liveBuildId (the freshly-dispatched build) so status pills
  // in the history list stay live. If the user has selected a different
  // history row the child BuildView won't fire onStatusChange for the
  // live build; we mirror onto the selected row instead — that's the row
  // the user is watching. Fall back to liveBuildId otherwise.
  const onBuildStatusChange = useCallback(
    (s: BuildStatus) => {
      setBuildStatus(s)
      const targetId = selectedBuildId ?? liveBuildId
      if (targetId) {
        updateEntry(targetId, { status: s })
      }
    },
    [selectedBuildId, liveBuildId, updateEntry],
  )

  const onCancelBuild = useCallback(
    async (buildId: string) => {
      try {
        await api.cancelBuild(buildId)
        // Backend flipped status to "cancelled" atomically; mirror it
        // locally so the row's pill flips immediately without waiting
        // for the SSE 'error' event.
        updateEntry(buildId, { status: 'cancelled' })
        // If the cancelled build is the one driving buildStatus, flip
        // that too so the header pill goes idle-ish.
        const targetId = selectedBuildId ?? liveBuildId
        if (buildId === targetId) {
          setBuildStatus('cancelled')
        }
      } catch (e) {
        toast.danger((e as Error).message, { title: 'Cancel failed' })
        throw e
      }
    },
    [toast, updateEntry, selectedBuildId, liveBuildId],
  )

  const onRetry = useCallback(async () => {
    // Retry is surfaced by BuildView when the current build is in a
    // terminal error state, so lastYamlRef is always populated.
    const yaml = lastYamlRef.current
    if (yaml == null) return
    setRetrying(true)
    setBuildStatus('running')
    try {
      const accepted = await api.dispatchJenkins(yaml)
      addEntry({
        buildId: accepted.buildId,
        worker: null,
        buildNo: null,
        startedAt: Date.now(),
        status: 'running',
        jenkinsBuildUrl: null,
        jenkinsJobUrl: null,
      })
      setLiveBuildId(accepted.buildId)
      setSelectedBuildId(accepted.buildId)
    } catch (e) {
      toast.danger((e as Error).message, { title: 'Retry failed' })
    } finally {
      setRetrying(false)
    }
  }, [toast, addEntry, setSelectedBuildId])

  return {
    // history
    entries,
    deleteEntry,
    clearAll,
    selectedBuildId,
    setSelectedBuildId,
    // live build
    buildStatus,
    liveBuildId,
    retrying,
    // handlers
    onBuildStarted,
    onBuildJenkinsMetaReady,
    onBuildStatusChange,
    onCancelBuild,
    onRetry,
  }
}
