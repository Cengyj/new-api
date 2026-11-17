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
  sessionStorage.clear()
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

test('empty readable invitation storage allows registration and OAuth login without an invitation', async () => {
  const { getAffiliateCode } = await import('../storage')
  const { register, createOAuthAuthorization } = await import('../../api')
  const { api } = await import('@/lib/api')
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: 'flow-token' },
  })

  await register({
    username: 'invitee',
    password: 'registration-password',
    aff_code: getAffiliateCode(),
  })
  await createOAuthAuthorization('github', 'login')

  expect(post).toHaveBeenCalledTimes(2)
  expect(post.mock.calls[0][1]).toMatchObject({ aff_code: '' })
  expect(post.mock.calls[1][1]).toMatchObject({ aff: undefined })
})

test.each(['getter', 'getItem'] as const)(
  'an initial durable invitation %s failure blocks registration and OAuth until the saved invitation is readable',
  async (failure) => {
    localStorage.setItem('aff', 'intended-inviter')
    const { getAffiliateCode } = await import('../storage')
    const { register, createOAuthAuthorization } = await import('../../api')
    const { api } = await import('@/lib/api')
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { success: true, data: 'flow-token' },
    })
    const durable = localStorage
    const originalRead = Storage.prototype.getItem
    const read =
      failure === 'getter'
        ? vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
            throw new DOMException('Storage blocked', 'SecurityError')
          })
        : vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
            this: Storage,
            key
          ) {
            if (this === durable && key === 'aff') {
              throw new DOMException('Storage blocked', 'SecurityError')
            }
            return originalRead.call(this, key)
          })

    expect(() =>
      register({
        username: 'invitee',
        password: 'registration-password',
        aff_code: getAffiliateCode(),
      })
    ).toThrow(
      'Unable to read your invitation information. Allow browser storage or reopen your invitation link, then try again.'
    )
    await expect(createOAuthAuthorization('github', 'login')).rejects.toThrow(
      'Unable to read your invitation information. Allow browser storage or reopen your invitation link, then try again.'
    )
    expect(post).not.toHaveBeenCalled()

    read.mockRestore()
    await register({
      username: 'invitee',
      password: 'registration-password',
      aff_code: getAffiliateCode(),
    })
    await createOAuthAuthorization('github', 'login')
    expect(post.mock.calls[0][1]).toMatchObject({
      aff_code: 'intended-inviter',
    })
    expect(post.mock.calls[1][1]).toMatchObject({ aff: 'intended-inviter' })
  }
)

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

test('a failed invitation write survives navigation and reload without restoring the previous inviter', async () => {
  localStorage.setItem('aff', 'previous-inviter')
  const { saveAffiliateCode } = await import('../storage')
  const originalWrite = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key,
    value
  ) {
    if (this === localStorage && key === 'aff') {
      throw new DOMException('Storage full', 'QuotaExceededError')
    }
    originalWrite.call(this, key, value)
  })
  saveAffiliateCode('current-inviter')

  vi.resetModules()
  const { getAffiliateCode } = await import('../storage')
  expect(getAffiliateCode()).toBe('current-inviter')
  expect(localStorage.getItem('aff')).toBeNull()
})

test.each(['getter', 'getItem'] as const)(
  'an initial session storage %s failure blocks registration and OAuth login until the original invitation can be recovered',
  async (failure) => {
    localStorage.setItem('aff', 'previous-inviter')
    const { saveAffiliateCode } = await import('../storage')
    const localRead = vi
      .spyOn(window, 'localStorage', 'get')
      .mockImplementation(() => {
        throw new DOMException('Storage blocked', 'SecurityError')
      })
    saveAffiliateCode('current-inviter')
    localRead.mockRestore()

    vi.resetModules()
    const { getAffiliateCode } = await import('../storage')
    const { register, createOAuthAuthorization } = await import('../../api')
    const { AuthOperationError } = await import('@/lib/secure-verification')
    const { api } = await import('@/lib/api')
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { success: true, data: 'flow-token' },
    })
    const savedSession = sessionStorage
    const originalRead = Storage.prototype.getItem
    const read =
      failure === 'getter'
        ? vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
            throw new DOMException('Storage blocked', 'SecurityError')
          })
        : vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
            this: Storage,
            key
          ) {
            if (this === savedSession) {
              throw new DOMException('Storage blocked', 'SecurityError')
            }
            return originalRead.call(this, key)
          })

    // Signup reads the invitation while constructing its registration request.
    expect(() =>
      register({
        username: 'invitee',
        password: 'registration-password',
        aff_code: getAffiliateCode(),
      })
    ).toThrow(AuthOperationError)
    await expect(
      createOAuthAuthorization('github', 'login')
    ).rejects.toMatchObject({
      name: 'AuthOperationError',
      message:
        'Unable to read your invitation information. Allow browser storage or reopen your invitation link, then try again.',
    })
    expect(post).not.toHaveBeenCalled()

    read.mockRestore()
    await register({
      username: 'invitee',
      password: 'registration-password',
      aff_code: getAffiliateCode(),
    })
    await createOAuthAuthorization('github', 'login')

    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0][1]).toMatchObject({ aff_code: 'current-inviter' })
    expect(post.mock.calls[1][1]).toMatchObject({ aff: 'current-inviter' })
  }
)

