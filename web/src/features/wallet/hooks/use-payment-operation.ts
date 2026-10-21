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
import { isAxiosError } from 'axios'
import i18next from 'i18next'
import { useCallback, useEffect, useRef, useState } from 'react'

import { handleServerError } from '@/lib/handle-server-error'
import { useAuthStore } from '@/stores/auth-store'

// A lost response does not cancel an order already created by the server.
// Prevent concurrent submissions and discard delivery after payer changes.
export function usePaymentOperation() {
  const [processing, setProcessing] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const activeController = useRef<AbortController | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeController.current?.abort()
    }
  }, [])

  const runPayment = useCallback(
    async <T>(
      request: (signal: AbortSignal) => Promise<T>,
      handleResponse: (response: T) => boolean
    ): Promise<boolean> => {
      if (pending.current || !mounted.current) return false
      pending.current = true
      setProcessing(true)
      const controller = new AbortController()
      activeController.current = controller
      const auth = useAuthStore.getState().auth
      let changed = false
      const unsubscribe = useAuthStore.subscribe((state) => {
        if (
          state.auth.user?.id !== auth.user?.id ||
          state.auth.session?.sid !== auth.session?.sid
        ) {
          changed = true
          // Axios runs its auth interceptor asynchronously. Cancel a queued
          // request before it can use the next account's credentials.
          controller.abort()
        }
      })
      try {
        const response = await request(controller.signal)
        if (!mounted.current || changed) return false
        // Keep delivery synchronous with the identity check: an await between
        // checking the payer and opening checkout allows another account to win.
        return handleResponse(response)
      } catch (error) {
        if (!mounted.current || changed) return false
        const status = isAxiosError(error) ? error.response?.status : undefined
        if (status !== undefined && status >= 400 && status < 500) {
          handleServerError(error, i18next.t('Payment request failed'))
        } else {
          handleServerError(error, undefined, {
            title: i18next.t(
              'Payment request result is unknown. Check Order History before trying again.'
            ),
          })
        }
        return false
      } finally {
        unsubscribe()
        activeController.current = null
        pending.current = false
        if (mounted.current) setProcessing(false)
      }
    },
    []
  )

  return { processing, runPayment }
}
