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
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

test('a new invitation survives a failed storage write instead of submitting the previous code', async () => {
  localStorage.setItem('aff', 'previous-inviter')
  const { getAffiliateCode, saveAffiliateCode } = await import('../storage')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage full', 'QuotaExceededError')
  })

  saveAffiliateCode('current-inviter')

  expect(getAffiliateCode()).toBe('current-inviter')
})

test('an invitation remains available to registration when browser storage is unavailable', async () => {
  const { getAffiliateCode, saveAffiliateCode } = await import('../storage')
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new DOMException('Storage blocked', 'SecurityError')
  })

  saveAffiliateCode('current-inviter')

  expect(getAffiliateCode()).toBe('current-inviter')
})

test('healthy storage still follows invitation changes and removal from another tab', async () => {
  const { getAffiliateCode, saveAffiliateCode } = await import('../storage')
  saveAffiliateCode('first-inviter')
  localStorage.setItem('aff', 'second-inviter')
  expect(getAffiliateCode()).toBe('second-inviter')

  localStorage.removeItem('aff')
  expect(getAffiliateCode()).toBe('')
})

test.each(['second-inviter', null])(
  'a later storage read failure preserves the last observed invitation %s',
  async (latest) => {
    const { getAffiliateCode, saveAffiliateCode } = await import('../storage')
    saveAffiliateCode('first-inviter')
    if (latest === null) localStorage.removeItem('aff')
    else localStorage.setItem('aff', latest)
    expect(getAffiliateCode()).toBe(latest ?? '')

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })

    expect(getAffiliateCode()).toBe(latest ?? '')
  }
)

test('a later successful save recovers persistent invitation reads after a write failure', async () => {
  const { getAffiliateCode, saveAffiliateCode } = await import('../storage')
  const write = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new DOMException('Storage full', 'QuotaExceededError')
    })
  saveAffiliateCode('first-inviter')
  write.mockRestore()

  saveAffiliateCode('second-inviter')
  localStorage.setItem('aff', 'third-inviter')

  expect(getAffiliateCode()).toBe('third-inviter')
})

test.each(['login', 'bind', 'verify'] as const)(
  'OAuth %s only includes the current invitation when creating a login flow',
  async (intent) => {
    localStorage.setItem('aff', 'previous-inviter')
    const { saveAffiliateCode } = await import('../storage')
    const { createOAuthAuthorization } = await import('../../api')
    const { api } = await import('@/lib/api')
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { success: true, data: 'flow-token' },
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage full', 'QuotaExceededError')
    })
    saveAffiliateCode('current-inviter')

    await createOAuthAuthorization('github', intent)

    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/api/oauth/state',
      {
        provider: 'github',
        intent,
        aff: intent === 'login' ? 'current-inviter' : undefined,
        scope: undefined,
      },
      expect.objectContaining({
        skipAuthRefresh: intent === 'login',
        singleUseAuthorization: intent === 'bind',
      })
    )
  }
)
