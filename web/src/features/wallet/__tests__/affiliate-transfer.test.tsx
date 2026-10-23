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
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, AxiosHeaders, type AxiosRequestConfig } from 'axios'
import { toast } from 'sonner'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { AffiliateRewardsCard } from '../components/affiliate-rewards-card'
import { useAffiliate } from '../hooks/use-affiliate'
import { parseAffiliateTransferQuota } from '../lib/affiliate'

const summary = {
  rule: { enabled: false, rate_bps: 1000, valid_days: 30 },
  compliance_confirmed: true,
  aff_quota: '1000000',
  aff_history_quota: '2000000',
  rebate_quota: '500000',
  direct_count: 2,
}
const success = (data: unknown) => ({ data: { success: true, data } })
const storageMethods = Object.hasOwn(localStorage, 'getItem')
  ? localStorage
  : Storage.prototype
const durableStorageMethods = Object.hasOwn(localStorage, 'getItem')
  ? localStorage
  : Storage.prototype

// Inspect the pending transfer across the old page-session format and the
// durable per-operation format, without weakening exact saved-value assertions.
function savedTransfer(key: string): string | null {
  const legacy = sessionStorage.getItem(key)
  if (legacy !== null) return legacy
  for (let index = 0; index < localStorage.length; index += 1) {
    const operationKey = localStorage.key(index)
    if (operationKey?.startsWith(`${key}:`)) {
      return localStorage.getItem(operationKey)
    }
  }
  return null
}

function Fixture(props: { refresh: () => Promise<void> }) {
  const account = useAuthStore((state) =>
    [state.auth.user?.id, state.auth.session?.sid].join(':')
  )
  return <AffiliateRewardsCard key={account} onBalanceChanged={props.refresh} />
}
function mountCard(refresh = vi.fn().mockResolvedValue(undefined)) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    ...render(
      <QueryClientProvider client={client}>
        <Fixture refresh={refresh} />
      </QueryClientProvider>
    ),
    refresh,
  }
}
beforeEach(() => {
  useSystemConfigStore.getState().setConfig({
    currency: { ...DEFAULT_CURRENCY_CONFIG },
  })
  sessionStorage.clear()
  localStorage.clear()
  useAuthStore.getState().auth.reset()
  useAuthStore.getState().auth.setUser({ id: 1, username: 'first', role: 1 })
})

test.each([
  { display: 'USD', amount: '2.000005', expectedQuota: 1000003 },
  { display: 'CNY', amount: '14.000035', expectedQuota: 1000003 },
  { display: 'CUSTOM', amount: '1.8000045', expectedQuota: 1000003 },
  { display: 'TOKENS', amount: '1000002.5', expectedQuota: 1000003 },
  { display: 'CNY', amount: '14.00003499999999999', expectedQuota: 1000002 },
] as const)(
  '$display transfer input rounds the decimal amount once in quota units',
  async ({ display, amount, expectedQuota }) => {
    useSystemConfigStore.getState().setConfig({
      currency: {
        ...DEFAULT_CURRENCY_CONFIG,
        quotaDisplayType: display,
        usdExchangeRate: 7,
        customCurrencyExchangeRate: 0.9,
      },
    })
    const request = vi
      .spyOn(api, 'request')
      .mockImplementation(async (config) => {
        if (config.method === 'post') return success(config.data)
        if (config.url === '/api/user/aff') return success('invite-first')
        return success({ ...summary, aff_quota: '1500000' })
      })
    mountCard()
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Transfer to Balance' })
    )
    const input = screen.getByRole('spinbutton', { name: 'Transfer Amount' })
    fireEvent.change(input, { target: { value: amount } })
    expect(input).toHaveValue(Number(amount))
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Transfer' }))
    const posts = request.mock.calls
      .filter(([config]) => config.method === 'post')
      .map(([config]) => config)
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe('/api/user/aff_transfer')
    expect(posts[0].data).toEqual({
      request_id: expect.any(String),
      quota: expectedQuota,
    })
  }
)

test('transfer conversion preserves fractional quota units and scientific display rates', () => {
  useSystemConfigStore.getState().setConfig({
    currency: {
      ...DEFAULT_CURRENCY_CONFIG,
      quotaDisplayType: 'CUSTOM',
      quotaPerUnit: 2.5,
      customCurrencyExchangeRate: 1e-7,
    },
  })
  expect(parseAffiliateTransferQuota('2e-7')).toBe(5)
})

test('transfer conversion accepts the exact safe limit and rejects out-of-range or invalid amounts', () => {
  expect(parseAffiliateTransferQuota('18014398509.481982')).toBe(
    Number.MAX_SAFE_INTEGER
  )
  for (const value of [
    '18014398509.481984',
    'NaN',
    'Infinity',
    '1e99999999',
    '-1',
    '',
    '0',
  ]) {
    expect(parseAffiliateTransferQuota(value)).toBeNaN()
  }
})

test.each(['network loss', 'timeout'])(
  '%s requires lookup and preserves the original ID and amount on retry',
  async (failure) => {
    const posts: AxiosRequestConfig[] = []
    const request = vi
      .spyOn(api, 'request')
      .mockImplementation(async (config) => {
        if (config.method === 'post') {
          posts.push(config)
          if (posts.length === 1) {
            if (failure === 'timeout') {
              throw new AxiosError('timeout exceeded', 'ECONNABORTED')
            }
            throw new Error('network unavailable')
          }
          return success({})
        }
        if (config.url?.includes('/aff_transfer/')) {
          return success({ found: false, transfer: null })
        }
        if (config.url === '/api/user/aff') return success('invite-first')
        return success(summary)
      })
    mountCard()
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Transfer to Balance' })
    )
    await user.click(screen.getByRole('button', { name: 'Transfer' }))
    const dialog = screen.getByRole('dialog', { name: 'Transfer Rewards' })
    expect(
      await within(dialog).findByText(
        'Transfer result is unknown. Check the original operation before retrying.'
      )
    ).toBeVisible()
    expect(
      within(dialog).getByRole('spinbutton', { name: 'Transfer Amount' })
    ).toBeDisabled()
    expect(
      within(dialog).getByRole('button', { name: 'Retry original transfer' })
    ).toBeDisabled()
    const original = posts[0].data as { request_id: string; quota: number }
    expect(original.request_id).toMatch(/^[a-zA-Z0-9_-]{16,64}$/)
    expect(original.quota).toBe(500000)
    expect(posts[0].skipAuthRefresh).toBe(true)
    await user.click(
      within(dialog).getByRole('button', { name: 'Check transfer result' })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Retry original transfer' })
      ).toBeEnabled()
    )
    await user.click(
      within(dialog).getByRole('button', { name: 'Retry original transfer' })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Transfer Rewards' })
      ).not.toBeInTheDocument()
    )
    expect(posts.map((post) => post.data)).toEqual([original, original])
    expect(
      request.mock.calls.some(
        ([config]) =>
          config.url === `/api/user/aff_transfer/${original.request_id}`
      )
    ).toBe(true)
    expect(savedTransfer('new-api:affiliate-transfer:1')).toBeNull()
  }
)

