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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { handleServerError } from '@/lib/handle-server-error'
import { getServerErrorSources } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { generateAffiliateLink } from '../lib/affiliate'
import {
  getReferralSummary,
  referralIdentity,
  referralRequest,
  type AffiliateTransferResult,
} from '../referral-api'

interface PendingTransfer {
  request_id: string
  quota: number
}

interface SavedTransfer {
  pending: PendingTransfer | null
  storageError: boolean
}

function parsePendingTransfer(raw: string): PendingTransfer {
  const value: unknown = JSON.parse(raw)
  if (
    typeof value === 'object' &&
    value !== null &&
    'request_id' in value &&
    typeof value.request_id === 'string' &&
    'quota' in value &&
    typeof value.quota === 'number' &&
    /^[a-zA-Z0-9_-]{16,64}$/.test(value.request_id) &&
    Number.isSafeInteger(value.quota) &&
    value.quota > 0
  ) {
    return { request_id: value.request_id, quota: value.quota }
  }
  throw new Error('Invalid saved transfer')
}

function readPendingTransfer(
  key: string,
  preferred: PendingTransfer | null = null
): SavedTransfer {
  try {
    const legacy = sessionStorage.getItem(key)
    const session = legacy === null ? null : parsePendingTransfer(legacy)
    // Keep pre-upgrade page sessions recoverable after the tab is closed.
    if (session) {
      const operationKey = `${key}:${session.request_id}`
      const existing = localStorage.getItem(operationKey)
      if (existing === null) {
        localStorage.setItem(operationKey, JSON.stringify(session))
      } else {
        const stored = parsePendingTransfer(existing)
        if (
          stored.request_id !== session.request_id ||
          stored.quota !== session.quota
        ) {
          throw new Error('Conflicting saved transfer')
        }
      }
      // Migrate once; a stale page-session mirror must not recreate a result
      // that another tab has already checked and removed from durable storage.
      sessionStorage.removeItem(key)
    }
    const prefix = `${key}:`
    const operations: PendingTransfer[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const operationKey = localStorage.key(index)
      if (!operationKey?.startsWith(prefix)) continue
      const raw = localStorage.getItem(operationKey)
      if (raw === null) continue
      const operation = parsePendingTransfer(raw)
      if (operationKey !== `${prefix}${operation.request_id}`) {
        throw new Error('Conflicting saved transfer')
      }
      if (
        operation.request_id === preferred?.request_id &&
        operation.quota !== preferred.quota
      ) {
        throw new Error('Conflicting saved transfer')
      }
      operations.push(operation)
    }
    operations.sort((left, right) =>
      left.request_id.localeCompare(right.request_id)
    )
    return {
      pending: preferred ?? session ?? operations[0] ?? null,
      storageError: false,
    }
  } catch {
    // Unreadable state may contain an unresolved money request.
    return { pending: preferred, storageError: true }
  }
}

// Release only this exact recorded operation. A storage failure or a different
// request must never silently permit another transfer.
function releasePendingTransfer(
  key: string,
  operation: PendingTransfer
): SavedTransfer {
  const stored = readPendingTransfer(key, operation)
  if (!stored.storageError) {
    try {
      localStorage.removeItem(`${key}:${operation.request_id}`)
      return readPendingTransfer(key)
    } catch {
      // Keep the original ID until storage can be safely reconciled.
    }
  }
  return { pending: operation, storageError: true }
}

