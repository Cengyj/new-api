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

// Allow slow checkout receipts without trapping the payer in confirmation.
const CHECKOUT_RECEIPT_TIMEOUT_MS = 10 * 60_000
const DETACHED_RECEIPT_TIMEOUT_MS = 5 * 60_000

function getCheckoutReview(sources: ReturnType<typeof getServerErrorSources>) {
  for (const source of sources) {
    if (
      source.message_key ===
      'Payment request result is unknown. Check Order History before trying again.'
    ) {
      return { unknown: true, tradeNo: source.trade_no }
    }
    if (
      source.success === false &&
      source.message_key ===
        'Payment was not started. Check order {{trade_no}} in Order History.'
    ) {
      const params = source.message_params
      if (params && typeof params === 'object' && 'trade_no' in params) {
        return { unknown: false, tradeNo: params.trade_no }
      }
    }
  }
}

// A lost response does not cancel an order already created by the server.
// Prevent concurrent submissions and discard delivery after payer changes.
export function usePaymentOperation(
  onReviewCheckout?: (tradeNo?: string) => void
) {
  const [processing, setProcessing] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const onLeave = useRef<(() => void) | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      onLeave.current?.()
    }
  }, [])

  const runPayment = useCallback(
    async <T>(
      request: (signal: AbortSignal, onDispatch: () => void) => Promise<T>,
      handleResponse: (response: T) => boolean
    ): Promise<boolean> => {
      if (pending.current || !mounted.current) return false
      pending.current = true
      setProcessing(true)
      const controller = new AbortController()
      // Release the wallet even if a suspended request does not reject on abort.
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(controller.signal.reason),
          { once: true }
        )
      })
      let dispatched = false
      let receiptTimer = setTimeout(
        () =>
          controller.abort(
            new DOMException('Checkout receipt timed out', 'TimeoutError')
          ),
        CHECKOUT_RECEIPT_TIMEOUT_MS
      )
      onLeave.current = () => {
        clearTimeout(receiptTimer)
        if (dispatched) {
          receiptTimer = setTimeout(
            () => controller.abort(),
            DETACHED_RECEIPT_TIMEOUT_MS
          )
        } else {
          controller.abort()
        }
      }
      const auth = useAuthStore.getState().auth
      let changed = false
      let unresolvedOrder: unknown
      let checkHistory = false
      let attempt: string | undefined
      let resolved = false
      const unsubscribe = useAuthStore.subscribe((state) => {
        if (
          state.auth.user?.id !== auth.user?.id ||
          state.auth.user?.role !== auth.user?.role ||
          state.auth.session?.sid !== auth.session?.sid
        ) {
          changed = true
          // Axios runs its auth interceptor asynchronously. Cancel a queued
          // request before it can use the next account's credentials.
          controller.abort()
        }
      })
      try {
        const receipt = request(controller.signal, () => {
          dispatched = true
          if (auth.user?.id) {
            const nonce = Array.from(
              crypto.getRandomValues(new Uint8Array(16)),
              (byte) => byte.toString(16).padStart(2, '0')
            ).join('')
            attempt = `~${Date.now()}-${nonce}`
            usePaymentRecoveryStore
              .getState()
              .remember(auth.user.id, attempt, { awaitingReceipt: true })
          }
        })
        const response = await Promise.race([receipt, aborted])
        if (changed) return false
        const sources = getServerErrorSources(response)
        const review = getCheckoutReview(sources)
        // Capture the reference before browser navigation, which can throw
        // even when the server successfully created the checkout.
        const checkout = sources.find(
          (source) => source.success === true || source.message === 'success'
        )
        const data = checkout?.data
        let tradeNo = review?.tradeNo
        if (!tradeNo && data && typeof data === 'object') {
          if ('order_id' in data) tradeNo = data.order_id
          else if ('out_trade_no' in data) tradeNo = data.out_trade_no
        }
        unresolvedOrder = tradeNo
        const declined =
          !review?.unknown &&
          !checkout &&
          sources.some((s) => s.success === false || s.message === 'error')
        resolved = declined
        // A receipt may arrive as its payer leaves the wallet. Retain the
        // reference for that payer, but only a current session can navigate.
        if (!mounted.current) return false
        // A proxy can return a document instead of the checkout receipt after
        // the order was created. Only a recognized decline is safe to present as one.
        if (review?.unknown || (!checkout && !declined)) {
          checkHistory = true
          handleServerError(response, undefined, {
            title: i18next.t(
              'Payment request result is unknown. Check Order History before trying again.'
            ),
          })
          return false
        }
        const completed = handleResponse(response)
        if (completed) {
          unresolvedOrder = undefined
          resolved = true
        }
        checkHistory = !completed && !!checkout
        return completed
      } catch (error) {
        if (changed) return false
        const review = getCheckoutReview(getServerErrorSources(error))
        if (review) unresolvedOrder = review.tradeNo
        resolved = review ? !review.unknown : hasPaymentDeclineResponse(error)
        if (!mounted.current) return false
        if (resolved) {
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
        clearTimeout(receiptTimer)
        onLeave.current = null
        pending.current = false
        if (mounted.current) setProcessing(false)
        if (!changed && auth.user?.id) {
          if (
            typeof unresolvedOrder === 'string' &&
            /^[a-zA-Z0-9_-]{1,128}$/.test(unresolvedOrder)
          ) {
            resolved = usePaymentRecoveryStore
              .getState()
              .remember(auth.user.id, unresolvedOrder, {
                replacesAttempt: attempt,
              })
            if (mounted.current) onReviewCheckout?.(unresolvedOrder)
          } else if (checkHistory && mounted.current) {
            onReviewCheckout?.()
          }
        }
        if (attempt && auth.user?.id) {
          const recovery = usePaymentRecoveryStore.getState()
          if (resolved) {
            recovery.resolve(auth.user.id, [attempt])
          } else {
            recovery.restore(auth.user.id, { dispatched: attempt })
          }
        }
      }
    },
    [onReviewCheckout]
  )

  return { processing, runPayment }
}