test('lookup after remount confirms an already committed transfer without another money request', async () => {
  const operation = { request_id: 'original-operation-0001', quota: 500000 }
  sessionStorage.setItem(
    'new-api:affiliate-transfer:1',
    JSON.stringify(operation)
  )
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url?.includes('/aff_transfer/')) {
        return success({
          found: true,
          transfer: { id: 5, ...operation, created_at: 1 },
        })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success({ ...summary, compliance_confirmed: false })
    })
  mountCard()
  const user = userEvent.setup()
  await screen.findByRole('textbox', { name: 'Invitation link' })
  await user.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  const dialog = screen.getByRole('dialog')
  await user.click(
    within(dialog).getByRole('button', { name: 'Check transfer result' })
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(0)
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBeNull()
})

test.each(['rejected', 'thrown'])(
  'a successful transfer remains successful when a balance refresh is %s',
  async (failure) => {
    vi.spyOn(api, 'request').mockImplementation(async (config) => {
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
    mountCard(
      vi.fn(() => {
        if (failure === 'thrown') throw new Error('refresh failed')
        return Promise.reject(new Error('refresh failed'))
      })
    )
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Transfer to Balance' })
    )
    await user.click(screen.getByRole('button', { name: 'Transfer' }))
    expect(
      await screen.findByText(
        'Transfer succeeded, but balances could not be refreshed.'
      )
    ).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(savedTransfer('new-api:affiliate-transfer:1')).toBeNull()
  }
)

test('switching accounts during an unresolved transfer aborts delivery and cannot refresh the new account', async () => {
  let resolve!: (value: ReturnType<typeof success>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<ReturnType<typeof success>>(
    (onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    }
  )
  const deferred = { promise, resolve, reject }
  let submitted: AxiosRequestConfig | undefined
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'post') {
      submitted = config
      return deferred.promise
    }
    if (config.url === '/api/user/aff') {
      return success(`invite-${useAuthStore.getState().auth.user?.id}`)
    }
    return success(summary)
  })
  const { refresh } = mountCard()
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() => expect(submitted).toBeDefined())
  act(() =>
    useAuthStore.getState().auth.setUser({ id: 2, username: 'second', role: 1 })
  )
  await screen.findByDisplayValue('http://localhost:3000/sign-up?aff=invite-2')
  expect(submitted?.signal?.aborted).toBe(true)
  await act(async () => {
    deferred.resolve(success({}))
    await deferred.promise
  })
  expect(refresh).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(savedTransfer('new-api:affiliate-transfer:1')).not.toBeNull()
  expect(savedTransfer('new-api:affiliate-transfer:2')).toBeNull()
})

test('double activation while a money request is pending sends only one operation', async () => {
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
    .mockImplementation(async (config) => {
      if (config.method === 'post') return deferred.promise
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  mountCard()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  const submit = screen.getByRole('button', { name: 'Transfer' })
  fireEvent.click(submit)
  fireEvent.click(submit)
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([config]) => config.method === 'post')
    ).toHaveLength(1)
  )
  expect(
    screen.getByRole('spinbutton', { name: 'Transfer Amount' })
  ).toBeDisabled()
  await act(async () => {
    deferred.resolve(success({}))
    await deferred.promise
  })
})

test.each(['invalid JSON', 'invalid operation', 'unreadable storage'])(
  '%s blocks new transfers until the original saved state can be read',
  async (failure) => {
    const operation = { request_id: 'original-operation-0001', quota: 500000 }
    const key = 'new-api:affiliate-transfer:1'
    sessionStorage.setItem(
      key,
      failure === 'invalid JSON'
        ? '{'
        : JSON.stringify({ ...operation, quota: -1 })
    )
    const getItem = vi.spyOn(storageMethods, 'getItem')
    if (failure === 'unreadable storage') {
      getItem.mockImplementation(() => {
        throw new DOMException('Storage unavailable', 'SecurityError')
      })
    }
    const request = vi
      .spyOn(api, 'request')
      .mockImplementation(async (config) => {
        if (config.url === '/api/user/aff') return success('invite-first')
        return success(summary)
      })
    mountCard()
    expect(
      await screen.findByText(
        'Saved transfer details are unavailable or invalid. Restore browser storage and retry before starting another transfer.'
      )
    ).toBeVisible()
    expect(
      await screen.findByRole('button', { name: 'Transfer to Balance' })
    ).toBeDisabled()
    expect(
      request.mock.calls.filter(([config]) => config.method === 'post')
    ).toHaveLength(0)
    getItem.mockRestore()
    sessionStorage.setItem(key, JSON.stringify(operation))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('button', { name: 'Check transfer result' })
    ).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'Transfer to Balance' })
    ).not.toBeInTheDocument()
    expect(savedTransfer(key)).toBe(JSON.stringify(operation))
  }
)

test('a storage write failure sends no money request and shows a recoverable storage error', async () => {
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  mountCard()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  const setItem = vi.spyOn(storageMethods, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage full', 'QuotaExceededError')
  })
  await userEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  expect(
    await within(screen.getByRole('dialog')).findByText(
      'Saved transfer details are unavailable or invalid. Restore browser storage and retry before starting another transfer.'
    )
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Transfer' })).toBeDisabled()
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(0)
  setItem.mockRestore()
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' })
  )
  expect(screen.getByRole('button', { name: 'Transfer' })).toBeEnabled()
})

