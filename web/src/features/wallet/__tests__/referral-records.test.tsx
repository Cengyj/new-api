/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import type { ReactNode } from 'react'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import zh from '@/i18n/locales/zh.json'
import { api } from '@/lib/api'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { AffiliateRewardsCard } from '../components/affiliate-rewards-card'
import { ReferralInviteesDialog } from '../components/dialogs/referral-invitees-dialog'
import { ReferralRecordsDialog } from '../components/dialogs/referral-records-dialog'
import { ReferralQuota } from '../components/referral-quota'

const success = (data: unknown) => ({ data: { success: true, data } })
const summary = {
  rule: { enabled: false, rate_bps: 1000, valid_days: 30 },
  compliance_confirmed: true,
  aff_quota: '0',
  aff_history_quota: '2000000',
  rebate_quota: '500000',
  direct_count: 2,
}
function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}
beforeEach(() => {
  sessionStorage.clear()
  useAuthStore.getState().auth.reset()
  useAuthStore.getState().auth.setUser({ id: 1, username: 'first', role: 1 })
  useSystemConfigStore.getState().setConfig({
    currency: { ...DEFAULT_CURRENCY_CONFIG },
  })
})

test('the card keeps four responsive statistics, disables below-threshold transfers and loads invitations only on demand', async () => {
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url === '/api/user/aff') return success('first')
      if (config.url === '/api/user/referral/invitees') {
        return success({ items: [], total: 0 })
      }
      return success(summary)
    })
  mount(<AffiliateRewardsCard onBalanceChanged={vi.fn()} />)
  expect(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  ).toBeDisabled()
  expect(screen.getByText('Total top-up rebates')).toBeVisible()
  const grid = screen.getByText('Direct invitations').closest('dl')
  expect(grid).toHaveClass('grid-cols-2', 'sm:grid-cols-4')
  expect(screen.queryByText(/quota units/)).not.toBeInTheDocument()
  expect(
    screen
      .getByRole('heading', { name: 'Referral Program' })
      .closest('[data-slot="card-header"]')
  ).toHaveTextContent('Activity paused')
  expect(
    screen.queryByRole('heading', { name: 'Invitation top-up rebates' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Top-up rebate records' })
  ).not.toBeInTheDocument()
  expect(
    request.mock.calls.some(([config]) => config.url?.includes('/invitees'))
  ).toBe(false)
  const user = userEvent.setup()
  const trigger = screen.getByRole('button', { name: 'Invitation records' })
  trigger.focus()
  await user.keyboard('{Enter}')
  expect(await screen.findByText('No invitations yet')).toBeVisible()
  expect(screen.getByRole('navigation', { name: 'Page' })).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(trigger).toHaveFocus()
})

test.each([
  [ROLE.ADMIN, true],
  [ROLE.SUPER_ADMIN, false],
])(
  'role %s keeps its sole management entry without duplicating the settings entry',
  async (role, visible) => {
    useAuthStore.getState().auth.setUser({ id: 1, username: 'first', role })
    vi.spyOn(api, 'request').mockImplementation(async (config) =>
      success(config.url === '/api/user/aff' ? 'first' : summary)
    )
    mount(<AffiliateRewardsCard onBalanceChanged={vi.fn()} />)
    await screen.findByText('Direct invitations')
    expect(
      screen.getByRole('button', { name: 'Invitation records' })
    ).toBeVisible()
    const management = screen.queryByRole('button', {
      name: 'Top-up rebate records',
    })
    if (visible) expect(management).toBeVisible()
    else expect(management).not.toBeInTheDocument()
  }
)

