import { Card } from '@/components/layout/Card'
import { PackageSearchCombobox } from '@/features/package-search'

/** OS package selection: inline combobox + the Advanced-search launcher. */
export function PackagesSection({
  packages,
  dist,
  arch,
  onChange,
  onOpenDialog,
}: {
  packages: string[]
  /** ⚠️ The pkgsvc query keys on the DIST (ubuntu24), not target.os (ubuntu) —
   *  the combobox prop is named `os` but the page has always passed dist. */
  dist: string
  arch: string
  onChange: (next: string[]) => void
  onOpenDialog: () => void
}) {
  return (
            <Card
              title="Packages"
              titleStyle="section"
              collapsible
              className="mb-4"
            >
              <PackageSearchCombobox
                values={packages}
                onChange={onChange}
                os={dist}
                arch={arch}
              />
              <div className="mt-2 flex items-center gap-3 text-xs" style={{ color: 'var(--muted-color)' }}>
                <span>
                  {packages.length} package(s) selected
                </span>
                <button
                  type="button"
                  onClick={onOpenDialog}
                  aria-label="Open expanded package search"
                  className="cursor-pointer inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                  style={{
                    borderColor: 'var(--border-color)',
                    color: 'var(--muted-color)',
                    background: 'var(--input-background)',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M14 14l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  Advanced search
                  <kbd
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '0 4px',
                      borderRadius: 3,
                      border: '1px solid var(--border-color)',
                      background: 'var(--section-background)',
                      color: 'var(--muted-color)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      lineHeight: 1.4,
                      marginLeft: 2,
                    }}
                  >
                    ⌘K
                  </kbd>
                </button>
              </div>
            </Card>
  )
}