test('an unreadable session store blocks a local-only invitation until an explicit fresh invitation is saved', async () => {
  localStorage.setItem('aff', 'previous-inviter')
  const { getAffiliateCode, saveAffiliateCode } = await import('../storage')
  const { register, createOAuthAuthorization } = await import('../../api')
  const { api } = await import('@/lib/api')
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: 'flow-token' },
  })
  vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
    throw new DOMException('Storage blocked', 'SecurityError')
  })

  expect(() =>
    register({
      username: 'invitee',
      password: 'registration-password',
      aff_code: getAffiliateCode(),
    })
  ).toThrow(
    'Unable to read your invitation information. Allow browser storage or reopen your invitation link, then try again.'
  )
  await expect(createOAuthAuthorization('github', 'login')).rejects.toThrow(
    'Unable to read your invitation information. Allow browser storage or reopen your invitation link, then try again.'
  )
  expect(post).not.toHaveBeenCalled()

  saveAffiliateCode('current-inviter')
  await register({
    username: 'invitee',
    password: 'registration-password',
    aff_code: getAffiliateCode(),
  })
  await createOAuthAuthorization('github', 'login')

  expect(post).toHaveBeenCalledTimes(2)
  expect(post.mock.calls[0][1]).toMatchObject({ aff_code: 'current-inviter' })
  expect(post.mock.calls[1][1]).toMatchObject({ aff: 'current-inviter' })
})

test.each(['bind', 'verify'] as const)(
  'OAuth %s does not read an unavailable invitation store',
  async (intent) => {
    const { createOAuthAuthorization } = await import('../../api')
    const { api } = await import('@/lib/api')
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { success: true, data: 'flow-token' },
    })
    const read = vi
      .spyOn(window, 'sessionStorage', 'get')
      .mockImplementation(() => {
        throw new DOMException('Storage blocked', 'SecurityError')
      })

    await createOAuthAuthorization('github', intent)

    expect(read).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/api/oauth/state',
      { provider: 'github', intent, aff: undefined, scope: undefined },
      expect.objectContaining({
        skipAuthRefresh: false,
        singleUseAuthorization: intent === 'bind',
      })
    )
  }
)

test.each(['another-inviter', null])(
  'a saved invitation fallback yields to another tab changing the old durable value to %s',
  async (latest) => {
    localStorage.setItem('aff', 'previous-inviter')
    const { saveAffiliateCode } = await import('../storage')
    const originalWrite = Storage.prototype.setItem
    const originalRemove = Storage.prototype.removeItem
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key, value) {
        if (this === localStorage) throw new Error('Storage is read-only')
        originalWrite.call(this, key, value)
      })
    const remove = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(function (this: Storage, key) {
        if (this === localStorage) throw new Error('Storage is read-only')
        originalRemove.call(this, key)
      })
    saveAffiliateCode('current-inviter')
    write.mockRestore()
    remove.mockRestore()
    if (latest === null) localStorage.removeItem('aff')
    else localStorage.setItem('aff', latest)

    vi.resetModules()
    const { getAffiliateCode } = await import('../storage')
    expect(getAffiliateCode()).toBe(latest ?? '')
  }
)

test.each([
  { latest: 'another-inviter', reload: false },
  { latest: null, reload: false },
  { latest: 'another-inviter', reload: true },
  { latest: null, reload: true },
])(
  'after storage access resumes, invitation changes to $latest remain visible with reload=$reload',
  async ({ latest, reload }) => {
    localStorage.setItem('aff', 'previous-inviter')
    const storage = await import('../storage')
    const blocked = vi
      .spyOn(window, 'localStorage', 'get')
      .mockImplementation(() => {
        throw new DOMException('Storage blocked', 'SecurityError')
      })
    storage.saveAffiliateCode('current-inviter')
    blocked.mockRestore()
    expect(storage.getAffiliateCode()).toBe('current-inviter')

    if (latest === null) localStorage.removeItem('aff')
    else localStorage.setItem('aff', latest)
    if (reload) vi.resetModules()
    const recovered = await import('../storage')
    expect(recovered.getAffiliateCode()).toBe(latest ?? '')
  }
)

test('a healthy save supersedes an earlier fallback even if removing the fallback fails', async () => {
  localStorage.setItem('aff', 'previous-inviter')
  const { saveAffiliateCode } = await import('../storage')
  const originalWrite = Storage.prototype.setItem
  const write = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage) throw new Error('Storage full')
      originalWrite.call(this, key, value)
    })
  saveAffiliateCode('failed-write-inviter')
  write.mockRestore()
  const originalRemove = Storage.prototype.removeItem
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
    this: Storage,
    key
  ) {
    if (this === sessionStorage) throw new Error('Storage cleanup failed')
    originalRemove.call(this, key)
  })
  saveAffiliateCode('previous-inviter')

  vi.resetModules()
  const { getAffiliateCode } = await import('../storage')
  expect(getAffiliateCode()).toBe('previous-inviter')
  localStorage.setItem('aff', 'another-inviter')
  expect(getAffiliateCode()).toBe('another-inviter')
})

