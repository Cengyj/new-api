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
import { AuthOperationError } from '@/lib/secure-verification'

/**
 * Utilities for managing authentication-related browser storage
 */

// ============================================================================
// LocalStorage Keys
// ============================================================================

const STORAGE_KEYS = {
  AFFILIATE: 'aff',
  AFFILIATE_FALLBACK: 'new-api:affiliate-code:fallback:v1',
  STATUS: 'status',
} as const

// ============================================================================
// Affiliate Code Storage
// ============================================================================

// Invitation codes are public inputs, not credentials. A failed durable write
// keeps the current input in this tab, including across a reload when possible.
let currentAffiliateCode = ''
let affiliateCodeKnown = false
let affiliateFallbackLoaded = false
let affiliateFallback: {
  code: string | null
  storedCode?: string | null
} | null = null

function clearAffiliateFallback(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEYS.AFFILIATE_FALLBACK)
  } catch {
    try {
      window.sessionStorage.setItem(STORAGE_KEYS.AFFILIATE_FALLBACK, 'null')
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to clear affiliate code fallback:', error)
    }
  }
}

/**
 * Get affiliate code from localStorage
 */
export function getAffiliateCode(): string {
  if (typeof window === 'undefined') return ''
  if (!affiliateFallbackLoaded || affiliateFallback?.code === null) {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEYS.AFFILIATE_FALLBACK)
      affiliateFallbackLoaded = true
      if (raw !== null && raw !== 'null') {
        // A damaged fallback cannot establish that an older durable code is
        // still the intended invitation. A new invitation can replace it.
        affiliateCodeKnown = false
        affiliateFallback = {
          code: null,
          storedCode:
            affiliateFallback?.code === null
              ? affiliateFallback.storedCode
              : undefined,
        }
        const saved: unknown = JSON.parse(raw)
        if (
          typeof saved !== 'object' ||
          saved === null ||
          !('code' in saved) ||
          typeof saved.code !== 'string'
        ) {
          throw new Error('Invalid saved invitation')
        }
        const storedCode = 'storedCode' in saved ? saved.storedCode : undefined
        if (
          storedCode !== undefined &&
          storedCode !== null &&
          typeof storedCode !== 'string'
        ) {
          throw new Error('Invalid saved invitation')
        }
        currentAffiliateCode = saved.code
        affiliateCodeKnown = true
        affiliateFallback = { code: saved.code, storedCode }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to get affiliate code fallback:', error)
      if (!affiliateFallbackLoaded) {
        throw new AuthOperationError(
          'Unable to read your invitation information. Allow browser storage or reopen your invitation link, then try again.',
          undefined,
          { cause: error }
        )
      }
    }
  }
  try {
    const storedCode = window.localStorage.getItem(STORAGE_KEYS.AFFILIATE)
    if (affiliateFallback && affiliateFallback.storedCode === undefined) {
      // The first readable old value must not replace the current invitation.
      // Remember it so a later change in another tab can take precedence.
      affiliateFallback.storedCode = storedCode
      if (affiliateFallback.code !== null) {
        try {
          window.sessionStorage.setItem(
            STORAGE_KEYS.AFFILIATE_FALLBACK,
            JSON.stringify(affiliateFallback)
          )
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('Failed to save affiliate code fallback:', error)
        }
      }
    }
    if (affiliateFallback && storedCode === affiliateFallback.storedCode) {
      if (affiliateFallback.code === null) {
        throw new Error('Invalid saved invitation')
      }
      return currentAffiliateCode
    }
    currentAffiliateCode = storedCode ?? ''
    affiliateCodeKnown = true
    if (affiliateFallback) {
      // Another tab has changed or removed the old value. Follow the durable
      // invitation again rather than allowing this tab's fallback to mask it.
      affiliateFallback = null
      clearAffiliateFallback()
    }
    return currentAffiliateCode
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to get affiliate code:', error)
    if (!affiliateCodeKnown) {
      throw new AuthOperationError(
        'Unable to read your invitation information. Allow browser storage or reopen your invitation link, then try again.',
        undefined,
        { cause: error }
      )
    }
    return currentAffiliateCode
  }
}

/**
 * Save affiliate code to localStorage
 */
export function saveAffiliateCode(code: string): void {
  if (typeof window === 'undefined') return
  currentAffiliateCode = code
  affiliateCodeKnown = true
  affiliateFallbackLoaded = true
  try {
    window.localStorage.setItem(STORAGE_KEYS.AFFILIATE, code)
  } catch (error) {
    affiliateFallback = { code }
    try {
      window.localStorage.removeItem(STORAGE_KEYS.AFFILIATE)
    } catch {
      // Even deletion can be blocked; compare that old value on later reads.
    }
    try {
      affiliateFallback.storedCode = window.localStorage.getItem(
        STORAGE_KEYS.AFFILIATE
      )
    } catch {
      // An unreadable old value must not supersede this known page input.
    }
    try {
      window.sessionStorage.setItem(
        STORAGE_KEYS.AFFILIATE_FALLBACK,
        JSON.stringify(affiliateFallback)
      )
    } catch (fallbackError) {
      // If both stores reject writes, only this page's memory can retain it.
      // Remove an older fallback so a reload cannot restore that invitation.
      clearAffiliateFallback()
      // eslint-disable-next-line no-console
      console.error('Failed to save affiliate code fallback:', fallbackError)
    }
    // eslint-disable-next-line no-console
    console.error('Failed to save affiliate code:', error)
    return
  }
  affiliateFallback = null
  clearAffiliateFallback()
}
