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
import {
  AxiosError,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios'
import { toast } from 'sonner'
import { beforeEach, expect, test, vi } from 'vitest'

import * as systemConfigHooks from '@/hooks/use-system-config'
import { api, applyAuthBundle } from '@/lib/api'
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import * as paymentApi from '../api'
import * as affiliateRewards from '../components/affiliate-rewards-card'
import { PaymentConfirmDialog } from '../components/dialogs/payment-confirm-dialog'
import { RechargeFormCard } from '../components/recharge-form-card'
import * as walletStats from '../components/wallet-stats-card'
import { useCreemPayment } from '../hooks/use-creem-payment'
import { requestPaymentAmount, usePayment } from '../hooks/use-payment'
import * as topupInfoHooks from '../hooks/use-topup-info'
import { useWaffoPancakePayment } from '../hooks/use-waffo-pancake-payment'
import { useWaffoPayment } from '../hooks/use-waffo-payment'
import { Wallet } from '../index'
import { isSafePaymentUrl } from '../lib/payment'
import type { StripePaymentResponse, TopupInfo } from '../types'

vi.mock('@/hooks/use-status', () => ({
  useStatus: () => ({ status: { price: 1 } }),
}))
vi.mock('@/hooks/use-system-config', () => ({
  useSystemConfig: () => ({ currency: { quotaDisplayType: 'USD' } }),
}))
vi.mock('../components/affiliate-rewards-card', () => ({
  AffiliateRewardsCard: () => null,
}))
vi.mock('../components/wallet-stats-card', () => ({
  WalletStatsCard: () => null,
}))
vi.mock('../components/subscription-plans-card', () => ({
  SubscriptionPlansCard: () => null,
}))
vi.mock('../components/dialogs/billing-history-dialog', () => ({
  BillingHistoryDialog: () => null,
}))

beforeEach(() => {
  useAuthStore.getState().auth.reset()
  useAuthStore.getState().auth.setUser({ id: 1, username: 'payer', role: 1 })
  useSystemConfigStore.getState().setConfig({
    currency: { ...DEFAULT_CURRENCY_CONFIG },
  })
})

const topupInfo: TopupInfo = {
  enable_online_topup: true,
  enable_stripe_topup: false,
  pay_methods: [{ name: 'Card', type: 'alipay' }],
  min_topup: 1,
  stripe_min_topup: 1,
  amount_options: [],
  discount: {},
}

test.each([
  { mode: 'USD', quantity: 10, preset: '10', confirmed: '$10', updated: '$10' },
  {
    mode: 'CNY',
    quantity: 10,
    preset: '70',
    confirmed: '¥70',
    updated: '¥140',
  },
  {
    mode: 'CUSTOM',
    quantity: 10,
    preset: '9',
    confirmed: '€ 9',
    updated: '€ 18',
  },
  {
    mode: 'TOKENS',
    quantity: 1000000,
    preset: '1,000,000',
    confirmed: '1,000,000',
    updated: '1,000,000',
  },
] as const)(
  '$mode topup display uses its own unit without changing the payment quantity',
  async ({ mode, quantity, preset, confirmed, updated }) => {
    const currency = {
      ...DEFAULT_CURRENCY_CONFIG,
      quotaDisplayType: mode,
      usdExchangeRate: 7,
      customCurrencySymbol: '€',
      customCurrencyExchangeRate: 0.9,
    }
    useSystemConfigStore.getState().setConfig({ currency })
    const { useSystemConfig } = await vi.importActual<
      typeof import('@/hooks/use-system-config')
    >('@/hooks/use-system-config')
    vi.spyOn(systemConfigHooks, 'useSystemConfig').mockImplementation(
      useSystemConfig
    )
    vi.spyOn(topupInfoHooks, 'useTopupInfo').mockReturnValue({
      topupInfo,
      presetAmounts: [{ value: quantity }],
      loading: false,
      refetch: vi.fn(),
    })
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: {} },
    })
    const post = vi.spyOn(api, 'post').mockImplementation(async (path) => ({
      data:
        path === '/api/user/pay'
          ? {
              success: true,
              url: 'https://payments.example.test/checkout',
              data: { out_trade_no: 'test-display-order' },
            }
          : { success: true, data: '10' },
    }))
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Wallet />
      </QueryClientProvider>
    )
    const amountButton = screen.getByRole('button', {
      name: new RegExp(`^${preset} Pay `),
    })
    await userEvent.click(amountButton)
    await userEvent.click(screen.getByRole('button', { name: 'Card' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Confirm Payment',
    })
    expect(within(dialog).getByText(confirmed)).toBeVisible()
    act(() => {
      useSystemConfigStore.getState().setConfig({
        currency: {
          ...currency,
          usdExchangeRate: 14,
          customCurrencyExchangeRate: 1.8,
        },
      })
    })
    expect(within(dialog).getByText(updated)).toBeVisible()
    expect(post).toHaveBeenLastCalledWith(
      '/api/user/amount',
      { amount: quantity },
      expect.anything()
    )
    expect(
      post.mock.calls.some(([path]) => String(path).endsWith('/pay'))
    ).toBe(false)
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Confirm Payment' })
    )
    expect(post).toHaveBeenLastCalledWith(
      '/api/user/pay',
      { amount: quantity, payment_method: 'alipay' },
      expect.objectContaining({ skipAuthRefresh: true })
    )
  }
)

