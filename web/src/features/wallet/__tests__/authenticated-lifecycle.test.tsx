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
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
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
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { useState } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { SignOutDialog } from '@/components/sign-out-dialog'
import { logout } from '@/features/auth/api'
import { ReferralRebateSection } from '@/features/system-settings/billing/referral-rebate-section'
import { SettingsPageProvider } from '@/features/system-settings/components/settings-page-context'
import { api } from '@/lib/api'
import { applyAuthBundle, clearAuthentication } from '@/lib/auth-session'
import { Route as RootRoute } from '@/routes/__root'
import { Route as AuthenticatedRoute } from '@/routes/_authenticated/route'
import { Route as WalletRoute } from '@/routes/_authenticated/wallet/index'
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { useTopupInfo } from '../hooks/use-topup-info'

// Keep the production root, auth guard, layout, outlet, wallet and dialogs.
// Navigation chrome and subscription merchandising do not participate in these operations.
vi.mock('@/components/layout/components/app-header', () => ({
  AppHeader: SignOutControl,
}))
vi.mock('@/components/layout/components/app-sidebar', () => ({
  AppSidebar: () => null,
}))
vi.mock('@/components/command-menu', () => ({ CommandMenu: () => null }))
vi.mock('../components/subscription-plans-card', () => ({
  SubscriptionPlansCard: () => null,
}))

function SignOutControl() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type='button' onClick={() => setOpen(true)}>
        Open sign out
      </button>
      <SignOutDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

function RulePage() {
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

function session(id: number, sid: string, role = 1): AuthBundle {
  return {
    access_token: `access-${sid}`,
    token_type: 'Bearer',
    access_expires_at: 2_000_000_000,
    user: { id, username: `user-${id}`, role },
    session: {
      sid,
      current: true,
      login_method: 'password',
      ip: '',
      user_agent: '',
      created_at: 1,
      last_active_at: 1,
      expires_at: 2_000_000_000,
    },
  }
}

function response(
  config: InternalAxiosRequestConfig,
  data: unknown
): AxiosResponse {
  return {
    data: { success: true, data },
    config,
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
  }
}

const topupInfo = {
  enable_online_topup: true,
  enable_stripe_topup: false,
  pay_methods: [{ name: 'Alipay', type: 'alipay' }],
  min_topup: 1,
  stripe_min_topup: 1,
  amount_options: [1],
  discount: {},
  payment_compliance_confirmed: true,
}
const pendingOrder = {
  id: 1,
  user_id: 1,
  trade_no: 'original-pending-order',
  amount: 1,
  money: 1,
  payment_method: 'alipay',
  payment_provider: 'epay',
  credited_quota: 500000,
  create_time: 1,
  status: 'pending',
}
let requests: InternalAxiosRequestConfig[]
let rule = { enabled: false, rate_bps: 500, valid_days: 7 }
let balance = 1000000
let reward = 1000000
let lookup: unknown = { found: false, transfer: null }
const originalAdapter = api.defaults.adapter

function readResponse(config: InternalAxiosRequestConfig): AxiosResponse {
  switch (config.url?.split('?')[0]) {
    case '/api/setup':
      return response(config, { status: true })
    case '/api/status':
      return response(config, {
        price: 1,
        quota_per_unit: 500000,
        quota_display_type: 'USD',
      })
    case '/api/user/auth/logout':
      return response(config, null)
    case '/api/user/self':
      return response(config, {
        id: useAuthStore.getState().auth.user?.id,
        username: 'wallet-user',
        quota: balance,
        used_quota: 0,
        request_count: 0,
        aff_quota: reward,
        aff_history_quota: 2000000,
        aff_count: 1,
        group: 'default',
      })
    case '/api/user/referral':
      return response(config, {
        rule,
        compliance_confirmed: true,
        aff_quota: String(reward),
        aff_history_quota: '2000000',
        rebate_quota: '500000',
        direct_count: 1,
      })
    case '/api/user/aff':
      return response(config, 'invitation-code')
    case '/api/user/topup/info':
      return response(config, topupInfo)
    case '/api/user/amount':
      return response(config, '1.00')
    case '/api/user/topup':
    case '/api/user/topup/self':
      return response(config, { items: [pendingOrder], total: 1 })
    case '/api/option/referral_rebate':
      return response(config, rule)
    default:
      if (config.url?.startsWith('/api/user/aff_transfer/')) {
        return response(config, lookup)
      }
      throw new Error(
        `Unexpected lifecycle boundary: ${config.method} ${config.url}`
      )
  }
}

async function mountWallet(path = '/wallet') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const authenticated = AuthenticatedRoute.update({
    id: '/_authenticated',
    getParentRoute: () => RootRoute,
  } as Parameters<typeof AuthenticatedRoute.update>[0])
  const wallet = WalletRoute.update({
    id: '/wallet/',
    path: '/wallet/',
    getParentRoute: () => authenticated,
  } as Parameters<typeof WalletRoute.update>[0])
  const rules = createRoute({
    getParentRoute: () => authenticated,
    path: '/referral-settings',
    component: RulePage,
  })
  const signedOut = createRoute({
    getParentRoute: () => RootRoute,
    path: '/sign-in',
    component: () => <div>Signed out route</div>,
  })
  const router = createRouter({
    routeTree: RootRoute.addChildren([
      authenticated.addChildren([wallet, rules]),
      signedOut,
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: client },
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await screen.findByRole('button', { name: 'Open sign out', hidden: true })
  return { client, router }
}

// A modal can prevent same-tab navigation, but another tab can revoke the session.
// Exercise the real logout API and the production root's storage-event subscriber.
async function signOutFromAnotherTab() {
  const sid = useAuthStore.getState().auth.session?.sid
  expect((await logout()).success).toBe(true)
  act(() =>
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'new-api:auth-session:event',
        newValue: JSON.stringify({
          kind: 'signed_out',
          sid,
          source: 'another-tab',
          nonce: 'logout-event',
          timestamp: Date.now(),
        }),
      })
    )
  )
  await screen.findByText('Signed out route')
  expect(useAuthStore.getState().auth.user).toBeNull()
  expect(
    screen.queryByRole('heading', { name: 'Wallet' })
  ).not.toBeInTheDocument()
}

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  localStorage.clear()
  sessionStorage.clear()
  clearAuthentication(false)
  applyAuthBundle(session(1, 'original-a'), false)
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
  requests = []
  rule = { enabled: false, rate_bps: 500, valid_days: 7 }
  balance = 1000000
  reward = 1000000
  lookup = { found: false, transfer: null }
  api.defaults.adapter = async (config) => {
    requests.push(config)
    return readResponse(config)
  }
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  vi.unstubAllGlobals()
})

