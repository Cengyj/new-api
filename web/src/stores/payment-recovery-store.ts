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

interface PaymentRecoveryState {
  orders: Record<number, string[]>
  storageErrors: Record<number, boolean>
  remember: (userId: number, tradeNo: string) => void
  restore: (userId: number) => void
  resolve: (userId: number, tradeNos: string[]) => void
}

export const PAYMENT_RECOVERY_PREFIX = 'new-api:payment-recovery:v1:'

// References are not credentials or payment proof. Independent keys preserve
// concurrent checkouts from different tabs without a shared read/modify/write.
export const usePaymentRecoveryStore = create<PaymentRecoveryState>(
  (set, get) => ({
    orders: {},
    storageErrors: {},
    remember: (userId, tradeNo) => {
      if (
        !Number.isSafeInteger(userId) ||
        userId <= 0 ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(tradeNo)
      ) {
        return
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
      set((state) => ({
        orders: {
          ...state.orders,
          [userId]: [...new Set([...(state.orders[userId] ?? []), tradeNo])],
        },
        storageErrors: {
          ...state.storageErrors,
          [userId]: storageError || !!state.storageErrors[userId],
        },
      }))
    },
    restore: (userId) => {
      const orders = new Set(get().orders[userId] ?? [])
      const persisted = new Set<string>()
      let storageError = false
      const prefix = `${PAYMENT_RECOVERY_PREFIX}${userId}:`
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index)
          if (!key?.startsWith(prefix)) continue
          const tradeNo = localStorage.getItem(key)
          if (tradeNo === null) continue
          if (
            !/^[a-zA-Z0-9_-]{1,128}$/.test(tradeNo) ||
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
        orders: { ...state.orders, [userId]: [...orders] },
        storageErrors: { ...state.storageErrors, [userId]: storageError },
      }))
    },
    resolve: (userId, tradeNos) => {
      const resolved = new Set<string>()
      let storageError = false
      for (const tradeNo of tradeNos) {
        if (!(get().orders[userId] ?? []).includes(tradeNo)) continue
        try {
          localStorage.removeItem(
            `${PAYMENT_RECOVERY_PREFIX}${userId}:${tradeNo}`
          )
          resolved.add(tradeNo)
        } catch {
          storageError = true
        }
      }
      set((state) => {
        const remaining = (state.orders[userId] ?? []).filter(
          (tradeNo) => !resolved.has(tradeNo)
        )
        return {
          orders: { ...state.orders, [userId]: remaining },
          storageErrors: {
            ...state.storageErrors,
            [userId]:
              storageError ||
              (remaining.length > 0 && !!state.storageErrors[userId]),
          },
        }
      })
    },
  })
)
