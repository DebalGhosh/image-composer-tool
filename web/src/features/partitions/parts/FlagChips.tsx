import { FLAG_CHOICES } from '../model/roles'

export function FlagChips({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (flag: string) => {
    const set = new Set(value)
    if (set.has(flag)) set.delete(flag)
    else set.add(flag)
    // Preserve FLAG_CHOICES order so serialized output is stable.
    onChange(FLAG_CHOICES.filter((f) => set.has(f)))
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {FLAG_CHOICES.map((f) => {
        const on = value.includes(f)
        return (
          <button
            key={f}
            type="button"
            onClick={() => toggle(f)}
            className="cursor-pointer rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--classic-blue)]"
            style={{
              background: on
                ? 'color-mix(in srgb, var(--classic-blue) 22%, var(--section-background))'
                : 'var(--input-background)',
              borderColor: on
                ? 'color-mix(in srgb, var(--classic-blue) 60%, var(--border-color))'
                : 'var(--border-color)',
              color: 'var(--font-color)',
            }}
            aria-pressed={on}
          >
            {f}
          </button>
        )
      })}
    </div>
  )
}

