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

import { CopyButton } from '@/components/copy-button'
import {
  DataTablePagination,
  DataTableToolbar,
  DataTableView,
  MobileCardList,
} from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { TableId } from '@/components/table-id'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { CompactDateTimeRangePicker } from '@/features/usage-logs/components/compact-date-time-range-picker'
import {
  LogsFilterField,
  LogsFilterInput,
} from '@/features/usage-logs/components/logs-filter-toolbar'
import { useMediaQuery } from '@/hooks/use-media-query'
import { toIntlLocale } from '@/i18n/languages'
import {
  formatNumber,
  formatPercent,
  formatTimestampToDate,
} from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import {
  getReferralRecords,
  referralIdentity,
  type ReferralFilters,
  type ReferralRecord,
} from '../../referral-api'
import { ReferralQuota } from '../referral-quota'

const emptyFilters: ReferralFilters = {
  inviter_id: '',
  invitee_id: '',
  trade_no: '',
  start_time: '',
  end_time: '',
}

export function ReferralRecordsDialog(props: {
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const identity = useAuthStore(referralIdentity)
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const mobile = useMediaQuery('(max-width: 1023px)')
  const compact = useMediaQuery('(max-height: 700px)')
  const [filterOpen, setFilterOpen] = useState(false)
  const [draft, setDraft] = useState({
    inviter_id: '',
    invitee_id: '',
    trade_no: '',
  })
  const [range, setRange] = useState<{ start?: Date; end?: Date }>({})
  const [filters, setFilters] = useState(emptyFilters)
  const filterKey = JSON.stringify([
    filters.inviter_id,
    filters.invitee_id,
    filters.trade_no,
    filters.start_time,
    filters.end_time,
  ])
  const [filterError, setFilterError] = useState('')
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 })
  const query = useQuery({
    queryKey: ['referral-records', identity, filterKey, pagination],
    queryFn: ({ signal }) =>
      getReferralRecords(
        pagination.pageIndex + 1,
        pagination.pageSize,
        filters,
        signal,
        identity
      ),
    // Only keep pagination context within the same account and filter set.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === identity &&
      previousQuery.queryKey[2] === filterKey
        ? previous
        : undefined,
    retry: false,
    meta: { errorToast: false },
  })
  const columns = useMemo<ColumnDef<ReferralRecord>[]>(
    () => [
      {
        accessorKey: 'trade_no',
        header: t('Order number'),
        meta: { mobileTitle: true, label: t('Order number') },
        cell: ({ row }) => (
          <div className='min-w-0 space-y-1.5'>
            <div className='flex min-w-0 items-center gap-1'>
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      variant='ghost'
                      size='sm'
                      aria-label={`${t('Order number')}: ${row.original.trade_no}`}
                      className='h-7 min-w-0 flex-1 justify-start px-0 font-mono text-xs font-normal underline decoration-dotted underline-offset-4'
                    />
                  }
                >
                  {row.original.trade_no.length > 32 ? (
                    <span className='flex max-w-full min-w-0 items-center whitespace-nowrap'>
                      <span className='min-w-0 overflow-hidden'>
                        {row.original.trade_no.slice(0, 16)}
                      </span>
                      <span className='shrink-0'>…</span>
                      <span className='shrink-0'>
                        {row.original.trade_no.slice(-12)}
                      </span>
                    </span>
                  ) : (
                    <span className='min-w-0 truncate'>
                      {row.original.trade_no}
                    </span>
                  )}
                </PopoverTrigger>
                <PopoverContent
                  align='start'
                  className='w-80 max-w-[calc(100vw-2rem)]'
                >
                  <PopoverTitle>{t('Order number')}</PopoverTitle>
                  <p className='font-mono text-xs break-all select-text'>
                    {row.original.trade_no}
                  </p>
                </PopoverContent>
              </Popover>
              <CopyButton
                value={row.original.trade_no}
                size='icon'
                className='size-6 shrink-0'
                aria-label={t('Copy order number')}
                tooltip={t('Copy order number')}
              />
            </div>
            <span className='text-muted-foreground text-xs'>
              {t('Record ID')}: <TableId value={row.original.id} />
            </span>
          </div>
        ),
      },
      {
        id: 'users',
        header: t('Inviter / Invitee'),
        meta: { label: t('Inviter / Invitee') },
        cell: ({ row }) => (
          <div className='space-y-1 text-xs whitespace-normal'>
            <div>
              <span className='text-muted-foreground'>{t('Inviter')}: </span>
              <TableId value={row.original.inviter_id} />
            </div>
            <div>
              <span className='text-muted-foreground'>{t('Invitee')}: </span>
              <TableId value={row.original.invitee_id} />
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'credited_quota',
        header: t('Wallet credited'),
        meta: { label: t('Wallet credited') },
        cell: ({ row }) => (
          <div className='font-medium'>
            <ReferralQuota value={row.original.credited_quota} />
          </div>
        ),
      },
      {
        accessorKey: 'reward_quota',
        header: t('Rebate / Rate'),
        meta: { label: t('Rebate / Rate') },
        cell: ({ row }) => (
          <div className='space-y-1 whitespace-normal'>
            <div className='font-medium'>
              <ReferralQuota value={row.original.reward_quota} />
            </div>
            <div className='text-muted-foreground text-xs'>
              {formatPercent(row.original.rate_bps / 100)}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'settled_at',
        header: t('Credited / Recorded at'),
        meta: { label: t('Credited / Recorded at') },
        cell: ({ row }) => (
          <div className='space-y-1 text-xs whitespace-normal tabular-nums'>
            <div>{formatTimestampToDate(row.original.settled_at)}</div>
            <div className='text-muted-foreground text-xs'>
              {formatTimestampToDate(row.original.created_at)}
            </div>
          </div>
        ),
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
  const applyFilters = () => {
    if (
      [draft.inviter_id, draft.invitee_id].some(
        (value) =>
          value &&
          (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      )
    ) {
      setFilterError(t('User IDs must be positive integers'))
      return
    }
    const start = range.start
      ? Math.floor(range.start.getTime() / 1000)
      : undefined
    // Presets end at 23:59:59.999; the API upper bound is exclusive.
    const end = range.end ? Math.ceil(range.end.getTime() / 1000) : undefined
    if (
      (start !== undefined && (!Number.isFinite(start) || start < 0)) ||
      (end !== undefined && (!Number.isFinite(end) || end < 0)) ||
      (start !== undefined && end !== undefined && start >= end)
    ) {
      setFilterError(
        t('Enter a valid time range with the start before the end')
      )
      return
    }
    setFilters({
      ...draft,
      trade_no: draft.trade_no.trim(),
      start_time: start === undefined ? '' : String(start),
      end_time: end === undefined ? '' : String(end),
    })
    setPagination((previous) => ({ ...previous, pageIndex: 0 }))
    setFilterError('')
    setFilterOpen(false)
  }
  const resetFilters = () => {
    setDraft({ inviter_id: '', invitee_id: '', trade_no: '' })
    setRange({})
    setFilters(emptyFilters)
    setFilterError('')
    setPagination((previous) => ({ ...previous, pageIndex: 0 }))
  }
  const filterFields = (
    <form
      className='min-w-0 shrink-0 space-y-2'
      onSubmit={(event) => {
        event.preventDefault()
        applyFilters()
      }}
    >
      <DataTableToolbar
        table={table}
        hideViewOptions
        searchLoading={query.isFetching}
        hasAdditionalFilters={Boolean(
          Object.values(draft).some(Boolean) ||
          range.start ||
          range.end ||
          Object.values(filters).some(Boolean)
        )}
        onSearch={applyFilters}
        onReset={resetFilters}
        customSearch={
          <div className='grid w-full min-w-0 grid-cols-2 gap-2 sm:flex-1 sm:grid-cols-[minmax(5rem,.8fr)_minmax(5rem,.8fr)_minmax(8rem,1.2fr)_minmax(10rem,1.7fr)]'>
            {(
              [
                ['inviter_id', t('Inviter ID')],
                ['invitee_id', t('Invitee ID')],
                ['trade_no', t('Order number')],
              ] as const
            ).map(([field, label]) => (
              <LogsFilterField
                key={field}
                className={
                  field === 'trade_no' ? 'col-span-2 sm:col-span-1' : undefined
                }
              >
                <LogsFilterInput
                  aria-label={label}
                  placeholder={label}
                  inputMode={field === 'trade_no' ? 'text' : 'numeric'}
                  value={draft[field]}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      [field]: event.target.value,
                    }))
                  }
                />
              </LogsFilterField>
            ))}
            <LogsFilterField className='col-span-2 sm:col-span-1'>
              <CompactDateTimeRangePicker
                start={range.start}
                end={range.end}
                onChange={setRange}
              />
            </LogsFilterField>
          </div>
        }
      />
      <p className='text-muted-foreground text-xs'>
        {t(
          'Times use your browser time zone. The end of the range is exclusive.'
        )}
      </p>
      {filterError && (
        <p role='alert' className='text-destructive text-xs'>
          {filterError}
        </p>
      )}
    </form>
  )
  return (
    <>
      <Dialog
        open
        onOpenChange={props.onOpenChange}
        title={t('Top-up rebate records')}
        description={t(
          'Totals include all matching records, not only the current page.'
        )}
        contentClassName='max-h-(--dialog-available-height) overflow-hidden sm:max-w-6xl'
        bodyClassName='flex h-full min-h-0 flex-col gap-4 [@media(max-height:500px)]:gap-2'
        contentHeight='min(76dvh, 44rem)'
        footer={
          query.data &&
          !query.isError && (
            <div className='w-full min-w-0'>
              <DataTablePagination table={table} disabled={query.isFetching} />
            </div>
          )
        }
      >
        <dl
          aria-busy={query.isFetching}
          className='bg-muted/30 grid shrink-0 grid-cols-2 gap-3 rounded-lg border p-3 sm:grid-cols-3'
        >
          <div className='col-span-2 min-w-0 sm:col-span-1'>
            <dt className='text-muted-foreground text-xs'>
              {t('Matching records')}
            </dt>
            <dd className='mt-1 text-lg font-semibold tabular-nums'>
              {query.isPending && <Skeleton className='h-6 w-12' />}
              {!query.isPending && query.isError && '—'}
              {!query.isPending &&
                !query.isError &&
                formatNumber(query.data?.total, locale)}
            </dd>
          </div>
          {[
            [t('Total wallet credited'), query.data?.credited_quota],
            [t('Total rebates paid'), query.data?.reward_quota],
          ].map(([label, value]) => (
            <div key={label} className='min-w-0'>
              <dt className='text-muted-foreground text-xs'>{label}</dt>
              <dd className='mt-1 text-lg font-semibold tabular-nums'>
                {query.isPending && <Skeleton className='h-6 w-16' />}
                {!query.isPending &&
                  (query.isError || value === undefined) &&
                  '—'}
                {!query.isPending && !query.isError && value !== undefined && (
                  <ReferralQuota value={value} />
                )}
              </dd>
            </div>
          ))}
        </dl>
        {compact ? (
          <Button
            variant='outline'
            className='shrink-0 self-start'
            onClick={() => setFilterOpen(true)}
          >
            {t('Filters')}
          </Button>
        ) : (
          filterFields
        )}
        {query.isError ? (
          <div className='min-h-0 flex-1 overflow-auto'>
            <ErrorState
              className='min-h-0'
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : (
          <div
            role='region'
            aria-label={t('Top-up rebate records')}
            aria-busy={query.isFetching}
            className='min-h-24 min-w-0 flex-1 overflow-auto overscroll-contain'
          >
            {mobile ? (
              <MobileCardList
                table={table}
                isLoading={query.isPending || query.isPlaceholderData}
                emptyTitle={t('No rebate records')}
              />
            ) : (
              <DataTableView
                table={table}
                isLoading={query.isPending || query.isPlaceholderData}
                containerClassName='h-full min-h-0'
                tableClassName='w-full table-fixed'
                bodyContainerClassName='overscroll-contain'
                getColumnClassName={(_, section) =>
                  section === 'cell'
                    ? 'px-3 py-4 align-top whitespace-normal'
                    : 'px-3 whitespace-normal'
                }
                colgroup={
                  <colgroup>
                    <col className='w-[27%]' />
                    <col className='w-[15%]' />
                    <col className='w-[17%]' />
                    <col className='w-[17%]' />
                    <col className='w-[24%]' />
                  </colgroup>
                }
                splitHeader
                emptyTitle={t('No rebate records')}
              />
            )}
          </div>
        )}
      </Dialog>
      {compact && filterOpen && (
        <Dialog
          open
          onOpenChange={setFilterOpen}
          title={t('Filters')}
          contentClassName='sm:max-w-3xl'
        >
          {filterFields}
        </Dialog>
      )}
    </>
  )
}