test('losing administrator privileges closes records and discards their late response in the same session', async () => {
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'first', role: ROLE.ADMIN })
  let finish!: (value: ReturnType<typeof success>) => void
  const response = new Promise<ReturnType<typeof success>>((resolve) => {
    finish = resolve
  })
  let recordsSignal: AbortSignal | undefined
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.url === '/api/user/referral_rebates') {
      recordsSignal = config.signal as AbortSignal
      return response
    }
    return success(config.url === '/api/user/aff' ? 'first' : summary)
  })
  mount(<AffiliateRewardsCard onBalanceChanged={vi.fn()} />)
  await userEvent.click(
    await screen.findByRole('button', { name: 'Top-up rebate records' })
  )
  await waitFor(() => expect(recordsSignal).toBeDefined())

  act(() =>
    useAuthStore
      .getState()
      .auth.setUser({ id: 1, username: 'first', role: ROLE.USER })
  )

  expect(
    screen.queryByRole('dialog', { name: 'Top-up rebate records' })
  ).not.toBeInTheDocument()
  expect(recordsSignal?.aborted).toBe(true)
  await act(async () => {
    finish(
      success({ items: [], total: 0, credited_quota: '0', reward_quota: '0' })
    )
    await response
  })
  expect(
    screen.queryByRole('dialog', { name: 'Top-up rebate records' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Top-up rebate records' })
  ).not.toBeInTheDocument()
})

test('server eligibility and unknown historical values are displayed without browser expiry calculations', async () => {
  vi.spyOn(api, 'request').mockResolvedValue(
    success({
      total: 5,
      items: ['none', 'expired', 'paused', 'active', 'none'].map(
        (status, index) => ({
          id: index + 2,
          display_name: `user-${index}`,
          deleted: index <= 1,
          created_at: null,
          status,
          rate_bps: index === 0 || index === 4 ? null : 1000,
          expires_at: index === 0 || index === 4 ? null : 1,
          rebate_quota: '1',
        })
      ),
    })
  )
  mount(<ReferralInviteesDialog onOpenChange={vi.fn()} />)
  const missingProfile = await screen.findByRole('row', {
    name: /Deleted user ID: 2/,
  })
  expect(within(missingProfile).queryByText('Not eligible')).toBeNull()
  expect(within(missingProfile).getAllByText('—')).toHaveLength(2)
  const retainedSnapshot = screen.getByRole('row', {
    name: /Deleted user ID: 3/,
  })
  expect(within(retainedSnapshot).getByText('Expired')).toBeVisible()
  for (const status of [
    'Not eligible',
    'Expired',
    'Activity paused',
    'Eligible',
  ]) {
    const badge = screen.getByText(status, { exact: true })
    expect(badge).toBeVisible()
    expect(badge.closest('[data-slot=status-badge]')).toHaveAttribute(
      'title',
      status
    )
  }
  expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  expect(screen.getByRole('table')).toHaveClass('min-w-[850px]')
})

test('server pagination fetches the requested page and keeps the dialog footer accessible', async () => {
  const request = vi.spyOn(api, 'request').mockImplementation(async (config) =>
    success({
      total: 11,
      items: [
        {
          id: Number((config.params as { p: number }).p),
          display_name: `page-${(config.params as { p: number }).p}`,
          deleted: false,
          created_at: null,
          status: 'none',
          rate_bps: null,
          expires_at: null,
          rebate_quota: '0',
        },
      ],
    })
  )
  mount(<ReferralInviteesDialog onOpenChange={vi.fn()} />)
  await screen.findByText('page-1')
  fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }))
  expect(await screen.findByText('page-2')).toBeVisible()
  expect(request.mock.calls.at(-1)?.[0].params).toEqual({ p: 2, page_size: 10 })
  expect(
    screen
      .getByRole('navigation', { name: 'Page' })
      .closest('[data-slot=dialog-footer]')
  ).toBeInTheDocument()
})