test('a negative custom amount clears the previously valid purchase amount', () => {
  const onAmount = vi.fn()
  render(
    <RechargeFormCard
      topupInfo={topupInfo}
      presetAmounts={[]}
      selectedPreset={null}
      onSelectPreset={vi.fn()}
      topupAmount={10}
      onTopupAmountChange={onAmount}
      paymentAmount={10}
      calculating={false}
      onPaymentMethodSelect={vi.fn()}
      paymentLoading={null}
      redemptionCode=''
      onRedemptionCodeChange={vi.fn()}
      onRedeem={vi.fn()}
      redeeming={false}
    />
  )
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Custom Amount' }), {
    target: { value: '-5' },
  })
  expect(onAmount).toHaveBeenLastCalledWith(0)
  expect(screen.getByRole('button', { name: 'Card' })).toBeDisabled()
})

test.each([
  ['stripe', 'Stripe', '/api/user/stripe/amount'],
  ['waffo_pancake', 'Waffo Pancake', '/api/user/waffo-pancake/amount'],
])(
  'a legal %s amount below the Epay minimum reaches its own confirmation',
  async (type, name, quotePath) => {
    vi.spyOn(topupInfoHooks, 'useTopupInfo').mockReturnValue({
      topupInfo: {
        ...topupInfo,
        enable_stripe_topup: type === 'stripe',
        enable_waffo_pancake_topup: type === 'waffo_pancake',
        min_topup: 100,
        stripe_min_topup: 1,
        waffo_pancake_min_topup: 1,
        pay_methods: [
          { name: 'Alipay', type: 'alipay' },
          { name, type, min_topup: 1 },
        ],
      },
      presetAmounts: [],
      loading: false,
      refetch: vi.fn(),
    })
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: {} },
    })
    const post = vi
      .spyOn(api, 'post')
      .mockImplementation(async (_url, request) => ({
        data: {
          success: true,
          data: String((request as { amount: number }).amount),
        },
      }))
    render(<Wallet />)
    await act(async () => {})
    const amount = screen.getByRole('spinbutton', { name: 'Custom Amount' })
    expect(amount).toHaveValue(100)
    expect(amount).toHaveAttribute('min', '1')
    expect(amount).toHaveAttribute('placeholder', 'Minimum 1')
    await act(async () => {
      fireEvent.change(amount, { target: { value: '50' } })
    })
    expect(screen.getByRole('button', { name: /Alipay/ })).toBeDisabled()
    const method = screen.getByRole('button', { name })
    expect(method).toBeEnabled()
    await userEvent.click(method)
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Confirm Payment',
    })
    expect(
      within(dialog).getByText(type === 'stripe' ? 'Quantity' : '$50')
    ).toBeVisible()
    expect(post).toHaveBeenCalledWith(
      quotePath,
      { amount: 50 },
      expect.anything()
    )
    expect(
      post.mock.calls.some(([path]) => String(path).endsWith('/pay'))
    ).toBe(false)
  }
)

test.each([
  { type: 'alipay', name: 'Alipay', providerMinimum: 60, methodMinimum: 1 },
  { type: 'stripe', name: 'Stripe', providerMinimum: 60, methodMinimum: 1 },
  {
    type: 'waffo_pancake',
    name: 'Waffo Pancake',
    providerMinimum: 60,
    methodMinimum: 1,
  },
  { type: 'stripe', name: 'Stripe', providerMinimum: 1, methodMinimum: 60 },
])(
  '$name keeps its own minimum and any stricter configured method minimum',
  ({ type, name, providerMinimum, methodMinimum }) => {
    render(
      <RechargeFormCard
        topupInfo={{
          ...topupInfo,
          min_topup: type === 'alipay' ? providerMinimum : 100,
          stripe_min_topup: providerMinimum,
          waffo_pancake_min_topup: providerMinimum,
          pay_methods: [{ name, type, min_topup: methodMinimum }],
        }}
        presetAmounts={[]}
        selectedPreset={null}
        onSelectPreset={vi.fn()}
        topupAmount={50}
        onTopupAmountChange={vi.fn()}
        paymentAmount={50}
        calculating={false}
        onPaymentMethodSelect={vi.fn()}
        paymentLoading={null}
        redemptionCode=''
        onRedemptionCodeChange={vi.fn()}
        onRedeem={vi.fn()}
        redeeming={false}
      />
    )
    expect(
      screen.getByRole('button', { name: `${name}. Minimum topup amount: 60` })
    ).toBeDisabled()
    expect(
      screen.getByRole('spinbutton', {
        name: type === 'stripe' ? 'Quantity' : 'Custom Amount',
      })
    ).toHaveAttribute('min', '60')
  }
)

test('the shared minimum includes Waffo only when its payment method is available', () => {
  const props = {
    topupInfo: { ...topupInfo, min_topup: 100 },
    presetAmounts: [],
    selectedPreset: null,
    onSelectPreset: vi.fn(),
    topupAmount: 50,
    onTopupAmountChange: vi.fn(),
    paymentAmount: 50,
    calculating: false,
    onPaymentMethodSelect: vi.fn(),
    paymentLoading: null,
    redemptionCode: '',
    onRedemptionCodeChange: vi.fn(),
    onRedeem: vi.fn(),
    redeeming: false,
    enableWaffoTopup: true,
    waffoMinTopup: 5,
    onWaffoMethodSelect: vi.fn(),
  }
  const view = render(<RechargeFormCard {...props} waffoPayMethods={[]} />)
  expect(
    screen.getByRole('spinbutton', { name: 'Custom Amount' })
  ).toHaveAttribute('min', '100')
  view.rerender(
    <RechargeFormCard {...props} waffoPayMethods={[{ name: 'Waffo card' }]} />
  )
  expect(
    screen.getByRole('spinbutton', { name: 'Custom Amount' })
  ).toHaveAttribute('min', '5')
  expect(screen.getByRole('button', { name: 'Waffo card' })).toBeEnabled()
  expect(screen.getByRole('button', { name: /Card. Minimum/ })).toBeDisabled()
})

