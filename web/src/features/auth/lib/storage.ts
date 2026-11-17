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
/**
 * Utilities for managing authentication-related browser storage
 */

// ============================================================================
// LocalStorage Keys
// ============================================================================

const STORAGE_KEYS = {
  AFFILIATE: 'aff',
  STATUS: 'status',
} as const

// ============================================================================
// Affiliate Code Storage
// ============================================================================

// Invitation codes are public inputs, not credentials. Keep the current page's
// input when storage is blocked/full so registration cannot use a stale code.
let currentAffiliateCode = ''
let affiliateWriteFailed = false

/**
 * Get affiliate code from localStorage
 */
export function getAffiliateCode(): string {
  if (typeof window === 'undefined') return ''
  if (affiliateWriteFailed) return currentAffiliateCode
  try {
    currentAffiliateCode =
      window.localStorage.getItem(STORAGE_KEYS.AFFILIATE) ?? ''
    return currentAffiliateCode
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to get affiliate code:', error)
    return currentAffiliateCode
  }
}

/**
 * Save affiliate code to localStorage
 */
export function saveAffiliateCode(code: string): void {
  if (typeof window === 'undefined') return
  currentAffiliateCode = code
  try {
    window.localStorage.setItem(STORAGE_KEYS.AFFILIATE, code)
    affiliateWriteFailed = false
  } catch (error) {
    affiliateWriteFailed = true
    // eslint-disable-next-line no-console
    console.error('Failed to save affiliate code:', error)
  }
}