test.each(['invitees', 'records'] as const)(
  '%s uses direct page buttons and a rows-per-page selector while keeping navigation mounted during loading',
  async (kind) => {
    const page = (number: number) =>
      kind === 'invitees'
        ? {
            total: 30,
            items: [
              {
                id: number,
                display_name: `page-${number}`,
                deleted: false,
                created_at: null,
                status: 'none',
                rate_bps: null,
                expires_at: null,
                rebate_quota: '0',
              },
            ],
          }
        : {
            total: 30,
            credited_quota: '3000000',
            reward_quota: '300000',
            items: [
              {
                id: number,
                trade_no: `page-${number}`,
                inviter_id: 1,
                invitee_id: 2,
                credited_quota: '100000',
                reward_quota: '10000',
                rate_bps: 1000,
                settled_at: 1,
                created_at: 1,
              },
            ],
          }
    let finish!: (value: ReturnType<typeof success>) => void
    const pending = new Promise<ReturnType<typeof success>>((resolve) => {
      finish = resolve
    })
    const request = vi
      .spyOn(api, 'request')
      .mockResolvedValueOnce(success(page(1)))
      .mockImplementationOnce(() => pending)
      .mockResolvedValueOnce(success(page(1)))
    mount(
      kind === 'invitees' ? (
        <ReferralInviteesDialog onOpenChange={vi.fn()} />
      ) : (
        <ReferralRecordsDialog onOpenChange={vi.fn()} />
      )
    )
    await screen.findByText('page-1')
    const user = userEvent.setup()
    expect(screen.getByRole('combobox')).toHaveTextContent('10')
    await user.click(screen.getByRole('button', { name: /Go to page 3/ }))
    await waitFor(() =>
      expect(request.mock.calls.at(-1)?.[0].params).toMatchObject({
        p: 3,
        page_size: 10,
      })
    )
    expect(screen.getByRole('navigation', { name: 'Page' })).toBeVisible()
    expect(screen.getByRole('button', { name: /Go to page 3/ })).toBeDisabled()
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Go to previous page' })
    ).toBeDisabled()
    expect(screen.queryByText('page-1')).not.toBeInTheDocument()
    await act(async () => {
      finish(success(page(3)))
      await pending
    })
    expect(await screen.findByText('page-3')).toBeVisible()
    expect(screen.getByRole('button', { name: /Go to page 3/ })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: /Go to page 3/ })
    ).toHaveAttribute('aria-current', 'page')
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: /^20$/ }))
    await waitFor(() =>
      expect(request.mock.calls.at(-1)?.[0].params).toMatchObject({
        p: 1,
        page_size: 20,
      })
    )
    expect(await screen.findByText('page-1')).toBeVisible()
    expect(screen.getByRole('combobox')).toHaveTextContent('20')
    expect(
      screen.getByRole('button', { name: /Go to page 1/ })
    ).toHaveAttribute('aria-current', 'page')
  }
)

test('pagination placeholders do not expose the prior account records after an account switch', async () => {
  let finish!: (value: ReturnType<typeof success>) => void
  const pending = new Promise<ReturnType<typeof success>>((resolve) => {
    finish = resolve
  })
  vi.spyOn(api, 'request')
    .mockResolvedValueOnce(
      success({
        total: 2,
        items: [
          {
            id: 2,
            display_name: 'account-one-invitee',
            deleted: false,
            created_at: null,
            status: 'none',
            rate_bps: null,
            expires_at: null,
            rebate_quota: '0',
          },
        ],
      })
    )
    .mockImplementationOnce(() => pending)
  mount(<ReferralInviteesDialog onOpenChange={vi.fn()} />)
  await screen.findByText('account-one-invitee')
  act(() =>
    useAuthStore.getState().auth.setUser({ id: 9, username: 'second', role: 1 })
  )
  expect(screen.queryByText('account-one-invitee')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('navigation', { name: 'Page' })
  ).not.toBeInTheDocument()
  await act(async () => {
    finish(success({ total: 0, items: [] }))
    await pending
  })
  expect(await screen.findByText('No invitations yet')).toBeVisible()
})