test('actual logout unmounts an in-flight transfer and a new session recovers only its durable original operation', async () => {
  let release!: () => void
  let operation!: { request_id: string; quota: number }
  api.defaults.adapter = async (config) => {
    requests.push(config)
    if (config.url !== '/api/user/aff_transfer') return readResponse(config)
    operation = JSON.parse(config.data as string)
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return response(config, operation)
  }
  const successToast = vi.spyOn(toast, 'success')
  const { router } = await mountWallet()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Transfer to Balance' })
  )
  await userEvent.click(screen.getByRole('button', { name: 'Transfer' }))
  await waitFor(() =>
    expect(operation).toEqual({ request_id: expect.any(String), quota: 500000 })
  )
  const key = `new-api:affiliate-transfer:1:${operation.request_id}`
  expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual(operation)
  await signOutFromAnotherTab()
  const transferRequest = requests.find(
    (request) => request.url === '/api/user/aff_transfer'
  )
  expect(transferRequest?.signal?.aborted).toBe(true)
  expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual(operation)

  act(() => applyAuthBundle(session(2, 'account-b'), false))
  await act(() => router.navigate({ to: '/wallet' }))
  await screen.findByRole('button', { name: 'Transfer to Balance' })
  expect(
    screen.queryByRole('button', { name: 'Check transfer result' })
  ).not.toBeInTheDocument()
  await act(async () => {
    release()
  })
  expect(successToast).not.toHaveBeenCalledWith('Transfer succeeded')
  expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual(operation)

  // Use the same-tab production dialog for B's logout before A reauthenticates.
  await userEvent.click(screen.getByRole('button', { name: 'Open sign out' }))
  await userEvent.click(
    within(
      await screen.findByRole('alertdialog', { name: 'Sign out' })
    ).getByRole('button', { name: 'Sign out' })
  )
  await screen.findByText('Signed out route')
  lookup = { found: true, transfer: { id: 1, ...operation, created_at: 1 } }
  balance = 1500000
  reward = 500000
  act(() => applyAuthBundle(session(1, 'new-a'), false))
  await act(() => router.navigate({ to: '/wallet' }))
  await userEvent.click(
    await screen.findByRole('button', { name: 'Check transfer result' })
  )
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Transfer Rewards' })).getByRole(
      'button',
      { name: 'Check transfer result' }
    )
  )
  await waitFor(() => expect(localStorage.getItem(key)).toBeNull())
  expect(
    requests.filter((request) => request.url === '/api/user/aff_transfer')
  ).toHaveLength(1)
  const resultRequest = requests.find(
    (request) =>
      request.url === `/api/user/aff_transfer/${operation.request_id}`
  )
  expect(resultRequest?.headers.get('Authorization')).toBe(
    'Bearer access-new-a'
  )
  expect(
    requests
      .filter((request) => request.url === '/api/user/auth/logout')
      .map((request) => request.headers.get('X-Auth-Session'))
  ).toEqual(['original-a', 'account-b'])
})