test('storage cleanup failure preserves a confirmed result and never offers another money request', async () => {
  let operation: { request_id: string; quota: number } | undefined
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.method === 'post') {
        operation = config.data as { request_id: string; quota: number }
        return success({})
      }
      if (config.url?.includes('/aff_transfer/')) {
        return success({
          found: true,
          transfer: { id: 5, ...operation, created_at: 1 },
        })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  mountCard()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  const removeItem = vi
    .spyOn(storageMethods, 'removeItem')
    .mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError')
    })
  await userEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(
    screen.getByText(
      'Transfer succeeded, but the saved operation could not be cleared. Check the original operation before starting another transfer.'
    )
  ).toBeVisible()
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBe(
    JSON.stringify(operation)
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Check transfer result' })
  )
  expect(
    within(screen.getByRole('dialog')).queryByText(
      'Transfer result is unknown. Check the original operation before retrying.'
    )
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Retry original transfer' })
  ).toBeDisabled()
  removeItem.mockRestore()
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(1)
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBeNull()
})

test('confirmation never clears a different unresolved operation saved while the response was pending', async () => {
  const laterOperation = { request_id: 'other-operation-0002', quota: 500000 }
  let finish!: (value: ReturnType<typeof success>) => void
  const response = new Promise<ReturnType<typeof success>>((resolve) => {
    finish = resolve
  })
  let submitted: AxiosRequestConfig | undefined
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'post') {
      submitted = config
      return response
    }
    if (config.url === '/api/user/aff') return success('invite-first')
    return success(summary)
  })
  mountCard()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() => expect(submitted).toBeDefined())
  sessionStorage.setItem(
    'new-api:affiliate-transfer:1',
    JSON.stringify(laterOperation)
  )
  await act(async () => {
    finish(success({}))
    await response
  })
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBe(
    JSON.stringify(laterOperation)
  )
  expect(
    screen.getByRole('button', { name: 'Check transfer result' })
  ).toBeEnabled()
  expect(
    screen.queryByRole('button', { name: 'Transfer to Balance' })
  ).not.toBeInTheDocument()
})

test('a confirmed transfer closes before a slow balance refresh finishes', async () => {
  let finish!: () => void
  const refresh = new Promise<void>((resolve) => {
    finish = resolve
  })
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.url === '/api/user/aff') return success('invite-first')
    return success(summary)
  })
  const onRefresh = vi.fn(() => refresh)
  mountCard(onRefresh)
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  await userEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() => expect(onRefresh).toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await act(async () => {
    finish()
    await refresh
  })
})

test('a mismatched lookup result keeps the original ID and blocks retrying the transfer', async () => {
  const operation = { request_id: 'original-operation-0001', quota: 500000 }
  sessionStorage.setItem(
    'new-api:affiliate-transfer:1',
    JSON.stringify(operation)
  )
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url?.includes('/aff_transfer/')) {
        return success({
          found: true,
          transfer: { id: 5, ...operation, quota: 1000000, created_at: 1 },
        })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  mountCard()
  await screen.findByRole('textbox', { name: 'Invitation link' })
  await userEvent.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  expect(
    screen.getByRole('button', { name: 'Retry original transfer' })
  ).toBeDisabled()
  expect(await screen.findByText(operation.request_id)).toBeVisible()
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBe(
    JSON.stringify(operation)
  )
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(0)
})

test('leaving the wallet during a transfer retains its ID and ignores the late response', async () => {
  let finish!: (value: ReturnType<typeof success>) => void
  const response = new Promise<ReturnType<typeof success>>((resolve) => {
    finish = resolve
  })
  let submitted: AxiosRequestConfig | undefined
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'post') {
      submitted = config
      return response
    }
    if (config.url === '/api/user/aff') return success('invite-first')
    return success(summary)
  })
  const { unmount, refresh } = mountCard()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() => expect(submitted).toBeDefined())
  unmount()
  expect(submitted?.signal?.aborted).toBe(true)
  await act(async () => {
    finish(success({}))
    await response
  })
  expect(refresh).not.toHaveBeenCalled()
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBe(
    JSON.stringify(submitted?.data)
  )
})

test('the real HTTP interceptor does not refresh or replay a transfer rejected with 401', async () => {
  const originalAdapter = api.defaults.adapter
  const requests: AxiosRequestConfig[] = []
  api.defaults.adapter = async (config) => {
    requests.push(config)
    if (config.method === 'post') {
      throw new AxiosError(
        'Session expired',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        {
          config,
          status: 401,
          statusText: 'Unauthorized',
          headers: {},
          data: { success: false, message: 'Session expired' },
        }
      )
    }
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        success: true,
        data: config.url === '/api/user/aff' ? 'invite-first' : summary,
      },
    }
  }
  try {
    mountCard()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Transfer to Balance' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Transfer' }))
    expect(
      await within(screen.getByRole('dialog')).findByText(
        'Transfer result is unknown. Check the original operation before retrying.'
      )
    ).toBeVisible()
    const posts = requests.filter((config) => config.method === 'post')
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe('/api/user/aff_transfer')
    expect(posts[0].skipAuthRefresh).toBe(true)
    expect(posts[0].authRetry).toBeUndefined()
    expect(savedTransfer('new-api:affiliate-transfer:1')).toBe(posts[0].data)
  } finally {
    api.defaults.adapter = originalAdapter
  }
})

test('a correlated first-attempt rejection releases the operation and permits a corrected amount', async () => {
  const posts: AxiosRequestConfig[] = []
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'post') {
      posts.push(config)
      if (posts.length === 1) {
        return {
          data: {
            success: false,
            message_key: 'Invitation quota is insufficient!',
            data: {
              transfer_status: 'rejected',
              result_persisted: true,
              ...(config.data as object),
            },
          },
        }
      }
      return success({})
    }
    if (config.url === '/api/user/aff') return success('invite-first')
    return success(summary)
  })
  mountCard()
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  const amount = screen.getByRole('spinbutton', { name: 'Transfer Amount' })
  fireEvent.change(amount, { target: { value: '2' } })
  await user.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() => expect(amount).toBeEnabled())
  expect(
    screen.queryByText(
      'Transfer result is unknown. Check the original operation before retrying.'
    )
  ).not.toBeInTheDocument()
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBeNull()
  fireEvent.change(amount, { target: { value: '1' } })
  await user.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(posts).toHaveLength(2)
  expect(posts[0].data.quota).toBe(1000000)
  expect(posts[1].data.quota).toBe(500000)
  expect(posts[1].data.request_id).not.toBe(posts[0].data.request_id)
})

