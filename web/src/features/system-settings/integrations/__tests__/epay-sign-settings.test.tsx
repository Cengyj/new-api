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
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios'
import { useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { applyAuthBundle, clearAuthentication } from '@/lib/auth-session'
import type { AuthBundle } from '@/stores/auth-store'

import { updateSystemOption } from '../../api'
import { SettingsPageProvider } from '../../components/settings-page-context'
import { useSystemOptions } from '../../hooks/use-system-options'
import { PaymentSettingsSection } from '../payment-settings-section'

type PaymentProps = ComponentProps<typeof PaymentSettingsSection>
type PaymentValues = PaymentProps['defaultValues']

const defaults: PaymentValues = {
  PayAddress: 'https://pay.example.com',
  EpayId: '1001',
  EpayKey: '',
  EpaySignType: 'MD5',
  EpayMerchantPrivateKey: '',
  EpayPlatformPublicKey: '',
  Price: 7.3,
  MinTopUp: 1,
  CustomCallbackAddress: '',
  PayMethods: '[]',
  AmountOptions: '[]',
  AmountDiscount: '{}',
  StripeApiSecret: '',
  StripeWebhookSecret: '',
  StripePriceId: '',
  StripeUnitPrice: 8,
  StripeMinTopUp: 1,
  StripePromotionCodesEnabled: false,
  CreemApiKey: '',
  CreemWebhookSecret: '',
  CreemTestMode: false,
  CreemProducts: '[]',
}

function PaymentFixture(props: { values: PaymentValues }) {
  const [actions, setActions] = useState<HTMLDivElement | null>(null)
  return (
    <SettingsPageProvider actionsContainer={actions}>
      <div ref={setActions} />
      <PaymentSettingsSection
        defaultValues={props.values}
        waffoDefaultValues={{
          WaffoEnabled: false,
          WaffoApiKey: '',
          WaffoPrivateKey: '',
          WaffoPublicCert: '',
          WaffoSandboxPublicCert: '',
          WaffoSandboxApiKey: '',
          WaffoSandboxPrivateKey: '',
          WaffoSandbox: false,
          WaffoMerchantId: '',
          WaffoCurrency: 'USD',
          WaffoUnitPrice: 1,
          WaffoMinTopUp: 1,
          WaffoNotifyUrl: '',
          WaffoReturnUrl: '',
          WaffoPayMethods: '[]',
        }}
        waffoPancakeDefaultValues={{
          WaffoPancakeMerchantID: '',
          WaffoPancakePrivateKey: '',
          WaffoPancakeReturnURL: '',
        }}
        complianceDefaults={{
          confirmed: true,
          termsVersion: 'v1',
          confirmedAt: 1,
          confirmedBy: 1,
        }}
      />
    </SettingsPageProvider>
  )
}

function RefetchedPaymentFixture() {
  const { data } = useSystemOptions()
  const options = Object.fromEntries(
    data?.data.map((option) => [option.key, option.value]) ?? []
  )
  return (
    <PaymentFixture
      values={{
        ...defaults,
        EpaySignType:
          options['payment_setting.epay_sign_type'] === 'RSA' ? 'RSA' : 'MD5',
        EpayPlatformPublicKey:
          options['payment_setting.epay_platform_public_key'] ?? '',
      }}
    />
  )
}

async function openEpayTab(values: Partial<PaymentValues> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <PaymentFixture values={{ ...defaults, ...values }} />
    </QueryClientProvider>
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: 'Epay' }))
  return user
}

const adminBundle: AuthBundle = {
  access_token: 'first-admin-access',
  token_type: 'Bearer',
  access_expires_at: 2_000_000_000,
  user: { id: 1, username: 'first-admin', role: 100 },
  session: {
    sid: 'first-admin-session',
    current: true,
    login_method: 'password',
    ip: '',
    user_agent: '',
    created_at: 1,
    last_active_at: 1,
    expires_at: 2_000_000_000,
  },
}

const originalAdapter = api.defaults.adapter

beforeEach(() => applyAuthBundle(adminBundle, false))

afterEach(() => {
  api.defaults.adapter = originalAdapter
  clearAuthentication(false)
  vi.restoreAllMocks()
})