test('logout during checkout removes the original confirmation and a late checkout cannot open for another account', async () => {
  let release!: () => void
  api.defaults.adapter = async (config) => {
    requests.push(config)
    if (config.url !== '/api/user/pay') return readResponse(config)
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      ...response(config, { merchant: 'original-order' }),
      data: {
        message: 'success',
        url: 'https://payment.example/original-order',
        data: { trade_no: 'original-order' },
      },
    }
  }
  const submit = vi
    .spyOn(HTMLFormElement.prototype, 'submit')
    .mockImplementation(() => undefined)
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const { router } = await mountWallet()
  await userEvent.click(await screen.findByRole('button', { name: 'Alipay' }))
  const confirm = await screen.findByRole('alertdialog', {
    name: 'Confirm Payment',
  })
  await userEvent.click(
    within(confirm).getByRole('button', { name: 'Confirm Payment' })
  )
  await waitFor(() =>
    expect(
      requests.filter((request) => request.url === '/api/user/pay')
    ).toHaveLength(1)
  )
  await signOutFromAnotherTab()
  const payment = requests.find((request) => request.url === '/api/user/pay')
  expect(payment?.signal?.aborted).toBe(true)
  expect(payment?.skipAuthRefresh).toBe(true)
  act(() => applyAuthBundle(session(2, 'next-payer'), false))
  await act(() => router.navigate({ to: '/wallet' }))
  await screen.findByRole('button', { name: 'Alipay' })
  await act(async () => {
    release()
  })
  expect(
    screen.queryByRole('alertdialog', { name: 'Confirm Payment' })
  ).not.toBeInTheDocument()
  expect(
    requests.filter((request) => request.url === '/api/user/pay')
  ).toHaveLength(1)
  expect(submit).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  await signOutFromAnotherTab()
  act(() => applyAuthBundle(session(1, 'reauthenticated-payer'), false))
  await act(() => router.navigate({ to: '/wallet' }))
  await screen.findByRole('button', { name: 'Alipay' })
  expect(
    screen.queryByRole('alertdialog', { name: 'Confirm Payment' })
  ).not.toBeInTheDocument()
  expect(
    requests.filter((request) => request.url === '/api/user/pay')
  ).toHaveLength(1)
})

