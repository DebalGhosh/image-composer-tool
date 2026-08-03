import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FailureBanner } from './FailureBanner'

/**
 * The banner distinguishes a FAILED build from a CANCELLED one, which matters:
 * a cancel is the operator's own doing and a failure is not, and the retry
 * affordance reads differently in each case. Both share the same button.
 */
describe('FailureBanner', () => {
  afterEach(cleanup)

  it('says "Build failed." for a failure', () => {
    render(
      <FailureBanner status="failed" retrying={false} onRetry={vi.fn()} />,
    )
    expect(screen.getByText('Build failed.')).toBeTruthy()
    expect(screen.queryByText('Build cancelled.')).toBeNull()
  })

  it('says "Build cancelled." for a cancellation', () => {
    render(
      <FailureBanner status="cancelled" retrying={false} onRetry={vi.fn()} />,
    )
    expect(screen.getByText('Build cancelled.')).toBeTruthy()
    expect(screen.queryByText('Build failed.')).toBeNull()
  })

  it('offers an enabled Retry button at rest', () => {
    render(
      <FailureBanner status="failed" retrying={false} onRetry={vi.fn()} />,
    )
    const btn = screen.getByRole('button', { name: '↺ Retry' })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })

  it('calls onRetry when clicked', async () => {
    const retry = vi.fn().mockResolvedValue(undefined)
    render(
      <FailureBanner status="failed" retrying={false} onRetry={retry} />,
    )
    await userEvent.click(screen.getByRole('button', { name: '↺ Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('shows "Starting…" and DISABLES itself while a retry is in flight', () => {
    render(<FailureBanner status="failed" retrying onRetry={vi.fn()} />)
    const btn = screen.getByRole('button', { name: 'Starting…' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '↺ Retry' })).toBeNull()
  })

  it('cannot be double-fired while retrying', async () => {
    const retry = vi.fn().mockResolvedValue(undefined)
    render(<FailureBanner status="failed" retrying onRetry={retry} />)
    await userEvent.click(screen.getByRole('button', { name: 'Starting…' }))
    // Dispatching a second build for the same failure would create a duplicate
    // Jenkins job. The disabled attribute is what prevents it.
    expect(retry).not.toHaveBeenCalled()
  })
})