export function useAffiliate(onBalanceChanged?: () => Promise<void>) {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id)
  const identity = referralIdentity()
  const storageKey = `new-api:affiliate-transfer:${userId}`
  const [saved, setSaved] = useState(() => readPendingTransfer(storageKey))
  const pending = saved.pending
  const [confirmed, setConfirmed] = useState(false)
  const [rejected, setRejected] = useState(false)
  const [checkedAbsent, setCheckedAbsent] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const mounted = useRef(true)
  const busy = useRef(false)
  const abort = useRef(new AbortController())
  const queryClient = useQueryClient()
  const queryKey = ['referral', identity]
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    abort.current = controller
    return () => {
      mounted.current = false
      controller.abort()
    }
  }, [])
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(`${storageKey}:`)) return
      // Another tab may complete or create its own operation. Preserve this
      // tab's unresolved identity; never infer its result from key deletion.
      setSaved((current) => readPendingTransfer(storageKey, current.pending))
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [storageKey])
  const query = useQuery({
    queryKey,
    enabled: !!userId,
    retry: false,
    meta: { errorToast: false },
    queryFn: async ({ signal }) => {
      const [summary, code] = await Promise.all([
        getReferralSummary(signal, identity),
        referralRequest<string>('/api/user/aff', { signal, identity }),
      ])
      return { ...summary, affiliateLink: generateAffiliateLink(code) }
    },
  })
  const transfer = useMutation({
    retry: false,
    meta: { errorToast: false },
    mutationFn: (operation: PendingTransfer) =>
      referralRequest('/api/user/aff_transfer', {
        method: 'post',
        data: operation,
        identity,
        signal: abort.current.signal,
      }),
  })
  const verify = useMutation({
    retry: false,
    meta: { errorToast: false },
    mutationFn: (operation: PendingTransfer) =>
      referralRequest<AffiliateTransferResult>(
        `/api/user/aff_transfer/${encodeURIComponent(operation.request_id)}`,
        { identity, signal: abort.current.signal }
      ),
  })

  const refresh = async () => {
    if (!mounted.current || referralIdentity() !== identity) return
    const results = await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey }, { throwOnError: true }),
      Promise.resolve().then(() => {
        if (mounted.current && referralIdentity() === identity) {
          return onBalanceChanged?.()
        }
      }),
    ])
    if (!mounted.current || referralIdentity() !== identity) return
    setRefreshFailed(results.some((result) => result.status === 'rejected'))
  }
  const completed = (operation: PendingTransfer) => {
    if (!mounted.current || referralIdentity() !== identity) return false
    const released = releasePendingTransfer(storageKey, operation)
    setSaved(released)
    setConfirmed(released.pending?.request_id === operation.request_id)
    setRejected(false)
    setCheckedAbsent(false)
    toast.success(t('Transfer successful'))
    void refresh()
    return true
  }
  const rejectOperation = (operation: PendingTransfer) => {
    const released = releasePendingTransfer(storageKey, operation)
    setSaved(released)
    setConfirmed(false)
    setRejected(released.pending?.request_id === operation.request_id)
    setCheckedAbsent(false)
  }
  const retryStorage = () => {
    if (busy.current || !mounted.current || referralIdentity() !== identity) {
      return
    }
    if (rejected && pending) {
      const released = releasePendingTransfer(storageKey, pending)
      setSaved(released)
      setRejected(released.pending?.request_id === pending.request_id)
      return
    }
    const recovered = readPendingTransfer(storageKey, pending)
    const conflicting =
      pending &&
      recovered.pending &&
      (recovered.pending.request_id !== pending.request_id ||
        recovered.pending.quota !== pending.quota)
    setSaved({
      pending: pending ?? recovered.pending,
      storageError: recovered.storageError || !!conflicting,
    })
  }
  const transferQuota = async (quota: number): Promise<boolean> => {
    if (busy.current || !mounted.current || referralIdentity() !== identity) {
      return false
    }
    if (
      saved.storageError ||
      confirmed ||
      rejected ||
      !Number.isSafeInteger(quota) ||
      quota <= 0
    ) {
      return false
    }
    if (pending && (!checkedAbsent || pending.quota !== quota)) return false
    const stored = readPendingTransfer(storageKey, pending)
    if (stored.storageError) {
      setSaved({ pending, storageError: true })
      return false
    }
    if (
      stored.pending &&
      (stored.pending.request_id !== pending?.request_id ||
        stored.pending.quota !== pending.quota)
    ) {
      setSaved(pending ? { pending, storageError: true } : stored)
      setCheckedAbsent(false)
      return false
    }
    const operation = pending ?? { request_id: crypto.randomUUID(), quota }
    busy.current = true
    try {
      // Persist before dispatch so reopening keeps an uncertain result's ID.
      try {
        // Independent durable keys cannot overwrite another tab's operation.
        localStorage.setItem(
          `${storageKey}:${operation.request_id}`,
          JSON.stringify(operation)
        )
      } catch {
        setSaved({ pending, storageError: true })
        return false
      }
      setSaved({ pending: operation, storageError: false })
      setCheckedAbsent(false)
      await transfer.mutateAsync(operation)
      return completed(operation)
    } catch (error) {
      if (mounted.current && referralIdentity() === identity) {
        // Another tab or transport retry may still submit this identity. Only
        // a persisted terminal result proves those attempts cannot commit.
        const definitelyRejected = getServerErrorSources(error).some(
          (source) => {
            const data = source.data
            return (
              source.success === false &&
              typeof data === 'object' &&
              data !== null &&
              'transfer_status' in data &&
              data.transfer_status === 'rejected' &&
              'result_persisted' in data &&
              data.result_persisted === true &&
              'request_id' in data &&
              data.request_id === operation.request_id &&
              'quota' in data &&
              data.quota === operation.quota
            )
          }
        )
        if (definitelyRejected) {
          rejectOperation(operation)
        }
        handleServerError(
          error,
          t(
            'Transfer result is unknown. Check the original operation before retrying.'
          )
        )
      }
      return false
    } finally {
      busy.current = false
    }
  }
  const verifyTransfer = async (): Promise<boolean> => {
    if (
      !pending ||
      rejected ||
      busy.current ||
      referralIdentity() !== identity
    ) {
      return false
    }
    busy.current = true
    try {
      const result = await verify.mutateAsync(pending)
      if (!mounted.current || referralIdentity() !== identity) return false
      if (result.rejection) {
        if (
          result.found ||
          result.transfer !== null ||
          confirmed ||
          result.rejection.request_id !== pending.request_id ||
          result.rejection.quota !== pending.quota
        ) {
          throw new Error(
            t('The transfer result does not match the original operation')
          )
        }
        rejectOperation(pending)
        handleServerError(result.rejection)
        return false
      }
      if (
        result.found &&
        result.transfer?.request_id === pending.request_id &&
        result.transfer.quota === pending.quota
      ) {
        return completed(pending)
      }
      if (result.found || confirmed) {
        throw new Error(
          t('The transfer result does not match the original operation')
        )
      }
      setCheckedAbsent(true)
      return false
    } catch (error) {
      if (mounted.current && referralIdentity() === identity) {
        handleServerError(error)
      }
      return false
    } finally {
      busy.current = false
    }
  }
  return {
    query,
    pending,
    storageError: saved.storageError,
    retryStorage,
    confirmed,
    rejected,
    checkedAbsent,
    refreshFailed,
    refresh,
    transferQuota,
    verifyTransfer,
    transferring: transfer.isPending || verify.isPending,
  }
}