test('logout during manual completion removes the original order confirmation and suppresses its late success after another login', async () => {
  applyAuthBundle(session(1, 'original-admin', 100), false)
  let release!: () => void
  api.defaults.adapter = async (config) => {
    requests.push(config)
    if (config.url !== '/api/user/topup/complete') return readResponse(config)
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return response(config, null)
  }
  const successToast = vi.spyOn(toast, 'success')
  const { router } = await mountWallet('/wallet?show_history=true')
  await userEvent.click(
    await screen.findByRole('button', { name: 'Complete Order' })
  )
  await userEvent.click(
    within(
      screen.getByRole('alertdialog', { name: 'Complete Order' })
    ).getByRole('button', { name: 'Confirm' })
  )
  await waitFor(() =>
    expect(
      requests.filter((request) => request.url === '/api/user/topup/complete')
    ).toHaveLength(1)
  )
  const completion = requests.find(
    (request) => request.url === '/api/user/topup/complete'
  )
  expect(JSON.parse(completion?.data as string)).toEqual({
    trade_no: 'original-pending-order',
  })
  expect(completion?.skipAuthRefresh).toBe(true)
  await signOutFromAnotherTab()
  expect(completion?.signal?.aborted).toBe(true)
  act(() => applyAuthBundle(session(2, 'other-admin', 100), false))
  await act(() => router.navigate({ to: '/wallet' }))
  await screen.findByRole('button', { name: 'Alipay' })
  successToast.mockClear()
  await act(async () => {
    release()
  })
  expect(successToast).not.toHaveBeenCalled()
  expect(
    screen.queryByRole('dialog', { name: 'Billing History' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('alertdialog', { name: 'Complete Order' })
  ).not.toBeInTheDocument()
  expect(
    requests.filter((request) => request.url === '/api/user/topup/complete')
  ).toHaveLength(1)
})

test.each(['another tab', 'same tab'])(
  'logout from $0 during rule save unmounts the dirty form and preserves the next session draft',
  async (source) => {
    applyAuthBundle(session(1, 'original-root', 100), false)
    let release!: () => void
    api.defaults.adapter = async (config) => {
      requests.push(config)
      if (
        config.url !== '/api/option/referral_rebate' ||
        config.method !== 'put'
      ) {
        return readResponse(config)
      }
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return response(config, { enabled: false, rate_bps: 900, valid_days: 7 })
    }
    const successToast = vi.spyOn(toast, 'success')
    const { router, client } = await mountWallet('/referral-settings')
    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Rebate percentage (%)' }),
      { target: { value: '9' } }
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() =>
      expect(
        requests.filter((request) => request.method === 'put')
      ).toHaveLength(1)
    )
    const save = requests.find((request) => request.method === 'put')
    expect(JSON.parse(save?.data as string)).toEqual({
      enabled: false,
      percentage: '9',
      valid_days: '7',
    })
    if (source === 'another tab') {
      await signOutFromAnotherTab()
    } else {
      await userEvent.click(
        screen.getByRole('button', { name: 'Open sign out' })
      )
      await userEvent.click(
        within(
          await screen.findByRole('alertdialog', { name: 'Sign out' })
        ).getByRole('button', { name: 'Sign out' })
      )
      await screen.findByText('Signed out route')
    }
    expect(save?.signal?.aborted).toBe(true)
    rule = { enabled: true, rate_bps: 1200, valid_days: 14 }
    act(() => applyAuthBundle(session(2, 'other-root', 100), false))
    act(() => router.history.push('/referral-settings'))
    const percentage = await screen.findByRole('textbox', {
      name: 'Rebate percentage (%)',
    })
    expect(percentage).toHaveValue('12')
    fireEvent.change(percentage, { target: { value: '13' } })
    successToast.mockClear()
    await act(async () => {
      release()
    })
    expect(percentage).toHaveValue('13')
    expect(successToast).not.toHaveBeenCalled()
    expect(client.getQueryData(['referral-rule', '2:other-root'])).toEqual(rule)
    expect(requests.filter((request) => request.method === 'put')).toHaveLength(
      1
    )
  }
)

test.each(['logout', 'replace account', 'replace same-user session'])(
  '$0 while loading payment methods ignores the prior wallet error',
  async (transition) => {
    let release!: () => void
    let first = true
    api.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url !== '/api/user/topup/info' || !first) {
        return readResponse(config)
      }
      first = false
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {
        ...response(config, null),
        data: {
          success: false,
          message: 'Previous wallet payment methods failed',
        },
      }
    }
    const errorToast = vi.spyOn(toast, 'error')
    const { router } = await mountWallet()
    await waitFor(() => expect(release).toBeTypeOf('function'))
    if (transition === 'logout') await signOutFromAnotherTab()
    act(() =>
      applyAuthBundle(
        session(
          transition === 'replace same-user session' ? 1 : 2,
          'new-wallet'
        ),
        false
      )
    )
    if (transition === 'logout') {
      await act(() => router.navigate({ to: '/wallet' }))
    }
    await screen.findByRole('button', { name: 'Alipay' })
    errorToast.mockClear()
    await act(async () => {
      release()
    })
    expect(errorToast).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Alipay' })).toBeEnabled()
  }
)

