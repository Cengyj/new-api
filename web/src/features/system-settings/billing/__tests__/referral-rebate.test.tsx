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
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosRequestConfig } from 'axios'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { ReferralRebateSection } from '../referral-rebate-section'

const initial = { enabled: false, rate_bps: 0, valid_days: 0 }
const success = (data: unknown) => ({ data: { success: true, data } })
function Fixture() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <ReferralRebateSection />
      </SettingsPageProvider>
    </>
  )
}
async function mountSettings() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const router = createRouter({
    routeTree: createRootRoute({ component: Fixture }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await screen.findByRole('textbox', { name: 'Rebate percentage (%)' })
  return client
}
beforeEach(() => {
  useAuthStore.getState().auth.reset()
  useAuthStore.getState().auth.setUser({ id: 1, username: 'root', role: 100 })
})

test('rule guidance describes the related controls while preserving the independent registration reward notice', async () => {
  vi.spyOn(api, 'request').mockResolvedValue(success(initial))
  await mountSettings()

  expect(
    screen.getByRole('switch', { name: 'Enable invitation top-up rebates' })
  ).toHaveAccessibleDescription(
    'Rates and expiry are fixed at registration. Rule changes affect only new eligibility.'
  )
  expect(
    screen.getByRole('textbox', { name: 'Rebate percentage (%)' })
  ).toHaveAccessibleDescription(
    'Eligible wallet top-ups and authorized order completion participate. Other balance credits and subscriptions do not.'
  )
  expect(
    screen.getByRole('textbox', { name: 'Valid days after registration' })
  ).toHaveAccessibleDescription(
    'One day is 24 hours. Pausing does not extend expiry or grant missed rebates.'
  )
  expect(
    screen.getByText(
      'Disabling keeps the configured rate and days. Existing registration rewards are independent.'
    )
  ).toBeVisible()
})

test('closing and reopening records preserves one rule form and identity changes replace its draft', async () => {
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url === '/api/user/referral_rebates') {
        return success({
          items: [],
          total: 0,
          credited_quota: '0',
          reward_quota: '0',
        })
      }
      return success({
        enabled: true,
        rate_bps: useAuthStore.getState().auth.user?.id === 1 ? 1000 : 2000,
        valid_days: 30,
      })
    })
  await mountSettings()
  const user = userEvent.setup()
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Rebate percentage (%)' }),
    { target: { value: '15' } }
  )

  for (const changeIdentity of [false, true]) {
    await user.click(
      screen.getByRole('button', { name: 'Top-up rebate records' })
    )
    await screen.findByRole('dialog', { name: 'Top-up rebate records' })
    if (changeIdentity) {
      act(() =>
        useAuthStore
          .getState()
          .auth.setUser({ id: 2, username: 'other-root', role: 100 })
      )
    }
    await user.click(
      within(
        screen.getByRole('dialog', { name: 'Top-up rebate records' })
      ).getByRole('button', { name: 'Close' })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Top-up rebate records' })
      ).not.toBeInTheDocument()
    )
    expect(
      screen.getAllByRole('switch', {
        name: 'Enable invitation top-up rebates',
      })
    ).toHaveLength(1)
    expect(
      screen.getAllByRole('button', { name: 'Save Changes' })
    ).toHaveLength(1)
    expect(
      screen.getByRole('textbox', { name: 'Rebate percentage (%)' })
    ).toHaveValue(changeIdentity ? '20' : '15')
  }
  expect(request.mock.calls.some(([config]) => config.method === 'put')).toBe(
    false
  )
})

test('server defaults keep rebates off and preserve five percent and seven days when enabled', async () => {
  const defaults = { enabled: false, rate_bps: 500, valid_days: 7 }
  const puts: AxiosRequestConfig[] = []
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'put') {
      puts.push(config)
      return success({ ...defaults, enabled: true })
    }
    return success(defaults)
  })
  await mountSettings()
  const user = userEvent.setup()
  const toggle = screen.getByRole('switch', {
    name: 'Enable invitation top-up rebates',
  })
  expect(toggle).not.toBeChecked()
  expect(
    screen.getByRole('textbox', { name: 'Rebate percentage (%)' })
  ).toHaveValue('5')
  expect(
    screen.getByRole('textbox', { name: 'Valid days after registration' })
  ).toHaveValue('7')

  await user.click(toggle)
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(puts).toHaveLength(1))
  expect(puts[0]).toMatchObject({
    url: '/api/option/referral_rebate',
    data: { enabled: true, percentage: '5', valid_days: '7' },
  })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  )
})

test('enabling an unconfigured rule validates both fields and saves all three fields in one request', async () => {
  const puts: AxiosRequestConfig[] = []
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'put') {
      puts.push(config)
      return success({ enabled: true, rate_bps: 1000, valid_days: 30 })
    }
    return success(initial)
  })
  await mountSettings()
  const user = userEvent.setup()
  const percent = screen.getByRole('textbox', { name: 'Rebate percentage (%)' })
  const days = screen.getByRole('textbox', {
    name: 'Valid days after registration',
  })
  expect(percent).toHaveValue('')
  expect(days).toHaveValue('')
  await user.click(
    screen.getByRole('switch', { name: 'Enable invitation top-up rebates' })
  )
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(percent).toHaveAttribute('aria-invalid', 'true'))
  expect(days).toHaveAttribute('aria-invalid', 'true')
  expect(puts).toHaveLength(0)
  await user.type(percent, '10')
  await user.type(days, '30')
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(puts).toHaveLength(1))
  expect(puts[0]).toMatchObject({
    url: '/api/option/referral_rebate',
    data: { enabled: true, percentage: '10', valid_days: '30' },
    skipAuthRefresh: true,
  })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  )
})

