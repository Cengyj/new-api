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
import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'

import { useIsAdmin } from '@/hooks/use-admin'
import { useDebounce } from '@/hooks/use-debounce'
import { handleServerError } from '@/lib/handle-server-error'
import { useAuthStore } from '@/stores/auth-store'

import {
  getUserBillingHistory,
  getAllBillingHistory,
  completeOrder,
  isApiSuccess,
} from '../api'
import type { TopupRecord } from '../types'

// ============================================================================
// Billing History Hook
// ============================================================================

interface UseBillingHistoryOptions {
  /** Initial page number */
  initialPage?: number
  /** Initial page size */
  initialPageSize?: number
}

export function billingHistoryIdentity(): string {
  const auth = useAuthStore.getState().auth
  return `${auth.user?.id ?? ''}:${auth.session?.sid ?? ''}:${auth.user?.role ?? ''}`
}

export function useBillingHistory(options: UseBillingHistoryOptions = {}) {
  const { initialPage = 1, initialPageSize = 10 } = options
  const isAdmin = useIsAdmin()
  const identity = useAuthStore(billingHistoryIdentity)
  const abort = useRef(new AbortController())
  const pendingCompletion = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    abort.current = controller
    const unsubscribe = useAuthStore.subscribe(() => {
      if (billingHistoryIdentity() !== identity) controller.abort()
    })
    return () => {
      controller.abort()
      unsubscribe()
    }
  }, [identity])

  const [records, setRecords] = useState<TopupRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(initialPage)
  const [pageSize, setPageSize] = useState(initialPageSize)
  const [keyword, setKeyword] = useState('')
  const debouncedKeyword = useDebounce(keyword)
  const requestIdRef = useRef(0)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)

  /**
   * Fetch billing history
   */
  const fetchBillingHistory = useCallback(async () => {
    const signal = abort.current.signal
    if (signal.aborted || billingHistoryIdentity() !== identity) return
    const requestId = ++requestIdRef.current
    setLoading(true)
    setLoadFailed(false)
    try {
      const response = isAdmin
        ? await getAllBillingHistory(page, pageSize, debouncedKeyword, signal)
        : await getUserBillingHistory(page, pageSize, debouncedKeyword, signal)

      if (requestId !== requestIdRef.current || signal.aborted) return

      if (isApiSuccess(response) && response.data) {
        setRecords(response.data.items || [])
        setTotal(response.data.total || 0)
      } else {
        handleServerError(response, i18next.t('Failed to load billing history'))
        setLoadFailed(true)
      }
    } catch (error) {
      if (requestId !== requestIdRef.current || signal.aborted) return
      handleServerError(error, i18next.t('Failed to load billing history'))
      setLoadFailed(true)
    } finally {
      if (requestId === requestIdRef.current && !signal.aborted) {
        setLoading(false)
      }
    }
  }, [debouncedKeyword, identity, isAdmin, page, pageSize])

  /**
   * Complete a pending order (admin only)
   */
  const handleCompleteOrder = useCallback(
    async (tradeNo: string) => {
      const signal = abort.current.signal
      if (
        signal.aborted ||
        pendingCompletion.current ||
        billingHistoryIdentity() !== identity
      ) {
        return false
      }
      if (!isAdmin) {
        toast.error(i18next.t('Admin access required'))
        return false
      }

      pendingCompletion.current = true
      setCompleting(true)
      try {
        const response = await completeOrder({ trade_no: tradeNo }, signal)
        if (signal.aborted) return false
        if (isApiSuccess(response)) {
          toast.success(i18next.t('Order completed successfully'))
          // Refresh the current search/page, not the values at confirmation.
          // Completion already succeeded; a refresh failure cannot undo it.
          setRefreshVersion((version) => version + 1)
          return true
        } else {
          handleServerError(response, i18next.t('Failed to complete order'))
          return false
        }
      } catch (error) {
        if (signal.aborted) return false
        handleServerError(error, i18next.t('Failed to complete order'))
        return false
      } finally {
        pendingCompletion.current = false
        if (!signal.aborted) setCompleting(false)
      }
    },
    [identity, isAdmin]
  )

  /**
   * Change page
   */
  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage)
  }, [])

  /**
   * Change page size
   */
  const handlePageSizeChange = useCallback((newPageSize: number) => {
    setPageSize(newPageSize)
    setPage(1) // Reset to first page when changing page size
  }, [])

  /**
   * Search by keyword
   */
  const handleSearch = useCallback((newKeyword: string) => {
    requestIdRef.current += 1
    setKeyword(newKeyword)
    setPage(1) // Reset to first page when searching
  }, [])

  // Fetch data after the search draft has settled.
  useEffect(() => {
    if (keyword !== debouncedKeyword) return

    fetchBillingHistory()
  }, [debouncedKeyword, fetchBillingHistory, keyword, refreshVersion])

  return {
    records,
    total,
    page,
    pageSize,
    keyword,
    loading,
    loadFailed,
    completing,
    isAdmin,
    handlePageChange,
    handlePageSizeChange,
    handleSearch,
    handleCompleteOrder,
    refresh: fetchBillingHistory,
  }
}