test('a normal navigation from a dirty rule still requires the existing leave confirmation', async () => {
  applyAuthBundle(session(1, 'editing-root', 100), false)
  const { router } = await mountWallet('/referral-settings')
  fireEvent.change(
    await screen.findByRole('textbox', { name: 'Rebate percentage (%)' }),
    { target: { value: '9' } }
  )
  act(() => {
    void router.navigate({ to: '/wallet' })
  })
  const confirmation = await screen.findByRole('alertdialog', {
    name: 'Unsaved changes',
  })
  await userEvent.click(
    within(confirmation).getByRole('button', { name: 'Stay' })
  )
  expect(
    screen.getByRole('textbox', { name: 'Rebate percentage (%)' })
  ).toHaveValue('9')
  act(() => {
    void router.navigate({ to: '/wallet' })
  })
  await userEvent.click(
    within(
      await screen.findByRole('alertdialog', { name: 'Unsaved changes' })
    ).getByRole('button', { name: 'Leave' })
  )
  await screen.findByRole('button', { name: 'Alipay' })
})

test.each(['success', 'failure'])(
  'a new payment-method refetch owns loading and data when the prior read later returns $0',
  async (outcome) => {
    let release!: () => void
    let first = true
    api.defaults.adapter = async (config) => {
      requests.push(config)
      if (!first) return readResponse(config)
      first = false
      await new Promise<void>((resolve) => {
        release = resolve
      })
      if (outcome === 'failure') {
        return {
          ...response(config, null),
          data: { success: false, message: 'Obsolete topup read failed' },
        }
      }
      return response(config, {
        ...topupInfo,
        pay_methods: [{ name: 'Obsolete payment', type: 'obsolete' }],
      })
    }
    const errorToast = vi.spyOn(toast, 'error')
    const { result } = renderHook(useTopupInfo)
    await waitFor(() => expect(release).toBeTypeOf('function'))
    await act(() => result.current.refetch())
    expect(result.current.loading).toBe(false)
    expect(result.current.topupInfo?.pay_methods).toEqual([
      {
        name: 'Alipay',
        type: 'alipay',
        color: undefined,
        icon: undefined,
        min_topup: 0,
      },
    ])
    expect(requests[0].signal?.aborted).toBe(true)
    await act(async () => {
      release()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.topupInfo?.pay_methods[0].name).toBe('Alipay')
    expect(errorToast).not.toHaveBeenCalled()
  }
)

test('a new account payment-method read failure cannot expose the previous account methods again', async () => {
  let first = true
  api.defaults.adapter = async (config) => {
    requests.push(config)
    if (config.url !== '/api/user/topup/info') return readResponse(config)
    if (first) {
      first = false
      return readResponse(config)
    }
    return {
      ...response(config, null),
      data: {
        success: false,
        message: 'New account payment methods unavailable',
      },
    }
  }
  const errorToast = vi.spyOn(toast, 'error')
  await mountWallet()
  await screen.findByRole('button', { name: 'Alipay' })
  act(() => applyAuthBundle(session(2, 'failed-wallet-read'), false))
  await waitFor(() =>
    expect(errorToast).toHaveBeenCalledWith(
      'New account payment methods unavailable'
    )
  )
  expect(
    screen.queryByRole('button', { name: 'Alipay' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('alertdialog', { name: 'Confirm Payment' })
  ).not.toBeInTheDocument()
})
