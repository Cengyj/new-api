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
import { isSafePaymentUrl, isValidTopupAmount } from '../lib/payment'
import type { WaffoPayMethod } from '../types'
import { usePaymentOperation } from './use-payment-operation'

export function useWaffoPayment() {
  const { processing, runPayment } = usePaymentOperation()
  const processWaffoPayment = useCallback(
    async (
      topupAmount: number,
      payMethodIndex?: number,
      payMethod?: Pick<WaffoPayMethod, 'payMethodType' | 'payMethodName'>
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
        (signal) =>
          requestWaffoPayment(
            {
              amount: topupAmount,
              pay_method_index: payMethodIndex,
              ...(payMethod && {
                pay_method_type: payMethod.payMethodType ?? '',
                pay_method_name: payMethod.payMethodName ?? '',
              }),
            },
            signal
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
          const url =
            response.data && typeof response.data === 'object'
              ? response.data.payment_url
              : undefined
          if (!isSafePaymentUrl(url, true)) {
            toast.error(i18next.t('Invalid payment redirect URL'))
            return false
          }
          window.open(url, '_blank', 'noopener,noreferrer')
          toast.success(i18next.t('Redirecting to payment page...'))
          return true
        }
      )
    },
    [runPayment]
  )
  return { processing, processWaffoPayment }
}
