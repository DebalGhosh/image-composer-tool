import {
  NativeSelect,
  fieldLabelClass,
  fieldLabelStyle,
} from '@/components/controls/Select'
import { seedLabel } from '../model/seedLabel'
import type { Manifest } from '@/api/types'

/**
 * The "prefill from a seed template" dropdown and its Reload button.
 *
 * ⚠️ RELOAD EXISTS BECAUSE THE DROPDOWN CANNOT RE-FIRE. Picking the same option
 * twice is a no-op for `onChange`, so an operator who has edited the buffer and
 * wants the pristine seed back has no way to ask for it. That is the whole
 * purpose of the second control, and it is why the hook exposes `onReloadSeed`
 * separately from `onSeedChange`.
 *
 * Extracted verbatim from AdvancedPage in FE-7d.
 */
export function SeedPickerRow({
  manifest,
  seedPick,
  seedBusy,
  busy,
  onSeedChange,
  onReloadSeed,
}: {
  manifest: Manifest
  seedPick: string
  seedBusy: boolean
  busy: boolean
  onSeedChange: (raw: string) => void | Promise<void>
  onReloadSeed: () => void | Promise<void>
}) {
  return (
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
              {seedLabel(manifest, i)}
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
            {seedLabel(manifest, Number(seedPick))}
          </span>
          . Edit freely — the seed selector will remain so you can revert with Reload.
        </p>
      )}
    </div>

  )
}