test.each(['', 'Card'])(
  'Waffo keeps the server method index when the preceding display name is %j',
  async (firstName) => {
    const methods = [
      { name: firstName, payMethodType: 'CARD', payMethodName: 'CARD' },
      {
        name: 'Bank transfer',
        payMethodType: 'BANK_TRANSFER',
        payMethodName: 'TEST_BANK',
      },
    ]
    vi.spyOn(api, 'get').mockImplementation(async (url) => ({
      data: {
        success: true,
        data:
          url === '/api/user/topup/info'
            ? {
                ...topupInfo,
                enable_online_topup: false,
                enable_waffo_topup: true,
                pay_methods: [],
                waffo_min_topup: 1,
                waffo_pay_methods: methods,
              }
            : {},
      },
    }))
    const post = vi.spyOn(api, 'post').mockImplementation(async (url) => ({
      data: {
        success: true,
        data:
          url === '/api/user/waffo/pay'
            ? { payment_url: 'https://checkout.example.invalid' }
            : '1.00',
      },
    }))
    vi.spyOn(window, 'open').mockReturnValue(null)
    const view = render(<Wallet />)
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Bank transfer' })
    )
    await user.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Confirm Payment' })
      ).getByRole('button', { name: 'Confirm Payment' })
    )
    expect(post).toHaveBeenCalledWith(
      '/api/user/waffo/pay',
      {
        amount: 1,
        pay_method_index: 1,
        pay_method_type: 'BANK_TRANSFER',
        pay_method_name: 'TEST_BANK',
      },
      expect.anything()
    )

    // A fresh configuration read must derive indexes from the new order.
    view.unmount()
    methods.reverse()
    render(<Wallet />)
    await user.click(
      await screen.findByRole('button', { name: 'Bank transfer' })
    )
    await user.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Confirm Payment' })
      ).getByRole('button', { name: 'Confirm Payment' })
    )
    const payments = post.mock.calls
      .filter(([url]) => url === '/api/user/waffo/pay')
      .map(([, request]) => request)
    expect(payments).toEqual([
      {
        amount: 1,
        pay_method_index: 1,
        pay_method_type: 'BANK_TRANSFER',
        pay_method_name: 'TEST_BANK',
      },
      {
        amount: 1,
        pay_method_index: 0,
        pay_method_type: 'BANK_TRANSFER',
        pay_method_name: 'TEST_BANK',
      },
    ])
  }
)

test.each([
  {
    type: 'BANK_TRANSFER',
    name: 'BANK',
    replacementType: 'CARD',
    replacementName: 'VISA',
  },
  {
    type: 'CARD',
    name: 'VISA',
    replacementType: 'CARD',
    replacementName: 'MASTERCARD',
  },
  { type: '', name: '', replacementType: 'CARD', replacementName: 'CARD' },
])(
  'Waffo confirmation keeps the chosen $type/$name identity after server configuration reorders',
  async (selected) => {
    let serverMethods = [
      {
        name: '',
        payMethodType: selected.replacementType,
        payMethodName: selected.replacementName,
      },
      {
        name: 'Selected method',
        payMethodType: selected.type,
        payMethodName: selected.name,
      },
    ]
    vi.spyOn(api, 'get').mockImplementation(async (url) => ({
      data: {
        success: true,
        data:
          url === '/api/user/topup/info'
            ? {
                ...topupInfo,
                enable_online_topup: false,
                enable_waffo_topup: true,
                pay_methods: [],
                waffo_min_topup: 1,
                waffo_pay_methods: serverMethods,
              }
            : {},
      },
    }))
    const post = vi.spyOn(api, 'post').mockImplementation(async (url) => ({
      data:
        url === '/api/user/waffo/pay'
          ? { message: 'error', data: 'Unsupported payment method' }
          : { message: 'success', data: '1.00' },
    }))
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<Wallet />)
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Selected method' })
    )
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Confirm Payment',
    })
    // Only the server changed: the existing confirmation still represents
    // the exact method the user saw, even if its old index now means another.
    serverMethods = [...serverMethods].reverse()
    await user.click(
      within(dialog).getByRole('button', { name: 'Confirm Payment' })
    )
    expect(post).toHaveBeenCalledWith(
      '/api/user/waffo/pay',
      {
        amount: 1,
        pay_method_index: 1,
        pay_method_type: selected.type,
        pay_method_name: selected.name,
      },
      expect.anything()
    )
    expect(open).not.toHaveBeenCalled()
    expect(dialog).toBeVisible()
    expect(
      post.mock.calls.filter(([url]) => url === '/api/user/waffo/pay')
    ).toHaveLength(1)
  }
)

test.each(['stripe', 'alipay'])(
  '%s confirmation keeps its own quantity and discount display contract',
  (paymentType) => {
    render(
      <PaymentConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        topupAmount={5}
        paymentAmount={10}
        paymentMethod={{ name: paymentType, type: paymentType }}
        calculating={false}
        processing={false}
        discountRate={0.8}
        usdExchangeRate={7}
      />
    )
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm Payment' })
    if (paymentType === 'stripe') {
      expect(within(dialog).getByText('Quantity')).toBeVisible()
      expect(within(dialog).getByText('5')).toBeVisible()
      expect(within(dialog).queryByText('$35')).not.toBeInTheDocument()
      expect(within(dialog).queryByText('You save')).not.toBeInTheDocument()
      expect(
        within(dialog).getByText('Estimated payment before discounts')
      ).toBeVisible()
      expect(
        within(dialog).getByText(
          'The final amount and any discounts are confirmed in Stripe Checkout.'
        )
      ).toBeVisible()
    } else {
      expect(within(dialog).getByText('Topup Amount')).toBeVisible()
      expect(within(dialog).getByText('$35')).toBeVisible()
      expect(within(dialog).getByText('You save')).toBeVisible()
      expect(within(dialog).getByText('You Pay')).toBeVisible()
      expect(within(dialog).queryByText('Quantity')).not.toBeInTheDocument()
    }
  }
)

