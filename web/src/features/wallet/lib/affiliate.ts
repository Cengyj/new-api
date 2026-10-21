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
import { getCurrencyDisplay } from '@/lib/currency'

// ============================================================================
// Affiliate Functions
// ============================================================================

/**
 * Generate affiliate registration link
 */
export function generateAffiliateLink(affCode: string): string {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}/sign-up?aff=${affCode}`
}

/** Round one reward-transfer input to quota units without binary-float drift. */
export function parseAffiliateTransferQuota(amount: string): number {
  const { config, meta } = getCurrencyDisplay()
  const factors =
    meta.kind === 'tokens'
      ? [amount]
      : [amount, String(config.quotaPerUnit), String(meta.exchangeRate)]
  let numerator = 1n
  let denominator = 1n

  for (const [index, value] of factors.entries()) {
    // Money inputs need far fewer digits than this bound. Limit the work before
    // constructing integers from untrusted browser input or display settings.
    if (
      value.length > 128 ||
      !Number.isFinite(Number(value)) ||
      Number(value) <= 0
    ) {
      return Number.NaN
    }
    const decimal = /^\+?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value)
    if (!decimal || !(decimal[1] || decimal[2])) return Number.NaN
    const digits = BigInt(decimal[1] + (decimal[2] ?? ''))
    const scale = (decimal[2]?.length ?? 0) - Number(decimal[3] ?? 0)
    const factorNumerator = digits * 10n ** BigInt(Math.max(-scale, 0))
    const factorDenominator = 10n ** BigInt(Math.max(scale, 0))
    // Preserve the shared currency contract: amount * quota-per-USD / rate.
    numerator *= index === 2 ? factorDenominator : factorNumerator
    denominator *= index === 2 ? factorNumerator : factorDenominator
  }

  // Inputs are positive; retain the existing nearest-integer, half-up policy.
  const quota = (2n * numerator + denominator) / (2n * denominator)
  return quota <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(quota) : Number.NaN
}
