import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface TerminalLogProps {
  logs: string[]
  className?: string
}

// Terminal is ALWAYS dark, in both light and dark app themes. CLI output is a
// long-established convention: operators read build logs against a dark
// surface regardless of the surrounding UI's brightness. Flipping the log
// pane to a light theme when the app is in light mode makes ANSI colors
// (especially yellows and greens) unreadable and breaks convention.
//
// Palette is tuned to match the app's vscode-dark YAML editor (background
// #1e1e1e, foreground ~#d4d4d4) so terminal + code editor read as ONE
// surface family. ANSI colors are picked to have good contrast against
// #1e1e1e without being too saturated.
const TERMINAL_THEME: ITheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#7cc4ff',
  selectionBackground: '#264f78',
  black: '#1e1e1e',
  red: '#f28b82',
  green: '#8bd17c',
  yellow: '#e2c08d',
  blue: '#7cc4ff',
  magenta: '#c792ea',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#6a6a6a',
  brightRed: '#ff9a9a',
  brightGreen: '#a3e0a0',
  brightYellow: '#ffd77a',
  brightBlue: '#a3d6ff',
  brightMagenta: '#dbb0f0',
  brightCyan: '#8de6d8',
  brightWhite: '#ffffff',
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

  // Create the terminal once. Logs are handled by the effect below; no
  // theme effect exists anymore because TERMINAL_THEME is a module-level
  // constant (terminal stays dark in both app themes on purpose).
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
      theme: TERMINAL_THEME,
    })

    const fit = new FitAddon()
    // Without a click handler WebLinksAddon just underlines URLs on hover --
    // clicks are ignored. Open in a new tab so long-running build logs stay
    // put. noopener/noreferrer to keep the child from reaching back into
    // window.opener.
    const links = new WebLinksAddon((_event, url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    })
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
