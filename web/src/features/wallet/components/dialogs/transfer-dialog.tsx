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
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatQuota, quotaUnitsToDollars } from '@/lib/format'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { parseAffiliateTransferQuota } from '../../lib/affiliate'

interface TransferDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (amount: number) => Promise<boolean>
  availableQuota: number
  transferring: boolean
  pending?: { request_id: string; quota: number } | null
  checkedAbsent?: boolean
  onVerify?: () => Promise<boolean>
  complianceConfirmed?: boolean
  storageError?: boolean
  onRetryStorage?: () => void
  confirmed?: boolean
  rejected?: boolean
}

export function TransferDialog({
  open,
  onOpenChange,
  onConfirm,
  availableQuota,
  transferring,
  pending,
  checkedAbsent,
  onVerify,
  complianceConfirmed = true,
  storageError = false,
  onRetryStorage,
  confirmed = false,
  rejected = false,
}: TransferDialogProps) {
  const { t } = useTranslation()
  const currencyConfig = useSystemConfigStore((state) => state.config.currency)
  const minimumQuota = Math.ceil(
    currencyConfig.quotaPerUnit > 0
      ? currencyConfig.quotaPerUnit
      : DEFAULT_CURRENCY_CONFIG.quotaPerUnit
  )
  const minimumAmount = quotaUnitsToDollars(minimumQuota)
  const maximumAmount = quotaUnitsToDollars(availableQuota)
  const [amount, setAmount] = useState(String(minimumAmount))
  const transferQuota = pending?.quota ?? parseAffiliateTransferQuota(amount)
  const canTransfer =
    complianceConfirmed &&
    !storageError &&
    !confirmed &&
    !rejected &&
    Number.isFinite(Number(amount)) &&
    Number.isSafeInteger(transferQuota) &&
    (!pending || checkedAbsent === true) &&
    transferQuota >= minimumQuota &&
    transferQuota <= availableQuota

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAmount(String(minimumAmount))
    }
  }, [minimumAmount, open])

  let resultDescription = t(
    'Transfer result is unknown. Check the original operation before retrying.'
  )
  if (confirmed) {
    resultDescription = t(
      'Transfer succeeded, but the saved operation could not be cleared. Check the original operation before starting another transfer.'
    )
  } else if (rejected) {
    resultDescription = t(
      'Transfer was rejected. No balance was moved. Restore browser storage before starting another transfer.'
    )
  }

  const handleConfirm = async () => {
    if (!canTransfer) return

    const success = await onConfirm(transferQuota)
    if (success) {
      onOpenChange(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!transferring) onOpenChange(next)
      }}
      title={t('Transfer Rewards')}
      description={t('Move affiliate rewards to your main balance')}
      contentClassName='max-sm:w-[calc(100vw-1.5rem)] sm:max-w-md'
      titleClassName='text-xl font-semibold'
      footerClassName='grid grid-cols-2 gap-2 sm:flex'
      contentHeight='auto'
      bodyClassName='space-y-4'
      footer={
        <>
          <Button
            variant='outline'
            onClick={() => onOpenChange(false)}
            disabled={transferring}
          >
            {pending ? t('Close') : t('Cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={transferring || !canTransfer}
          >
            {transferring && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
            {pending ? t('Retry original transfer') : t('Transfer')}
          </Button>
        </>
      }
    >
      <div className='space-y-4 py-3 sm:space-y-6 sm:py-4'>
        {storageError && (
          <ErrorState
            className='min-h-0'
            description={t(
              'Saved transfer details are unavailable or invalid. Restore browser storage and retry before starting another transfer.'
            )}
            onRetry={onRetryStorage}
          />
        )}
        {pending && (
          <div role='status' className='space-y-2 text-sm'>
            <p>{resultDescription}</p>
            <p className='font-mono text-xs break-all'>{pending.request_id}</p>
            {checkedAbsent && (
              <p>
                {t(
                  'No completed result was found. A request may still be processing; retry only this original transfer.'
                )}
              </p>
            )}
            {!rejected && (
              <Button
                variant='outline'
                disabled={transferring}
                onClick={async () => {
                  if (await onVerify?.()) onOpenChange(false)
                }}
              >
                {t('Check transfer result')}
              </Button>
            )}
          </div>
        )}
        {!complianceConfirmed && (
          <p className='text-destructive text-xs'>
            {t(
              'Referral reward transfer is disabled until the administrator confirms compliance terms.'
            )}
          </p>
        )}
        <div className='space-y-2'>
          <Label className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>
            {t('Available Rewards')}
          </Label>
          <div className='text-2xl font-semibold'>
            {formatQuota(availableQuota)}
          </div>
        </div>

        <div className='space-y-3'>
          <Label
            htmlFor='transfer-amount'
            className='text-muted-foreground text-xs font-medium tracking-wider uppercase'
          >
            {t('Transfer Amount')}
          </Label>
          <Input
            id='transfer-amount'
            type='number'
            value={pending ? quotaUnitsToDollars(pending.quota) : amount}
            disabled={!!pending || transferring}
            onChange={(e) => setAmount(e.target.value)}
            min={minimumAmount}
            max={maximumAmount}
            step={minimumAmount}
            className='font-mono text-lg'
          />
        </div>
      </div>
    </Dialog>
  )
}
