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
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { toIntlLocale } from '@/i18n/languages'
import { formatLocalCurrencyAmount, getCurrencyDisplay } from '@/lib/currency'
import { formatNumber } from '@/lib/format'

import { DEFAULT_DISCOUNT_RATE } from '../../constants'
import { formatCurrency, getPaymentIcon } from '../../lib'
import { isStripePayment, isValidTopupAmount } from '../../lib/payment'
import type { PaymentMethod } from '../../types'

interface PaymentConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  topupAmount: number
  paymentAmount: number
  paymentMethod: PaymentMethod | undefined
  calculating: boolean
  processing: boolean
  discountRate?: number
  usdExchangeRate?: number
}

export function PaymentConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  topupAmount,
  paymentAmount,
  paymentMethod,
  calculating,
  processing,
  discountRate = DEFAULT_DISCOUNT_RATE,
  usdExchangeRate = 1,
}: PaymentConfirmDialogProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const stripe = isStripePayment(paymentMethod?.type ?? '')
  const tokenAmount = getCurrencyDisplay().meta.kind === 'tokens'
  const hasDiscount =
    !stripe && discountRate > 0 && discountRate < 1 && paymentAmount > 0
  const originalAmount = hasDiscount ? paymentAmount / discountRate : 0
  const discountAmount = hasDiscount ? originalAmount - paymentAmount : 0

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!processing) onOpenChange(nextOpen)
      }}
      title={t('Confirm Payment')}
      desc={t('Review your payment details')}
      className='max-sm:w-[calc(100vw-1.5rem)] sm:max-w-md'
      handleConfirm={onConfirm}
      isLoading={processing}
      disabled={
        calculating ||
        !isValidTopupAmount(topupAmount) ||
        !Number.isFinite(paymentAmount) ||
        paymentAmount <= 0 ||
        !paymentMethod
      }
      confirmText={
        <>
          {processing && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
          {t('Confirm Payment')}
        </>
      }
    >
      <div className='space-y-3 py-3 sm:space-y-4 sm:py-4'>
        <div className='flex items-center justify-between'>
          <span className='text-muted-foreground text-sm'>
            {stripe ? t('Quantity') : t('Topup Amount')}
          </span>
          <span className='text-lg font-semibold'>
            {stripe || tokenAmount
              ? formatNumber(topupAmount, locale)
              : formatLocalCurrencyAmount(topupAmount * usdExchangeRate, {
                  digitsLarge: 2,
                  digitsSmall: 2,
                  abbreviate: false,
                })}
          </span>
        </div>

        <div className='flex items-center justify-between'>
          <span className='text-muted-foreground text-sm'>
            {stripe ? t('Estimated payment before discounts') : t('You Pay')}
          </span>
          {calculating ? (
            <Skeleton className='h-6 w-24' />
          ) : (
            <div className='flex items-baseline gap-2'>
              <span className='text-2xl font-semibold'>
                {formatCurrency(paymentAmount)}
              </span>
              {hasDiscount && (
                <span className='text-muted-foreground text-sm line-through'>
                  {formatCurrency(originalAmount)}
                </span>
              )}
            </div>
          )}
        </div>

        {stripe && (
          <p className='text-muted-foreground text-xs'>
            {t(
              'The final amount and any discounts are confirmed in Stripe Checkout.'
            )}
          </p>
        )}

        {hasDiscount && !calculating && (
          <div className='bg-muted/50 rounded-lg p-3'>
            <div className='flex items-center justify-between text-sm'>
              <span className='text-muted-foreground'>{t('You save')}</span>
              <span className='font-semibold text-green-600'>
                {formatCurrency(discountAmount)}
              </span>
            </div>
          </div>
        )}

        <div className='border-t pt-4'>
          <div className='flex items-center justify-between'>
            <span className='text-muted-foreground text-sm'>
              {t('Payment Method')}
            </span>
            <div className='flex items-center gap-2'>
              {getPaymentIcon(
                paymentMethod?.type,
                'h-4 w-4',
                paymentMethod?.icon,
                paymentMethod?.name
              )}
              <span className='font-medium'>{paymentMethod?.name}</span>
            </div>
          </div>
        </div>
      </div>
    </ConfirmDialog>
  )
}
