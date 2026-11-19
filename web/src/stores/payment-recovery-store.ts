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
import { create } from 'zustand'

type PendingStorageChange = 'remove' | { replacesAttempt?: string }

interface PaymentRecoveryState {
  orders: Record<number, string[]>
  attempts: Record<number, string[]>
  storageErrors: Record<number, boolean>
  pendingChanges: Record<number, Map<string, PendingStorageChange>>
  remember: (
    userId: number,
    reference: string,
    options?: { awaitingReceipt?: boolean; replacesAttempt?: string }
  ) => boolean
  restore: (
    userId: number,
    changes?: { retired?: string; dispatched?: string; resolved?: string[] }
  ) => void
  resolve: (userId: number, tradeNos: string[]) => void
}

export const PAYMENT_RECOVERY_PREFIX = 'new-api:payment-recovery:v1:'

// The "~" prefix cannot occur in a server trade number. The timestamp is for
// the payer to find a purchase in history, never for matching it automatically.
export const paymentAttemptPattern = /^~(\d{13})-[a-f0-9]{32}$/

// References are not credentials or payment proof. Independent keys preserve
// concurrent checkouts from different tabs without a shared read/modify/write.
export const usePaymentRecoveryStore = create<PaymentRecoveryState>(
  (set, get) => ({
    orders: {},
    attempts: {},
    storageErrors: {},
    pendingChanges: {},
    remember: (userId, tradeNo, { awaitingReceipt, replacesAttempt } = {}) => {
      if (
        !Number.isSafeInteger(userId) ||
        userId <= 0 ||
        (!/^[a-zA-Z0-9_-]{1,128}$/.test(tradeNo) &&
          !paymentAttemptPattern.test(tradeNo))
      ) {
        return false
      }
      let storageError = false
      try {
        localStorage.setItem(
          `${PAYMENT_RECOVERY_PREFIX}${userId}:${tradeNo}`,
          tradeNo
        )
      } catch {
        storageError = true
      }
      // A new page can already restore the dispatched request. The sending
      // page needs a reminder when the receipt is lost or storage failed.
      if (awaitingReceipt && !storageError) return true
      const field = paymentAttemptPattern.test(tradeNo) ? 'attempts' : 'orders'
      set((state) => {
        const references = state[field][userId] ?? []
        const pending = new Map(state.pendingChanges[userId])
        if (!storageError) {
          pending.delete(tradeNo)
        } else if (!references.includes(tradeNo) || pending.has(tradeNo)) {
          pending.set(tradeNo, { replacesAttempt })
        }
        return {
          [field]: {
            ...state[field],
            [userId]: [...new Set([...references, tradeNo])],
          },
          pendingChanges: { ...state.pendingChanges, [userId]: pending },
          storageErrors: {
            ...state.storageErrors,
            [userId]: storageError || !!state.storageErrors[userId],
          },
        }
      })
      return !storageError
    },
    restore: (userId, { retired, dispatched, resolved = [] } = {}) => {
      const orders = new Set([
        ...(get().orders[userId] ?? []),
        ...(get().attempts[userId] ?? []),
      ])
      const pending = new Map(get().pendingChanges[userId])
      if (retired) {
        pending.delete(retired)
        if (paymentAttemptPattern.test(retired)) orders.delete(retired)
      }
      for (const reference of resolved) {
        if (!orders.has(reference) && !paymentAttemptPattern.test(reference)) {
          continue
        }
        const change = pending.get(reference)
        if (change && change !== 'remove' && change.replacesAttempt) {
          pending.set(change.replacesAttempt, 'remove')
        }
        pending.set(reference, 'remove')
      }
      const persisted = new Set<string>()
      let storageError = false
      const prefix = `${PAYMENT_RECOVERY_PREFIX}${userId}:`
      if (dispatched) orders.add(dispatched)
      // Retry only failed writes. A reference saved earlier may have been
      // retired by another tab while this wallet was closed.
      for (const [reference, change] of pending) {
        if (change === 'remove') continue
        try {
          const key = `${prefix}${reference}`
          const value = localStorage.getItem(key)
          if (value === null) localStorage.setItem(key, reference)
          else if (value !== reference) continue
          pending.delete(reference)
          if (change.replacesAttempt) {
            pending.set(change.replacesAttempt, 'remove')
          }
        } catch {
          // Keep the reference and its fallback until the write succeeds.
        }
      }
      for (const [reference, change] of pending) {
        if (change !== 'remove') continue
        try {
          localStorage.removeItem(`${prefix}${reference}`)
          orders.delete(reference)
          pending.delete(reference)
        } catch {
          // A later recovery can finish this known resolution.
        }
      }
      try {
        // Another tab may already have checked this request. A late timeout
        // must not recreate a marker once its original save or retry succeeded.
        if (
          dispatched &&
          !pending.has(dispatched) &&
          localStorage.getItem(`${prefix}${dispatched}`) === null
        ) {
          orders.delete(dispatched)
        }
        // Capture names before reading: another tab can remove an earlier key
        // during a read, shifting numeric indexes past an unresolved order.
        for (const key of Object.keys(localStorage)) {
          if (!key.startsWith(prefix)) continue
          const tradeNo = localStorage.getItem(key)
          if (tradeNo === null) continue
          if (
            (!/^[a-zA-Z0-9_-]{1,128}$/.test(tradeNo) &&
              !paymentAttemptPattern.test(tradeNo)) ||
            key !== `${prefix}${tradeNo}`
          ) {
            storageError = true
            continue
          }
          orders.add(tradeNo)
          persisted.add(tradeNo)
        }
        // A deleted key may have been checked in another tab. Retain this tab's
        // reference until its own query resolves it, but never recreate the key.
        storageError ||= [...orders].some((tradeNo) => !persisted.has(tradeNo))
      } catch {
        storageError = true
      }
      set((state) => ({
        orders: {
          ...state.orders,
          [userId]: [...orders].filter(
            (reference) => !paymentAttemptPattern.test(reference)
          ),
        },
        attempts: {
          ...state.attempts,
          [userId]: [...orders].filter((reference) =>
            paymentAttemptPattern.test(reference)
          ),
        },
        pendingChanges: { ...state.pendingChanges, [userId]: pending },
        storageErrors: {
          ...state.storageErrors,
          [userId]: storageError || pending.size > 0,
        },
      }))
    },
    resolve: (userId, tradeNos) => {
      get().restore(userId, { resolved: tradeNos })
    },
  })
)