test.each([
  'technical failure',
  'wrong request ID',
  'wrong amount',
  'uncorrelated business error',
  'unpersisted rejection',
])('%s cannot discard an unresolved transfer', async (kind) => {
  let operation: { request_id: string; quota: number } | undefined
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'post') {
      operation = config.data as { request_id: string; quota: number }
      let data: unknown = {
        transfer_status: 'rejected',
        result_persisted: kind !== 'unpersisted rejection',
        ...operation,
      }
      if (kind === 'wrong request ID') {
        data = { ...(data as object), request_id: 'different-operation-01' }
      }
      if (kind === 'wrong amount') {
        data = { ...(data as object), quota: 1000000 }
      }
      if (
        kind === 'technical failure' ||
        kind === 'uncorrelated business error'
      ) {
        data = undefined
      }
      return {
        data: {
          success: false,
          message_key:
            kind === 'technical failure'
              ? 'Database error, please contact the administrator'
              : 'Invitation quota is insufficient!',
          data,
        },
      }
    }
    if (config.url === '/api/user/aff') return success('invite-first')
    return success(summary)
  })
  mountCard()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  await userEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  expect(
    await screen.findByText(
      'Transfer result is unknown. Check the original operation before retrying.'
    )
  ).toBeVisible()
  expect(
    screen.getByRole('spinbutton', { name: 'Transfer Amount' })
  ).toBeDisabled()
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBe(
    JSON.stringify(operation)
  )
})

test('rejection after a prior unknown request retains the original ID because that request may still commit', async () => {
  const operation = { request_id: 'still-in-flight-operation', quota: 500000 }
  sessionStorage.setItem(
    'new-api:affiliate-transfer:1',
    JSON.stringify(operation)
  )
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.method === 'post') {
        return {
          data: {
            success: false,
            message_key: 'Invitation quota is insufficient!',
            data: { transfer_status: 'rejected', ...operation },
          },
        }
      }
      if (config.url?.includes('/aff_transfer/')) {
        return success({ found: false, transfer: null })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  mountCard()
  const user = userEvent.setup()
  await screen.findByRole('textbox', { name: 'Invitation link' })
  await user.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Retry original transfer' })
    ).toBeEnabled()
  )
  await user.click(
    screen.getByRole('button', { name: 'Retry original transfer' })
  )
  expect(
    screen.getByRole('spinbutton', { name: 'Transfer Amount' })
  ).toBeDisabled()
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBe(
    JSON.stringify(operation)
  )
  expect(
    request.mock.calls
      .filter(([config]) => config.method === 'post')
      .map(([config]) => config.data)
  ).toEqual([operation])
})

test('a rejected operation with failed storage cleanup stays blocked until its exact saved ID can be cleared', async () => {
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.method === 'post') {
        return {
          data: {
            success: false,
            message_key: 'Invitation quota is insufficient!',
            data: {
              transfer_status: 'rejected',
              result_persisted: true,
              ...(config.data as object),
            },
          },
        }
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  mountCard()
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  const remove = vi
    .spyOn(storageMethods, 'removeItem')
    .mockImplementation(() => {
      throw new Error('Storage unavailable')
    })
  await user.click(screen.getByRole('button', { name: 'Transfer' }))
  expect(
    await screen.findByText(
      'Transfer was rejected. No balance was moved. Restore browser storage before starting another transfer.'
    )
  ).toBeVisible()
  expect(
    screen.queryByText(
      'Transfer result is unknown. Check the original operation before retrying.'
    )
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Retry original transfer' })
  ).toBeDisabled()
  const operation = request.mock.calls.find(
    ([config]) => config.method === 'post'
  )?.[0].data
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBe(
    JSON.stringify(operation)
  )
  remove.mockRestore()
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' })
  )
  expect(screen.getByRole('button', { name: 'Transfer' })).toBeEnabled()
  expect(
    screen.getByRole('spinbutton', { name: 'Transfer Amount' })
  ).toBeEnabled()
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBeNull()
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(1)
})

test('replacing a session for the same user retains the pending ID and ignores the old response', async () => {
  let finish!: (value: ReturnType<typeof success>) => void
  const response = new Promise<ReturnType<typeof success>>((resolve) => {
    finish = resolve
  })
  let submitted: AxiosRequestConfig | undefined
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.method === 'post') {
        submitted = config
        return response
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  const { refresh } = mountCard()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() => expect(submitted).toBeDefined())
  act(() =>
    useAuthStore.getState().auth.setBundle({
      access_token: 'isolated-test-token',
      token_type: 'Bearer',
      access_expires_at: 1000,
      user: { id: 1, username: 'first', role: 1 },
      session: {
        sid: 'replacement-session',
        current: true,
        login_method: 'password',
        ip: '',
        user_agent: '',
        created_at: 1,
        last_active_at: 1,
        expires_at: 1000,
      },
    })
  )
  await screen.findByRole('textbox', { name: 'Invitation link' })
  expect(submitted?.signal?.aborted).toBe(true)
  await act(async () => {
    finish(success({}))
    await response
  })
  expect(refresh).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Check transfer result' })
  ).toBeEnabled()
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBe(
    JSON.stringify(submitted?.data)
  )
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(1)
})

test('missing referral APIs on a legacy backend fail closed and retain the original transfer identity', async () => {
  const operation = { request_id: 'legacy-unresolved-operation', quota: 500000 }
  sessionStorage.setItem(
    'new-api:affiliate-transfer:1',
    JSON.stringify(operation)
  )
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url === '/api/user/aff') return success('invite-first')
      throw new AxiosError(
        'Not Found',
        'ERR_BAD_REQUEST',
        undefined,
        undefined,
        {
          data: { success: false, message: 'Not Found' },
          status: 404,
          statusText: 'Not Found',
          headers: {},
          config: { headers: new AxiosHeaders() },
        }
      )
    })
  mountCard()
  await screen.findByRole('button', { name: 'Retry' })
  expect(
    screen.queryByRole('button', { name: 'Transfer to Balance' })
  ).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(
    screen.getByRole('button', { name: 'Check transfer result' })
  )
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  expect(
    screen.getByRole('button', { name: 'Retry original transfer' })
  ).toBeDisabled()
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBe(
    JSON.stringify(operation)
  )
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(0)
})

