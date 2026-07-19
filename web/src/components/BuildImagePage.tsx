import { BuildView } from './BuildView'

type BuildStatus = 'idle' | 'running' | 'success' | 'failed'

interface BuildImagePageProps {
  buildId: string | null
  onRetry: () => Promise<void>
  retrying: boolean
  onStatusChange: (s: BuildStatus) => void
}

export function BuildImagePage({ buildId, onRetry, retrying, onStatusChange }: BuildImagePageProps) {
  // Full-viewport flex column so the BuildView's Build Log card can grow
  // into all remaining vertical space via flex-1 min-h-0. The 3.75rem
  // subtracted from 100vh matches the sticky Header height.
  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col p-6"
      style={{ height: 'calc(100vh - 3.75rem)' }}
    >
      <h1 className="mb-4 flex-none text-2xl font-bold" style={{ color: 'var(--title-text)' }}>
        Build Image
      </h1>
      {buildId ? (
        <BuildView buildId={buildId} onRetry={onRetry} retrying={retrying} onStatusChange={onStatusChange} />
      ) : (
        <div
          className="rounded-md border border-dashed p-8 text-center text-sm text-[var(--muted-color)]"
          style={{ borderColor: 'var(--border-color)' }}
        >
          No build started yet. Choose a configuration on the Basic tab and click
          <span className="font-semibold"> Build Image</span>.
        </div>
      )}
    </div>
  )
}
