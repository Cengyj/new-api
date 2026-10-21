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
import { useQuery } from '@tanstack/react-query'
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DataTablePagination, DataTableView } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { StatusBadge } from '@/components/status-badge'
import { formatPercent, formatTimestampToDate } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import {
  getReferralInvitees,
  referralIdentity,
  type ReferralInvitee,
} from '../../referral-api'
import { ReferralQuota } from '../referral-quota'

export function ReferralInviteesDialog(props: {
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const identity = useAuthStore(referralIdentity)
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 })
  const query = useQuery({
    queryKey: ['referral-invitees', identity, pagination],
    queryFn: ({ signal }) =>
      getReferralInvitees(
        pagination.pageIndex + 1,
        pagination.pageSize,
        signal,
        identity
      ),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === identity ? previous : undefined,
    retry: false,
    meta: { errorToast: false },
  })
  const columns = useMemo<ColumnDef<ReferralInvitee>[]>(
    () => [
      {
        accessorKey: 'id',
        header: t('Invitee'),
        cell: ({ row }) => (
          <div className='max-w-48 break-words whitespace-normal'>
            <div>
              {row.original.deleted
                ? t('Deleted user')
                : row.original.display_name || '—'}
            </div>
            <div className='text-muted-foreground text-xs'>
              ID: {row.original.id}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'created_at',
        header: t('Registration time'),
        cell: ({ row }) =>
          formatTimestampToDate(row.original.created_at ?? undefined),
      },
      {
        accessorKey: 'status',
        header: t('Eligibility'),
        cell: ({ row }) => {
          if (
            row.original.deleted &&
            row.original.rate_bps === null &&
            row.original.expires_at === null
          ) {
            return '—'
          }
          let label = t('Not eligible')
          switch (row.original.status) {
            case 'active':
              label = t('Eligible')
              break
            case 'expired':
              label = t('Expired')
              break
            case 'paused':
              label = t('Activity paused')
              break
          }
          return (
            <StatusBadge
              label={label}
              variant={row.original.status === 'active' ? 'success' : 'neutral'}
              copyable={false}
            />
          )
        },
      },
      {
        accessorKey: 'rate_bps',
        header: t('Personal rebate rate'),
        cell: ({ row }) =>
          row.original.rate_bps
            ? formatPercent(row.original.rate_bps / 100)
            : '—',
      },
      {
        accessorKey: 'expires_at',
        header: t('Expires at'),
        cell: ({ row }) =>
          formatTimestampToDate(row.original.expires_at ?? undefined),
      },
      {
        accessorKey: 'rebate_quota',
        header: t('Total rebate contribution'),
        cell: ({ row }) => <ReferralQuota value={row.original.rebate_quota} />,
      },
    ],
    [t]
  )
  const table = useReactTable({
    data: query.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    enableSorting: false,
    enableHiding: false,
    rowCount: query.data?.total ?? 0,
    state: { pagination },
    onPaginationChange: (updater) => {
      setPagination((previous) => {
        const next = typeof updater === 'function' ? updater(previous) : updater
        return next.pageSize === previous.pageSize
          ? next
          : { ...next, pageIndex: 0 }
      })
    },
  })
  return (
    <Dialog
      open
      onOpenChange={props.onOpenChange}
      title={t('Invitation records')}
      description={t(
        'Personal rates and expiry times are fixed at registration. Times use your browser time zone.'
      )}
      contentClassName='max-h-(--dialog-available-height) sm:max-w-6xl'
      bodyClassName='min-w-0'
      contentHeight='min(55dvh, 560px)'
      footer={
        query.data &&
        !query.isError && (
          <div className='w-full min-w-0'>
            <DataTablePagination table={table} disabled={query.isFetching} />
          </div>
        )
      }
    >
      {query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : (
        <DataTableView
          table={table}
          isLoading={query.isPending || query.isPlaceholderData}
          tableClassName='min-w-[850px]'
          tableContainerClassName='overflow-x-auto'
          emptyTitle={t('No invitations yet')}
          emptyDescription={t(
            'Users who register through your invitation link will appear here'
          )}
        />
      )}
    </Dialog>
  )
}
