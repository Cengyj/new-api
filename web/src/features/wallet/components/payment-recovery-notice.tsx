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
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { formatTimestampToDate } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'
import {
  PAYMENT_RECOVERY_PREFIX,
  paymentAttemptPattern,
  usePaymentRecoveryStore,
} from '@/stores/payment-recovery-store'

const NO_ORDERS: string[] = []

export function PaymentRecoveryNotice(props: {
  onViewOrder: (tradeNo: string) => void
}) {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id)
  const orders = usePaymentRecoveryStore((state) =>
    userId ? (state.orders[userId] ?? NO_ORDERS) : NO_ORDERS
  )
  const attempts = usePaymentRecoveryStore((state) =>
    userId ? (state.attempts[userId] ?? NO_ORDERS) : NO_ORDERS
  )
  const storageError = usePaymentRecoveryStore((state) =>
    userId ? state.storageErrors[userId] : false
  )
  useEffect(() => {
    if (!userId) return
    usePaymentRecoveryStore.getState().restore(userId)
    const retryStorage = () => {
      const recovery = usePaymentRecoveryStore.getState()
      if (recovery.storageErrors[userId]) recovery.restore(userId)
    }
    const restore = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key.startsWith(`${PAYMENT_RECOVERY_PREFIX}${userId}:`)
      ) {
        const retired =
          event.newValue === null &&
          event.key === `${PAYMENT_RECOVERY_PREFIX}${userId}:${event.oldValue}`
            ? (event.oldValue ?? undefined)
            : undefined
        usePaymentRecoveryStore.getState().restore(userId, { retired })
      }
    }
    window.addEventListener('storage', restore)
    window.addEventListener('focus', retryStorage)
    window.addEventListener('pagehide', retryStorage)
    return () => {
      window.removeEventListener('storage', restore)
      window.removeEventListener('focus', retryStorage)
      window.removeEventListener('pagehide', retryStorage)
    }
  }, [userId])
  if (!orders.length && !attempts.length && !storageError) return null
  return (
    <Alert>
      <AlertTitle>{t('Payment requests to check')}</AlertTitle>
      <AlertDescription className='space-y-2'>
        {orders.length === 0 && (
          <p>
            {t(
              'Payment request result is unknown. Check Order History before trying again.'
            )}
          </p>
        )}
        {storageError && (
          <p>
            {attempts.length > 0 || orders.length === 0
              ? t(
                  'This browser could not save a payment reminder. Check your recent top-ups before leaving.'
                )
              : t(
                  'Order references could not be saved in this browser. Copy the order number before leaving this page.'
                )}
          </p>
        )}
        {storageError && orders.length === 0 && attempts.length === 0 && (
          <Button
            variant='outline'
            size='sm'
            onClick={() => props.onViewOrder('')}
          >
            {t('Order History')}
          </Button>
        )}
        {[...orders, ...attempts].map((tradeNo) => {
          const attempt = paymentAttemptPattern.exec(tradeNo)
          if (attempt && userId) {
            return (
              <div
                key={tradeNo}
                className='flex min-w-0 flex-wrap items-center gap-2'
              >
                <span className='min-w-0 flex-1'>
                  {t('Payment request at {{time}}', {
                    time: formatTimestampToDate(
                      Number(attempt[1]),
                      'milliseconds'
                    ),
                  })}
                </span>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => props.onViewOrder('')}
                >
                  {t('Order History')}
                </Button>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() =>
                    usePaymentRecoveryStore
                      .getState()
                      .resolve(userId, [tradeNo])
                  }
                >
                  {t('I checked Order History')}
                </Button>
              </div>
            )
          }
          return (
            <div
              key={tradeNo}
              className='flex min-w-0 flex-wrap items-center gap-2'
            >
              <span className='min-w-0 flex-1 font-mono text-xs break-all select-text'>
                {tradeNo}
              </span>
              <CopyButton
                value={tradeNo}
                aria-label={t('Copy order number')}
                size='sm'
              />
              <Button
                variant='outline'
                size='sm'
                onClick={() => props.onViewOrder(tradeNo)}
              >
                {t('View order')}
              </Button>
            </div>
          )
        })}
      </AlertDescription>
    </Alert>
  )
}
