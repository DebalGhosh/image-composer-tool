import { useStore } from '../store'
import type { Theme } from '../store'

type View = 'basic' | 'advanced' | 'builds'
type BuildStatus = 'idle' | 'running' | 'success' | 'failed'

interface HeaderProps {
  view: View
  onViewChange: (v: View) => void
  buildStatus: BuildStatus
  onBuildIndicatorClick: () => void
}

const tabs: { id: View; label: string }[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'builds', label: 'Build Image' },
]

export function Header({
  view,
  onViewChange,
  buildStatus,
  onBuildIndicatorClick,
}: HeaderProps) {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)

  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark')

  return (
    <header
      className="sticky top-0 z-40 flex items-center gap-6 border-b px-6 py-3"
      style={{
        /* Header always presents a dark backdrop so the product title reads
         * cleanly in white across both themes. Dark mode leans further into
         * SSF-UI's --navbar-bg-color; light mode uses --classic-blue for the
         * Intel-brand strip look. */
        background: 'var(--classic-blue)',
        borderColor: 'color-mix(in srgb, black 30%, var(--classic-blue))',
      }}
    >
      <div className="flex items-center gap-3">
        <img src="/intel-logo.svg" alt="" className="h-7 w-auto" aria-hidden="true" />
        <span className="text-lg font-bold tracking-tight text-white">
          Image Composer Tool
        </span>
      </div>

      <nav className="flex items-center gap-1" aria-label="Primary">
        {tabs.map((t) => {
          const active = view === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onViewChange(t.id)}
              className={
                'relative rounded px-3 py-1.5 text-sm font-medium transition-colors ' +
                (active
                  ? 'text-white bg-white/10'
                  : 'text-white/70 hover:text-white hover:bg-white/10')
              }
              aria-current={active ? 'page' : undefined}
            >
              {t.label}
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-2 -bottom-[13px] h-[3px] rounded-t bg-white"
                />
              )}
            </button>
          )
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <BuildIndicator status={buildStatus} onClick={onBuildIndicatorClick} />
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>
    </header>
  )
}

function BuildIndicator({
  status,
  onClick,
}: {
  status: BuildStatus
  onClick: () => void
}) {
  if (status === 'idle') return null
  const cfg = {
    running: { color: 'bg-[var(--warning)]', pulse: true, label: 'Build in progress' },
    success: { color: 'bg-[var(--success)]', pulse: false, label: 'Build completed' },
    failed: { color: 'bg-[var(--danger)]', pulse: false, label: 'Build failed' },
  }[status]
  return (
    <button
      type="button"
      onClick={onClick}
      title={cfg.label}
      className="flex items-center gap-2 rounded px-2 py-1 text-xs font-medium text-white/80 hover:text-white hover:bg-white/10"
    >
      <span className="relative flex h-2.5 w-2.5">
        {cfg.pulse && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${cfg.color} opacity-75`}
          />
        )}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${cfg.color}`} />
      </span>
      {cfg.label}
    </button>
  )
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const isDark = theme === 'dark'
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Light mode' : 'Dark mode'}
      className="grid h-8 w-8 place-items-center rounded-md border text-white/90 hover:text-white hover:bg-white/10"
      style={{ borderColor: 'rgba(255,255,255,0.3)' }}
    >
      {isDark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z" />
        </svg>
      )}
    </button>
  )
}
