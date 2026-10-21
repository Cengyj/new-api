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
import { z } from 'zod'

export const referralRuleSchema = z
  .object({
    enabled: z.boolean(),
    percentage: z.string(),
    valid_days: z.string(),
  })
  .superRefine((rule, ctx) => {
    if (!rule.enabled && rule.percentage === '' && rule.valid_days === '') {
      return
    }
    if (
      !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(rule.percentage) ||
      Number(rule.percentage) < 0.01 ||
      Number(rule.percentage) > 100
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['percentage'],
        message:
          'Enter a percentage from 0.01 to 100 with at most two decimal places',
      })
    }
    // The server also bounds expiry against its transaction time and storage range.
    if (
      !/^[1-9]\d*$/.test(rule.valid_days) ||
      !Number.isSafeInteger(Number(rule.valid_days))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['valid_days'],
        message:
          'Enter a positive whole number of days within the supported range',
      })
    }
  })
