import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRef } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BuildLogCard } from './BuildLogCard'

/**
 * TerminalLog is STUBBED, deliberately.
 *
 * It wraps xterm.js, which on construction reaches for `matchMedia`, then
 * `ResizeObserver`, then a real layout box — none of which jsdom provides. Left
 * unmocked, this suite becomes a test of how many browser APIs we are willing to
 * fake, and every one of those fakes is a place where a real rendering bug can
 * hide.
 *
 * What is under test here is the CARD: which toolbar buttons are enabled, what
 * the empty state says, and whether the fullscreen ref lands on the element
 * whose `:fullscreen` rule sizes the terminal. All of that is BuildLogCard's own
 * logic and none of it needs a working terminal — only the knowledge that a
 * terminal was asked to render the lines it was given, which the stub asserts by
 * echoing them.
 *
 * The terminal's own behaviour (fit-on-resize, the clientHeight===0 guard) is a
 * by-eye check per the layout rules.
 */
vi.mock('@/components/feedback/TerminalLog', () => ({
  TerminalLog: ({ logs }: { logs: string[] }) => (
    <div data-testid="terminal-stub">{logs.join('\n')}</div>
  ),
}))

/**
 * Two behaviours here are easy to lose in a refactor and both are visible to
 * the operator on every build:
 *
 *   1. Copy and Download are DISABLED while the log is empty (a build that has
 *      only just been dispatched), but Fullscreen is NOT — you can go fullscreen
 *      before the first line arrives and watch it fill.
 *   2. The empty state says "Waiting for build output…" rather than rendering an
 *      empty terminal, so a slow dispatch does not look like a dead one.
 *
 * The fullscreen toggle's own logic lives in hooks/useTerminalFullscreen; here
 * we only pin that the button reflects the state it is handed and that the ref
 * reaches the element the browser will promote.
 */

function setup(over: Partial<Parameters<typeof BuildLogCard>[0]> = {}) {
  const props = {
    logs: [] as string[],
    terminalWrapRef: createRef<HTMLDivElement>(),
    isFullscreen: false,
    toggleFullscreen: vi.fn(),
    copyLogs: vi.fn(),
    downloadLogs: vi.fn(),
    ...over,
  }
  const r = render(<BuildLogCard {...props} />)
  return { ...r, props }
}

const btn = (name: string) =>
  screen.getByRole('button', { name }) as HTMLButtonElement

describe('BuildLogCard', () => {
  afterEach(cleanup)

  describe('with no log lines yet', () => {
    it('shows the waiting placeholder rather than an empty terminal', () => {
      setup()
      expect(screen.getByText('Waiting for build output…')).toBeTruthy()
    })

    it('disables Copy and Download', () => {
      setup()
      expect(btn('Copy').disabled).toBe(true)
      expect(btn('Download').disabled).toBe(true)
    })

    it('leaves Fullscreen ENABLED', () => {
      // You can enter fullscreen before the first line lands.
      setup()
      expect(btn('Fullscreen').disabled).toBe(false)
    })

    it('does not fire the disabled handlers when clicked', async () => {
      const { props } = setup()
      await userEvent.click(btn('Copy'))
      await userEvent.click(btn('Download'))
      expect(props.copyLogs).not.toHaveBeenCalled()
      expect(props.downloadLogs).not.toHaveBeenCalled()
    })
  })

  describe('with log lines', () => {
    it('drops the placeholder', () => {
      setup({ logs: ['line one', 'line two'] })
      expect(screen.queryByText('Waiting for build output…')).toBeNull()
    })

    it('enables and wires Copy', async () => {
      const { props } = setup({ logs: ['a'] })
      expect(btn('Copy').disabled).toBe(false)
      await userEvent.click(btn('Copy'))
      expect(props.copyLogs).toHaveBeenCalledTimes(1)
    })

    it('enables and wires Download', async () => {
      const { props } = setup({ logs: ['a'] })
      expect(btn('Download').disabled).toBe(false)
      await userEvent.click(btn('Download'))
      expect(props.downloadLogs).toHaveBeenCalledTimes(1)
    })
  })

  describe('the fullscreen toggle', () => {
    it('reads "Fullscreen" with an Esc-free tooltip when windowed', () => {
      setup({ isFullscreen: false })
      expect(btn('Fullscreen').getAttribute('title')).toBe(
        'View terminal fullscreen',
      )
    })

    it('flips to "Collapse" and mentions Esc when fullscreen', () => {
      // The label is driven by the browser's fullscreenchange event upstream,
      // so it stays correct when the user leaves via Escape.
      setup({ isFullscreen: true })
      expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull()
      expect(btn('Collapse').getAttribute('title')).toBe(
        'Exit fullscreen (Esc)',
      )
    })

    it('calls toggleFullscreen', async () => {
      const { props } = setup()
      await userEvent.click(btn('Fullscreen'))
      expect(props.toggleFullscreen).toHaveBeenCalledTimes(1)
    })
  })

  it('attaches the ref to the element carrying the fullscreen-host class', () => {
    // `.terminal-fullscreen-host:fullscreen` in index.css sets height:100vh on
    // exactly this element. If the ref and the class ever drift apart, native
    // fullscreen silently sizes the wrong box.
    const { props } = setup()
    const el = props.terminalWrapRef.current
    expect(el).not.toBeNull()
    expect(el!.classList.contains('terminal-fullscreen-host')).toBe(true)
  })

  it('gives all three toolbar buttons an accessible name', () => {
    // They are icon-only; without aria-label they are unreachable by name.
    setup({ logs: ['a'] })
    for (const name of ['Copy', 'Download', 'Fullscreen']) {
      expect(btn(name).getAttribute('aria-label')).toBe(name)
    }
  })
})