test('save failure preserves inputs and a later successful save becomes the reset baseline', async () => {
  let fail = true
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'put') {
      if (fail) {
        return { data: { success: false, message: 'Database unavailable' } }
      }
      return success({ enabled: false, rate_bps: 1250, valid_days: 20 })
    }
    return success({ enabled: false, rate_bps: 1000, valid_days: 30 })
  })
  await mountSettings()
  const percent = screen.getByRole('textbox', { name: 'Rebate percentage (%)' })
  const days = screen.getByRole('textbox', {
    name: 'Valid days after registration',
  })
  fireEvent.change(percent, { target: { value: '12.5' } })
  fireEvent.change(days, { target: { value: '20' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Database unavailable'
  )
  expect(percent).toHaveValue('12.5')
  expect(days).toHaveValue('20')
  fail = false
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  )
  fireEvent.change(percent, { target: { value: '20' } })
  await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
  expect(percent).toHaveValue('12.5')
  expect(days).toHaveValue('20')
})

test('late reads cannot replace unsaved input or a new saved baseline', async () => {
  vi.spyOn(api, 'request').mockResolvedValue(
    success({ enabled: false, rate_bps: 1000, valid_days: 30 })
  )
  const client = await mountSettings()
  const percent = screen.getByRole('textbox', { name: 'Rebate percentage (%)' })
  fireEvent.change(percent, { target: { value: '15' } })
  act(() =>
    client.setQueryData(['referral-rule', '1:'], {
      enabled: false,
      rate_bps: 500,
      valid_days: 10,
    })
  )
  expect(percent).toHaveValue('15')
  await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
  expect(percent).toHaveValue('10')
})

test('disabling a configured rule retains its rate and days', async () => {
  const request = vi
    .spyOn(api, 'request')
    .mockResolvedValue(
      success({ enabled: true, rate_bps: 1025, valid_days: 40 })
    )
  await mountSettings()
  fireEvent.click(
    screen.getByRole('switch', { name: 'Enable invitation top-up rebates' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() =>
    expect(request.mock.calls.some(([config]) => config.method === 'put')).toBe(
      true
    )
  )
  expect(
    request.mock.calls.find(([config]) => config.method === 'put')?.[0].data
  ).toEqual({ enabled: false, percentage: '10.25', valid_days: '40' })
})

test('an in-flight old rule read cannot overwrite a successfully saved rule in the query cache', async () => {
  let finishRead!: (value: ReturnType<typeof success>) => void
  const oldRead = new Promise<ReturnType<typeof success>>((resolve) => {
    finishRead = resolve
  })
  const original = { enabled: false, rate_bps: 1000, valid_days: 30 }
  const saved = { ...original, rate_bps: 1500 }
  let reads = 0
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'put') return success(saved)
    reads++
    return reads === 1 ? success(original) : oldRead
  })
  const client = await mountSettings()
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Rebate percentage (%)' }),
    { target: { value: '15' } }
  )
  let refreshing!: Promise<void>
  act(() => {
    refreshing = client.refetchQueries({ queryKey: ['referral-rule', '1:'] })
  })
  await waitFor(() => expect(reads).toBe(2))
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  )
  await act(async () => {
    finishRead(success(original))
    await refreshing
  })
  expect(client.getQueryData(['referral-rule', '1:'])).toEqual(saved)
  expect(
    screen.getByRole('textbox', { name: 'Rebate percentage (%)' })
  ).toHaveValue('15')
})

test('a late save response after leaving the settings page cannot replace a newer saved rule', async () => {
  let finishSave!: (value: ReturnType<typeof success>) => void
  const oldSave = new Promise<ReturnType<typeof success>>((resolve) => {
    finishSave = resolve
  })
  let submitted: AxiosRequestConfig | undefined
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'put') {
      submitted = config
      return oldSave
    }
    return success({ enabled: false, rate_bps: 1000, valid_days: 30 })
  })
  const client = await mountSettings()
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Rebate percentage (%)' }),
    { target: { value: '15' } }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(submitted).toBeDefined())
  cleanup()
  expect(submitted?.signal?.aborted).toBe(true)
  const currentRule = { enabled: true, rate_bps: 2000, valid_days: 60 }
  client.setQueryData(['referral-rule', '1:'], currentRule)
  await act(async () => {
    finishSave(success({ enabled: false, rate_bps: 1500, valid_days: 30 }))
    await oldSave
  })
  expect(client.getQueryData(['referral-rule', '1:'])).toEqual(currentRule)
})

test('losing root privileges unmounts the rule form and ignores its late save in the same session', async () => {
  let finishSave!: (value: ReturnType<typeof success>) => void
  const pending = new Promise<ReturnType<typeof success>>((resolve) => {
    finishSave = resolve
  })
  let submitted: AxiosRequestConfig | undefined
  const original = { enabled: false, rate_bps: 1000, valid_days: 30 }
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.method === 'put') {
        submitted = config
        return pending
      }
      return success(original)
    })
  const client = await mountSettings()
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Rebate percentage (%)' }),
    { target: { value: '15' } }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(submitted).toBeDefined())

  act(() =>
    useAuthStore.getState().auth.setUser({ id: 1, username: 'root', role: 10 })
  )

  expect(
    screen.queryByRole('textbox', { name: 'Rebate percentage (%)' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Save Changes' })
  ).not.toBeInTheDocument()
  expect(submitted?.signal?.aborted).toBe(true)
  await act(async () => {
    finishSave(success({ ...original, rate_bps: 1500 }))
    await pending
  })
  expect(client.getQueryData(['referral-rule', '1:'])).toEqual(original)
  expect(
    request.mock.calls.filter(([config]) => config.method === 'get')
  ).toHaveLength(1)
})
