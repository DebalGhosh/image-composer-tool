import { Card } from '@/components/layout/Card'
import { Select } from '@/components/controls/Select'
import type { CascadeOptions } from '../model/autofill'
import type { Selection } from '@/store'

/**
 * The six dependent dropdowns of "Choose Image Configuration".
 *
 * ⚠️ EACH `disabled` PREDICATE HAS A TWIN in model/autofill.ts. The auto-fill
 * cascade must never set a field the user sees greyed out, so changing a
 * `disabled` here means revisiting the matching rule there. One known asymmetry
 * is documented in that file — auto-fill is deliberately stricter on `platform`.
 *
 * `onChange` goes through the parent's `setSel`, not the store's `setField`
 * directly: setSel also clears any resolved review, so the right pane blanks the
 * instant a field changes instead of showing a stale summary for the debounce
 * window. Auto-fill uses `setField` precisely to AVOID that clearing.
 *
 * Extracted verbatim from BasicPage in FE-7c.
 */
export function CascadeForm({
  selection,
  opts,
  setSel,
}: {
  selection: Selection
  opts: CascadeOptions
  setSel: (k: keyof Selection, v: string) => void
}) {
  return (
    <Card>
      <Select
        label="Targeted Vertical"
        placeholder="-- Select Vertical --"
        value={selection.vertical}
        options={opts.verticals}
        onChange={(v) => setSel('vertical', v)}
      />
      <Select
        label="SKU"
        placeholder="-- Select SKU --"
        value={selection.sku}
        options={opts.skus}
        disabled={!selection.vertical}
        onChange={(v) => setSel('sku', v)}
      />
      <Select
        label="Platform"
        placeholder="-- Select Platform --"
        value={selection.platform}
        options={opts.platforms}
        disabled={!selection.sku && opts.skus.length > 0}
        onChange={(v) => setSel('platform', v)}
      />
      <Select
        label="Operating System"
        placeholder="-- Select Operating System --"
        value={selection.os}
        options={opts.oses}
        disabled={!selection.platform}
        onChange={(v) => setSel('os', v)}
      />
      {/* Kernel selector appears only when the manifest offers kernel
          variants (e.g. standard vs real-time) for the selection. */}
      {opts.kernels.length > 0 && (
        <Select
          label="Kernel"
          placeholder="-- Select Kernel --"
          value={selection.kernel}
          options={opts.kernels}
          disabled={!selection.os}
          onChange={(v) => setSel('kernel', v)}
        />
      )}
      <Select
        label="Image Type"
        placeholder="-- Select Image Type --"
        value={selection.imageType}
        options={opts.imageTypes}
        disabled={!selection.os || (opts.kernels.length > 0 && !selection.kernel)}
        onChange={(v) => setSel('imageType', v)}
      />
    </Card>
  )
}
