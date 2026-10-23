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
import { useTranslation } from 'react-i18next'

import { toIntlLocale } from '@/i18n/languages'
import { formatQuotaWithCurrency, getCurrencyDisplay } from '@/lib/currency'
import { quotaUnitsToDollars } from '@/lib/format'

import { parseAffiliateTransferQuota } from '../lib/affiliate'

/** Keep ordinary amounts compact without rounding unsafe integer totals. */
export function ReferralQuota(props: { value: string }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  if (!/^-?\d+$/.test(props.value)) return <span>—</span>
  const exact = BigInt(props.value)
  const safe =
    exact <= BigInt(Number.MAX_SAFE_INTEGER) &&
    exact >= BigInt(Number.MIN_SAFE_INTEGER)
  const raw = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(exact)
  let display = t('{{amount}} quota units', { amount: raw })
  if (safe) {
    const quota = Number(exact)
    // Even a safe integer can lose quota units during currency conversion.
    // Check the unrounded amount so normal six-decimal display rounding stays
    // unchanged; token mode also checks the formatter's USD round trip.
    const amount =
      getCurrencyDisplay().meta.kind === 'tokens'
        ? formatQuotaWithCurrency(Math.abs(quota), { abbreviate: false })
        : String(Math.abs(quotaUnitsToDollars(quota)))
    if (
      quota === 0 ||
      parseAffiliateTransferQuota(amount) === Math.abs(quota)
    ) {
      display = formatQuotaWithCurrency(quota, {
        abbreviate: false,
        digitsLarge: 6,
        digitsSmall: 6,
      })
    }
  }
  return (
    <span className='max-w-full min-w-0 [overflow-wrap:anywhere] break-words whitespace-normal tabular-nums'>
      {display}
    </span>
  )
}