test('Stripe quantity selection omits local discounts and sends the unchanged quantity after confirmation', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data:
        url === '/api/user/topup/info'
          ? {
              ...topupInfo,
              enable_online_topup: false,
              enable_stripe_topup: true,
              pay_methods: [{ name: 'Stripe', type: 'stripe' }],
              stripe_min_topup: 5,
              amount_options: [5],
              discount: { 5: 0.8 },
            }
          : {},
    },
  }))
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => ({
    data: {
      success: true,
      data:
        url === '/api/user/stripe/pay'
          ? { pay_link: 'https://checkout.example.invalid' }
          : '10.00',
    },
  }))
  vi.spyOn(window, 'open').mockReturnValue(null)
  render(<Wallet />)
  const user = userEvent.setup()
  const quantity = await screen.findByRole('spinbutton', { name: 'Quantity' })
  await waitFor(() => expect(quantity).toHaveValue(5))
  expect(screen.queryByText('20% OFF')).not.toBeInTheDocument()
  expect(screen.queryByText('Pay 4')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Stripe' }))
  await user.click(
    within(
      await screen.findByRole('alertdialog', { name: 'Confirm Payment' })
    ).getByRole('button', { name: 'Confirm Payment' })
  )
  expect(post).toHaveBeenCalledWith(
    '/api/user/stripe/amount',
    { amount: 5 },
    expect.anything()
  )
  expect(post).toHaveBeenCalledWith(
    '/api/user/stripe/pay',
    { amount: 5, payment_method: 'stripe' },
    expect.anything()
  )
})

test('a late earlier quote cannot replace the latest amount displayed for payment', async () => {
  let first!: (value: { data: { success: boolean; data: string } }) => void
  const firstQuote = new Promise<{ data: { success: boolean; data: string } }>(
    (resolve) => {
      first = resolve
    }
  )
  vi.spyOn(api, 'post').mockImplementation(async (_url, data) =>
    (data as { amount: number }).amount === 10
      ? firstQuote
      : { data: { success: true, data: '20.00' } }
  )
  const { result } = renderHook(() => usePayment())
  let older!: Promise<number>
  await act(async () => {
    older = result.current.calculatePaymentAmount(10, 'alipay')
    await result.current.calculatePaymentAmount(20, 'alipay')
  })
  expect(result.current.amount).toBe(20)
  await act(async () => {
    first({ data: { success: true, data: '10.00' } })
    await older
  })
  expect(result.current.amount).toBe(20)
})

const paymentCases = [
  {
    name: 'Epay',
    path: '/api/user/pay',
    hook: usePayment,
    run: (hook: ReturnType<typeof usePayment>) =>
      hook.processPayment(10, 'alipay'),
    body: {
      message: 'success',
      url: 'https://pay.example.test/pay',
      data: { trade_no: 'test' },
    },
  },
  {
    name: 'Stripe',
    path: '/api/user/stripe/pay',
    hook: usePayment,
    run: (hook: ReturnType<typeof usePayment>) =>
      hook.processPayment(10, 'stripe'),
    body: {
      message: 'success',
      data: { pay_link: 'https://pay.example.test/pay' },
    },
  },
]

test.each(paymentCases)(
  '$name creates one order for concurrent confirmation and disables authentication replay',
  async ({ path, hook, run, body }) => {
    let resolve!: (value: { data: typeof body }) => void
    const pending = new Promise<{ data: typeof body }>((done) => {
      resolve = done
    })
    const post = vi.spyOn(api, 'post').mockReturnValue(pending)
    vi.spyOn(window, 'open').mockReturnValue({} as Window)
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    const { result } = renderHook(hook)
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    await act(async () => {
      first = run(result.current)
      second = run(result.current)
    })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      path,
      expect.anything(),
      expect.objectContaining({ skipAuthRefresh: true })
    )
    await act(async () => {
      resolve({ data: body })
      await Promise.all([first, second])
    })
  }
)

test.each(['stripe', 'creem', 'waffo', 'waffo_pancake'])(
  '%s ignores a checkout response after the payer changes',
  async (provider) => {
    let resolve!: (value: { data: unknown }) => void
    const pending = new Promise<{ data: unknown }>((done) => {
      resolve = done
    })
    vi.spyOn(api, 'post').mockReturnValue(pending)
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    const { result } = renderHook(() => ({
      regular: usePayment(),
      creem: useCreemPayment(),
      waffo: useWaffoPayment(),
      pancake: useWaffoPancakePayment(),
    }))
    let operation!: Promise<boolean>
    await act(async () => {
      if (provider === 'creem') {
        operation = result.current.creem.processCreemPayment('product-test')
      } else if (provider === 'waffo') {
        operation = result.current.waffo.processWaffoPayment(10, 0)
      } else if (provider === 'waffo_pancake') {
        operation = result.current.pancake.processWaffoPancakePayment(10)
      } else operation = result.current.regular.processPayment(10, 'stripe')
    })
    act(() =>
      useAuthStore
        .getState()
        .auth.setUser({ id: 2, username: 'other', role: 1 })
    )
    await act(async () => {
      resolve({
        data: {
          message: 'success',
          data: {
            pay_link: 'https://pay.example.test/pay',
            checkout_url: 'https://pay.example.test/pay',
            payment_url: 'https://pay.example.test/pay',
          },
        },
      })
      expect(await operation).toBe(false)
    })
    expect(open).not.toHaveBeenCalled()
  }
)