test('admin filters apply together, reset to page one, and totals represent the full server match', async () => {
  const request = vi.spyOn(api, 'request').mockResolvedValue(
    success({
      items: [
        {
          id: 7,
          trade_no: `order-${'x'.repeat(100)}`,
          inviter_id: 1,
          invitee_id: 2,
          credited_quota: '50000000',
          reward_quota: '5000000',
          rate_bps: 1000,
          settled_at: 1,
          created_at: 2,
        },
      ],
      total: 25,
      credited_quota: '9007199254740993',
      reward_quota: '5000000',
    })
  )
  mount(<ReferralRecordsDialog onOpenChange={vi.fn()} />)
  expect(
    await screen.findByText('9,007,199,254,740,993 quota units')
  ).toBeVisible()
  expect(
    screen.getByText(
      'Totals include all matching records, not only the current page.'
    )
  ).toBeVisible()
  expect(
    screen.getByRole('region', { name: 'Top-up rebate records' })
  ).toHaveClass('flex-1', 'overflow-auto')
  expect(screen.getByRole('table').querySelector('thead')).toHaveClass(
    'sticky',
    'top-0'
  )
  expect(
    screen
      .getByRole('navigation', { name: 'Page' })
      .closest('[data-slot=dialog-footer]')
  ).toBeInTheDocument()
  const order = screen.getByRole('button', {
    name: `Order number: order-${'x'.repeat(100)}`,
  })
  expect(within(order).getByText('xxxxxxxxxxxx', { exact: true })).toHaveClass(
    'shrink-0'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }))
  await waitFor(() =>
    expect(request.mock.calls.at(-1)?.[0].params).toMatchObject({ p: 2 })
  )
  fireEvent.change(screen.getByLabelText('Inviter ID'), {
    target: { value: '12' },
  })
  fireEvent.change(screen.getByLabelText('Invitee ID'), {
    target: { value: '34' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  await waitFor(() =>
    expect(request.mock.calls.at(-1)?.[0].params).toMatchObject({
      p: 1,
      inviter_id: '12',
      invitee_id: '34',
    })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
  await waitFor(() =>
    expect(request.mock.calls.at(-1)?.[0].params).toMatchObject({
      p: 1,
      inviter_id: '',
      invitee_id: '',
    })
  )
})

test('reusing cached filter values keeps pagination mounted while an uncached page loads', async () => {
  let finish!: (value: ReturnType<typeof success>) => void
  const pending = new Promise<ReturnType<typeof success>>((resolve) => {
    finish = resolve
  })
  const page = (number: number, inviter: string) => ({
    total: 30,
    credited_quota: '3000000',
    reward_quota: '300000',
    items: [
      {
        id: number,
        trade_no: `${inviter}-page-${number}`,
        inviter_id: 12,
        invitee_id: 2,
        credited_quota: '100000',
        reward_quota: '10000',
        rate_bps: 1000,
        settled_at: 1,
        created_at: 1,
      },
    ],
  })
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      const params = config.params as { p: number; inviter_id: string }
      if (params.p === 2) return pending
      return success(page(params.p, params.inviter_id || 'all'))
    })
  mount(<ReferralRecordsDialog onOpenChange={vi.fn()} />)
  await screen.findByText('all-page-1')
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Inviter ID'), '12')
  await user.click(screen.getByRole('button', { name: 'Search' }))
  await screen.findByText('12-page-1')
  await user.click(screen.getByRole('button', { name: 'Reset' }))
  await screen.findByText('all-page-1')
  await user.type(screen.getByLabelText('Inviter ID'), '12')
  await user.click(screen.getByRole('button', { name: 'Search' }))
  await screen.findByText('12-page-1')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Go to page 2/ })).toBeEnabled()
  )
  await user.click(screen.getByRole('button', { name: /Go to page 2/ }))
  await waitFor(() =>
    expect(request.mock.calls.at(-1)?.[0].params).toMatchObject({
      p: 2,
      inviter_id: '12',
    })
  )
  expect(screen.getByRole('navigation', { name: 'Page' })).toBeVisible()
  expect(screen.getByRole('button', { name: /Go to page 2/ })).toBeDisabled()
  expect(screen.queryByText('12-page-1')).not.toBeInTheDocument()
  await act(async () => {
    finish(success(page(2, '12')))
    await pending
  })
  expect(await screen.findByText('12-page-2')).toBeVisible()
  expect(screen.getByRole('button', { name: /Go to page 2/ })).toHaveFocus()
})

