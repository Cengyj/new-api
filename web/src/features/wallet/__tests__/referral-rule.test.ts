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
import { expect, test } from 'vitest'

import { referralRuleSchema } from '../lib/referral-rule'

test.each([
  '0',
  '-1',
  '0.001',
  '10.001',
  '100.01',
  'Infinity',
  'NaN',
  '1e1',
  ' 10',
  '',
])('invalid percentage %s is rejected without rounding', (percentage) => {
  expect(
    referralRuleSchema.safeParse({
      enabled: true,
      percentage,
      valid_days: '30',
    }).success
  ).toBe(false)
})
test.each(['0.01', '10', '10.25', '100', '100.00'])(
  'valid exact percentage %s is accepted',
  (percentage) => {
    expect(
      referralRuleSchema.safeParse({
        enabled: true,
        percentage,
        valid_days: '30',
      }).success
    ).toBe(true)
  }
)
test.each(['0', '-1', '1.5', '1e2', '9007199254740992', ''])(
  'invalid days %s are rejected',
  (valid_days) => {
    expect(
      referralRuleSchema.safeParse({
        enabled: true,
        percentage: '10',
        valid_days,
      }).success
    ).toBe(false)
  }
)
test('disabled unconfigured rules allow blanks while partial and zero rules are rejected', () => {
  expect(
    referralRuleSchema.safeParse({
      enabled: false,
      percentage: '',
      valid_days: '',
    }).success
  ).toBe(true)
  expect(
    referralRuleSchema.safeParse({
      enabled: false,
      percentage: '0',
      valid_days: '30',
    }).success
  ).toBe(false)
  expect(
    referralRuleSchema.safeParse({
      enabled: false,
      percentage: '10',
      valid_days: '',
    }).success
  ).toBe(false)
  expect(
    referralRuleSchema.safeParse({
      enabled: false,
      percentage: '10',
      valid_days: '30',
    }).success
  ).toBe(true)
})
