import { useMemo, useState } from 'react'
import { useStore } from '@/store'
import { Card } from '@/components/layout/Card'
import { fieldLabelClass, fieldLabelStyle } from '@/components/controls/Select'
import { YamlEditor } from '@/features/yaml'
import { computeBuildGates } from './model/buildGates'
import { validateYaml } from './model/validateYaml'
import { useSeedTemplate } from './hooks/useSeedTemplate'
import { useDispatchYaml } from './hooks/useDispatchYaml'
import { AdvancedFooter } from './parts/AdvancedFooter'
import { PlaceholderBanner } from './parts/PlaceholderBanner'
import { SeedPickerRow } from './parts/SeedPickerRow'
import { YamlErrorBanner } from './parts/YamlErrorBanner'
import { YamlMetaRow } from './parts/YamlMetaRow'

interface AdvancedPageProps {
  onBuildStarted: (buildId: string, yaml?: string) => void
}

// Tokens that ship in the reference templates as "fill me in" markers. If any
// survive into a build request the build fails deep in ICT (missing URL,
// unresolvable SSH key, non-existent path). Surface them up front and force an
// explicit override to build.
const PLACEHOLDER_TOKENS = ['<URL>', '<PUBLIC_KEY_URL>', '/path/to/'] as const

/**
 * The Advanced tab: paste or prefill a template, validate it live, dispatch it
 * verbatim.
 *
 * ⚠️ THIS PAGE CARRIES NO `@container` MARKER, AND MUST NOT GAIN ONE. Its
 * YamlEditor can go fullscreen, and that overlay is an in-tree `position: fixed`
 * element — this app renders no React portals. `container-type: inline-size`
 * implies `contain: layout`, which would make the marked element the overlay's
 * containing block and trap a "fullscreen" editor inside a Card. The three
 * legitimate markers live on InteractivePage, BasicPage and BuildView; the count
 * must stay at three. See .claude/UI-LAYOUT.md.
 *
 * A container. Its own job is the layout, the memoised derivations, and wiring:
 *   - model/validateYaml   live parse + the size cap (pure, tested)
 *   - model/buildGates     the six reasons a build is refused (pure, tested)
 *   - model/seedLabel      the dropdown's display string (pure, tested)
 *   - hooks/useSeedTemplate  prefill, with the confirm() and the override reset
 *   - hooks/useDispatchYaml  the dispatch, and the busy flag that guards it
 */
export function AdvancedPage({ onBuildStarted }: AdvancedPageProps) {
  const manifest = useStore((s) => s.manifest)
  const yaml = useStore((s) => s.advancedYaml)
  const setYaml = useStore((s) => s.setAdvancedYaml)

  const [override, setOverride] = useState(false)

  const byteLen = useMemo(() => new Blob([yaml]).size, [yaml])
  const placeholders = useMemo(
    () => PLACEHOLDER_TOKENS.filter((t) => yaml.includes(t)),
    [yaml],
  )
  // Real-time YAML validation. Re-parses on every keystroke; `yaml` parses
  // ~1 MB in single-digit ms so this is cheap for typical templates. Memoised
  // on the buffer so re-renders that don't touch the text don't re-parse.
  const validity = useMemo(() => validateYaml(yaml), [yaml])

  // Every hook above AND below this guard must be unconditional — the early
  // return means anything after it would be called conditionally.
  const { seedPick, seedBusy, onSeedChange, onReloadSeed } = useSeedTemplate({
    manifest,
    yaml,
    setYaml,
    setOverride,
  })

  // ⚠️ ORDERING NOTE. `canBuild` includes `!busy`, and `busy` comes from the
  // dispatch hook — a cycle if taken naively. It is broken by computing the
  // CONTENT gates first (they know nothing about in-flight state), then folding
  // `busy` in afterwards. That reproduces the original's single six-term
  // conjunction exactly; an earlier draft of this refactor passed `busy: false`
  // into the gates and silently allowed a second click to queue a duplicate
  // Jenkins job.
  const contentGates = computeBuildGates({
    yaml,
    byteLen,
    validity,
    placeholderCount: placeholders.length,
    override,
    busy: false,
    seedBusy,
  })

  const { busy, onBuild } = useDispatchYaml({
    // The hook re-tests this at click time, so it must see the FULL predicate.
    canBuild: contentGates.canBuild,
    yaml,
    onBuildStarted,
  })

  const { empty, tooLarge, invalid, blockedByPlaceholders } = contentGates
  const canBuild = contentGates.canBuild && !busy

  if (!manifest) return <div className="p-8">Loading…</div>

  return (
    <div className="page-shell">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-6">
      <h1 className="mb-1 text-2xl font-bold" style={{ color: 'var(--title-text)' }}>
        Advanced: Raw Template YAML
      </h1>
      <p className="mb-3 text-sm text-[var(--muted-color)]">
        Paste an ICT template YAML and build it directly. The YAML is sent to the backend
        as-is; the manifest is not consulted.
      </p>

      <Card variant="warning" title="Advanced mode caveats" className="mb-5">
        <ul className="list-disc space-y-0.5 pl-5 text-xs">
          <li>Skips the curated vertical/SKU/platform combinations from the manifest.</li>
          <li>The build runs as root on the server host — take care with mounts and post-install hooks.</li>
          <li>Syntax is validated client-side as you type; deeper semantic errors surface in the build log.</li>
        </ul>
      </Card>

      <Card>
        <SeedPickerRow
          manifest={manifest}
          seedPick={seedPick}
          seedBusy={seedBusy}
          busy={busy}
          onSeedChange={onSeedChange}
          onReloadSeed={onReloadSeed}
        />

        <span
          id="advanced-yaml-label"
          className={fieldLabelClass}
          style={fieldLabelStyle}
        >
          Template YAML
        </span>
        <YamlEditor
          id="advanced-yaml"
          labelledBy="advanced-yaml-label"
          value={yaml}
          onChange={setYaml}
          readOnly={seedBusy}
          placeholder="# Paste an ICT template here, or pick a seed above."
          height="480px"
          className={
            'overflow-hidden rounded-md border transition-colors ' +
            'focus-within:ring-2 focus-within:ring-[var(--tine-1)]/40 ' +
            (invalid
              ? 'border-[color:var(--danger)] '
              : 'focus-within:border-[var(--classic-blue)] dark:focus-within:border-[var(--tine-1)] ') +
            (seedBusy ? 'opacity-60' : '')
          }
        />

        <YamlMetaRow
          yaml={yaml}
          byteLen={byteLen}
          validity={validity}
          empty={empty}
          tooLarge={tooLarge}
        />

        <YamlErrorBanner invalid={invalid} validity={validity} />
      </Card>

      {placeholders.length > 0 && (
        <PlaceholderBanner
          placeholders={[...placeholders]}
          override={override}
          setOverride={setOverride}
        />
      )}

        </div>
      </div>

      <AdvancedFooter
        canBuild={canBuild}
        busy={busy}
        empty={empty}
        tooLarge={tooLarge}
        invalid={invalid}
        blockedByPlaceholders={blockedByPlaceholders}
        onBuild={onBuild}
      />
    </div>
  )
}
