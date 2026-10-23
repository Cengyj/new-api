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
import {
  AxiosError,
  AxiosHeaders,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { applyAuthBundle, clearAuthentication } from '@/lib/auth-session'
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { getUserBillingHistory, requestPayment } from '../api'
import { BillingHistoryDialog } from '../components/dialogs/billing-history-dialog'
import { useBillingHistory } from '../hooks/use-billing-history'
import { usePaymentOperation } from '../hooks/use-payment-operation'

const original: AuthBundle = {
  access_token: 'test-admin-access',
  token_type: 'Bearer',
  access_expires_at: 2_000_000_000,
  user: { id: 1, username: 'test-admin', role: 100 },
  session: {
    sid: 'test-session',
    current: true,
    login_method: 'password',
    ip: '',
    user_agent: '',
    created_at: 1,
    last_active_at: 1,
    expires_at: 2_000_000_000,
  },
}
const record = {
  id: 1,
  user_id: 2,
  trade_no: 'pending-order',
  amount: 10,
  money: 10,
  payment_method: 'stripe',
  create_time: 1,
  status: 'pending',
}
const history = { data: { success: true, data: { items: [record], total: 1 } } }

beforeEach(() => {
  useAuthStore.getState().auth.reset()
  applyAuthBundle(original, false)
  useSystemConfigStore.getState().setConfig({
    currency: { ...DEFAULT_CURRENCY_CONFIG },
  })
})

describe('billing history authentication recovery', () => {
  const originalAdapter = api.defaults.adapter
  let requests: InternalAxiosRequestConfig[]
  let refreshStatus: number
  let refreshBundle: AuthBundle
  let holdRefresh: boolean
  let finishRefresh: (() => void) | undefined

  beforeEach(() => {
    window.history.replaceState({}, '', '/sign-in')
    requests = []
    refreshStatus = 200
    refreshBundle = { ...original, access_token: 'fresh-history-access' }
    holdRefresh = false
    finishRefresh = undefined
    vi.spyOn(XMLHttpRequest.prototype, 'open')
    vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(function (
      this: XMLHttpRequest
    ) {
      finishRefresh = () => {
        Object.defineProperties(this, {
          status: { value: refreshStatus, configurable: true },
          statusText: { value: 'Refresh response', configurable: true },
          responseText: {
            value: JSON.stringify({
              success: refreshStatus === 200,
              data: refreshStatus === 200 ? refreshBundle : undefined,
            }),
            configurable: true,
          },
          readyState: { value: 4, configurable: true },
        })
        this.onloadend?.(new ProgressEvent('loadend'))
      }
      if (!holdRefresh) finishRefresh()
    })
    api.defaults.adapter = async (config) => {
      requests.push({ ...config, headers: new AxiosHeaders(config.headers) })
      if (config.method === 'post') {
        throw new AxiosError('Response lost', 'ERR_NETWORK', config)
      }
      if (config.headers.get('Authorization') === 'Bearer test-admin-access') {
        throw new AxiosError('HTTP 401', 'ERR_BAD_REQUEST', config, undefined, {
          config,
          status: 401,
          statusText: 'Unauthorized',
          headers: {},
          data: { success: false, message: 'Access token expired' },
        })
      }
      return {
        config,
        status: 200,
        statusText: 'OK',
        headers: {},
        data: history.data,
      }
    }
  })

  afterEach(() => {
    api.defaults.adapter = originalAdapter
    clearAuthentication(false)
    window.history.replaceState({}, '', '/')
  })

  test.each([
    { role: 1, endpoint: '/api/user/topup/self?p=1&page_size=10' },
    { role: 100, endpoint: '/api/user/topup?p=1&page_size=10' },
  ])(
    'an expired role $role query refreshes once and shows its order history',
    async ({ role, endpoint }) => {
      applyAuthBundle({ ...original, user: { ...original.user, role } }, false)
      refreshBundle.user = { ...original.user, role }
      render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
      expect(await screen.findByText(record.trade_no)).toBeVisible()
      expect(requests.map((request) => request.url)).toEqual([
        endpoint,
        endpoint,
      ])
      expect(requests[1].headers.get('Authorization')).toBe(
        'Bearer fresh-history-access'
      )
      expect(XMLHttpRequest.prototype.open).toHaveBeenCalledExactlyOnceWith(
        'POST',
        '/api/user/auth/refresh',
        true
      )
      expect(requests.every((request) => request.method === 'get')).toBe(true)
    }
  )

  test.each(['user', 'session', 'role'])(
    '%s changing during refresh cancels the old query before retry and preserves the new identity',
    async (change) => {
      holdRefresh = true
      const { result } = renderHook(() => useBillingHistory())
      await waitFor(() => expect(finishRefresh).toBeTypeOf('function'))
      const next: AuthBundle = {
        ...original,
        access_token: 'next-history-access',
        user: {
          ...original.user,
          id: change === 'user' ? 2 : original.user.id,
          role: change === 'role' ? 1 : original.user.role,
        },
        session: {
          ...original.session,
          sid: change === 'role' ? original.session.sid : 'next-session',
        },
      }
      act(() => applyAuthBundle(next, false))
      await waitFor(() => expect(result.current.records).toHaveLength(1))
      await act(async () => finishRefresh?.())
      expect(requests).toHaveLength(2)
      expect(requests[0].signal?.aborted).toBe(true)
      expect(requests[1].headers.get('Authorization')).toBe(
        'Bearer next-history-access'
      )
      expect(requests[1].url).toBe(
        change === 'role'
          ? '/api/user/topup/self?p=1&page_size=10'
          : '/api/user/topup?p=1&page_size=10'
      )
      expect(useAuthStore.getState().auth.accessToken).toBe(next.access_token)
      expect(useAuthStore.getState().auth.user).toEqual(next.user)
      expect(useAuthStore.getState().auth.session?.sid).toBe(next.session.sid)
    }
  )

  test.each([401, 503])(
    'refresh HTTP %i rejects the query without returning an empty or stale history',
    async (status) => {
      refreshStatus = status
      await expect(getUserBillingHistory(1, 10)).rejects.toMatchObject({
        response: { status: 401 },
      })
      expect(requests).toHaveLength(1)
      expect(XMLHttpRequest.prototype.open).toHaveBeenCalledTimes(1)
      expect(useAuthStore.getState().auth.accessToken).toBe(
        status === 401 ? null : original.access_token
      )
    }
  )

  test('a transient refresh failure shows unconfirmed history until explicit retry recovers', async () => {
    refreshStatus = 503
    render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
    expect(
      await screen.findByText('Failed to load billing history')
    ).toBeVisible()
    expect(
      screen.queryByText('No billing records found')
    ).not.toBeInTheDocument()
    refreshStatus = 200
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(record.trade_no)).toBeVisible()
    expect(requests).toHaveLength(3)
    expect(XMLHttpRequest.prototype.open).toHaveBeenCalledTimes(2)
  })

  test('concurrent queries share refresh while one cancellation cannot cancel the other history read', async () => {
    holdRefresh = true
    const canceled = new AbortController()
    const first = getUserBillingHistory(
      1,
      10,
      undefined,
      canceled.signal
    ).catch((error: unknown) => error)
    const second = getUserBillingHistory(2, 10)
    await waitFor(() => {
      expect(requests).toHaveLength(2)
      expect(finishRefresh).toBeTypeOf('function')
    })
    canceled.abort()
    finishRefresh?.()
    expect(await first).toMatchObject({ code: 'ERR_CANCELED' })
    await expect(second).resolves.toEqual(history.data)
    expect(XMLHttpRequest.prototype.open).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(3)
    expect(requests[2].url).toBe('/api/user/topup/self?p=2&page_size=10')
  })

  test('after an unknown payment response history can recover authentication without resubmitting payment', async () => {
    const notify = vi.spyOn(toast, 'error')
    const { result } = renderHook(() => usePaymentOperation())
    await act(async () => {
      expect(
        await result.current.runPayment(
          (signal) =>
            requestPayment({ amount: 1, payment_method: 'alipay' }, signal),
          () => true
        )
      ).toBe(false)
    })
    expect(notify).toHaveBeenCalledWith(
      'Payment request result is unknown. Check Order History before trying again.'
    )
    render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
    expect(await screen.findByText(record.trade_no)).toBeVisible()
    expect(
      requests.filter((request) => request.method === 'post')
    ).toHaveLength(1)
    expect(requests.filter((request) => request.method === 'get')).toHaveLength(
      2
    )
    expect(XMLHttpRequest.prototype.open).toHaveBeenCalledTimes(1)
  })
})