test.each(['committed', 'still processing'])(
  'closing a page with a %s transfer keeps the original identity in a new page session',
  async (state) => {
    const posts: { request_id: string; quota: number }[] = []
    let completed = false
    const request = vi
      .spyOn(api, 'request')
      .mockImplementation(async (config) => {
        if (config.method === 'post') {
          posts.push(config.data as { request_id: string; quota: number })
          completed = state === 'committed'
          throw new Error('Response lost after dispatch')
        }
        if (config.url?.includes('/aff_transfer/')) {
          return success({
            found: completed,
            transfer: completed ? { id: 1, ...posts[0], created_at: 1 } : null,
          })
        }
        if (config.url === '/api/user/aff') return success('invite-first')
        return success({
          ...summary,
          aff_quota: completed ? '500000' : '1000000',
        })
      })
    const first = mountCard()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Transfer to Balance' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Transfer' }))
    expect(posts).toHaveLength(1)
    expect(savedTransfer('new-api:affiliate-transfer:1')).not.toBeNull()
    first.unmount()
    // This models a new page session after the old tab closed.
    sessionStorage.clear()
    mountCard()
    await screen.findByRole('textbox', { name: 'Invitation link' })
    expect(
      screen.queryByRole('button', { name: 'Transfer to Balance' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Check transfer result' })
    )
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Check transfer result',
      })
    )
    expect(
      request.mock.calls.some(
        ([config]) =>
          config.url === `/api/user/aff_transfer/${posts[0].request_id}`
      )
    ).toBe(true)
    expect(posts).toHaveLength(1)
  }
)

test('a legacy page-session operation is durably retained before its tab closes', async () => {
  const operation = { request_id: 'legacy-pending-operation', quota: 500000 }
  const key = 'new-api:affiliate-transfer:1'
  sessionStorage.setItem(key, JSON.stringify(operation))
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  const first = mountCard()
  await screen.findByRole('button', { name: 'Check transfer result' })
  expect(localStorage.getItem(`${key}:${operation.request_id}`)).toBe(
    JSON.stringify(operation)
  )
  expect(sessionStorage.getItem(key)).toBeNull()
  first.unmount()
  sessionStorage.clear()
  mountCard()
  await screen.findByRole('textbox', { name: 'Invitation link' })
  await userEvent.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  expect(await screen.findByText(operation.request_id)).toBeVisible()
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(0)
})

test('an operation published by another tab survives the current transfer completion and is reconciled next', async () => {
  const other = { request_id: 'other-tab-operation-0001', quota: 500000 }
  const otherUser = { request_id: 'other-user-operation-0001', quota: 500000 }
  const key = 'new-api:affiliate-transfer:1'
  let operation: { request_id: string; quota: number } | undefined
  let finish!: (value: ReturnType<typeof success>) => void
  const response = new Promise<ReturnType<typeof success>>((resolve) => {
    finish = resolve
  })
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.method === 'post') {
        operation = config.data as { request_id: string; quota: number }
        return response
      }
      if (config.url?.includes('/aff_transfer/')) {
        return success({
          found: true,
          transfer: { id: 2, ...other, created_at: 1 },
        })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  mountCard()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() => expect(operation).toBeDefined())
  act(() => {
    localStorage.setItem(`${key}:${other.request_id}`, JSON.stringify(other))
    localStorage.setItem(
      `new-api:affiliate-transfer:2:${otherUser.request_id}`,
      JSON.stringify(otherUser)
    )
    window.dispatchEvent(
      new StorageEvent('storage', { key: `${key}:${other.request_id}` })
    )
  })
  expect(localStorage.getItem(`${key}:${operation?.request_id}`)).toBe(
    JSON.stringify(operation)
  )
  await act(async () => {
    finish(success(operation))
    await response
  })
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(localStorage.getItem(`${key}:${operation?.request_id}`)).toBeNull()
  expect(localStorage.getItem(`${key}:${other.request_id}`)).toBe(
    JSON.stringify(other)
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Check transfer result' })
  )
  expect(screen.getByText(other.request_id)).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Retry original transfer' })
  ).toBeDisabled()
  await userEvent.click(
    within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(localStorage.getItem(`${key}:${other.request_id}`)).toBeNull()
  expect(
    localStorage.getItem(`new-api:affiliate-transfer:2:${otherUser.request_id}`)
  ).toBe(JSON.stringify(otherUser))
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(1)
})

test('an idle tab adopts another tab pending operation without sending a new transfer', async () => {
  const operation = { request_id: 'other-tab-pending-0001', quota: 500000 }
  const key = `new-api:affiliate-transfer:1:${operation.request_id}`
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  mountCard()
  await screen.findByRole('button', { name: 'Transfer to Balance' })
  act(() => {
    localStorage.setItem(key, JSON.stringify(operation))
    window.dispatchEvent(new StorageEvent('storage', { key }))
  })
  await userEvent.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  expect(await screen.findByText(operation.request_id)).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Retry original transfer' })
  ).toBeDisabled()
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(0)
})

test.each(['invalid JSON', 'mismatched request ID', 'conflicting quota'])(
  'a durable operation with %s blocks new transfers without deleting saved evidence',
  async (failure) => {
    const operation = { request_id: 'durable-pending-operation', quota: 500000 }
    const key = `new-api:affiliate-transfer:1:${operation.request_id}`
    let raw = '{invalid'
    if (failure === 'mismatched request ID') {
      raw = JSON.stringify({
        ...operation,
        request_id: 'different-operation-0001',
      })
    }
    if (failure === 'conflicting quota') {
      raw = JSON.stringify({ ...operation, quota: 500001 })
      sessionStorage.setItem(
        'new-api:affiliate-transfer:1',
        JSON.stringify(operation)
      )
    }
    localStorage.setItem(key, raw)
    const request = vi
      .spyOn(api, 'request')
      .mockImplementation(async (config) => {
        if (config.url === '/api/user/aff') return success('invite-first')
        return success(summary)
      })
    mountCard()
    await screen.findByRole('textbox', { name: 'Invitation link' })
    expect(
      screen.getByRole('button', { name: 'Transfer to Balance' })
    ).toBeDisabled()
    expect(
      screen.getByText(
        'Saved transfer details are unavailable or invalid. Restore browser storage and retry before starting another transfer.'
      )
    ).toBeVisible()
    expect(localStorage.getItem(key)).toBe(raw)
    expect(
      request.mock.calls.filter(([config]) => config.method === 'post')
    ).toHaveLength(0)
  }
)