test.each([false, true])(
  'long order numbers preserve their suffix without a second ellipsis on mobile=%s',
  async (mobile) => {
    const original = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...original(query),
      matches: query.includes('max-width') ? mobile : original(query).matches,
    }))
    const order = 'DEMO-LOCAL-NO-PAYMENT-18-creem-OmrIjZVAFuHKOhyNZ6YMpV'
    vi.spyOn(api, 'request').mockResolvedValue(
      success({
        items: [
          {
            id: 18,
            trade_no: order,
            inviter_id: 1,
            invitee_id: 2,
            credited_quota: '500000',
            reward_quota: '50000',
            rate_bps: 1000,
            settled_at: 1,
            created_at: 2,
          },
        ],
        total: 1,
        credited_quota: '500000',
        reward_quota: '50000',
      })
    )
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    mount(<ReferralRecordsDialog onOpenChange={vi.fn()} />)
    const trigger = await screen.findByRole('button', {
      name: `Order number: ${order}`,
    })
    expect(trigger).toHaveTextContent('DEMO-LOCAL-NO-PA…HKOhyNZ6YMpV')
    const prefix = within(trigger).getByText('DEMO-LOCAL-NO-PA', {
      exact: true,
    })
    expect(prefix).toHaveClass('min-w-0', 'overflow-hidden')
    expect(prefix).not.toHaveClass('truncate')
    expect(
      within(trigger).getByText('HKOhyNZ6YMpV', { exact: true })
    ).toHaveClass('shrink-0')
    expect(within(trigger).getByText('…', { exact: true })).toHaveClass(
      'shrink-0'
    )
    expect(screen.queryByText(order, { exact: true })).not.toBeInTheDocument()
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(
      await screen.findByRole('dialog', { name: 'Order number' })
    ).toHaveTextContent(order)
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Order number' })
      ).not.toBeInTheDocument()
    )
    expect(trigger).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Copy order number' }))
    expect(copy).toHaveBeenCalledWith(order)
  }
)

test('the compact date filter commits local timestamps together and rejects a reversed range', async () => {
  const request = vi
    .spyOn(api, 'request')
    .mockResolvedValue(
      success({ items: [], total: 0, credited_quota: '0', reward_quota: '0' })
    )
  mount(<ReferralRecordsDialog onOpenChange={vi.fn()} />)
  await screen.findByText('No rebate records')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Date Range' }))
  fireEvent.change(screen.getByLabelText('Start Time'), {
    target: { value: '2026-10-01T09:00:15' },
  })
  fireEvent.change(screen.getByLabelText('End Time'), {
    target: { value: '2026-10-02T18:30:45' },
  })
  await user.click(screen.getByRole('button', { name: 'Confirm' }))
  expect(request).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: 'Search' }))
  await waitFor(() =>
    expect(request.mock.calls.at(-1)?.[0].params).toMatchObject({
      p: 1,
      start_time: String(new Date('2026-10-01T09:00:15').getTime() / 1000),
      end_time: String(new Date('2026-10-02T18:30:45').getTime() / 1000),
    })
  )
  await user.click(screen.getByRole('button', { name: /2026-10-01 09:00:15/ }))
  fireEvent.change(screen.getByLabelText('Start Time'), {
    target: { value: '2026-10-03T09:00:15' },
  })
  await user.click(screen.getByRole('button', { name: 'Confirm' }))
  await user.click(screen.getByRole('button', { name: 'Search' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Enter a valid time range with the start before the end'
  )
  expect(request).toHaveBeenCalledTimes(2)
  await user.click(screen.getByRole('button', { name: 'Reset' }))
  expect(screen.getByRole('button', { name: 'Date Range' })).toBeVisible()
  await waitFor(() =>
    expect(request.mock.calls.at(-1)?.[0].params).toMatchObject({
      p: 1,
      start_time: '',
      end_time: '',
    })
  )
})

test('the Today date preset includes the final second with an exclusive upper bound', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-19T12:00:00'))
  try {
    const request = vi
      .spyOn(api, 'request')
      .mockResolvedValue(
        success({ items: [], total: 0, credited_quota: '0', reward_quota: '0' })
      )
    mount(<ReferralRecordsDialog onOpenChange={vi.fn()} />)
    await screen.findByText('No rebate records')
    fireEvent.click(screen.getByRole('button', { name: 'Date Range' }))
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() =>
      expect(request.mock.calls.at(-1)?.[0].params).toMatchObject({
        start_time: String(new Date('2026-10-19T00:00:00').getTime() / 1000),
        end_time: String(new Date('2026-10-20T00:00:00').getTime() / 1000),
      })
    )
  } finally {
    vi.useRealTimers()
  }
})