test('checkout delivery never runs under a payer changed at the response microtask boundary', async () => {
  let resolve!: (value: StripePaymentResponse) => void
  const pending = new Promise<StripePaymentResponse>((done) => {
    resolve = done
  })
  vi.spyOn(paymentApi, 'requestStripePayment').mockReturnValue(pending)
  const payerAtRedirect: Array<number | undefined> = []
  vi.spyOn(window, 'open').mockImplementation(() => {
    payerAtRedirect.push(useAuthStore.getState().auth.user?.id)
    return {} as Window
  })
  const { result } = renderHook(() => usePayment())
  let operation!: Promise<boolean>
  await act(async () => {
    operation = result.current.processPayment(10, 'stripe')
  })
  await act(async () => {
    resolve({
      message: 'success',
      data: { pay_link: 'https://pay.example.test/pay' },
    })
    queueMicrotask(() =>
      useAuthStore
        .getState()
        .auth.setUser({ id: 2, username: 'other', role: 1 })
    )
    await operation
  })
  expect(payerAtRedirect).not.toContain(2)
})

test('switching away and back before checkout responds still invalidates that operation', async () => {
  let resolve!: (value: StripePaymentResponse) => void
  vi.spyOn(paymentApi, 'requestStripePayment').mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
  const { result } = renderHook(() => usePayment())
  let operation!: Promise<boolean>
  await act(async () => {
    operation = result.current.processPayment(10, 'stripe')
  })
  await act(async () => {
    useAuthStore.getState().auth.setUser({ id: 2, username: 'other', role: 1 })
    useAuthStore.getState().auth.setUser({ id: 1, username: 'payer', role: 1 })
    resolve({
      message: 'success',
      data: { pay_link: 'https://pay.example.test/pay' },
    })
    expect(await operation).toBe(false)
  })
  expect(open).not.toHaveBeenCalled()
})

test('an already displayed confirmation cannot submit for a different payer before React renders', async () => {
  vi.spyOn(topupInfoHooks, 'useTopupInfo').mockReturnValue({
    topupInfo,
    presetAmounts: [],
    loading: false,
    refetch: vi.fn(),
  })
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: {} } })
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: '1.00' } })
  render(<Wallet />)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Card' }))
  })
  const dialog = await screen.findByRole('alertdialog', {
    name: 'Confirm Payment',
  })
  const confirm = within(dialog).getByRole('button', {
    name: 'Confirm Payment',
  })
  post.mockClear()
  await act(async () => {
    useAuthStore.getState().auth.setUser({ id: 2, username: 'other', role: 1 })
    fireEvent.click(confirm)
  })
  expect(post).not.toHaveBeenCalled()
})

test.each([
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
])('invalid amount %s never creates a numeric top-up order', async (amount) => {
  const post = vi.spyOn(api, 'post')
  const { result } = renderHook(() => ({
    regular: usePayment(),
    waffo: useWaffoPayment(),
    pancake: useWaffoPancakePayment(),
  }))
  await act(async () => {
    expect(await result.current.regular.processPayment(amount, 'alipay')).toBe(
      false
    )
    expect(await result.current.regular.processPayment(amount, 'stripe')).toBe(
      false
    )
    expect(await result.current.waffo.processWaffoPayment(amount, 0)).toBe(
      false
    )
    expect(
      await result.current.pancake.processWaffoPancakePayment(amount)
    ).toBe(false)
  })
  expect(post).not.toHaveBeenCalled()
})

test.each(['NaN', 'Infinity', '10invalid', '0', '-1'])(
  'invalid quote %s cannot become a payable amount',
  async (quoted) => {
    vi.spyOn(api, 'post').mockResolvedValue({
      data: { success: true, data: quoted },
    })
    expect(await requestPaymentAmount(10, 'alipay')).toBe(0)
  }
)

test.each([
  { calculating: true, amount: 10 },
  { calculating: false, amount: 0 },
  { calculating: false, amount: Number.NaN },
])(
  'confirmation stays disabled for an unfinished or invalid quote %#',
  ({ calculating, amount }) => {
    const confirm = vi.fn()
    render(
      <PaymentConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={confirm}
        topupAmount={10}
        paymentAmount={amount}
        paymentMethod={{ name: 'Card', type: 'alipay' }}
        calculating={calculating}
        processing={false}
      />
    )
    const button = screen.getByRole('button', { name: 'Confirm Payment' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(confirm).not.toHaveBeenCalled()
  }
)

test.each(['creem', 'waffo', 'waffo_pancake'])(
  '%s creates only one order on same-tick confirmation and ignores delivery after unmount',
  async (provider) => {
    let resolve!: (value: { data: unknown }) => void
    const pending = new Promise<{ data: unknown }>((done) => {
      resolve = done
    })
    const post = vi.spyOn(api, 'post').mockReturnValue(pending)
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    const { result, unmount } = renderHook(() => ({
      creem: useCreemPayment(),
      waffo: useWaffoPayment(),
      pancake: useWaffoPancakePayment(),
    }))
    const submit = () => {
      if (provider === 'creem') {
        return result.current.creem.processCreemPayment('product-test')
      }
      if (provider === 'waffo') {
        return result.current.waffo.processWaffoPayment(10, 0)
      }
      return result.current.pancake.processWaffoPancakePayment(10)
    }
    let first!: Promise<boolean>
    await act(async () => {
      first = submit()
      expect(await submit()).toBe(false)
    })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][2]).toEqual(
      expect.objectContaining({ skipAuthRefresh: true })
    )
    unmount()
    resolve({
      data: {
        message: 'success',
        data: {
          checkout_url: 'https://pay.example.test/pay',
          payment_url: 'https://pay.example.test/pay',
        },
      },
    })
    expect(await first).toBe(false)
    expect(open).not.toHaveBeenCalled()
  }
)

