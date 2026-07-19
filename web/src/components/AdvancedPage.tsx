import { useMemo, useState } from 'react'
import YAML from 'yaml'
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

// Parsed-YAML validity result. Structural failures block the build; empty and
// too-large are surfaced separately by their own gates.
interface YamlValidity {
  ok: boolean
  message: string | null
  line: number | null
  col: number | null
}

function validateYaml(text: string): YamlValidity {
  if (text.trim().length === 0) {
    // Empty is handled by the `empty` gate; not "invalid" per se.
    return { ok: true, message: null, line: null, col: null }
  }
  try {
    // parse (not parseDocument) throws on the first structural error, which is
    // exactly what we want to surface. It also enforces a valid YAML document.
    YAML.parse(text)
    return { ok: true, message: null, line: null, col: null }
  } catch (e) {
    const err = e as { name?: string; message?: string; linePos?: Array<{ line: number; col: number }> }
    const pos = err.linePos && err.linePos[0]
    return {
      ok: false,
      // Trim trailing "at line X, column Y" from the message — we render that ourselves.
      message: (err.message ?? 'YAML syntax error').replace(/\s*at line \d+, column \d+.*$/s, ''),
      line: pos?.line ?? null,
      col: pos?.col ?? null,
    }
  }
}

export function AdvancedPage({ onBuildStarted, buildInProgress }: AdvancedPageProps) {
  const manifest = useStore((s) => s.manifest)
  const yaml = useStore((s) => s.advancedYaml)
  const setYaml = useStore((s) => s.setAdvancedYaml)
  const seedPick = useStore((s) => s.advancedSeedPick)
  const setSeedPick = useStore((s) => s.setAdvancedSeedPick)
  const toast = useToast()

  const [seedBusy, setSeedBusy] = useState(false)
  const [busy, setBusy] = useState(false)
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

  if (!manifest) return <div className="p-8">Loading…</div>

  const empty = yaml.trim().length === 0
  const tooLarge = byteLen > MAX_YAML_BYTES
  const invalid = !empty && !validity.ok
  const blockedByPlaceholders = placeholders.length > 0 && !override
  const canBuild =
    !empty &&
    !tooLarge &&
    !invalid &&
    !blockedByPlaceholders &&
    !busy &&
    !buildInProgress &&
    !seedBusy

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

  /**
   * Load (or reload) the seed template at index `idx`.
   *
   * Split from onChange so the same-seed-twice case can call it explicitly via
   * the Reload button without going through the dropdown's onChange (which
   * would be a no-op because the value hasn't changed).
   */
  const loadSeed = async (idx: number, confirmReplace: boolean) => {
    const combo = manifest.combinations[idx]
    if (!combo) return

    if (
      confirmReplace &&
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

  const onSeedChange = async (raw: string) => {
    if (!raw) {
      // User cleared the dropdown ("-- Pick a template to prefill --" chosen).
      setSeedPick('')
      return
    }
    setSeedPick(raw)
    await loadSeed(Number(raw), /* confirmReplace= */ true)
  }

  const onReloadSeed = async () => {
    if (!seedPick) return
    await loadSeed(Number(seedPick), /* confirmReplace= */ true)
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
          <li>Syntax is validated client-side as you type; deeper semantic errors surface in the build log.</li>
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
          <div className="flex items-stretch gap-2">
            <NativeSelect
              id="advanced-seed"
              value={seedPick}
              disabled={seedBusy || busy}
              onChange={(e) => onSeedChange(e.target.value)}
              containerClassName="min-w-0 flex-1"
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
            <button
              type="button"
              onClick={onReloadSeed}
              disabled={!seedPick || seedBusy || busy}
              className="rounded-md border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
              style={{ borderColor: 'var(--border-color)', color: 'var(--font-color)' }}
              title={seedPick ? 'Discard local edits and reload the selected seed' : 'Pick a seed first'}
              aria-label="Reload seed template"
            >
              ↻ Reload
            </button>
          </div>
          {seedPick && !seedBusy && (
            <p className="mt-1 text-xs" style={{ color: 'var(--muted-color)' }}>
              Loaded from{' '}
              <span className="font-mono" style={{ color: 'var(--font-color)' }}>
                {seedLabel(Number(seedPick))}
              </span>
              . Edit freely — the seed selector will remain so you can revert with Reload.
            </p>
          )}
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
            (invalid
              ? 'border-[color:var(--danger)] '
              : 'focus-within:border-[var(--classic-blue)] dark:focus-within:border-[var(--tine-1)] ') +
            (seedBusy ? 'opacity-60' : '')
          }
        />
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--muted-color)' }}>
          <span>
            {yaml.length} chars · {(byteLen / 1024).toFixed(1)} KB
          </span>
          {/* Compact live-validity pill. Reads YAMLParseError line/col from `yaml`. */}
          {!empty && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{
                background: validity.ok
                  ? 'color-mix(in srgb, var(--success) 12%, transparent)'
                  : 'color-mix(in srgb, var(--danger) 14%, transparent)',
                color: validity.ok ? 'var(--success)' : 'var(--danger-fg)',
              }}
              aria-live="polite"
            >
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: validity.ok ? 'var(--success)' : 'var(--danger-fg)' }}
              />
              {validity.ok
                ? 'YAML valid'
                : validity.line
                  ? `YAML invalid · line ${validity.line}${validity.col ? `, col ${validity.col}` : ''}`
                  : 'YAML invalid'}
            </span>
          )}
          {tooLarge && (
            <span style={{ color: 'var(--danger-fg)' }}>
              Exceeds 200 KB hard limit — trim before building.
            </span>
          )}
        </div>

        {invalid && validity.message && (
          <div
            className="mt-3 rounded-md border-l-4 p-3 text-xs"
            style={{
              background: 'color-mix(in srgb, var(--danger) 8%, var(--section-background))',
              borderLeftColor: 'var(--danger)',
              color: 'var(--font-color)',
            }}
          >
            <p className="mb-1 font-semibold" style={{ color: 'var(--danger-fg)' }}>
              YAML syntax error
              {validity.line ? ` at line ${validity.line}${validity.col ? `, col ${validity.col}` : ''}` : ''}
            </p>
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed opacity-90">
              {validity.message}
            </pre>
          </div>
        )}
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
        {!empty && invalid && !buildInProgress && (
          <span className="ml-3 text-sm" style={{ color: 'var(--danger)' }}>
            Fix the YAML syntax error to build.
          </span>
        )}
        {!empty && !invalid && tooLarge && (
          <span className="ml-3 text-sm" style={{ color: 'var(--danger)' }}>
            YAML exceeds 200 KB — trim before building.
          </span>
        )}
        {!empty && !invalid && !tooLarge && blockedByPlaceholders && (
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
