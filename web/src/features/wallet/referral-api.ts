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
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

export interface ReferralRule {
  enabled: boolean
  rate_bps: number
  valid_days: number
}
export interface ReferralRuleInput {
  enabled: boolean
  percentage: string
  valid_days: string
}
export interface ReferralSummary {
  rule: ReferralRule
  compliance_confirmed: boolean
  aff_quota: string
  aff_history_quota: string
  rebate_quota: string
  direct_count: number
}
export interface ReferralInvitee {
  id: number
  display_name: string
  deleted: boolean
  created_at: number | null
  status: 'none' | 'active' | 'expired' | 'paused'
  rate_bps: number | null
  expires_at: number | null
  rebate_quota: string
}
export interface ReferralRecord {
  id: number
  trade_no: string
  inviter_id: number
  invitee_id: number
  credited_quota: string
  rate_bps: number
  reward_quota: string
  settled_at: number
  created_at: number
}
export interface ReferralPage<T> {
  items: T[]
  total: number
}
export interface ReferralRecordPage extends ReferralPage<ReferralRecord> {
  credited_quota: string
  reward_quota: string
}
export interface ReferralFilters {
  inviter_id: string
  invitee_id: string
  trade_no: string
  start_time: string
  end_time: string
}
export interface AffiliateTransferResult {
  found: boolean
  transfer: {
    id: number
    request_id: string
    quota: number
    created_at: number
  } | null
  rejection?: {
    request_id: string
    quota: number
    message_key: string
    message_params?: Record<string, unknown>
  }
}

// Bind every request to the initiating login. Aborting only prevents client
// delivery; a submitted transfer remains pending until its ID is reconciled.
export function referralIdentity(): string {
  const auth = useAuthStore.getState().auth
  return `${auth.user?.id ?? ''}:${auth.session?.sid ?? ''}`
}

export async function referralRequest<T>(
  path: string,
  options: {
    method?: 'get' | 'post' | 'put'
    data?: unknown
    params?: unknown
    signal?: AbortSignal
    identity?: string
  } = {}
): Promise<T> {
  const identity = options.identity ?? referralIdentity()
  const controller = new AbortController()
  const abort = () => controller.abort()
  const unsubscribe = useAuthStore.subscribe(() => {
    if (referralIdentity() !== identity) abort()
  })
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted || referralIdentity() !== identity) abort()
  try {
    const response = await api.request({
      method: options.method ?? 'get',
      url: path,
      data: options.data,
      params: options.params,
      signal: controller.signal,
      skipAuthRefresh: true,
      skipErrorHandler: true,
      disableDuplicate: true,
    })
    if (referralIdentity() !== identity || controller.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    return requireServerSuccess(response.data).data as T
  } finally {
    unsubscribe()
    options.signal?.removeEventListener('abort', abort)
  }
}

export function getReferralSummary(signal?: AbortSignal, identity?: string) {
  return referralRequest<ReferralSummary>('/api/user/referral', {
    signal,
    identity,
  })
}
export function getReferralInvitees(
  page: number,
  pageSize: number,
  signal?: AbortSignal,
  identity?: string
) {
  return referralRequest<ReferralPage<ReferralInvitee>>(
    '/api/user/referral/invitees',
    { params: { p: page, page_size: pageSize }, signal, identity }
  )
}
export function getReferralRecords(
  page: number,
  pageSize: number,
  filters: ReferralFilters,
  signal?: AbortSignal,
  identity?: string
) {
  return referralRequest<ReferralRecordPage>('/api/user/referral_rebates', {
    params: { p: page, page_size: pageSize, ...filters },
    signal,
    identity,
  })
}