test('a lost order response warns about uncertainty without automatic resubmission', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK'))
  const error = vi.spyOn(toast, 'error')
  const { result } = renderHook(() => usePayment())
  await act(async () => {
    expect(await result.current.processPayment(10, 'stripe')).toBe(false)
  })
  expect(post).toHaveBeenCalledTimes(1)
  expect(error).toHaveBeenCalledWith(
    'Payment request result is unknown. Check Order History before trying again.'
  )
})

test('the real HTTP interceptor does not refresh or replay a payment rejected with 401', async () => {
  const originalAdapter = api.defaults.adapter
  const requests: AxiosRequestConfig[] = []
  api.defaults.adapter = async (config) => {
    requests.push(config)
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
  try {
    const { result } = renderHook(() => usePayment())
    await act(async () => {
      expect(await result.current.processPayment(10, 'stripe')).toBe(false)
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/user/stripe/pay')
    expect(requests[0].skipAuthRefresh).toBe(true)
    expect(requests[0].authRetry).toBeUndefined()
  } finally {
    api.defaults.adapter = originalAdapter
  }
})

test.each(['alipay', 'stripe', 'creem', 'waffo', 'waffo_pancake'])(
  '%s cancels order creation when the payer changes before the real request interceptor runs',
  async (provider) => {
    const originalAdapter = api.defaults.adapter
    const requests: AxiosRequestConfig[] = []
    useAuthStore.setState((state) => ({
      auth: { ...state.auth, accessToken: 'payer-a-token' },
    }))
    api.defaults.adapter = async (config) => {
      requests.push(config)
      return {
        config,
        status: 200,
        statusText: 'OK',
        headers: {},
        data: {
          message: 'success',
          data: { pay_link: 'https://pay.example.test/pay' },
        },
      }
    }
    try {
      const { result } = renderHook(() => ({
        regular: usePayment(),
        creem: useCreemPayment(),
        waffo: useWaffoPayment(),
        pancake: useWaffoPancakePayment(),
      }))
      await act(async () => {
        let operation: Promise<boolean>
        if (provider === 'creem') {
          operation = result.current.creem.processCreemPayment('product-test')
        } else if (provider === 'waffo') {
          operation = result.current.waffo.processWaffoPayment(10, 0)
        } else if (provider === 'waffo_pancake') {
          operation = result.current.pancake.processWaffoPancakePayment(10)
        } else {
          operation = result.current.regular.processPayment(10, provider)
        }
        useAuthStore.setState((state) => ({
          auth: {
            ...state.auth,
            user: { id: 2, username: 'other', role: 1 },
            accessToken: 'payer-b-token',
          },
        }))
        expect(await operation).toBe(false)
      })
      expect(requests.map((request) => request.headers?.Authorization)).toEqual(
        []
      )
    } finally {
      api.defaults.adapter = originalAdapter
    }
  }
)

test('unmounting before the real request interceptor runs cancels order creation', async () => {
  const originalAdapter = api.defaults.adapter
  const adapter = vi
    .fn()
    .mockRejectedValue(new Error('An unmounted payment must not dispatch'))
  api.defaults.adapter = adapter
  try {
    const { result, unmount } = renderHook(() => usePayment())
    await act(async () => {
      const operation = result.current.processPayment(10, 'stripe')
      unmount()
      expect(await operation).toBe(false)
    })
    expect(adapter).not.toHaveBeenCalled()
  } finally {
    api.defaults.adapter = originalAdapter
  }
})

test('Waffo keeps supported provider deep links while rejecting active content URLs', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      message: 'success',
      data: { payment_url: 'alipays://platformapi/startapp?appId=20000067' },
    },
  })
  const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
  const { result } = renderHook(() => useWaffoPayment())
  await act(async () => {
    expect(await result.current.processWaffoPayment(10, 0)).toBe(true)
  })
  expect(open).toHaveBeenCalledWith(
    'alipays://platformapi/startapp?appId=20000067',
    '_blank',
    'noopener,noreferrer'
  )
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<h1>test</h1>',
    'file:///tmp/test',
    'blob:https://example.test/test',
    '/relative',
  ]) {
    expect(isSafePaymentUrl(url, true)).toBe(false)
  }
  expect(isSafePaymentUrl('https://pay.example.test/checkout')).toBe(true)
  expect(isSafePaymentUrl('alipays://platformapi/startapp')).toBe(false)
})

test('changing the amount invalidates a pending method quote and keeps the new amount payable', async () => {
  vi.spyOn(topupInfoHooks, 'useTopupInfo').mockReturnValue({
    topupInfo,
    presetAmounts: [],
    loading: false,
    refetch: vi.fn(),
  })
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: {} } })
  let resolve!: (value: { data: { success: boolean; data: string } }) => void
  const pending = new Promise<{ data: { success: boolean; data: string } }>(
    (done) => {
      resolve = done
    }
  )
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: '1.00' } })
  render(<Wallet />)
  await act(async () => {})
  post.mockReturnValueOnce(pending)
  fireEvent.click(screen.getByRole('button', { name: 'Card' }))
  await act(async () => {
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Custom Amount' }),
      { target: { value: '20' } }
    )
  })
  await act(async () => {
    resolve({ data: { success: true, data: '1.00' } })
    await pending
  })
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Card' })).toBeEnabled()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Card' }))
  })
  const dialog = await screen.findByRole('alertdialog', {
    name: 'Confirm Payment',
  })
  expect(within(dialog).getByText('$20')).toBeVisible()
})

