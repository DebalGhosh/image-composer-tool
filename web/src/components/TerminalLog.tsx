import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'

interface TerminalLogProps {
  logs: string[]
  className?: string
}

// Themes that read the CSS custom properties the rest of the app uses, so
// light/dark mode flips the terminal too. Kept minimal -- xterm gives us
// full ANSI 256-color rendering out of the box; we just supply the base
// palette.
function themeFor(mode: 'dark' | 'light'): ITheme {
  if (mode === 'dark') {
    return {
      background: '#0b1220',
      foreground: '#e5eefc',
      cursor: '#7cc4ff',
      selectionBackground: '#2f4a7a',
      black: '#0b1220',
      red: '#ff6b6b',
      green: '#5ee0a0',
      yellow: '#f7c948',
      blue: '#7cc4ff',
      magenta: '#c792ea',
      cyan: '#5ce6d0',
      white: '#e5eefc',
      brightBlack: '#4a5670',
      brightRed: '#ff8a8a',
      brightGreen: '#7ee8b0',
      brightYellow: '#ffd77a',
      brightBlue: '#a3d6ff',
      brightMagenta: '#dbb0f0',
      brightCyan: '#8de6d8',
      brightWhite: '#ffffff',
    }
  }
  return {
    background: '#f8fafc',
    foreground: '#0f172a',
    cursor: '#1d4ed8',
    selectionBackground: '#c7d2fe',
    black: '#111827',
    red: '#b91c1c',
    green: '#047857',
    yellow: '#a16207',
    blue: '#1d4ed8',
    magenta: '#7c3aed',
    cyan: '#0e7490',
    white: '#0f172a',
    brightBlack: '#475569',
    brightRed: '#dc2626',
    brightGreen: '#059669',
    brightYellow: '#ca8a04',
    brightBlue: '#2563eb',
    brightMagenta: '#9333ea',
    brightCyan: '#0891b2',
    brightWhite: '#0f172a',
  }
}

// Jenkins wraps its per-line audit metadata in an SGR-8 concealed block:
//   ESC [ 8 m ha:////<base64...> ESC [ 0 m
// The base64 payload is enormous (200+ chars per line) and, even though
// terminals hide it visually, xterm still allocates the cursor advance
// which produces a big visual gap between the visible text and the rest
// of the line. Strip the whole concealed span before writing so the
// terminal never sees it. This matches how Jenkins' own web console
// displays these lines.
//
// eslint-disable-next-line no-control-regex
const SGR8_CONCEAL = /\x1b\[8m[^\x1b]*\x1b\[0?m/g

export function TerminalLog({ logs, className }: TerminalLogProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const writtenRef = useRef(0)
  const theme = useStore((s) => s.theme)

  // Create the terminal once. Theme + logs are handled by the effects below.
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      convertEol: true,       // treat '\n' as CRLF -- our lines already end this way
      cursorBlink: false,     // read-only pane, no blinking
      cursorStyle: 'bar',
      disableStdin: true,     // this is a viewer, not an interactive shell
      fontFamily: '"Intel One Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 10000,      // ICT builds emit tens of thousands of lines
      allowProposedApi: true,
      theme: themeFor(theme),
    })

    const fit = new FitAddon()
    const links = new WebLinksAddon()
    term.loadAddon(fit)
    term.loadAddon(links)

    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // Refit on container resize (window resize, panel resize, tab switch
    // that flips 'hidden' back to visible, ...).
    const ro = new ResizeObserver(() => {
      // FitAddon reads clientWidth/clientHeight; a zero-size container (e.g.
      // during the initial hidden mount) blows up its rows/cols math.
      const el = containerRef.current
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        /* container still animating; try again next tick */
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      writtenRef.current = 0
    }
  }, [])

  // Push only newly-added lines to the terminal. Tracking writtenRef lets
  // this component be a pure function of the logs array without ever
  // rewriting history.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (logs.length < writtenRef.current) {
      // Log array shrank (buildId changed and parent reset logs to []).
      // Nuke the terminal too so history doesn't bleed across builds.
      term.reset()
      writtenRef.current = 0
    }
    if (logs.length === writtenRef.current) return
    for (let i = writtenRef.current; i < logs.length; i++) {
      const clean = logs[i].replace(SGR8_CONCEAL, '')
      term.writeln(clean)
    }
    writtenRef.current = logs.length
    // Keep the view pinned to the newest line.
    term.scrollToBottom()
  }, [logs])

  // Live theme switching.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = themeFor(theme)
  }, [theme])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        // xterm draws into this div with its own canvas. Padding must live
        // OUTSIDE the terminal or its viewport math gets confused, so we
        // leave the container padding-free and let the outer Card pad it.
        width: '100%',
        height: '100%',
      }}
    />
  )
}
