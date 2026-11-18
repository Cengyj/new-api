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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios'
import i18next from 'i18next'
import { createElement, StrictMode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  createWaffoPancakePair,
  listWaffoPancakeCatalog,
  saveWaffoPancakeConfig,
} from '@/features/system-settings/integrations/waffo-pancake-api'
import zh from '@/i18n/locales/zh.json'
import { api } from '@/lib/api'
import { applyAuthBundle, clearAuthentication } from '@/lib/auth-session'
import type { AuthBundle } from '@/stores/auth-store'

import { WaffoPancakeSettingsSection } from '../waffo-pancake-settings-section'

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

beforeEach(() => applyAuthBundle(adminBundle, false))

const originalAdapter = api.defaults.adapter
const catalogPath = '/api/option/waffo-pancake/catalog'

afterEach(async () => {
  api.defaults.adapter = originalAdapter
  clearAuthentication(false)
  vi.useRealTimers()
  vi.restoreAllMocks()
  await i18next.changeLanguage('en')
  i18next.removeResourceBundle('zh', 'translation')
})

test.each([
  ['supplied credentials', 'fixture-merchant', 'fixture-key-not-usable'],
  ['persisted credential fallback', '', ''],
])(
  'catalog %s travel in JSON without appearing in the request URL',
  async (_, merchantID, privateKey) => {
    const body = {
      message: 'success',
      data: {
        stores: [
          {
            id: 'fixture-store',
            name: 'Fixture store',
            status: 'active',
            prodEnabled: false,
            onetimeProducts: [
              {
                id: 'fixture-product',
                name: 'Wallet credit',
                status: 'active',
              },
            ],
          },
        ],
      },
    }
    const adapter = vi.fn<AxiosAdapter>(async (config) => ({
      config,
      data: body,
      status: 200,
      statusText: 'OK',
      headers: new AxiosHeaders(),
    }))
    api.defaults.adapter = adapter

    expect(await listWaffoPancakeCatalog(merchantID, privateKey)).toEqual(body)

    expect(adapter).toHaveBeenCalledTimes(1)
    const [request] = adapter.mock.calls[0]
    expect(api.getUri(request)).toBe(catalogPath)
    expect(request.method).toBe('post')
    expect(request.headers.getContentType()).toBe('application/json')
    expect(JSON.parse(request.data as string)).toEqual({
      merchant_id: merchantID,
      private_key: privateKey,
    })
  }
)

test('catalog preserves a business rejection for the settings error state', async () => {
  const body = { message: 'error', data: 'Credentials could not be verified' }
  api.defaults.adapter = async (config) => ({
    config,
    data: body,
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
  })

  expect(await listWaffoPancakeCatalog('', '')).toEqual(body)
})

test('catalog rejects an HTTP failure instead of returning a successful empty list', async () => {
  const body = { message: 'error', data: 'Catalog temporarily unavailable' }
  api.defaults.adapter = async (config) => {
    throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, {
      config,
      data: body,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new AxiosHeaders(),
    })
  }

  await expect(listWaffoPancakeCatalog('', '')).rejects.toMatchObject({
    response: { status: 503, data: body },
  })
})

const writeFixture = {
  merchantID: 'fixture-merchant',
  privateKey: 'fixture-key-not-usable',
  returnURL: 'https://gateway.example.com',
  storeID: 'fixture-store',
  productID: 'fixture-product',
}

test.each([
  ['pair', () => createWaffoPancakePair(writeFixture)],
  ['save', () => saveWaffoPancakeConfig(writeFixture)],
] as const)(
  '%s rejects an unauthorized write without refresh or replay',
  async (_, write) => {
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
          config,
          data: { message: 'Session expired!' },
          status: 401,
          statusText: 'Unauthorized',
          headers: new AxiosHeaders(),
        }
      )
    })
    api.defaults.adapter = adapter
    await expect(write()).rejects.toMatchObject({ response: { status: 401 } })
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
  }
)