test.each([
  { provider: 'creem', method: 'creem', amount: 500000, expected: '$1' },
  { provider: 'epay', method: 'creem', amount: 10, expected: '$10' },
  { provider: '', method: 'creem', amount: 10, expected: '$10' },
  { provider: 'unknown', method: 'creem', amount: 10, expected: '$10' },
  { provider: 'stripe', method: 'stripe', amount: 10, expected: '$10' },
])(
  'billing history respects the stored amount units for provider "$provider" without guessing from method "$method"',
  async ({ provider, method, amount, expected }) => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        success: true,
        data: {
          items: [
            {
              ...record,
              amount,
              money: 90,
              payment_provider: provider,
              payment_method: method,
            },
          ],
          total: 1,
        },
      },
    })
    render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
    expect(await screen.findByText(record.trade_no)).toBeVisible()
    expect(screen.getByText(expected)).toBeVisible()
    expect(screen.getByText('90')).toBeVisible()
  }
)

test('a failed payment is shown as failed and never offers administrator completion', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [{ ...record, status: 'failed' }], total: 1 },
    },
  })
  render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
  expect(await screen.findByText(record.trade_no)).toBeVisible()
  expect(screen.getByText('Failed')).toBeVisible()
  expect(screen.queryByText('Pending')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Complete Order' })
  ).not.toBeInTheDocument()
})

