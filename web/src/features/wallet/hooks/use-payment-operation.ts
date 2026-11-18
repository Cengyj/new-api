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
import i18next from 'i18next'
import { useCallback, useEffect, useRef, useState } from 'react'

import { handleServerError } from '@/lib/handle-server-error'
import { getServerErrorSources } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'
import { usePaymentRecoveryStore } from '@/stores/payment-recovery-store'

import { hasPaymentDeclineResponse } from '../lib/payment'

function isUnknownCheckout(source: Record<string | symbol, unknown>): boolean {
  return (
    source.message_key ===
    'Payment request result is unknown. Check Order History before trying again.'
  )
}

// A lost response does not cancel an order already created by the server.
// Prevent concurrent submissions and discard delivery after payer changes.
export function usePaymentOperation(
  onUnknownCheckout?: (tradeNo?: string) => void
) {
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
      let unresolvedOrder: unknown
      let checkHistory = false
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
        const sources = getServerErrorSources(response)
        const unknownOrder = sources.find(isUnknownCheckout)
        // Capture the reference before browser navigation, which can throw
        // even when the server successfully created the checkout.
        const checkout = sources.find(
          (source) => source.success === true || source.message === 'success'
        )
        const data = checkout?.data
        let tradeNo = unknownOrder?.trade_no
        if (!tradeNo && data && typeof data === 'object') {
          if ('order_id' in data) tradeNo = data.order_id
          else if ('out_trade_no' in data) tradeNo = data.out_trade_no
        }
        unresolvedOrder = tradeNo
        // A proxy can return a document instead of the checkout receipt after
        // the order was created. Only a recognized decline is safe to present as one.
        if (
          unknownOrder ||
          (!checkout &&
            !sources.some((s) => s.success === false || s.message === 'error'))
        ) {
          checkHistory = true
          handleServerError(response, undefined, {
            title: i18next.t(
              'Payment request result is unknown. Check Order History before trying again.'
            ),
          })
          return false
        }
        const completed = handleResponse(response)
        if (completed) unresolvedOrder = undefined
        checkHistory = !completed && !!checkout
        return completed
      } catch (error) {
        if (!mounted.current || changed) return false
        const unknownOrder =
          getServerErrorSources(error).find(isUnknownCheckout)
        if (unknownOrder) unresolvedOrder = unknownOrder.trade_no
        if (!unknownOrder && hasPaymentDeclineResponse(error)) {
          handleServerError(error, i18next.t('Payment request failed'))
        } else {
          checkHistory = true
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
        if (mounted.current && !changed && auth.user?.id) {
          if (
            typeof unresolvedOrder === 'string' &&
            /^[a-zA-Z0-9_-]{1,128}$/.test(unresolvedOrder)
          ) {
            usePaymentRecoveryStore
              .getState()
              .remember(auth.user.id, unresolvedOrder)
            onUnknownCheckout?.(unresolvedOrder)
          } else if (checkHistory) {
            onUnknownCheckout?.()
          }
        }
      }
    },
    [onUnknownCheckout]
  )

  return { processing, runPayment }
}
