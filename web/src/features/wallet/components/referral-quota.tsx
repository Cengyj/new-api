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
import { formatQuotaWithCurrency } from '@/lib/currency'

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
  return (
    <span className='max-w-full min-w-0 [overflow-wrap:anywhere] break-words whitespace-normal tabular-nums'>
      {safe
        ? formatQuotaWithCurrency(Number(exact), {
            abbreviate: false,
            digitsLarge: 6,
            digitsSmall: 6,
          })
        : t('{{amount}} quota units', { amount: raw })}
    </span>
  )
}