test.each([
  ['pair', () => createWaffoPancakePair(writeFixture)],
  ['save', () => saveWaffoPancakeConfig(writeFixture)],
] as const)(
  '%s discards a saved result after the initiating session changes',
  async (_, write) => {
    let release: (() => void) | undefined
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {
        config,
        data: {
          message: 'success',
          data: { store_id: 'fixture-store', product_id: 'fixture-product' },
        },
        status: 200,
        statusText: 'OK',
        headers: new AxiosHeaders(),
      }
    })
    api.defaults.adapter = adapter
    const outcome = write().catch((error: unknown) => error)
    await waitFor(() => expect(release).toBeTypeOf('function'))
    applyAuthBundle(
      {
        ...adminBundle,
        session: { ...adminBundle.session, sid: 'replacement-session' },
      },
      false
    )
    release?.()
    expect(await outcome).toMatchObject({ code: 'ERR_CANCELED' })
    expect(adapter).toHaveBeenCalledTimes(1)
  }
)

test('a late catalog response cannot select the previous administrator product after session replacement', async () => {
  let release: (() => void) | undefined
  api.defaults.adapter = async (config) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      config,
      data: {
        message: 'success',
        data: {
          stores: [
            {
              id: 'old-store',
              name: 'Old merchant',
              status: 'active',
              prodEnabled: true,
              onetimeProducts: [
                { id: 'old-product', name: 'Old product', status: 'active' },
              ],
            },
          ],
        },
      },
      status: 200,
      statusText: 'OK',
      headers: new AxiosHeaders(),
    }
  }
  const select = vi.fn()
  const values = {
    WaffoPancakeMerchantID: 'saved-merchant',
    WaffoPancakePrivateKey: '',
    WaffoPancakeReturnURL: 'https://gateway.example.com',
  }
  render(
    createElement(WaffoPancakeSettingsSection, {
      defaultValues: values,
      values,
      onValueChange: vi.fn(),
      selectedBinding: { storeID: '', productID: '' },
      savedBinding: { storeID: '', productID: '' },
      onSelectedBindingChange: select,
    })
  )
  await waitFor(() => expect(release).toBeTypeOf('function'))
  await act(async () => {
    applyAuthBundle(
      {
        ...adminBundle,
        session: { ...adminBundle.session, sid: 'replacement-session' },
      },
      false
    )
    release?.()
  })
  expect(select).not.toHaveBeenCalled()
})

test.each(['typed credentials', 'saved credentials'] as const)(
  'scheduled catalog verification with %s does not run under a replacement session',
  async (source) => {
    vi.useFakeTimers()
    const adapter = vi.fn<AxiosAdapter>(async (config) => ({
      config,
      data: { message: 'success', data: { stores: [] } },
      status: 200,
      statusText: 'OK',
      headers: new AxiosHeaders(),
    }))
    api.defaults.adapter = adapter
    const defaults = {
      WaffoPancakeMerchantID:
        source === 'saved credentials' ? 'old-merchant' : '',
      WaffoPancakePrivateKey: '',
      WaffoPancakeReturnURL: 'https://gateway.example.com',
    }
    const select = vi.fn()
    render(
      createElement(WaffoPancakeSettingsSection, {
        defaultValues: defaults,
        values: {
          ...defaults,
          WaffoPancakeMerchantID: 'old-merchant',
          WaffoPancakePrivateKey:
            source === 'typed credentials' ? 'old-private-key' : '',
        },
        onValueChange: vi.fn(),
        selectedBinding: { storeID: '', productID: '' },
        savedBinding: { storeID: '', productID: '' },
        onSelectedBindingChange: select,
      })
    )

    await act(async () => {
      applyAuthBundle(
        {
          ...adminBundle,
          access_token: 'replacement-access',
          session: { ...adminBundle.session, sid: 'replacement-session' },
        },
        false
      )
      await vi.advanceTimersByTimeAsync(800)
    })

    expect(adapter).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  }
)

