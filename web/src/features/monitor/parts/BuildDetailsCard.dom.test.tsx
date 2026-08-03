import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BuildDetailsCard } from './BuildDetailsCard'
import { CommandBlock } from './CommandBlock'
import { TemplateRow } from './TemplateRow'
import type { BuildDetails } from '@/api/types'

/**
 * Covers the three leaves BuildDetailsCard composes, plus the card's own job
 * (being collapsed on arrival).
 *
 * The colour assertions look pedantic and are not: #1e1e1e / #d4d4d4 are
 * hard-coded rather than themed so the command block, the log terminal and the
 * YAML editor stay one visual family in BOTH app themes. A well-meaning
 * "replace magic values with tokens" pass would flip this block to a light
 * surface in light mode, and nothing else in the suite would notice.
 */

const details = {
  command: 'ict compose --template seed.yaml --dispatch',
  template: 'ubuntu-24.04-minimal.yaml',
} as BuildDetails

describe('BuildDetailsCard', () => {
  afterEach(cleanup)

  it('starts COLLAPSED — the log is what an operator wants on arrival', () => {
    render(
      <BuildDetailsCard
        details={details}
        buildId="b1"
        copyCommand={vi.fn()}
      />,
    )
    expect(screen.getByText('Build details')).toBeTruthy()
    // Card collapses via a grid-rows transition, NOT by unmounting — it needs
    // the content in the DOM to measure the open height. So the command is
    // present but inside an aria-hidden subtree, and the toggle reports closed.
    const toggle = screen.getByRole('button', { expanded: false })
    expect(toggle.textContent).toContain('Build details')
    const region = screen
      .getByText(details.command)
      .closest('[aria-hidden="true"]')
    expect(region).not.toBeNull()
  })

  it('reveals the command, template and metadata once expanded', async () => {
    render(
      <BuildDetailsCard
        details={{ ...details, workDir: '/tmp/ict-work' } as BuildDetails}
        buildId="b1"
        copyCommand={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByText('Build details'))
    expect(screen.getByText(details.command)).toBeTruthy()
    expect(screen.getByText(details.template)).toBeTruthy()
    expect(screen.getByText('Work dir')).toBeTruthy()
  })
})

describe('CommandBlock', () => {
  afterEach(cleanup)

  it('shows the command verbatim', () => {
    render(<CommandBlock command={details.command} copyCommand={vi.fn()} />)
    expect(screen.getByText(details.command)).toBeTruthy()
  })

  it('calls copyCommand when Copy is clicked', async () => {
    const copy = vi.fn()
    render(<CommandBlock command={details.command} copyCommand={copy} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(copy).toHaveBeenCalledTimes(1)
  })

  it('keeps the vscode-dark surface hard-coded, NOT themed', () => {
    // See the file header: three "code surfaces" stay dark in both app themes.
    render(<CommandBlock command={details.command} copyCommand={vi.fn()} />)
    const pre = screen.getByText(details.command)
    expect(pre.tagName).toBe('PRE')
    expect(pre.style.background).toBe('rgb(30, 30, 30)') // #1e1e1e
    expect(pre.style.color).toBe('rgb(212, 212, 212)') // #d4d4d4
  })

  it('does not wrap — long commands scroll horizontally', () => {
    // Wrapping a 300-char dispatch command would push the log off-screen.
    render(<CommandBlock command={details.command} copyCommand={vi.fn()} />)
    expect(
      screen.getByText(details.command).className,
    ).toContain('overflow-x-auto')
  })
})

describe('TemplateRow', () => {
  afterEach(cleanup)

  it('shows the template filename', () => {
    render(<TemplateRow template={details.template} buildId="b1" />)
    expect(screen.getByText(details.template)).toBeTruthy()
  })

  it('routes the download through api.templateUrl so BASE is applied', () => {
    render(<TemplateRow template={details.template} buildId="b42" />)
    const dl = screen.getByRole('link', { name: 'Download' })
    // The buildId, not the template name, identifies the stored template.
    expect(dl.getAttribute('href')).toContain('b42')
  })

  it('saves under the TEMPLATE name, not the build id', () => {
    render(<TemplateRow template={details.template} buildId="b42" />)
    expect(
      screen.getByRole('link', { name: 'Download' }).getAttribute('download'),
    ).toBe(details.template)
  })
})
