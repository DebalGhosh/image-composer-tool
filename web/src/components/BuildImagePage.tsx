import { BuildView } from './BuildView'

type BuildStatus = 'idle' | 'running' | 'success' | 'failed'

interface BuildImagePageProps {
  buildId: string | null
  onRetry: () => Promise<void>
  retrying: boolean
  onStatusChange: (s: BuildStatus) => void
}

export function BuildImagePage({ buildId, onRetry, retrying, onStatusChange }: BuildImagePageProps) {
  return (
    <div className="mx-auto max-w-6xl p-6">
      <h1 className="mb-4 text-2xl font-bold" style={{ color: 'var(--title-text)' }}>
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