test('a pending Creem order cannot be dismissed before checkout resolves', async () => {
  vi.spyOn(topupInfoHooks, 'useTopupInfo').mockReturnValue({
    topupInfo: {
      ...topupInfo,
      enable_creem_topup: true,
      creem_products: [
        {
          name: 'Starter credits',
          productId: 'starter',
          price: 10,
          quota: 5000000,
          currency: 'USD',
        },
      ],
    },
    presetAmounts: [],
    loading: false,
    refetch: vi.fn(),
  })
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: {} } })
  let resolve!: (value: { data: unknown }) => void
  const pending = new Promise<{ data: unknown }>((done) => {
    resolve = done
  })
  vi.spyOn(api, 'post').mockImplementation((path) =>
    path === '/api/user/creem/pay'
      ? pending
      : Promise.resolve({ data: { success: true, data: '1.00' } })
  )
  const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
  render(<Wallet />)
  await userEvent.click(screen.getByText('Starter credits'))
  const dialog = screen.getByRole('dialog', { name: 'Confirm Creem Purchase' })
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Confirm Payment' })
  )
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
  await userEvent.keyboard('{Escape}')
  expect(dialog).toBeVisible()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(dialog).toBeVisible()
  await act(async () => {
    resolve({
      data: {
        message: 'success',
        data: { checkout_url: 'https://pay.example.test/creem' },
      },
    })
    await pending
  })
  expect(
    screen.queryByRole('dialog', { name: 'Confirm Creem Purchase' })
  ).not.toBeInTheDocument()
  expect(open).toHaveBeenCalledOnce()
})

test.each(['business', 'network'])(
  '%s wallet read failure is unconfirmed rather than zero and GET retry recovers',
  async (failure) => {
    const realStats = await vi.importActual<
      typeof import('../components/wallet-stats-card')
    >('../components/wallet-stats-card')
    vi.spyOn(walletStats, 'WalletStatsCard').mockImplementation(
      realStats.WalletStatsCard
    )
    vi.spyOn(topupInfoHooks, 'useTopupInfo').mockReturnValue({
      topupInfo,
      presetAmounts: [],
      loading: false,
      refetch: vi.fn(),
    })
    let reads = 0
    const get = vi.spyOn(api, 'get').mockImplementation(async () => {
      reads += 1
      if (reads === 1) {
        if (failure === 'network') {
          throw new AxiosError('Network unavailable', 'ERR_NETWORK')
        }
        return {
          data: { success: false, message: 'Temporary database failure' },
        }
      }
      return {
        data: {
          success: true,
          data: { id: 1, quota: 1000000, used_quota: 0, request_count: 0 },
        },
      }
    })
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ data: { success: true, data: '1' } })
    render(<Wallet />)
    await screen.findByText('Oops! Something went wrong')
    expect(screen.queryByText('Current Balance')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Current Balance')
    expect(screen.getByText('$2')).toBeVisible()
    expect(
      screen.queryByText('Oops! Something went wrong')
    ).not.toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(2)
    expect(
      post.mock.calls.filter(([url]) => url !== '/api/user/amount')
    ).toHaveLength(0)
  }
)

test('a late wallet read failure cannot replace the next account balance with an error', async () => {
  const realStats = await vi.importActual<
    typeof import('../components/wallet-stats-card')
  >('../components/wallet-stats-card')
  vi.spyOn(walletStats, 'WalletStatsCard').mockImplementation(
    realStats.WalletStatsCard
  )
  vi.spyOn(topupInfoHooks, 'useTopupInfo').mockReturnValue({
    topupInfo,
    presetAmounts: [],
    loading: false,
    refetch: vi.fn(),
  })
  let rejectOld!: (reason: Error) => void
  const previous = new Promise((_, reject) => {
    rejectOld = reject
  })
  const get = vi
    .spyOn(api, 'get')
    .mockReturnValueOnce(previous)
    .mockResolvedValue({
      data: {
        success: true,
        data: { id: 2, quota: 1000000, used_quota: 0, request_count: 0 },
      },
    })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: '1' },
  })
  render(<Wallet />)
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  act(() =>
    useAuthStore
      .getState()
      .auth.setUser({ id: 2, username: 'next-payer', role: 1 })
  )
  await screen.findByText('$2')
  await act(async () => {
    rejectOld(new AxiosError('Previous account failed', 'ERR_NETWORK'))
    await previous.catch(() => undefined)
  })
  expect(screen.getByText('$2')).toBeVisible()
  expect(
    screen.queryByText('Oops! Something went wrong')
  ).not.toBeInTheDocument()
})

