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
import { useAuthStore } from '@/stores/auth-store'
import {
  PAYMENT_RECOVERY_PREFIX,
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
  const storageError = usePaymentRecoveryStore((state) =>
    userId ? state.storageErrors[userId] : false
  )
  useEffect(() => {
    if (!userId) return
    usePaymentRecoveryStore.getState().restore(userId)
    const restore = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key.startsWith(`${PAYMENT_RECOVERY_PREFIX}${userId}:`)
      ) {
        usePaymentRecoveryStore.getState().restore(userId)
      }
    }
    window.addEventListener('storage', restore)
    return () => window.removeEventListener('storage', restore)
  }, [userId])
  if (!orders.length && !storageError) return null
  return (
    <Alert>
      <AlertTitle>{t('Payment requests to check')}</AlertTitle>
      <AlertDescription className='space-y-2'>
        <p>
          {t(
            'Payment request result is unknown. Check Order History before trying again.'
          )}
        </p>
        {storageError && (
          <p>
            {t(
              'Order references could not be saved in this browser. Copy the order number before leaving this page.'
            )}
          </p>
        )}
        {orders.map((tradeNo) => (
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
        ))}
      </AlertDescription>
    </Alert>
  )
}
