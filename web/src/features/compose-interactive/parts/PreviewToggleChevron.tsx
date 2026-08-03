export function PreviewToggleChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      aria-hidden="true"
      style={{
        color: 'currentColor',
        transform: collapsed ? 'rotate(90deg)' : 'rotate(-90deg)',
        transition: 'transform 220ms cubic-bezier(0.22, 0.7, 0.32, 1)',
      }}
    >
      <path
        d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z"
        fill="currentColor"
      />
    </svg>
  )
}

/* ------------------------------------------------------------------------- *
 * Segmented — radio-style pill row.
 * ------------------------------------------------------------------------- */