test('durable cleanup failure after page-session cleanup keeps the confirmed ID recoverable in a new tab', async () => {
  const key = 'new-api:affiliate-transfer:1'
  let operation: { request_id: string; quota: number } | undefined
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.method === 'post') {
        operation = config.data as { request_id: string; quota: number }
        return success(operation)
      }
      if (config.url?.includes('/aff_transfer/')) {
        return success({
          found: true,
          transfer: { id: 1, ...operation, created_at: 1 },
        })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  const first = mountCard()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  const originalRemove = durableStorageMethods.removeItem
  const remove = vi
    .spyOn(durableStorageMethods, 'removeItem')
    .mockImplementation(function (this: Storage, entry: string) {
      if (entry.startsWith(`${key}:`)) {
        throw new DOMException('Storage unavailable', 'SecurityError')
      }
      originalRemove.call(this, entry)
    })
  await userEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(sessionStorage.getItem(key)).toBeNull()
  expect(localStorage.getItem(`${key}:${operation?.request_id}`)).toBe(
    JSON.stringify(operation)
  )
  expect(
    screen.getByText(
      'Transfer succeeded, but the saved operation could not be cleared. Check the original operation before starting another transfer.'
    )
  ).toBeVisible()
  first.unmount()
  sessionStorage.clear()
  remove.mockRestore()
  mountCard()
  await screen.findByRole('textbox', { name: 'Invitation link' })
  await userEvent.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  await userEvent.click(
    within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(localStorage.getItem(`${key}:${operation?.request_id}`)).toBeNull()
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(1)
})

test('durable pending operations stay scoped to the account after logout and a new login', async () => {
  const operation = { request_id: 'returning-user-operation', quota: 500000 }
  const key = `new-api:affiliate-transfer:1:${operation.request_id}`
  localStorage.setItem(key, JSON.stringify(operation))
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url === '/api/user/aff') {
        return success(`invite-${useAuthStore.getState().auth.user?.id}`)
      }
      return success(summary)
    })
  mountCard()
  await screen.findByRole('button', { name: 'Check transfer result' })
  act(() => {
    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({ id: 2, username: 'second', role: 1 })
  })
  await screen.findByRole('button', { name: 'Transfer to Balance' })
  expect(
    screen.queryByRole('button', { name: 'Check transfer result' })
  ).not.toBeInTheDocument()
  expect(screen.queryByText(operation.request_id)).not.toBeInTheDocument()
  act(() => {
    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({ id: 1, username: 'first', role: 1 })
  })
  await userEvent.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  expect(await screen.findByText(operation.request_id)).toBeVisible()
  expect(localStorage.getItem(key)).toBe(JSON.stringify(operation))
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(0)
})

test.each(['persist', 'retire legacy'])(
  'a failed %s step during legacy migration preserves the original ID and blocks dispatch until storage recovers',
  async (failure) => {
    const operation = {
      request_id: 'migration-pending-operation',
      quota: 500000,
    }
    const key = 'new-api:affiliate-transfer:1'
    sessionStorage.setItem(key, JSON.stringify(operation))
    const legacyStorageMethods = Object.hasOwn(sessionStorage, 'removeItem')
      ? sessionStorage
      : Storage.prototype
    const blocked =
      failure === 'persist'
        ? vi.spyOn(durableStorageMethods, 'setItem').mockImplementation(() => {
            throw new DOMException('Storage full', 'QuotaExceededError')
          })
        : vi
            .spyOn(legacyStorageMethods, 'removeItem')
            .mockImplementation(() => {
              throw new DOMException('Storage unavailable', 'SecurityError')
            })
    const request = vi
      .spyOn(api, 'request')
      .mockImplementation(async (config) => {
        if (config.url === '/api/user/aff') return success('invite-first')
        return success(summary)
      })
    mountCard()
    await screen.findByRole('textbox', { name: 'Invitation link' })
    expect(
      screen.getByRole('button', { name: 'Transfer to Balance' })
    ).toBeDisabled()
    expect(sessionStorage.getItem(key)).toBe(JSON.stringify(operation))
    expect(
      request.mock.calls.filter(([config]) => config.method === 'post')
    ).toHaveLength(0)
    blocked.mockRestore()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await userEvent.click(
      await screen.findByRole('button', { name: 'Check transfer result' })
    )
    expect(await screen.findByText(operation.request_id)).toBeVisible()
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(localStorage.getItem(`${key}:${operation.request_id}`)).toBe(
      JSON.stringify(operation)
    )
    expect(
      request.mock.calls.filter(([config]) => config.method === 'post')
    ).toHaveLength(0)
  }
)

test('a persisted rejection found after reopening releases only that operation without reporting a transfer success', async () => {
  const operation = { request_id: 'rejected-durable-operation', quota: 500000 }
  const other = { request_id: 'other-durable-operation', quota: 500000 }
  const key = 'new-api:affiliate-transfer:1'
  sessionStorage.setItem(key, JSON.stringify(operation))
  localStorage.setItem(`${key}:${other.request_id}`, JSON.stringify(other))
  const successToast = vi.spyOn(toast, 'success')
  const errorToast = vi.spyOn(toast, 'error')
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url?.includes('/aff_transfer/')) {
        return success({
          found: false,
          transfer: null,
          rejection: {
            ...operation,
            message_key: 'Invitation quota is insufficient!',
          },
        })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  const { refresh } = mountCard()
  await screen.findByRole('textbox', { name: 'Invitation link' })
  await userEvent.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  expect(localStorage.getItem(`${key}:${operation.request_id}`)).toBeNull()
  expect(localStorage.getItem(`${key}:${other.request_id}`)).toBe(
    JSON.stringify(other)
  )
  expect(screen.getByText(other.request_id)).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Retry original transfer' })
  ).toBeDisabled()
  expect(successToast).not.toHaveBeenCalled()
  expect(errorToast).toHaveBeenCalledWith('Invitation quota is insufficient!')
  expect(refresh).not.toHaveBeenCalled()
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toHaveLength(0)
})