test.each(['business rejection', 'network failure'])(
  'a billing history %s stays unconfirmed until an explicit retry succeeds',
  async (failure) => {
    const previousAdapter = api.defaults.adapter
    const requests: AxiosRequestConfig[] = []
    api.defaults.adapter = async (config) => {
      requests.push(config)
      if (requests.length === 1 && failure === 'network failure') {
        throw new AxiosError('Network Error', 'ERR_NETWORK', config)
      }
      return {
        config,
        status: 200,
        statusText: 'OK',
        headers: {},
        data:
          requests.length === 1
            ? { success: false, message: 'Database error' }
            : { success: true, data: { items: [], total: 0 } },
      }
    }
    try {
      render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
      expect(
        await screen.findByText('Failed to load billing history')
      ).toBeVisible()
      expect(
        screen.queryByText('No billing records found')
      ).not.toBeInTheDocument()
      expect(requests).toHaveLength(1)
      expect(requests[0].url).toBe('/api/user/topup?p=1&page_size=10')
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(await screen.findByText('No billing records found')).toBeVisible()
      expect(
        screen.queryByText('Failed to load billing history')
      ).not.toBeInTheDocument()
      expect(requests).toHaveLength(2)
      expect(requests.every((request) => request.method === 'get')).toBe(true)
    } finally {
      api.defaults.adapter = previousAdapter
    }
  }
)