test.each([
  { description: 'a different account', id: 2 },
  { description: 'a replacement session', id: 1 },
])(
  '$description clears the displayed wallet and reads that identity afresh',
  async ({ id }) => {
    const bundle: AuthBundle = {
      access_token: 'wallet-test-access',
      token_type: 'Bearer',
      access_expires_at: 2_000_000_000,
      user: { id: 1, username: 'first-payer', role: 1 },
      session: {
        sid: 'wallet-first-session',
        current: true,
        login_method: 'password',
        ip: '',
        user_agent: '',
        created_at: 1,
        last_active_at: 1,
        expires_at: 2_000_000_000,
      },
    }
    applyAuthBundle(bundle, false)
    vi.spyOn(walletStats, 'WalletStatsCard').mockImplementation((props) => (
      <output aria-label='Wallet balance'>
        {props.user?.quota ?? 'loading'}
      </output>
    ))
    vi.spyOn(topupInfoHooks, 'useTopupInfo').mockReturnValue({
      topupInfo,
      presetAmounts: [],
      loading: false,
      refetch: vi.fn(),
    })
    let finish!: (value: unknown) => void
    const nextRead = new Promise((resolve) => {
      finish = resolve
    })
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({
        data: { success: true, data: { id: 1, quota: 500000 } },
      })
      .mockReturnValue(nextRead)
    vi.spyOn(api, 'post').mockResolvedValue({
      data: { success: true, data: '1' },
    })
    render(<Wallet />)
    const balance = screen.getByRole('status', { name: 'Wallet balance' })
    await waitFor(() => expect(balance).toHaveTextContent('500000'))
    act(() => {
      applyAuthBundle(
        {
          ...bundle,
          user: { ...bundle.user, id },
          session: { ...bundle.session, sid: 'wallet-replacement-session' },
        },
        false
      )
    })
    expect(balance).toHaveTextContent('loading')
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    await act(async () => {
      finish({ data: { success: true, data: { id, quota: 1000000 } } })
      await nextRead
    })
    expect(balance).toHaveTextContent('1000000')
  }
)

test('a confirmed reward transfer refreshes wallet data without reusing or restoring an older balance read', async () => {
  localStorage.clear()
  sessionStorage.clear()
  const realAffiliate = await vi.importActual<
    typeof import('../components/affiliate-rewards-card')
  >('../components/affiliate-rewards-card')
  vi.spyOn(affiliateRewards, 'AffiliateRewardsCard').mockImplementation(
    realAffiliate.AffiliateRewardsCard
  )
  vi.spyOn(walletStats, 'WalletStatsCard').mockImplementation((props) => (
    <output aria-label='Wallet balance'>
      {props.user?.quota ?? 'loading'}
    </output>
  ))
  vi.spyOn(topupInfoHooks, 'useTopupInfo').mockReturnValue({
    topupInfo,
    presetAmounts: [],
    loading: false,
    refetch: vi.fn(),
  })
  const originalAdapter = api.defaults.adapter
  let wallet = 0
  let selfReads = 0
  let transferPosts = 0
  let failRefresh = false
  let finishInitial: (() => void) | undefined
  const response = (config: InternalAxiosRequestConfig, data: unknown) => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
    data: { success: true, data },
  })
  api.defaults.adapter = async (config) => {
    if (config.url === '/api/user/self') {
      selfReads += 1
      const captured = wallet
      if (selfReads === 1) {
        return new Promise((resolve) => {
          finishInitial = () =>
            resolve(response(config, { id: 1, quota: captured }))
        })
      }
      if (failRefresh) {
        return {
          ...response(config, null),
          data: { success: false, message: 'Temporary wallet read failure' },
        }
      }
      return response(config, { id: 1, quota: captured })
    }
    if (config.url === '/api/user/aff_transfer') {
      transferPosts += 1
      wallet += 500000
      return response(config, {
        id: 1,
        ...JSON.parse(config.data),
        created_at: 1,
      })
    }
    if (config.url === '/api/user/aff') return response(config, 'payer-code')
    if (config.url === '/api/user/referral') {
      return response(config, {
        rule: { enabled: false, rate_bps: 1000, valid_days: 30 },
        compliance_confirmed: true,
        aff_quota: String(1000000 - wallet),
        aff_history_quota: '2000000',
        rebate_quota: '500000',
        direct_count: 2,
      })
    }
    return response(config, '1')
  }
  try {
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <Wallet />
      </QueryClientProvider>
    )
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Transfer to Balance' })
    )
    await user.click(screen.getByRole('button', { name: 'Transfer' }))
    await waitFor(() => expect(wallet).toBe(500000))
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Transfer Rewards' })
      ).not.toBeInTheDocument()
    )
    await waitFor(() => expect(selfReads).toBe(2))
    await waitFor(() =>
      expect(
        screen.getByRole('status', { name: 'Wallet balance' })
      ).toHaveTextContent('500000')
    )
    await act(async () => finishInitial?.())
    await waitFor(() =>
      expect(
        screen.getByRole('status', { name: 'Wallet balance' })
      ).toHaveTextContent('500000')
    )
    expect(selfReads).toBe(2)
    failRefresh = true
    await user.click(
      screen.getByRole('button', { name: 'Transfer to Balance' })
    )
    await user.click(screen.getByRole('button', { name: 'Transfer' }))
    await screen.findByText(
      'Transfer succeeded, but balances could not be refreshed.'
    )
    await screen.findByText('Oops! Something went wrong')
    expect(
      screen.queryByRole('status', { name: 'Wallet balance' })
    ).not.toBeInTheDocument()
    expect(wallet).toBe(1000000)
    expect(transferPosts).toBe(2)
    failRefresh = false
    await user.click(screen.getAllByRole('button', { name: 'Retry' })[0])
    await waitFor(() =>
      expect(
        screen.getByRole('status', { name: 'Wallet balance' })
      ).toHaveTextContent('1000000')
    )
    expect(transferPosts).toBe(2)
  } finally {
    finishInitial?.()
    api.defaults.adapter = originalAdapter
    localStorage.clear()
    sessionStorage.clear()
  }
})