test.each([
  'wrong request ID',
  'wrong amount',
  'conflicting successful result',
])(
  'a rejected lookup with %s preserves the unresolved operation',
  async (failure) => {
    const operation = {
      request_id: 'unresolved-rejection-lookup',
      quota: 500000,
    }
    const key = `new-api:affiliate-transfer:1:${operation.request_id}`
    localStorage.setItem(key, JSON.stringify(operation))
    const rejected = {
      ...operation,
      message_key: 'Invitation quota is insufficient!',
    }
    if (failure === 'wrong request ID') {
      rejected.request_id = 'another-rejected-operation'
    }
    if (failure === 'wrong amount') rejected.quota = 1000000
    const successToast = vi.spyOn(toast, 'success')
    vi.spyOn(api, 'request').mockImplementation(async (config) => {
      if (config.url?.includes('/aff_transfer/')) {
        return success({
          found: failure === 'conflicting successful result',
          transfer:
            failure === 'conflicting successful result'
              ? { id: 1, ...operation, created_at: 1 }
              : null,
          rejection: rejected,
        })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
    const { refresh } = mountCard()
    await screen.findByRole('textbox', { name: 'Invitation link' })
    await userEvent.click(
      await screen.findByRole('button', { name: 'Check transfer result' })
    )
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Check transfer result',
      })
    )
    expect(localStorage.getItem(key)).toBe(JSON.stringify(operation))
    expect(
      screen.getByRole('spinbutton', { name: 'Transfer Amount' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Retry original transfer' })
    ).toBeDisabled()
    expect(successToast).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  }
)

test('a durable rejected result recovers after storage access fails and the page reopens', async () => {
  let respond!: (value: ReturnType<typeof success>) => void
  const response = new Promise<ReturnType<typeof success>>((resolve) => {
    respond = resolve
  })
  let original: { request_id: string; quota: number } | undefined
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.method === 'post') {
        original = config.data as typeof original
        return response
      }
      if (config.url?.includes('/aff_transfer/')) {
        return success({
          found: false,
          transfer: null,
          rejection: {
            ...original,
            message_key: 'Invitation quota is insufficient!',
          },
        })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  const first = mountCard()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() => expect(original).toBeDefined())
  const get = vi
    .spyOn(durableStorageMethods, 'getItem')
    .mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError')
    })
  await act(async () => {
    respond({
      data: {
        success: false,
        message_key: 'Invitation quota is insufficient!',
        data: {
          transfer_status: 'rejected',
          result_persisted: true,
          ...original,
        },
      },
    } as ReturnType<typeof success>)
    await response
  })
  expect(
    await screen.findByText(
      'Transfer was rejected. No balance was moved. Restore browser storage before starting another transfer.'
    )
  ).toBeVisible()
  first.unmount()
  get.mockRestore()
  const successToast = vi.spyOn(toast, 'success')
  const second = mountCard()
  await screen.findByRole('textbox', { name: 'Invitation link' })
  await userEvent.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  expect(
    screen.getByRole('spinbutton', { name: 'Transfer Amount' })
  ).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Transfer' })).toBeEnabled()
  expect(savedTransfer('new-api:affiliate-transfer:1')).toBeNull()
  expect(successToast).not.toHaveBeenCalled()
  expect(second.refresh).not.toHaveBeenCalled()
  expect(
    request.mock.calls
      .filter(([config]) => config.method === 'post')
      .map(([config]) => config.data)
  ).toEqual([original])
})

test('a persisted rejection of a retry releases its original identity for a corrected amount', async () => {
  const operation = { request_id: 'retry-rejected-durable', quota: 1000000 }
  const key = `new-api:affiliate-transfer:1:${operation.request_id}`
  localStorage.setItem(key, JSON.stringify(operation))
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.method === 'post') {
        return {
          data: {
            success: false,
            message_key: 'Invitation quota is insufficient!',
            data: {
              transfer_status: 'rejected',
              result_persisted: true,
              ...(config.data as object),
            },
          },
        }
      }
      if (config.url?.includes('/aff_transfer/')) {
        return success({ found: false, transfer: null })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  const { refresh } = mountCard()
  const successToast = vi.spyOn(toast, 'success')
  await screen.findByRole('textbox', { name: 'Invitation link' })
  await userEvent.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Retry original transfer' })
  )
  expect(
    screen.getByRole('spinbutton', { name: 'Transfer Amount' })
  ).toBeEnabled()
  expect(localStorage.getItem(key)).toBeNull()
  expect(
    request.mock.calls
      .filter(([config]) => config.method === 'post')
      .map(([config]) => config.data)
  ).toEqual([operation])
  expect(successToast).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
})

test('a delayed unpersisted rejection cannot release an operation still being retried in another tab', async () => {
  const responses: ((value: ReturnType<typeof success>) => void)[] = []
  const posts: { request_id: string; quota: number }[] = []
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    if (config.method === 'post') {
      posts.push(config.data as { request_id: string; quota: number })
      if (posts.length <= 2) {
        return new Promise<ReturnType<typeof success>>((resolve) => {
          responses.push(resolve)
        })
      }
      return success({ id: 2, ...(config.data as object), created_at: 1 })
    }
    if (config.url?.includes('/aff_transfer/')) {
      return success({ found: false, transfer: null })
    }
    if (config.url === '/api/user/aff') return success('invite-first')
    return success(summary)
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  const first = renderHook(() => useAffiliate(), { wrapper })
  const peer = renderHook(() => useAffiliate(), { wrapper })
  await waitFor(() =>
    expect(
      first.result.current.query.isSuccess &&
        peer.result.current.query.isSuccess
    ).toBe(true)
  )
  let originalAttempt!: Promise<boolean>
  act(() => {
    originalAttempt = first.result.current.transferQuota(500000)
  })
  await waitFor(() => expect(posts).toHaveLength(1))
  const original = posts[0]
  const key = `new-api:affiliate-transfer:1:${original.request_id}`
  act(() => window.dispatchEvent(new StorageEvent('storage', { key })))
  await waitFor(() => expect(peer.result.current.pending).toEqual(original))
  await act(async () => {
    await peer.result.current.verifyTransfer()
  })
  let peerAttempt!: Promise<boolean>
  act(() => {
    peerAttempt = peer.result.current.transferQuota(500000)
  })
  await waitFor(() => expect(posts).toHaveLength(2))
  await act(async () => {
    responses[0]({
      data: {
        success: false,
        message_key: 'Invitation quota is insufficient!',
        data: { transfer_status: 'rejected', ...original },
      },
    } as ReturnType<typeof success>)
    await originalAttempt
  })
  const pendingAfterRejection = first.result.current.pending
  let replacement = false
  await act(async () => {
    replacement = await first.result.current.transferQuota(500000)
  })
  await act(async () => {
    responses[1](success({ id: 1, ...original, created_at: 1 }))
    await peerAttempt
  })
  expect(pendingAfterRejection).toEqual(original)
  expect(replacement).toBe(false)
  expect(posts).toEqual([original, original])
})