test('an order completion rejected with 401 is not automatically refreshed and replayed by the real HTTP client', async () => {
  const previousAdapter = api.defaults.adapter
  const requests: AxiosRequestConfig[] = []
  const send = vi
    .spyOn(XMLHttpRequest.prototype, 'send')
    .mockImplementation(function (this: XMLHttpRequest) {
      Object.defineProperties(this, {
        status: { value: 200, configurable: true },
        statusText: { value: 'OK', configurable: true },
        responseText: {
          value: JSON.stringify({
            success: true,
            data: { ...original, access_token: 'refreshed-admin-access' },
          }),
          configurable: true,
        },
        readyState: { value: 4, configurable: true },
      })
      this.onloadend?.(new ProgressEvent('loadend'))
    })
  api.defaults.adapter = async (config) => {
    if (config.method === 'post') {
      requests.push(config)
      if (!config.authRetry) {
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
        data: { success: true },
      }
    }
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: history.data,
    }
  }
  try {
    const { result } = renderHook(() => useBillingHistory())
    await waitFor(() => expect(result.current.records).toHaveLength(1))
    let completed = true
    await act(async () => {
      completed = await result.current.handleCompleteOrder(record.trade_no)
    })
    expect(requests).toHaveLength(1)
    expect(send).not.toHaveBeenCalled()
    expect(completed).toBe(false)
  } finally {
    api.defaults.adapter = previousAdapter
  }
})

test('leaving the wallet while completion is pending prevents a late success from refreshing or notifying another page', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue(history)
  let finish!: (value: { data: { success: boolean } }) => void
  const pending = new Promise<{ data: { success: boolean } }>((resolve) => {
    finish = resolve
  })
  vi.spyOn(api, 'post').mockReturnValue(pending)
  const notify = vi.spyOn(toast, 'success')
  const { result, unmount } = renderHook(() => useBillingHistory())
  await waitFor(() => expect(result.current.records).toHaveLength(1))
  let operation!: Promise<boolean>
  act(() => {
    operation = result.current.handleCompleteOrder(record.trade_no)
  })
  unmount()
  await act(async () => {
    finish({ data: { success: true } })
    await operation
  })
  expect(get).toHaveBeenCalledTimes(1)
  expect(notify).not.toHaveBeenCalled()
  expect(await operation).toBe(false)
})

test('the same session losing admin privileges dismisses an old completion confirmation', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(history)
  const post = vi.spyOn(api, 'post')
  render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Complete Order' }))
  expect(
    screen.getByRole('alertdialog', { name: 'Complete Order' })
  ).toBeVisible()
  act(() =>
    applyAuthBundle({ ...original, user: { ...original.user, role: 1 } }, false)
  )
  await waitFor(() =>
    expect(
      screen.queryByRole('alertdialog', { name: 'Complete Order' })
    ).not.toBeInTheDocument()
  )
  expect(
    screen.queryByRole('button', { name: 'Complete Order' })
  ).not.toBeInTheDocument()
  expect(post).not.toHaveBeenCalled()
})

test('a completed order closes confirmation even when refreshing the history fails', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValueOnce(history)
    .mockRejectedValueOnce(new Error('History unavailable'))
    .mockResolvedValue({
      data: {
        success: true,
        data: { items: [{ ...record, status: 'success' }], total: 1 },
      },
    })
  const notify = vi.spyOn(toast, 'success')
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true } })
  render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Complete Order' }))
  fireEvent.click(
    within(
      screen.getByRole('alertdialog', { name: 'Complete Order' })
    ).getByRole('button', { name: 'Confirm' })
  )
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  await waitFor(() =>
    expect(
      screen.queryByRole('alertdialog', { name: 'Complete Order' })
    ).not.toBeInTheDocument()
  )
  expect(
    await screen.findByText('Failed to load billing history')
  ).toBeVisible()
  expect(screen.queryByText('No billing records found')).not.toBeInTheDocument()
  expect(screen.queryByText(record.trade_no)).not.toBeInTheDocument()
  expect(notify).toHaveBeenCalledWith('Order completed successfully')
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText(record.trade_no)).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Complete Order' })
  ).not.toBeInTheDocument()
  expect(get).toHaveBeenCalledTimes(3)
  expect(post).toHaveBeenCalledTimes(1)
})