test.each(['edited credentials', 'cleared credentials', 'unmounted form'])(
  'a catalog response cannot replace the binding after %s',
  async (change) => {
    vi.useFakeTimers()
    let release!: () => void
    const responseReady = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      const { merchant_id: merchant } = JSON.parse(config.data as string) as {
        merchant_id: string
      }
      if (!merchant) await responseReady
      return {
        config,
        data: {
          message: 'success',
          data: {
            stores: [
              {
                id: merchant ? 'new-store' : 'old-store',
                name: merchant ? 'New store' : 'Old store',
                status: 'active',
                prodEnabled: false,
                onetimeProducts: [
                  {
                    id: merchant ? 'new-product' : 'old-product',
                    name: merchant ? 'New product' : 'Old product',
                    status: 'active',
                  },
                ],
              },
            ],
          },
        },
        status: 200,
        statusText: 'OK',
        headers: new AxiosHeaders(),
      }
    })
    api.defaults.adapter = adapter
    const defaults = {
      WaffoPancakeMerchantID: 'saved-merchant',
      WaffoPancakePrivateKey: '',
      WaffoPancakeReturnURL: 'https://gateway.example.com',
    }
    const select = vi.fn()
    const props = {
      defaultValues: defaults,
      values: defaults,
      onValueChange: vi.fn(),
      selectedBinding: { storeID: 'saved-store', productID: 'saved-product' },
      savedBinding: { storeID: 'saved-store', productID: 'saved-product' },
      onSelectedBindingChange: select,
    }
    const view = render(createElement(WaffoPancakeSettingsSection, props))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(adapter).toHaveBeenCalledTimes(1)

    if (change === 'unmounted form') {
      view.unmount()
    } else {
      view.rerender(
        createElement(WaffoPancakeSettingsSection, {
          ...props,
          values: {
            ...defaults,
            WaffoPancakeMerchantID:
              change === 'cleared credentials' ? '' : 'new-merchant',
            WaffoPancakePrivateKey:
              change === 'cleared credentials' ? '' : 'new-private-key',
          },
        })
      )
    }
    await act(async () => release())
    expect(select).not.toHaveBeenCalled()

    if (change === 'edited credentials') {
      await act(async () => vi.advanceTimersByTimeAsync(800))
      expect(adapter).toHaveBeenCalledTimes(2)
      expect(select).toHaveBeenCalledExactlyOnceWith({
        storeID: 'new-store',
        productID: 'new-product',
      })
    }
  }
)

test('saved credentials still load their catalog after a StrictMode effect restart', async () => {
  vi.useFakeTimers()
  const adapter = vi.fn<AxiosAdapter>(async (config) => ({
    config,
    data: { message: 'success', data: { stores: [] } },
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
  }))
  api.defaults.adapter = adapter
  const values = {
    WaffoPancakeMerchantID: 'saved-merchant',
    WaffoPancakePrivateKey: '',
    WaffoPancakeReturnURL: 'https://gateway.example.com',
  }
  const select = vi.fn()
  render(
    createElement(
      StrictMode,
      null,
      createElement(WaffoPancakeSettingsSection, {
        defaultValues: values,
        values,
        onValueChange: vi.fn(),
        selectedBinding: { storeID: '', productID: '' },
        savedBinding: { storeID: '', productID: '' },
        onSelectedBindingChange: select,
      })
    )
  )
  await act(async () => vi.advanceTimersByTimeAsync(0))
  expect(adapter).toHaveBeenCalledTimes(1)
  expect(select).toHaveBeenCalledExactlyOnceWith({
    storeID: '',
    productID: '',
  })
})

test('restoring saved credentials reloads their catalog after discarding a typed draft', async () => {
  vi.useFakeTimers()
  const adapter = vi.fn<AxiosAdapter>(async (config) => ({
    config,
    data: { message: 'success', data: { stores: [] } },
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
  }))
  api.defaults.adapter = adapter
  const values = {
    WaffoPancakeMerchantID: 'saved-merchant',
    WaffoPancakePrivateKey: '',
    WaffoPancakeReturnURL: 'https://gateway.example.com',
  }
  const select = vi.fn()
  const props = {
    defaultValues: values,
    values,
    onValueChange: vi.fn(),
    selectedBinding: { storeID: '', productID: '' },
    savedBinding: { storeID: '', productID: '' },
    onSelectedBindingChange: select,
  }
  const view = render(createElement(WaffoPancakeSettingsSection, props))
  await act(async () => vi.advanceTimersByTimeAsync(0))
  expect(adapter).toHaveBeenCalledTimes(1)
  view.rerender(
    createElement(WaffoPancakeSettingsSection, {
      ...props,
      values: { ...values, WaffoPancakeMerchantID: 'discarded-draft' },
    })
  )
  view.rerender(createElement(WaffoPancakeSettingsSection, props))
  await act(async () => vi.advanceTimersByTimeAsync(0))
  expect(adapter).toHaveBeenCalledTimes(2)
  expect(select).toHaveBeenCalledTimes(2)
  expect(JSON.parse(adapter.mock.calls[1][0].data as string)).toEqual({
    merchant_id: '',
    private_key: '',
  })
})

