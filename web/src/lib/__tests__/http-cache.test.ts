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
import { waitFor } from '@testing-library/react'
import { AxiosError, CanceledError, type AxiosAdapter } from 'axios'
import { afterEach, expect, it, vi } from 'vitest'

import { useAuthStore, type AuthBundle } from '@/stores/auth-store'

import { api, getNotice } from '../api'
import { applyAuthBundle, clearAuthentication } from '../auth-session'
import { createAppQueryClient } from '../query-client'

const originalAdapter = api.defaults.adapter

afterEach(() => {
  api.defaults.adapter = originalAdapter
  clearAuthentication(false)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('a retry after 404 revalidates HTTP caches instead of accepting a stored error', async () => {
  const adapter = vi
    .fn<AxiosAdapter>()
    .mockImplementationOnce(async (config) => {
      throw new AxiosError('Not Found', 'ERR_BAD_REQUEST', config, undefined, {
        data: { error: { message: 'Invalid URL' } },
        status: 404,
        statusText: 'Not Found',
        headers: {},
        config,
      })
    })
    .mockImplementationOnce(async (config) => ({
      data: { success: true, data: { exists: false } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }))
  api.defaults.adapter = adapter
  const config = { skipErrorHandler: true }
  await expect(api.get('/api/user/token/status', config)).rejects.toMatchObject(
    { response: { status: 404 } }
  )
  const response = await api.get('/api/user/token/status', config)
  expect(response.data.data.exists).toBe(false)
  expect(adapter).toHaveBeenCalledTimes(2)
  for (const [request] of adapter.mock.calls) {
    const directives = String(request.headers.get('Cache-Control'))
      .split(',')
      .map((value: string) => value.trim())
    expect(directives).toContain('no-cache')
    expect(directives).toContain('no-store')
  }
})

it('public notices keep their existing ETag revalidation policy', async () => {
  const adapter = vi.fn<AxiosAdapter>(async (config) => ({
    data: { success: true },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  }))
  api.defaults.adapter = adapter
  await getNotice()
  expect(adapter.mock.calls[0][0].headers.get('Cache-Control')).toBeNull()
})

it('deduplicates GETs within one session and ignores a late 401 after a new session starts', async () => {
  const original: AuthBundle = {
    access_token: 'first-access',
    token_type: 'Bearer',
    access_expires_at: 2_000_000_000,
    user: { id: 1, username: 'first-user', role: 1 },
    session: {
      sid: 'first-session',
      current: true,
      login_method: 'password',
      ip: '',
      user_agent: '',
      created_at: 1,
      last_active_at: 1,
      expires_at: 2_000_000_000,
    },
  }
  applyAuthBundle(original, false)
  let finishFirst: (() => void) | undefined
  const adapter = vi.fn<AxiosAdapter>(async (config) => {
    if (config.headers.get('Authorization') === 'Bearer first-access') {
      await new Promise<void>((resolve) => {
        finishFirst = resolve
      })
      throw new AxiosError(
        'Unauthorized',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        {
          data: { message: 'Session expired!' },
          status: 401,
          statusText: 'Unauthorized',
          headers: {},
          config,
        }
      )
    }
    return {
      data: { success: true, data: 'second-user-records' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  })
  api.defaults.adapter = adapter
  const refresh = vi.spyOn(XMLHttpRequest.prototype, 'send')
  const first = api.get('/api/user/referral')
  const firstOutcome = first.catch((error: unknown) => error)
  const duplicate = api.get('/api/user/referral')
  expect(duplicate).toBe(first)
  await waitFor(() => expect(finishFirst).toBeTypeOf('function'))
  expect(adapter).toHaveBeenCalledTimes(1)

  const next: AuthBundle = {
    ...original,
    access_token: 'second-access',
    user: { id: 2, username: 'second-user', role: 1 },
    session: { ...original.session, sid: 'second-session' },
  }
  applyAuthBundle(next, false)
  await expect(api.get('/api/user/referral')).resolves.toMatchObject({
    data: { data: 'second-user-records' },
  })
  finishFirst?.()
  expect(await firstOutcome).toMatchObject({ code: 'ERR_CANCELED' })
  expect(adapter).toHaveBeenCalledTimes(2)
  expect(refresh).not.toHaveBeenCalled()
  expect(useAuthStore.getState().auth.user?.id).toBe(next.user.id)
  expect(useAuthStore.getState().auth.session?.sid).toBe(next.session.sid)
  expect(useAuthStore.getState().auth.accessToken).toBe(next.access_token)
})

it.each(['post', 'put', 'patch', 'delete', 'get', 'head', 'options'])(
  '%s only replays after authentication refresh when the method is read-only',
  async (method) => {
    const original: AuthBundle = {
      access_token: 'expired-access',
      token_type: 'Bearer',
      access_expires_at: 1,
      user: { id: 1, username: 'test-user', role: 100 },
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
    applyAuthBundle(original, false)
    const refresh = vi
      .spyOn(XMLHttpRequest.prototype, 'send')
      .mockImplementation(function (this: XMLHttpRequest) {
        Object.defineProperties(this, {
          status: { value: 200, configurable: true },
          statusText: { value: 'OK', configurable: true },
          responseText: {
            value: JSON.stringify({
              success: true,
              data: {
                ...original,
                access_token: 'fresh-access',
                access_expires_at: 2_000_000_000,
              },
            }),
            configurable: true,
          },
          readyState: { value: 4, configurable: true },
        })
        this.onloadend?.(new ProgressEvent('loadend'))
      })
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      if (!config.authRetry) {
        throw new AxiosError(
          'Unauthorized',
          'ERR_BAD_REQUEST',
          config,
          undefined,
          {
            data: { message: 'Access token expired' },
            status: 401,
            statusText: 'Unauthorized',
            headers: {},
            config,
          }
        )
      }
      return {
        config,
        data: { success: true },
        status: 200,
        statusText: 'OK',
        headers: {},
      }
    })
    api.defaults.adapter = adapter
    const request = api.request({
      method,
      url: '/api/protected-operation',
      skipErrorHandler: true,
    })
    if (['get', 'head', 'options'].includes(method)) {
      await expect(request).resolves.toMatchObject({ data: { success: true } })
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(adapter).toHaveBeenCalledTimes(2)
      expect(adapter.mock.calls[1][0].headers.get('Authorization')).toBe(
        'Bearer fresh-access'
      )
    } else {
      await expect(request).rejects.toMatchObject({ response: { status: 401 } })
      expect(refresh).not.toHaveBeenCalled()
      expect(adapter).toHaveBeenCalledTimes(1)
      expect(useAuthStore.getState().auth.accessToken).toBe('expired-access')
    }
  }
)

it('does not retry an authentication cancellation in production', async () => {
  vi.stubEnv('DEV', false)
  const client = createAppQueryClient()
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
  })
  const adapter = vi.fn<AxiosAdapter>(async (config) => {
    throw new CanceledError('Authentication changed', config)
  })
  api.defaults.adapter = adapter
  try {
    await expect(
      client.fetchQuery({
        queryKey: ['system-options'],
        queryFn: () => api.get('/api/option/'),
      })
    ).rejects.toMatchObject({ code: 'ERR_CANCELED' })
    expect(adapter).toHaveBeenCalledTimes(1)
  } finally {
    client.clear()
  }
})

it.each([
  ['success', 'session'],
  ['success', 'logout'],
  ['error', 'account'],
  ['success', 'role'],
] as const)(
  'discards a late %s after the initiating %s changes without sharing the old GET',
  async (outcome, change) => {
    const original: AuthBundle = {
      access_token: 'original-access',
      token_type: 'Bearer',
      access_expires_at: 2_000_000_000,
      user: { id: 1, username: 'admin', role: 100 },
      session: {
        sid: 'original-session',
        current: true,
        login_method: 'password',
        ip: '',
        user_agent: '',
        created_at: 1,
        last_active_at: 1,
        expires_at: 2_000_000_000,
      },
    }
    applyAuthBundle(original, false)
    let release: (() => void) | undefined
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      if (config.headers.get('Authorization') === 'Bearer original-access') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        if (outcome === 'error') {
          throw new AxiosError(
            'Original account error',
            'ERR_BAD_RESPONSE',
            config,
            null,
            {
              config,
              data: { message: 'Original account error' },
              status: 500,
              statusText: 'Internal Server Error',
              headers: {},
            }
          )
        }
      }
      return {
        config,
        data: {
          success: true,
          data: config.headers.get('Authorization') || 'anonymous',
        },
        status: 200,
        statusText: 'OK',
        headers: {},
      }
    })
    api.defaults.adapter = adapter
    const first = api.get('/api/user/self')
    const firstOutcome = first.catch((error: unknown) => error)
    await waitFor(() => expect(release).toBeTypeOf('function'))

    if (change === 'logout') {
      clearAuthentication(false)
    } else {
      applyAuthBundle(
        {
          ...original,
          access_token: 'replacement-access',
          user: {
            ...original.user,
            id: change === 'account' ? 2 : 1,
            role: change === 'role' ? 1 : 100,
          },
          session: {
            ...original.session,
            sid:
              change === 'session'
                ? 'replacement-session'
                : original.session.sid,
          },
        },
        false
      )
    }
    const replacement = api.get('/api/user/self')
    const replacementOutcome = replacement.catch((error: unknown) => error)
    release?.()
    expect(await firstOutcome).toMatchObject({ code: 'ERR_CANCELED' })
    expect(replacement).not.toBe(first)
    expect(await replacementOutcome).toMatchObject({
      data: {
        data: change === 'logout' ? 'anonymous' : 'Bearer replacement-access',
      },
    })
    expect(adapter).toHaveBeenCalledTimes(2)
  }
)
