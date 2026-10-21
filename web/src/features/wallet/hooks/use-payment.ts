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
import { useState, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'

import { handleServerError } from '@/lib/handle-server-error'
import { useAuthStore } from '@/stores/auth-store'

import {
  calculateAmount,
  calculateStripeAmount,
  calculateWaffoAmount,
  calculateWaffoPancakeAmount,
  requestPayment,
  requestStripePayment,
  isApiSuccess,
} from '../api'
import {
  isStripePayment,
  isWaffoPayment,
  isWaffoPancakePayment,
  submitPaymentForm,
} from '../lib'
import { isSafePaymentUrl, isValidTopupAmount } from '../lib/payment'
import type { AmountRequest, AmountResponse, PaymentResponse } from '../types'
import { usePaymentOperation } from './use-payment-operation'

type AmountCalculator = (request: AmountRequest) => Promise<AmountResponse>
export interface PaymentAmountCalculators {
  regular: AmountCalculator
  stripe: AmountCalculator
  waffo: AmountCalculator
  waffoPancake: AmountCalculator
}
const defaultPaymentAmountCalculators: PaymentAmountCalculators = {
  regular: calculateAmount,
  stripe: calculateStripeAmount,
  waffo: calculateWaffoAmount,
  waffoPancake: calculateWaffoPancakeAmount,
}
export async function requestPaymentAmount(
  topupAmount: number,
  paymentType: string,
  calculators: PaymentAmountCalculators = defaultPaymentAmountCalculators
): Promise<number> {
  if (!isValidTopupAmount(topupAmount)) return 0
  let calculator = calculators.regular
  if (isStripePayment(paymentType)) calculator = calculators.stripe
  else if (isWaffoPayment(paymentType)) calculator = calculators.waffo
  else if (isWaffoPancakePayment(paymentType)) {
    calculator = calculators.waffoPancake
  }
  const response = await calculator({ amount: topupAmount })
  if (!isApiSuccess(response) || !response.data) return 0
  const amount = Number(response.data)
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}

export function usePayment() {
  const [amount, setAmount] = useState(0)
  const [calculating, setCalculating] = useState(false)
  const { processing, runPayment } = usePaymentOperation()
  const quoteVersion = useRef(0)
  useEffect(() => {
    let auth = useAuthStore.getState().auth
    const unsubscribe = useAuthStore.subscribe((state) => {
      if (
        state.auth.user?.id !== auth.user?.id ||
        state.auth.session?.sid !== auth.session?.sid
      ) {
        quoteVersion.current += 1
        setAmount(0)
        setCalculating(false)
      }
      auth = state.auth
    })
    return () => {
      quoteVersion.current += 1
      unsubscribe()
    }
  }, [])

  const calculatePaymentAmount = useCallback(
    async (topupAmount: number, paymentType: string) => {
      const version = ++quoteVersion.current
      setAmount(0)
      setCalculating(true)
      try {
        const calculated = await requestPaymentAmount(topupAmount, paymentType)
        if (version !== quoteVersion.current) return 0
        setAmount(calculated)
        return calculated
      } catch {
        if (version === quoteVersion.current) setAmount(0)
        return 0
      } finally {
        if (version === quoteVersion.current) setCalculating(false)
      }
    },
    []
  )

  const processPayment = useCallback(
    async (topupAmount: number, paymentType: string) => {
      if (!isValidTopupAmount(topupAmount)) {
        toast.error(i18next.t('Invalid top-up amount'))
        return false
      }
      const stripe = isStripePayment(paymentType)
      return runPayment<PaymentResponse>(
        (signal) =>
          stripe
            ? requestStripePayment(
                {
                  amount: topupAmount,
                  payment_method: 'stripe',
                },
                signal
              )
            : requestPayment(
                {
                  amount: topupAmount,
                  payment_method: paymentType,
                },
                signal
              ),
        (response) => {
          if (!isApiSuccess(response)) {
            handleServerError(response, i18next.t('Payment request failed'))
            return false
          }
          const url = stripe
            ? response.data?.pay_link
            : (response as { url?: string }).url
          if (!isSafePaymentUrl(url)) {
            toast.error(i18next.t('Invalid payment redirect URL'))
            return false
          }
          if (stripe) {
            window.open(url, '_blank', 'noopener,noreferrer')
          } else if (response.data && typeof response.data === 'object') {
            submitPaymentForm(url, response.data)
          } else {
            toast.error(
              i18next.t(
                'Payment request result is unknown. Check Order History before trying again.'
              )
            )
            return false
          }
          toast.success(i18next.t('Redirecting to payment page...'))
          return true
        }
      )
    },
    [runPayment]
  )

  return {
    amount,
    calculating,
    processing,
    calculatePaymentAmount,
    processPayment,
    setAmount,
  }
}
