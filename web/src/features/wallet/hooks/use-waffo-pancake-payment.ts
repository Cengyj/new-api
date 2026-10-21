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

import { requestWaffoPancakePayment, isApiSuccess } from '../api'
import { getPaymentErrorTranslation } from '../lib'
import { isSafePaymentUrl, isValidTopupAmount } from '../lib/payment'
import { usePaymentOperation } from './use-payment-operation'

export function useWaffoPancakePayment() {
  const { processing, runPayment } = usePaymentOperation()
  const processWaffoPancakePayment = useCallback(
    async (topupAmount: number) => {
      if (!isValidTopupAmount(topupAmount)) {
        toast.error(i18next.t('Invalid top-up amount'))
        return false
      }
      return runPayment(
        (signal) => requestWaffoPancakePayment({ amount: topupAmount }, signal),
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
              ? response.data.checkout_url
              : undefined
          if (!isSafePaymentUrl(url)) {
            toast.error(i18next.t('Invalid payment redirect URL'))
            return false
          }
          toast.success(i18next.t('Redirecting to payment page...'))
          window.location.href = url
          return true
        }
      )
    },
    [runPayment]
  )
  return { processing, processWaffoPancakePayment }
}