test('failure of both invitation writes keeps page memory and removes the previous durable inviter', async () => {
  localStorage.setItem('aff', 'previous-inviter')
  const { saveAffiliateCode, getAffiliateCode } = await import('../storage')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage full', 'QuotaExceededError')
  })
  saveAffiliateCode('current-inviter')

  expect(getAffiliateCode()).toBe('current-inviter')
  expect(localStorage.getItem('aff')).toBeNull()
  vi.resetModules()
  const reloaded = await import('../storage')
  expect(reloaded.getAffiliateCode()).toBe('')
})

test('a failed replacement of the session fallback cannot restore the previous invitation after reload', async () => {
  const storage = await import('../storage')
  const originalWrite = Storage.prototype.setItem
  const write = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage) {
        throw new DOMException('Storage full', 'QuotaExceededError')
      }
      originalWrite.call(this, key, value)
    })
  storage.saveAffiliateCode('previous-inviter')
  expect(storage.getAffiliateCode()).toBe('previous-inviter')

  write.mockImplementation(() => {
    throw new DOMException('Storage full', 'QuotaExceededError')
  })
  storage.saveAffiliateCode('current-inviter')
  expect(storage.getAffiliateCode()).toBe('current-inviter')

  vi.resetModules()
  const reloaded = await import('../storage')
  expect(reloaded.getAffiliateCode()).toBe('')
})

test.each([
  { fallback: '{', readFailure: false },
  { fallback: '{', readFailure: true },
  {
    fallback: '{"code":42,"storedCode":"previous-inviter"}',
    readFailure: false,
  },
  {
    fallback: '{"code":42,"storedCode":"previous-inviter"}',
    readFailure: true,
  },
])(
  'a damaged invitation fallback $fallback blocks registration until repaired after readFailure=$readFailure',
  async ({ fallback, readFailure }) => {
    localStorage.setItem('aff', 'previous-inviter')
    sessionStorage.setItem('new-api:affiliate-code:fallback:v1', fallback)
    let storage = await import('../storage')
    if (readFailure) {
      const read = vi
        .spyOn(window, 'sessionStorage', 'get')
        .mockImplementation(() => {
          throw new DOMException('Storage blocked', 'SecurityError')
        })
      expect(() => storage.getAffiliateCode()).toThrow(
        'Unable to read your invitation information. Allow browser storage or reopen your invitation link, then try again.'
      )
      read.mockRestore()
    }
    const { register, createOAuthAuthorization } = await import('../../api')
    const { api } = await import('@/lib/api')
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { success: true, data: 'flow-token' },
    })
    expect(() =>
      register({
        username: 'invitee',
        password: 'registration-password',
        aff_code: storage.getAffiliateCode(),
      })
    ).toThrow('Unable to read your invitation information.')
    await expect(createOAuthAuthorization('github', 'login')).rejects.toThrow(
      'Unable to read your invitation information.'
    )
    expect(post).not.toHaveBeenCalled()

    await createOAuthAuthorization('github', 'bind')
    await createOAuthAuthorization('github', 'verify')
    expect(post.mock.calls.map(([, data]) => data)).toEqual([
      expect.objectContaining({ intent: 'bind', aff: undefined }),
      expect.objectContaining({ intent: 'verify', aff: undefined }),
    ])

    vi.resetModules()
    storage = await import('../storage')
    expect(() => storage.getAffiliateCode()).toThrow(
      'Unable to read your invitation information.'
    )
    expect(() => storage.getAffiliateCode()).toThrow(
      'Unable to read your invitation information.'
    )

    localStorage.setItem('aff', 'another-inviter')
    expect(storage.getAffiliateCode()).toBe('another-inviter')

    storage.saveAffiliateCode('current-inviter')
    vi.resetModules()
    const reloaded = await import('../storage')
    expect(reloaded.getAffiliateCode()).toBe('current-inviter')
  }
)

test.each(['recovered-inviter', ''])(
  'a damaged fallback recovers from a repaired invitation %s without a reload',
  async (code) => {
    localStorage.setItem('aff', 'previous-inviter')
    sessionStorage.setItem('new-api:affiliate-code:fallback:v1', '{')
    const { getAffiliateCode } = await import('../storage')
    expect(() => getAffiliateCode()).toThrow(
      'Unable to read your invitation information.'
    )

    sessionStorage.setItem(
      'new-api:affiliate-code:fallback:v1',
      JSON.stringify({ code, storedCode: 'previous-inviter' })
    )
    expect(getAffiliateCode()).toBe(code)

    sessionStorage.setItem('new-api:affiliate-code:fallback:v1', '{')
    vi.resetModules()
    const reloaded = await import('../storage')
    expect(() => reloaded.getAffiliateCode()).toThrow(
      'Unable to read your invitation information.'
    )
    reloaded.saveAffiliateCode(code)
    expect(reloaded.getAffiliateCode()).toBe(code)
  }
)

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