test('deleting an unresolved durable key in another tab retains and retries the original operation', async () => {
  const operation = { request_id: 'r2-peer-deleted-pending', quota: 500000 }
  const key = `new-api:affiliate-transfer:1:${operation.request_id}`
  localStorage.setItem(key, JSON.stringify(operation))
  const posts: unknown[] = []
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.method === 'post') {
        expect(localStorage.getItem(key)).toBe(JSON.stringify(operation))
        posts.push(config.data)
        return success({ id: 1, ...operation, created_at: 1 })
      }
      if (config.url?.includes('/aff_transfer/')) {
        return success({ found: false, transfer: null })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
  mountCard()
  await screen.findByRole('textbox', { name: 'Invitation link' })
  await userEvent.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  act(() => {
    localStorage.removeItem(key)
    window.dispatchEvent(new StorageEvent('storage', { key }))
  })
  expect(screen.getByText(operation.request_id)).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Retry original transfer' })
  ).toBeDisabled()
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Retry original transfer' })
  )
  expect(posts).toEqual([operation])
  expect(
    request.mock.calls.filter(([config]) =>
      config.url?.includes('/aff_transfer/')
    )
  ).toHaveLength(1)
  expect(localStorage.getItem(key)).toBeNull()
})

test.each(['confirmed', 'rejected'] as const)(
  'another tab retires a %s key while local cleanup failed without deleting its next operation',
  async (terminal) => {
    const operation = {
      request_id: 'r2-local-terminal-operation',
      quota: 500000,
    }
    const other = { request_id: 'r2-peer-next-operation', quota: 1000000 }
    const key = `new-api:affiliate-transfer:1:${operation.request_id}`
    const otherKey = `new-api:affiliate-transfer:1:${other.request_id}`
    localStorage.setItem(key, JSON.stringify(operation))
    const posts: unknown[] = []
    vi.spyOn(api, 'request').mockImplementation(async (config) => {
      if (config.method === 'post') posts.push(config.data)
      if (config.url?.includes('/aff_transfer/')) {
        if (terminal === 'confirmed') {
          return success({
            found: true,
            transfer: { id: 1, ...operation, created_at: 1 },
          })
        }
        return success({
          found: false,
          transfer: null,
          rejection: {
            ...operation,
            message_key: 'Invitation quota is insufficient!',
          },
        })
      }
      if (config.url === '/api/user/aff') return success('invite-first')
      return success(summary)
    })
    mountCard()
    await screen.findByRole('textbox', { name: 'Invitation link' })
    await userEvent.click(
      await screen.findByRole('button', { name: 'Check transfer result' })
    )
    const remove = vi
      .spyOn(durableStorageMethods, 'removeItem')
      .mockImplementation(() => {
        throw new DOMException('Storage unavailable', 'SecurityError')
      })
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Check transfer result',
      })
    )
    expect(localStorage.getItem(key)).toBe(JSON.stringify(operation))
    remove.mockRestore()
    act(() => {
      localStorage.removeItem(key)
      localStorage.setItem(otherKey, JSON.stringify(other))
      window.dispatchEvent(new StorageEvent('storage', { key }))
      window.dispatchEvent(new StorageEvent('storage', { key: otherKey }))
    })
    if (terminal === 'confirmed') {
      await userEvent.click(
        screen.getByRole('button', { name: 'Check transfer result' })
      )
      expect(screen.getByText(operation.request_id)).toBeVisible()
      await userEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Check transfer result',
        })
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Check transfer result' })
      )
    } else {
      await userEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Retry',
        })
      )
    }
    expect(screen.getByText(other.request_id)).toBeVisible()
    expect(
      screen.getByRole('spinbutton', { name: 'Transfer Amount' })
    ).toHaveValue(2)
    expect(
      screen.getByRole('button', { name: 'Retry original transfer' })
    ).toBeDisabled()
    expect(localStorage.getItem(otherKey)).toBe(JSON.stringify(other))
    expect(posts).toEqual([])
  }
)

test('a storage event for the previous account cannot replace the current account pending transfer', async () => {
  const first = { request_id: 'first-account-pending-transfer', quota: 500000 }
  const second = {
    request_id: 'second-account-pending-transfer',
    quota: 1000000,
  }
  const firstKey = `new-api:affiliate-transfer:1:${first.request_id}`
  const secondKey = `new-api:affiliate-transfer:2:${second.request_id}`
  localStorage.setItem(firstKey, JSON.stringify(first))
  localStorage.setItem(secondKey, JSON.stringify(second))
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (config) => {
      if (config.url?.includes('/aff_transfer/')) {
        return success({ found: false, transfer: null })
      }
      if (config.url === '/api/user/aff') return success('invite-current')
      return success(summary)
    })
  mountCard()
  await screen.findByRole('textbox', { name: 'Invitation link' })
  act(() => {
    useAuthStore.getState().auth.setUser({ id: 2, username: 'second', role: 1 })
  })
  await screen.findByRole('textbox', { name: 'Invitation link' })
  await userEvent.click(
    screen.getByRole('button', { name: 'Check transfer result' })
  )
  act(() => {
    localStorage.removeItem(firstKey)
    window.dispatchEvent(new StorageEvent('storage', { key: firstKey }))
  })
  expect(screen.getByText(second.request_id)).toBeVisible()
  expect(screen.queryByText(first.request_id)).not.toBeInTheDocument()
  expect(
    screen.getByRole('spinbutton', { name: 'Transfer Amount' })
  ).toHaveValue(2)
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Check transfer result',
    })
  )
  expect(
    screen.getByRole('button', { name: 'Retry original transfer' })
  ).toBeEnabled()
  expect(
    request.mock.calls
      .filter(([config]) => config.url?.includes('/aff_transfer/'))
      .map(([config]) => config.url)
  ).toEqual([`/api/user/aff_transfer/${second.request_id}`])
  expect(
    request.mock.calls.filter(([config]) => config.method === 'post')
  ).toEqual([])
  expect(localStorage.getItem(secondKey)).toBe(JSON.stringify(second))
})