test('an old merchant pair creation cannot bind its result after credentials change', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const pairReady = new Promise<void>((resolve) => {
    release = resolve
  })
  const adapter = vi.fn<AxiosAdapter>(async (config) => {
    const pair = config.url?.endsWith('/pair')
    if (pair) await pairReady
    return {
      config,
      data: {
        message: 'success',
        data: pair
          ? { store_id: 'old-created-store', product_id: 'old-created-product' }
          : { stores: [] },
      },
      status: 200,
      statusText: 'OK',
      headers: new AxiosHeaders(),
    }
  })
  api.defaults.adapter = adapter
  const defaults = {
    WaffoPancakeMerchantID: 'saved-merchant',
    WaffoPancakePrivateKey: '',
    WaffoPancakeReturnURL: 'https://gateway.example.com',
  }
  const select = vi.fn()
  const props = {
    defaultValues: defaults,
    values: defaults,
    onValueChange: vi.fn(),
    selectedBinding: { storeID: '', productID: '' },
    savedBinding: { storeID: '', productID: '' },
    onSelectedBindingChange: select,
  }
  const view = render(createElement(WaffoPancakeSettingsSection, props))
  await act(async () => vi.advanceTimersByTimeAsync(0))
  select.mockClear()
  await act(async () =>
    fireEvent.click(
      screen.getByRole('button', { name: /Create new-api-store/ })
    )
  )
  expect(adapter).toHaveBeenCalledTimes(2)
  view.rerender(
    createElement(WaffoPancakeSettingsSection, {
      ...props,
      values: {
        ...defaults,
        WaffoPancakeMerchantID: 'new-merchant',
        WaffoPancakePrivateKey: 'new-private-key',
      },
    })
  )
  await act(async () => release())
  expect(adapter).toHaveBeenCalledTimes(2)
  expect(select).not.toHaveBeenCalled()
  expect(
    screen.getByRole('button', { name: /Create new-api-store/ })
  ).toBeEnabled()
})

test.each([true, false])(
  'pair creation preserves the orphan store and translated error when message_key is %s',
  async (translated) => {
    vi.useFakeTimers()
    i18next.addResourceBundle('zh', 'translation', zh.translation)
    await i18next.changeLanguage('zh')
    const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => '')
    api.defaults.adapter = async (config) => ({
      config,
      data: config.url?.endsWith('/pair')
        ? {
            message: 'error',
            ...(translated ? { message_key: 'Invalid response' } : {}),
            data: {
              orphan_store: true,
              store_id: 'recoverable-store',
              error: translated
                ? 'create primary product: Invalid response'
                : 'Remote catalog busy',
            },
          }
        : { message: 'success', data: { stores: [] } },
      status: 200,
      statusText: 'OK',
      headers: new AxiosHeaders(),
    })
    const values = {
      WaffoPancakeMerchantID: 'saved-merchant',
      WaffoPancakePrivateKey: '',
      WaffoPancakeReturnURL: 'https://gateway.example.com',
    }
    const select = vi.fn()
    render(
      createElement(WaffoPancakeSettingsSection, {
        defaultValues: values,
        values,
        onValueChange: vi.fn(),
        selectedBinding: { storeID: '', productID: '' },
        savedBinding: { storeID: '', productID: '' },
        onSelectedBindingChange: select,
      })
    )
    await act(async () => vi.advanceTimersByTimeAsync(0))
    select.mockClear()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /new-api-store/ }))
    )
    expect(select).toHaveBeenCalledExactlyOnceWith({
      storeID: 'recoverable-store',
      productID: '',
    })
    expect(errorToast).toHaveBeenCalledExactlyOnceWith(
      `${zh.translation['Creation failed']}: ${translated ? zh.translation['Invalid response'] : 'Remote catalog busy'}`
    )
  }
)
