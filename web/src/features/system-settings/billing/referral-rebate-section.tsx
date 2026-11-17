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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { ReferralRecordsDialog } from '@/features/wallet/components/dialogs/referral-records-dialog'
import { referralRuleSchema } from '@/features/wallet/lib/referral-rule'
import {
  referralIdentity,
  referralRequest,
  type ReferralRule,
  type ReferralRuleInput,
} from '@/features/wallet/referral-api'
import { ROLE } from '@/lib/roles'
import { getServerErrorMessage } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { FormDirtyIndicator } from '../components/form-dirty-indicator'
import { FormNavigationGuard } from '../components/form-navigation-guard'
import {
  SettingsForm,
  SettingsFormGrid,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import {
  SettingsPageActionsPortal,
  SettingsPageFormActions,
} from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useSettingsForm } from '../hooks/use-settings-form'

export function ReferralRebateSection() {
  const role = useAuthStore((state) => state.auth.user?.role)
  // The rule GET and PUT both require RootAuth. Unmounting also aborts
  // client delivery of in-flight reads and saves when the role loses access.
  if (role === undefined || role < ROLE.SUPER_ADMIN) return null
  return <ReferralRebateSectionContent />
}

function ReferralRebateSectionContent() {
  const { t } = useTranslation()
  const user = useAuthStore((state) => state.auth.user)
  const identity = useAuthStore(referralIdentity)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const query = useQuery({
    queryKey: ['referral-rule', identity],
    queryFn: ({ signal }) =>
      referralRequest<ReferralRule>('/api/option/referral_rebate', {
        signal,
        identity,
      }),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { errorToast: false },
  })
  return (
    <SettingsSection title={t('Invitation top-up rebates')}>
      {user && user.role >= ROLE.ADMIN && (
        <SettingsPageActionsPortal>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setRecordsOpen(true)}
          >
            {t('Top-up rebate records')}
          </Button>
        </SettingsPageActionsPortal>
      )}
      {query.isPending && <Skeleton className='h-48' />}
      {query.isError && !query.data && (
        <ErrorState onRetry={() => void query.refetch()} />
      )}
      {query.data && (
        <ReferralRebateForm
          key={`rule:${identity}`}
          initialRule={query.data}
          canWrite={user?.role === ROLE.SUPER_ADMIN}
        />
      )}
      {recordsOpen && (
        <ReferralRecordsDialog
          key={`records:${identity}`}
          onOpenChange={setRecordsOpen}
        />
      )}
    </SettingsSection>
  )
}

function ReferralRebateForm(props: {
  initialRule: ReferralRule
  canWrite: boolean
}) {
  const { t } = useTranslation()
  const identity = referralIdentity()
  const client = useQueryClient()
  const abort = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController()
    abort.current = controller
    return () => controller.abort()
  }, [])
  // Freeze the initial baseline: query refreshes must not replace local edits.
  const [defaults] = useState<ReferralRuleInput>(() => ({
    enabled: props.initialRule.enabled,
    percentage: props.initialRule.rate_bps
      ? String(props.initialRule.rate_bps / 100)
      : '',
    valid_days: props.initialRule.valid_days
      ? String(props.initialRule.valid_days)
      : '',
  }))
  const save = useMutation({
    retry: false,
    meta: { errorToast: false },
    mutationFn: (data: ReferralRuleInput) =>
      referralRequest<ReferralRule>('/api/option/referral_rebate', {
        method: 'put',
        data,
        identity,
        signal: abort.current.signal,
      }),
  })
  const { form, handleSubmit, handleReset, isDirty, isSubmitting } =
    useSettingsForm<ReferralRuleInput>({
      resolver: zodResolver(referralRuleSchema),
      defaultValues: defaults,
      onSubmit: async (data) => {
        const signal = abort.current.signal
        form.clearErrors('root')
        try {
          const rule = await save.mutateAsync(data)
          if (signal.aborted || referralIdentity() !== identity) return
          // A read started before this save must not publish the previous rule.
          await client.cancelQueries({
            queryKey: ['referral-rule', identity],
            exact: true,
          })
          if (signal.aborted || referralIdentity() !== identity) return
          client.setQueryData(['referral-rule', identity], rule)
          toast.success(t('Saved successfully'))
          // Refresh is a separate consequence. Saving already succeeded.
          void client
            .invalidateQueries({ queryKey: ['referral'] })
            .catch(() => {})
        } catch (error) {
          if (!signal.aborted && referralIdentity() === identity) {
            form.setError('root', { message: getServerErrorMessage(error) })
          }
          throw error
        }
      },
    })
  const submit = () => {
    void handleSubmit().catch(() => {})
  }
  return (
    <>
      <FormNavigationGuard when={isDirty} />
      <Form {...form}>
        <SettingsForm
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <SettingsPageFormActions
            onSave={submit}
            onReset={handleReset}
            isSaving={isSubmitting}
            isSaveDisabled={!props.canWrite || !isDirty}
            isResetDisabled={!isDirty}
          />
          <FormDirtyIndicator isDirty={isDirty} />
          <FormField
            control={form.control}
            name='enabled'
            render={({ field }) => (
              <SettingsSwitchItem>
                <SettingsSwitchContent>
                  <FormLabel>{t('Enable invitation top-up rebates')}</FormLabel>
                  <FormDescription>
                    {t(
                      'Rates and expiry are fixed at registration. Rule changes affect only new eligibility.'
                    )}
                  </FormDescription>
                </SettingsSwitchContent>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={!props.canWrite || isSubmitting}
                  />
                </FormControl>
              </SettingsSwitchItem>
            )}
          />
          <SettingsFormGrid>
            <FormField
              control={form.control}
              name='percentage'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Rebate percentage (%)')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      inputMode='decimal'
                      disabled={!props.canWrite || isSubmitting}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Eligible wallet top-ups and authorized order completion participate. Other balance credits and subscriptions do not.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='valid_days'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Valid days after registration')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      inputMode='numeric'
                      disabled={!props.canWrite || isSubmitting}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'One day is 24 hours. Pausing does not extend expiry or grant missed rebates.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </SettingsFormGrid>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Disabling keeps the configured rate and days. Existing registration rewards are independent.'
            )}
          </p>
          {form.formState.errors.root?.message && (
            <p role='alert' className='text-destructive text-sm'>
              {form.formState.errors.root.message}
            </p>
          )}
        </SettingsForm>
      </Form>
    </>
  )
}