describe('Epay signature type', () => {
  it('keeps drafts across token refresh but discards them when the form session changes', async () => {
    const user = await openEpayTab()
    await user.click(screen.getByRole('combobox', { name: 'Signature type' }))
    await user.click(screen.getByRole('option', { name: 'RSA' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Merchant private key' }),
      'old-session-private-key'
    )
    await act(async () => {
      applyAuthBundle(
        { ...adminBundle, access_token: 'refreshed-access' },
        false
      )
    })
    expect(
      screen.getByRole('textbox', { name: 'Merchant private key' })
    ).toHaveValue('old-session-private-key')

    await act(async () => {
      applyAuthBundle(
        {
          ...adminBundle,
          session: { ...adminBundle.session, sid: 'new-session' },
        },
        false
      )
    })
    await user.click(screen.getByRole('tab', { name: 'Epay' }))
    expect(
      screen.getByRole('combobox', { name: 'Signature type' })
    ).toHaveTextContent('MD5')
    await user.click(screen.getByRole('combobox', { name: 'Signature type' }))
    await user.click(screen.getByRole('option', { name: 'RSA' }))
    expect(
      screen.getByRole('textbox', { name: 'Merchant private key' })
    ).toHaveValue('')
  })

  it('returns an unauthorized option write without refreshing or replaying it', async () => {
    const refresh = vi
      .spyOn(XMLHttpRequest.prototype, 'send')
      .mockImplementation(() => {
        throw new Error('Unexpected refresh request')
      })
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      throw new AxiosError(
        'Unauthorized',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        {
          data: { message: 'Session expired!' },
          status: 401,
          statusText: 'Unauthorized',
          headers: new AxiosHeaders(),
          config,
        }
      )
    })
    api.defaults.adapter = adapter

    await expect(
      updateSystemOption({
        key: 'payment_setting.epay_sign_type',
        value: 'RSA',
      })
    ).rejects.toMatchObject({ response: { status: 401 } })
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
  })

  it.each(['account', 'session', 'role'] as const)(
    'stops saving RSA fields when the initiating %s changes after the first response',
    async (change) => {
      const original = adminBundle
      applyAuthBundle(original, false)
      let releaseFirst: (() => void) | undefined
      const adapter = vi.fn<AxiosAdapter>(async (config) => {
        if (adapter.mock.calls.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        }
        return {
          config,
          data: { success: true },
          status: 200,
          statusText: 'OK',
          headers: new AxiosHeaders(),
        }
      })
      api.defaults.adapter = adapter
      const user = await openEpayTab()
      await user.click(screen.getByRole('combobox', { name: 'Signature type' }))
      await user.click(screen.getByRole('option', { name: 'RSA' }))
      await user.type(
        screen.getByRole('textbox', { name: 'Merchant private key' }),
        'private-key'
      )
      await user.type(
        screen.getByRole('textbox', { name: 'Platform public key' }),
        'public-key'
      )
      await user.click(
        screen.getByRole('button', { name: 'Save all settings' })
      )
      await waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
      await act(async () => {
        applyAuthBundle(
          {
            ...original,
            access_token: 'second-admin-access',
            user:
              change === 'account'
                ? { id: 2, username: 'second-admin', role: 100 }
                : { ...original.user, role: change === 'role' ? 1 : 100 },
            session: {
              ...original.session,
              sid:
                change === 'session'
                  ? 'second-admin-session'
                  : original.session.sid,
            },
          },
          false
        )
        releaseFirst?.()
      })
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Save all settings' })
        ).toBeEnabled()
      )
      expect(adapter).toHaveBeenCalledTimes(1)
      expect(adapter.mock.calls[0][0].headers.get('Authorization')).toBe(
        'Bearer first-admin-access'
      )
    }
  )

  it('shows only the MD5 secret by default and only the RSA keys after choosing RSA', async () => {
    const user = await openEpayTab()
    expect(
      screen.getByRole('combobox', { name: 'Signature type' })
    ).toHaveTextContent('MD5')
    expect(screen.getByLabelText('Epay secret key')).toHaveAttribute(
      'type',
      'password'
    )
    expect(
      screen.queryByRole('textbox', { name: 'Merchant private key' })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Signature type' }))
    await user.click(screen.getByRole('option', { name: 'RSA' }))

    expect(screen.queryByLabelText('Epay secret key')).not.toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Merchant private key' })
    ).toBeVisible()
    expect(
      screen.getByRole('textbox', { name: 'Platform public key' })
    ).toBeVisible()
  })

  it('saves both RSA keys before switching the signature type', async () => {
    const request = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true } })
    const user = await openEpayTab()
    await user.click(screen.getByRole('combobox', { name: 'Signature type' }))
    await user.click(screen.getByRole('option', { name: 'RSA' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Merchant private key' }),
      ' merchant-private-key\n'
    )
    await user.type(
      screen.getByRole('textbox', { name: 'Platform public key' }),
      'platform-public-key'
    )

    await user.click(screen.getByRole('button', { name: 'Save all settings' }))

    await waitFor(() => expect(request).toHaveBeenCalledTimes(3))
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      {
        key: 'payment_setting.epay_merchant_private_key',
        value: 'merchant-private-key',
      },
      {
        key: 'payment_setting.epay_platform_public_key',
        value: 'platform-public-key',
      },
      { key: 'payment_setting.epay_sign_type', value: 'RSA' },
    ])
  })

  it('keeps RSA edits after a partial save refetch and activation failure so an explicit retry can finish', async () => {
    const saved = {
      'payment_setting.epay_sign_type': 'MD5',
      'payment_setting.epay_platform_public_key': '',
    }
    let rejectActivation: (() => void) | undefined
    let failActivation = true
    const writes: string[] = []
    api.defaults.adapter = async (config) => {
      if (config.method === 'get') {
        return {
          config,
          data: {
            success: true,
            data: Object.entries(saved).map(([key, value]) => ({ key, value })),
          },
          status: 200,
          statusText: 'OK',
          headers: new AxiosHeaders(),
        }
      }
      const body = JSON.parse(config.data as string) as {
        key: string
        value: string
      }
      writes.push(body.key)
      if (body.key === 'payment_setting.epay_platform_public_key') {
        saved['payment_setting.epay_platform_public_key'] = body.value
      }
      if (body.key === 'payment_setting.epay_sign_type') {
        if (failActivation) {
          await new Promise<void>((resolve) => {
            rejectActivation = resolve
          })
        } else {
          saved['payment_setting.epay_sign_type'] = body.value
        }
      }
      return {
        config,
        data:
          body.key === 'payment_setting.epay_sign_type' && failActivation
            ? {
                success: false,
                message: 'Signature configuration could not be saved',
              }
            : { success: true },
        status: 200,
        statusText: 'OK',
        headers: new AxiosHeaders(),
      }
    }
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    const view = render(
      <QueryClientProvider client={client}>
        <RefetchedPaymentFixture />
      </QueryClientProvider>
    )
    const user = userEvent.setup()
    await waitFor(() =>
      expect(client.getQueryState(['system-options'])?.status).toBe('success')
    )
    await user.click(screen.getByRole('tab', { name: 'Epay' }))
    await user.click(screen.getByRole('combobox', { name: 'Signature type' }))
    await user.click(screen.getByRole('option', { name: 'RSA' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Merchant private key' }),
      'merchant-private-key'
    )
    await user.type(
      screen.getByRole('textbox', { name: 'Platform public key' }),
      'platform-public-key'
    )
    await user.click(screen.getByRole('button', { name: 'Save all settings' }))
    await waitFor(() => expect(rejectActivation).toBeTypeOf('function'))
    await waitFor(() => expect(client.isFetching()).toBe(0))
    await act(async () => {
      rejectActivation?.()
    })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save all settings' })
      ).toBeEnabled()
    )

    expect(writes).toEqual([
      'payment_setting.epay_merchant_private_key',
      'payment_setting.epay_platform_public_key',
      'payment_setting.epay_sign_type',
    ])
    expect(
      screen.getByRole('combobox', { name: 'Signature type' })
    ).toHaveTextContent('RSA')
    expect(
      screen.getByRole('textbox', { name: 'Merchant private key' })
    ).toHaveValue('merchant-private-key')
    expect(
      screen.getByRole('textbox', { name: 'Platform public key' })
    ).toHaveValue('platform-public-key')

    failActivation = false
    await user.click(screen.getByRole('button', { name: 'Save all settings' }))
    await waitFor(() =>
      expect(saved['payment_setting.epay_sign_type']).toBe('RSA')
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save all settings' })
      ).toBeEnabled()
    )
    view.unmount()
    client.clear()
  })

  it('keeps saved RSA keys when switching back to MD5 with blank key fields', async () => {
    const request = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true } })
    const user = await openEpayTab({
      EpaySignType: 'RSA',
      EpayPlatformPublicKey: 'saved-platform-public-key',
    })
    expect(
      screen.getByRole('textbox', { name: 'Merchant private key' })
    ).toHaveValue('')
    expect(
      screen.getByRole('textbox', { name: 'Platform public key' })
    ).toHaveValue('saved-platform-public-key')

    await user.click(screen.getByRole('combobox', { name: 'Signature type' }))
    await user.click(screen.getByRole('option', { name: 'MD5' }))
    await user.click(screen.getByRole('button', { name: 'Save all settings' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/api/option/',
        {
          key: 'payment_setting.epay_sign_type',
          value: 'MD5',
        },
        expect.objectContaining({ skipAuthRefresh: true })
      )
    )
    expect(request).toHaveBeenCalledTimes(1)
  })
})