test('low-height mobile records use shared cards and a keyboard-accessible filter dialog', async () => {
  const original = window.matchMedia
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    ...original(query),
    matches:
      query.includes('max-height') ||
      query.includes('max-width') ||
      query.includes('prefers-reduced-motion'),
  }))
  vi.spyOn(api, 'request').mockResolvedValue(
    success({
      items: [
        {
          id: 7,
          trade_no: 'mobile-order',
          inviter_id: 1,
          invitee_id: 2,
          credited_quota: '100',
          reward_quota: '10',
          rate_bps: 1000,
          settled_at: 1,
          created_at: 2,
        },
      ],
      total: 1,
      credited_quota: '100',
      reward_quota: '10',
    })
  )
  mount(<ReferralRecordsDialog onOpenChange={vi.fn()} />)
  expect(await screen.findByText('mobile-order')).toBeVisible()
  expect(screen.getByText('Total wallet credited').closest('dl')).toHaveClass(
    'grid-cols-2',
    'sm:grid-cols-3'
  )
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Inviter ID')).not.toBeInTheDocument()
  const user = userEvent.setup()
  const filter = screen.getByRole('button', { name: 'Filters' })
  filter.focus()
  await user.keyboard('{Enter}')
  const dialog = screen.getByRole('dialog', { name: 'Filters' })
  expect(within(dialog).getByLabelText('Inviter ID')).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Filters' })
    ).not.toBeInTheDocument()
  )
  expect(filter).toHaveFocus()
  expect(screen.getByRole('navigation', { name: 'Page' })).toBeVisible()
})

test('loading and failure never display fabricated zero totals and retry can recover', async () => {
  let resolve!: (value: ReturnType<typeof success>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<ReturnType<typeof success>>(
    (onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    }
  )
  const deferred = { promise, resolve, reject }
  const request = vi
    .spyOn(api, 'request')
    .mockImplementationOnce(() => deferred.promise)
    .mockResolvedValue(
      success({ items: [], total: 0, credited_quota: '0', reward_quota: '0' })
    )
  mount(<ReferralRecordsDialog onOpenChange={vi.fn()} />)
  expect(
    screen.getByText('Matching records').nextElementSibling
  ).toHaveTextContent(/^$/)
  await act(async () => {
    deferred.reject(new Error('offline'))
    await deferred.promise.catch(() => {})
  })
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeVisible()
  expect(
    screen.getByText('Matching records').nextElementSibling
  ).toHaveTextContent('—')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('No rebate records')).toBeVisible()
  expect(request).toHaveBeenCalledTimes(2)
})

test('safe wallet amounts keep six-decimal display precision without an extra raw-unit field', () => {
  render(
    <>
      <ReferralQuota value='1' />
      <ReferralQuota value='5000000' />
      <ReferralQuota value='invalid' />
    </>
  )
  expect(screen.getByText('$0.000002')).toBeVisible()
  expect(screen.getByText('$10')).toBeVisible()
  expect(screen.getByText('—')).toBeVisible()
  expect(screen.queryByText(/quota units/)).not.toBeInTheDocument()
})

test('exact quota strings remain exact after switching interface languages', async () => {
  const i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en, zh },
    interpolation: { escapeValue: false },
  })
  render(
    <I18nextProvider i18n={i18n}>
      <ReferralQuota value='9007199254740993' />
    </I18nextProvider>
  )
  expect(screen.getByText('9,007,199,254,740,993 quota units')).toBeVisible()
  await act(() => i18n.changeLanguage('zh'))
  expect(screen.getByText('9,007,199,254,740,993 额度单位')).toBeVisible()
})

test.each([
  ['zhCN', '9,007,199,254,740,993'],
  ['zhTW', '9,007,199,254,740,993'],
  ['en', '9,007,199,254,740,993'],
  ['fr', '9\u202f007\u202f199\u202f254\u202f740\u202f993'],
  ['ru', '9\u00a0007\u00a0199\u00a0254\u00a0740\u00a0993'],
  ['ja', '9,007,199,254,740,993'],
  ['vi', '9.007.199.254.740.993'],
  ['invalid_locale', '9,007,199,254,740,993'],
])(
  'exact amount display supports interface locale %s without losing integer precision',
  async (language, amount) => {
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: language,
      fallbackLng: false,
      resources: { [language]: en },
      interpolation: { escapeValue: false },
    })
    render(
      <I18nextProvider i18n={i18n}>
        <ReferralQuota value='9007199254740993' />
      </I18nextProvider>
    )
    expect(
      screen.getByText(`${amount} quota units`, {
        normalizer: (value) => value,
      })
    ).toBeVisible()
  }
)
