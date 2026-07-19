import { useMemo, useState } from 'react'
import { useStore, useToast } from '../store'
import { api } from '../api/client'
import type { ComposeRequest } from '../api/types'
import { Card } from './Card'
import { NativeSelect, fieldLabelClass, fieldLabelStyle } from './Select'
import { YamlEditor } from './YamlEditor'

interface AdvancedPageProps {
  onBuildStarted: (buildId: string, yaml?: string) => void
  buildInProgress: boolean
}

// Tokens that ship in the reference templates as "fill me in" markers. If any
// survive into a build request the build fails deep in ICT (missing URL,
// unresolvable SSH key, non-existent path). Surface them up front and force an
// explicit override to build.
const PLACEHOLDER_TOKENS = ['<URL>', '<PUBLIC_KEY_URL>', '/path/to/'] as const

// Hard cap. buildRequest.YAML is written verbatim to workdir/template.yml; a
// runaway paste (a whole log, a binary blob) shouldn't quietly hit the server.
const MAX_YAML_BYTES = 200 * 1024

export function AdvancedPage({ onBuildStarted, buildInProgress }: AdvancedPageProps) {
  const manifest = useStore((s) => s.manifest)
  const yaml = useStore((s) => s.advancedYaml)
  const setYaml = useStore((s) => s.setAdvancedYaml)
  const toast = useToast()

  const [seedPick, setSeedPick] = useState('')
  const [seedBusy, setSeedBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [override, setOverride] = useState(false)

  const byteLen = useMemo(() => new Blob([yaml]).size, [yaml])
  const placeholders = useMemo(
    () => PLACEHOLDER_TOKENS.filter((t) => yaml.includes(t)),
    [yaml],
  )

  if (!manifest) return <div className="p-8">Loading…</div>

  const empty = yaml.trim().length === 0
  const tooLarge = byteLen > MAX_YAML_BYTES
  const blockedByPlaceholders = placeholders.length > 0 && !override
  const canBuild =
    !empty && !tooLarge && !blockedByPlaceholders && !busy && !buildInProgress && !seedBusy

  const seedLabel = (i: number): string => {
    const c = manifest.combinations[i]
    const v = manifest.verticals.find((o) => o.id === c.vertical)?.displayName ?? c.vertical
    const sku = c.sku
      ? manifest.skus.find((o) => o.id === c.sku)?.displayName ?? c.sku
      : ''
    const p = manifest.platforms.find((o) => o.id === c.platform)?.displayName ?? c.platform
    const os = manifest.targets.find((o) => o.id === c.os)?.displayName ?? c.os
    const rt = c.kernel === 'rt' ? 'RT' : ''
    return [v, sku, p, os, rt, c.imageType.toUpperCase()].filter(Boolean).join(' · ')
  }

  const onSeed = async (raw: string) => {
    // Always reset the select back to the placeholder so picking the same
    // seed twice still re-fires (and so nothing looks "stuck" selected).
    setSeedPick('')
    if (!raw) return
    const idx = Number(raw)
    const combo = manifest.combinations[idx]
    if (!combo) return

    if (
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

  const onBuild = async () => {
    if (!canBuild) return
    try {
      setBusy(true)
      const accepted = await api.startBuildFromYaml(yaml)
      // Pass the YAML back to App so Retry replays this build (and not the
      // Basic selection, which may be stale or empty).
      onBuildStarted(accepted.buildId, yaml)
    } catch (e) {
      toast.danger((e as Error).message, { title: 'Build failed to start' })
    } finally {
      setBusy(false)
    }
  }

  return (
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
          <li>No client-side YAML validation is performed; syntax errors surface via the build log.</li>
        </ul>
      </Card>

      <Card>
        <div className="mb-4">
          <label
            htmlFor="advanced-seed"
            className={fieldLabelClass}
            style={fieldLabelStyle}
          >
            Seed from template (optional)
          </label>
          <NativeSelect
            id="advanced-seed"
            value={seedPick}
            disabled={seedBusy || busy}
            onChange={(e) => onSeed(e.target.value)}
          >
            <option value="">
              {seedBusy ? 'Loading seed…' : '-- Pick a template to prefill --'}
            </option>
            {manifest.combinations.map((c, i) => (
              <option key={`${c.template}-${i}`} value={i}>
                {seedLabel(i)}
              </option>
            ))}
          </NativeSelect>
        </div>

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
            'focus-within:border-[var(--classic-blue)] dark:focus-within:border-[var(--tine-1)] ' +
            (seedBusy ? 'opacity-60' : '')
          }
        />
        <div className="mt-1 text-xs" style={{ color: 'var(--muted-color)' }}>
          {yaml.length} chars · {(byteLen / 1024).toFixed(1)} KB
          {tooLarge && (
            <span className="ml-2" style={{ color: 'var(--danger-fg)' }}>
              Exceeds 200 KB hard limit — trim before building.
            </span>
          )}
        </div>
      </Card>

      {placeholders.length > 0 && (
        <Card variant="warning" title="Placeholder tokens detected" className="mt-5">
          <ul className="list-disc pl-5 font-mono text-xs">
            {placeholders.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            These are unfilled markers from the reference templates and will make the
            build fail. Replace them, or acknowledge the override below to build anyway.
          </p>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
              className="accent-[var(--classic-blue)]"
            />
            I know these placeholders are present; build anyway.
          </label>
        </Card>
      )}

      <div className="mt-6">
        <button
          className="rounded-md px-5 py-2.5 font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: 'var(--metrics-gradient)' }}
          disabled={!canBuild}
          onClick={onBuild}
        >
          {busy ? 'Starting…' : buildInProgress ? 'Build in progress…' : 'Build Image'}
        </button>
        {empty && !buildInProgress && (
          <span className="ml-3 text-sm text-[var(--muted-color)]">
            Paste template YAML to build.
          </span>
        )}
        {!empty && tooLarge && (
          <span className="ml-3 text-sm" style={{ color: 'var(--danger)' }}>
            YAML exceeds 200 KB — trim before building.
          </span>
        )}
        {!empty && !tooLarge && blockedByPlaceholders && (
          <span className="ml-3 text-sm" style={{ color: 'var(--warning)' }}>
            Resolve placeholders or acknowledge the override to build.
          </span>
        )}
        {buildInProgress && (
          <span className="ml-3 text-sm" style={{ color: 'var(--warning)' }}>
            A build is already in progress. Switch to the Build Image tab to monitor it.
          </span>
        )}
      </div>
    </div>
  )
}
