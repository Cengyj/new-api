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
import { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios'
import { afterEach, expect, test, vi } from 'vitest'

import { listWaffoPancakeCatalog } from '@/features/system-settings/integrations/waffo-pancake-api'
import { api } from '@/lib/api'

const originalAdapter = api.defaults.adapter
const catalogPath = '/api/option/waffo-pancake/catalog'

afterEach(() => {
  api.defaults.adapter = originalAdapter
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
