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
import { useCallback } from 'react'
import { toast } from 'sonner'

import { handleServerError } from '@/lib/handle-server-error'

import { requestWaffoPayment, isApiSuccess } from '../api'
import { getPaymentErrorTranslation } from '../lib'
import {
  isSafePaymentUrl,
  isValidTopupAmount,
  navigateToPayment,
} from '../lib/payment'
import type { WaffoPayMethod } from '../types'
import { usePaymentOperation } from './use-payment-operation'

export function useWaffoPayment(onReviewCheckout?: (tradeNo?: string) => void) {
  const { processing, runPayment } = usePaymentOperation(onReviewCheckout)
  const processWaffoPayment = useCallback(
    async (
      topupAmount: number,
      payMethodIndex?: number,
      payMethod?: Pick<WaffoPayMethod, 'payMethodType' | 'payMethodName'>,
      onAppLink?: (url: string, orderId?: string) => void
    ) => {
      if (!isValidTopupAmount(topupAmount)) {
        toast.error(i18next.t('Invalid top-up amount'))
        return false
      }
      if (
        payMethodIndex !== undefined &&
        (!Number.isSafeInteger(payMethodIndex) || payMethodIndex < 0)
      ) {
        return false
      }
      return runPayment(
        (signal, onDispatch) =>
          requestWaffoPayment(
            {
              amount: topupAmount,
              pay_method_index: payMethodIndex,
              ...(payMethod && {
                pay_method_type: payMethod.payMethodType ?? '',
                pay_method_name: payMethod.payMethodName ?? '',
              }),
            },
            signal,
            onDispatch
          ),
        (response) => {
          if (!isApiSuccess(response)) {
            const message =
              typeof response.data === 'string' && response.data.trim()
                ? response.data
                : response.message
            handleServerError(response, undefined, {
              title:
                getPaymentErrorTranslation(response) ??
                (message && message !== 'success'
                  ? message
                  : i18next.t('Payment request failed')),
            })
            return false
          }
          const checkout =
            typeof response.data === 'object' ? response.data : undefined
          const url = checkout?.payment_url
          if (!isSafePaymentUrl(url, true)) {
            toast.error(i18next.t('Invalid payment redirect URL'))
            return false
          }
          if (!isSafePaymentUrl(url)) {
            if (!onAppLink) return false
            onAppLink(url, checkout?.order_id)
            return true
          }
          navigateToPayment(url)
          toast.success(i18next.t('Redirecting to payment page...'))
          return true
        }
      )
    },
    [runPayment]
  )
  return { processing, processWaffoPayment }
}