test('a completion response refreshes the current search instead of restoring the old unfiltered page', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: {
        total: 1,
        items: [
          {
            ...record,
            trade_no: url.includes('keyword=matching')
              ? 'matching-order'
              : 'unfiltered-order',
          },
        ],
      },
    },
  }))
  let finish!: (value: { data: { success: boolean } }) => void
  const pending = new Promise<{ data: { success: boolean } }>((resolve) => {
    finish = resolve
  })
  vi.spyOn(api, 'post').mockReturnValue(pending)
  const { result } = renderHook(() => useBillingHistory())
  await waitFor(() =>
    expect(result.current.records[0]?.trade_no).toBe('unfiltered-order')
  )
  let operation!: Promise<boolean>
  act(() => {
    operation = result.current.handleCompleteOrder('unfiltered-order')
  })
  act(() => result.current.handleSearch('matching'))
  await waitFor(() =>
    expect(result.current.records[0]?.trade_no).toBe('matching-order')
  )
  await act(async () => {
    finish({ data: { success: true } })
    await operation
  })
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3))
  expect(result.current.keyword).toBe('matching')
  expect(result.current.records[0]?.trade_no).toBe('matching-order')
})

test('same-user session replacement clears the previous history and completion confirmation before the new read completes', async () => {
  let finish!: (value: typeof history) => void
  const pending = new Promise<typeof history>((resolve) => {
    finish = resolve
  })
  vi.spyOn(api, 'get').mockResolvedValueOnce(history).mockReturnValue(pending)
  render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Complete Order' }))
  act(() =>
    applyAuthBundle(
      {
        ...original,
        session: { ...original.session, sid: 'replacement-session' },
      },
      false
    )
  )
  expect(
    screen.queryByRole('alertdialog', { name: 'Complete Order' })
  ).not.toBeInTheDocument()
  expect(screen.queryByText(record.trade_no)).not.toBeInTheDocument()
  await act(async () => {
    finish({
      data: {
        success: true,
        data: {
          items: [{ ...record, trade_no: 'replacement-order' }],
          total: 1,
        },
      },
    })
    await pending
  })
  expect(await screen.findByText('replacement-order')).toBeVisible()
})

test('a late all-user history response is discarded after the same session loses admin privileges', async () => {
  let finish!: (value: typeof history) => void
  const pending = new Promise<typeof history>((resolve) => {
    finish = resolve
  })
  const get = vi
    .spyOn(api, 'get')
    .mockReturnValueOnce(pending)
    .mockResolvedValue({
      data: { success: true, data: { items: [], total: 0 } },
    })
  render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  const oldSignal = get.mock.calls[0][1]?.signal
  act(() =>
    applyAuthBundle({ ...original, user: { ...original.user, role: 1 } }, false)
  )
  await screen.findByText('No billing records found')
  await act(async () => {
    finish(history)
    await pending
  })
  expect(screen.queryByText(record.trade_no)).not.toBeInTheDocument()
  expect(oldSignal?.aborted).toBe(true)
  expect(get.mock.calls[1][0]).toContain('/api/user/topup/self?')
})

test.each(['unmount', 'role change'])(
  '%s before the real HTTP interceptor runs prevents order completion dispatch',
  async (boundary) => {
    const previousAdapter = api.defaults.adapter
    const requests: AxiosRequestConfig[] = []
    api.defaults.adapter = async (config) => {
      requests.push(config)
      return {
        config,
        status: 200,
        statusText: 'OK',
        headers: {},
        data: history.data,
      }
    }
    try {
      const { result, unmount } = renderHook(() => useBillingHistory())
      await waitFor(() => expect(result.current.records).toHaveLength(1))
      await act(async () => {
        const operation = result.current.handleCompleteOrder(record.trade_no)
        if (boundary === 'unmount') {
          unmount()
        } else {
          applyAuthBundle(
            { ...original, user: { ...original.user, role: 1 } },
            false
          )
        }
        expect(await operation).toBe(false)
      })
      expect(
        requests.filter((request) => request.method === 'post')
      ).toHaveLength(0)
    } finally {
      api.defaults.adapter = previousAdapter
    }
  }
)

