export function RoleGlyph({ name }: { name: string }) {
  // Tiny inline SVGs — flat, monochrome-white so they read on the colored
  // segment. Keeping them here avoids adding an icon dep just for six shapes.
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 20 20',
    fill: 'currentColor',
    'aria-hidden': true as const,
  }
  switch (name) {
    case 'efi':
      // "chip" glyph
      return (
        <svg {...common}>
          <rect x="4" y="4" width="12" height="12" rx="1.5" />
          <path d="M2 7h2v1H2zM2 12h2v1H2zM16 7h2v1h-2zM16 12h2v1h-2zM7 2h1v2H7zM12 2h1v2h-1zM7 16h1v2H7zM12 16h1v2h-1z" />
        </svg>
      )
    case 'bios':
      return (
        <svg {...common}>
          <path d="M3 5h14v10H3z" opacity=".4" />
          <path d="M5 8h4v1H5zM5 10h6v1H5zM5 12h3v1H5z" />
        </svg>
      )
    case 'swap':
      return (
        <svg {...common}>
          <path d="M4 6h9l-2-2 1-1 4 4-4 4-1-1 2-2H4zM16 14H7l2 2-1 1-4-4 4-4 1 1-2 2h9z" />
        </svg>
      )
    case 'root':
      return (
        <svg {...common}>
          <path d="M10 2l7 4v8l-7 4-7-4V6z" opacity=".4" />
          <path d="M10 5.5L14.5 8 10 10.5 5.5 8z" />
        </svg>
      )
    case 'verity':
      return (
        <svg {...common}>
          <path d="M10 2l6 3v5c0 4-3 7-6 8-3-1-6-4-6-8V5z" />
        </svg>
      )
    case 'userdata':
      return (
        <svg {...common}>
          <path d="M3 6h6l1 1h7v9H3z" opacity=".5" />
          <path d="M3 6h6l1 1H3z" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="4" />
        </svg>
      )
  }
}

