/**
 * Disclosure caret for the combobox family.
 *
 * Was declared byte-identically in Combobox.tsx and MultiCombobox.tsx. One copy
 * here so the rotation timing cannot drift between the two controls sitting side
 * by side in the same form.
 *
 * `currentColor` throughout, and no colour of its own, so it inherits from
 * whatever control hosts it in both themes. The rotation is on `transform`,
 * which is safe HERE — this is a leaf with no positioned descendants — but note
 * that a transform on a container creates a containing block for
 * `position: fixed`; see .claude/UI-LAYOUT.md before adding one higher up.
 */
export function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4 shrink-0"
      aria-hidden
      style={{
        color: 'currentColor',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 200ms cubic-bezier(0.22, 0.7, 0.32, 1)',
      }}
    >
      <path
        d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z"
        fill="currentColor"
      />
    </svg>
  )
}
