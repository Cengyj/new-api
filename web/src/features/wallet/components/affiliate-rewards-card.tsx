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
import { Share2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { ErrorState } from '@/components/error-state'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader } from '@/components/ui/card'
import { IconBadge } from '@/components/ui/icon-badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber, formatPercent } from '@/lib/format'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { useAffiliate } from '../hooks/use-affiliate'
import { ReferralInviteesDialog } from './dialogs/referral-invitees-dialog'
import { ReferralRecordsDialog } from './dialogs/referral-records-dialog'
import { TransferDialog } from './dialogs/transfer-dialog'
import { ReferralQuota } from './referral-quota'

export function AffiliateRewardsCard(props: {
  onBalanceChanged: () => Promise<void>
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const affiliate = useAffiliate(props.onBalanceChanged)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const role = useAuthStore((state) => state.auth.user?.role)
  const [transferOpen, setTransferOpen] = useState(false)
  const currency = useSystemConfigStore((state) => state.config.currency)
  const minimum = Math.ceil(
    currency.quotaPerUnit > 0
      ? currency.quotaPerUnit
      : DEFAULT_CURRENCY_CONFIG.quotaPerUnit
  )
  const data = affiliate.query.data
  const available = Number(data?.aff_quota ?? 0)
  const validAmount = Number.isSafeInteger(available) && available >= minimum

  return (
    <Card data-card-hover='false' className='bg-muted/20 py-0'>
      <CardHeader className='gap-x-3 px-3 pt-3 sm:px-4 sm:pt-4'>
        <div className='flex min-w-0 items-center gap-2.5'>
          <IconBadge tone='chart-3'>
            <Share2 />
          </IconBadge>
          <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
            <h3 className='min-w-0 text-sm font-semibold break-words'>
              {t('Referral Program')}
            </h3>
            {data && !affiliate.query.isError && (
              <StatusBadge
                copyable={false}
                label={
                  data.rule.enabled
                    ? t('Activity active')
                    : t('Activity paused')
                }
                variant={data.rule.enabled ? 'success' : 'neutral'}
              />
            )}
          </div>
        </div>
        <CardAction className='row-span-1 flex flex-col gap-2 sm:flex-row'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setRecordsOpen(true)}
          >
            {t('Invitation records')}
          </Button>
          {role && role >= ROLE.ADMIN && role < ROLE.SUPER_ADMIN && (
            <Button
              variant='outline'
              size='sm'
              onClick={() => setAdminOpen(true)}
            >
              {t('Top-up rebate records')}
            </Button>
          )}
        </CardAction>
        <p className='text-muted-foreground col-span-2 mt-1 text-xs'>
          {t('Invite users and earn rewards from eligible wallet top-ups.')}
        </p>
      </CardHeader>
      <CardContent className='min-w-0 space-y-4 px-3 pb-3 sm:px-4 sm:pb-4'>
        {affiliate.query.isPending && (
          <div
            aria-busy='true'
            className='grid grid-cols-2 gap-4 sm:grid-cols-4'
          >
            {[0, 1, 2, 3].map((id) => (
              <Skeleton key={id} className='h-14' />
            ))}
          </div>
        )}
        {affiliate.query.isError && (
          <ErrorState
            className='min-h-32'
            onRetry={() => void affiliate.query.refetch()}
          />
        )}
        {affiliate.storageError && !transferOpen && (
          <ErrorState
            className='min-h-0'
            description={t(
              'Saved transfer details are unavailable or invalid. Restore browser storage and retry before starting another transfer.'
            )}
            onRetry={affiliate.retryStorage}
          />
        )}
        {affiliate.confirmed && !transferOpen && (
          <p role='status' className='text-muted-foreground text-xs'>
            {t(
              'Transfer succeeded, but the saved operation could not be cleared. Check the original operation before starting another transfer.'
            )}
          </p>
        )}
        {affiliate.refreshFailed && (
          <div
            role='status'
            className='flex flex-wrap items-center gap-2 text-xs'
          >
            <span>
              {t('Transfer succeeded, but balances could not be refreshed.')}
            </span>
            <Button
              size='sm'
              variant='outline'
              onClick={() => void affiliate.refresh()}
            >
              {t('Retry')}
            </Button>
          </div>
        )}
        {data && !affiliate.query.isError && (
          <>
            <dl className='grid grid-cols-2 gap-4 sm:grid-cols-4'>
              {[
                [t('Available Rewards'), data.aff_quota],
                [t('Total Earned'), data.aff_history_quota],
                [t('Total top-up rebates'), data.rebate_quota],
              ].map(([label, value]) => (
                <div key={label} className='min-w-0'>
                  <dt className='text-muted-foreground text-xs'>{label}</dt>
                  <dd className='mt-1 text-sm font-semibold'>
                    <ReferralQuota value={value} />
                  </dd>
                </div>
              ))}
              <div>
                <dt className='text-muted-foreground text-xs'>
                  {t('Direct invitations')}
                </dt>
                <dd className='mt-1 text-sm font-semibold tabular-nums'>
                  {formatNumber(data.direct_count, locale)}
                </dd>
              </div>
            </dl>
            <section
              aria-label={t('Invitation top-up rebates')}
              className='flex min-w-0 flex-col gap-2'
            >
              <ul className='text-muted-foreground list-disc space-y-1.5 pl-4 text-xs leading-relaxed'>
                <li>
                  {data.rule.rate_bps > 0 && data.rule.valid_days > 0
                    ? t('New eligibility: {{rate}} for {{days}} days', {
                        rate: formatPercent(data.rule.rate_bps / 100),
                        days: formatNumber(data.rule.valid_days, locale),
                      })
                    : t('Rules not configured')}
                </li>
                <li>
                  {t(
                    'Only direct invitations qualify. The personal rate and expiry are fixed at registration; one day is 24 hours.'
                  )}{' '}
                  {t(
                    'Top-up rebates are already included in total earned rewards.'
                  )}
                </li>
                <li>
                  {t(
                    'Rewards can only be used on this site and cannot be withdrawn.'
                  )}
                </li>
              </ul>
            </section>
            {!data.compliance_confirmed && (
              <p className='text-destructive text-xs'>
                {t(
                  'Payment compliance must be confirmed before rebates and reward transfers are available.'
                )}
              </p>
            )}
            <div className='flex flex-wrap items-center gap-2'>
              <Input
                aria-label={t('Invitation link')}
                value={data.affiliateLink}
                readOnly
                className='bg-background/70 min-w-0 flex-1 font-mono text-xs'
              />
              <CopyButton
                value={data.affiliateLink}
                variant='outline'
                tooltip={t('Copy referral link')}
                aria-label={t('Copy referral link')}
              />
              <Button
                size='sm'
                onClick={() => setTransferOpen(true)}
                disabled={
                  !affiliate.pending &&
                  (!validAmount ||
                    !data.compliance_confirmed ||
                    affiliate.storageError)
                }
              >
                {affiliate.pending
                  ? t('Check transfer result')
                  : t('Transfer to Balance')}
              </Button>
            </div>
          </>
        )}
        {affiliate.pending && (!data || affiliate.query.isError) && (
          <Button variant='outline' onClick={() => setTransferOpen(true)}>
            {t('Check transfer result')}
          </Button>
        )}
        {adminOpen && role !== undefined && role >= ROLE.ADMIN && (
          <ReferralRecordsDialog onOpenChange={setAdminOpen} />
        )}
        {recordsOpen && (
          <ReferralInviteesDialog onOpenChange={setRecordsOpen} />
        )}
        {transferOpen && (
          <TransferDialog
            open
            onOpenChange={setTransferOpen}
            onConfirm={affiliate.transferQuota}
            availableQuota={available}
            transferring={affiliate.transferring}
            pending={affiliate.pending}
            checkedAbsent={affiliate.checkedAbsent}
            storageError={affiliate.storageError}
            onRetryStorage={affiliate.retryStorage}
            confirmed={affiliate.confirmed}
            rejected={affiliate.rejected}
            onVerify={affiliate.verifyTransfer}
            complianceConfirmed={data?.compliance_confirmed === true}
          />
        )}
      </CardContent>
    </Card>
  )
}