test('concurrent order confirmations send one mutation and a slow history refresh does not keep it pending', async () => {
  let finish!: (value: { data: { success: boolean } }) => void
  const pending = new Promise<{ data: { success: boolean } }>((resolve) => {
    finish = resolve
  })
  const post = vi.spyOn(api, 'post').mockReturnValue(pending)
  let finishRefresh!: (value: typeof history) => void
  const refresh = new Promise<typeof history>((resolve) => {
    finishRefresh = resolve
  })
  vi.spyOn(api, 'get').mockResolvedValueOnce(history).mockReturnValue(refresh)
  const { result } = renderHook(() => useBillingHistory())
  await waitFor(() => expect(result.current.records).toHaveLength(1))
  let operation!: Promise<boolean>
  await act(async () => {
    operation = result.current.handleCompleteOrder(record.trade_no)
    expect(await result.current.handleCompleteOrder(record.trade_no)).toBe(
      false
    )
  })
  expect(post).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish({ data: { success: true } })
    expect(await operation).toBe(true)
  })
  expect(result.current.completing).toBe(false)
  expect(result.current.loading).toBe(true)
  await act(async () => {
    finishRefresh(history)
    await refresh
  })
})

test('completion refreshes the current page when pagination changes while the request is pending', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: {
        total: 20,
        items: [
          {
            ...record,
            trade_no: url.includes('p=2&')
              ? 'second-page-order'
              : 'first-page-order',
          },
        ],
      },
    },
  }))
  let finish!: (value: { data: { success: boolean } }) => void
  const pending = new Promise<{ data: { success: boolean } }>((resolve) => {
    finish = resolve
  })
  vi.spyOn(api, 'post').mockReturnValue(pending)
  const { result } = renderHook(() => useBillingHistory())
  await waitFor(() =>
    expect(result.current.records[0]?.trade_no).toBe('first-page-order')
  )
  let operation!: Promise<boolean>
  act(() => {
    operation = result.current.handleCompleteOrder('first-page-order')
  })
  act(() => result.current.handlePageChange(2))
  await waitFor(() =>
    expect(result.current.records[0]?.trade_no).toBe('second-page-order')
  )
  await act(async () => {
    finish({ data: { success: true } })
    await operation
  })
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3))
  expect(result.current.page).toBe(2)
  expect(result.current.records[0]?.trade_no).toBe('second-page-order')
})

test('rejected completion keeps its confirmation available and never reports success', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(history)
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: false, message: 'Order cannot be completed' },
  })
  const notify = vi.spyOn(toast, 'success')
  render(<BillingHistoryDialog open onOpenChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Complete Order' }))
  const dialog = screen.getByRole('alertdialog', { name: 'Complete Order' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Confirm' })
    ).toBeEnabled()
  )
  expect(dialog).toBeVisible()
  expect(notify).not.toHaveBeenCalled()
})

test('Escape and outer-dialog dismissal cannot close billing history while order completion is pending', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(history)
  let finish!: (value: { data: { success: boolean } }) => void
  const pending = new Promise<{ data: { success: boolean } }>((resolve) => {
    finish = resolve
  })
  vi.spyOn(api, 'post').mockReturnValue(pending)
  const close = vi.fn()
  render(<BillingHistoryDialog open onOpenChange={close} />)
  const outerClose = within(
    screen.getByRole('dialog', { name: 'Billing History' })
  ).getByRole('button', { name: 'Close' })
  fireEvent.click(await screen.findByRole('button', { name: 'Complete Order' }))
  const dialog = screen.getByRole('alertdialog', { name: 'Complete Order' })
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Processing...' })
    ).toBeDisabled()
  )
  await userEvent.keyboard('{Escape}')
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(outerClose)
  expect(close).not.toHaveBeenCalled()
  expect(dialog).toBeVisible()
  await act(async () => {
    finish({ data: { success: true } })
    await pending
  })
  await waitFor(() =>
    expect(
      screen.queryByRole('alertdialog', { name: 'Complete Order' })
    ).not.toBeInTheDocument()
  )
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Billing History' })).getByRole(
      'button',
      { name: 'Close' }
    )
  )
  expect(close).toHaveBeenCalledWith(false)
})
