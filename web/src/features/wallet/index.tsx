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
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout'
import { useStatus } from '@/hooks/use-status'
import { useSystemConfig } from '@/hooks/use-system-config'
import { getSelf } from '@/lib/api'
import { getCurrencyDisplay } from '@/lib/currency'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { AffiliateRewardsCard } from './components/affiliate-rewards-card'
import { BillingHistoryDialog } from './components/dialogs/billing-history-dialog'
import { CreemConfirmDialog } from './components/dialogs/creem-confirm-dialog'
import { PaymentConfirmDialog } from './components/dialogs/payment-confirm-dialog'
import { RechargeFormCard } from './components/recharge-form-card'
import { SubscriptionPlansCard } from './components/subscription-plans-card'
import { WalletStatsCard } from './components/wallet-stats-card'
import { DEFAULT_DISCOUNT_RATE, PAYMENT_TYPES } from './constants'
import {
  useTopupInfo,
  usePayment,
  useRedemption,
  useCreemPayment,
  useWaffoPayment,
  useWaffoPancakePayment,
} from './hooks'
import {
  getDefaultPaymentType,
  getMinTopupAmount,
  getPaymentMethodMinTopup,
  dispatchSelectedPayment,
} from './lib'
import { isValidTopupAmount } from './lib/payment'
import { referralIdentity } from './referral-api'
import type {
  UserWalletData,
  PaymentMethod,
  PresetAmount,
  CreemProduct,
  WaffoPayMethod,
} from './types'

interface WalletProps {
  initialShowHistory?: boolean
}

interface PaymentConfirmation {
  identity: string
  version: number
  topupAmount: number
  paymentAmount: number
  paymentMethod: PaymentMethod
  waffoMethodIndex: number | null
  waffoMethod?: Pick<WaffoPayMethod, 'payMethodType' | 'payMethodName'>
}

export function Wallet(props: WalletProps) {
  const referralAccount = useAuthStore(
    (state) => `${state.auth.user?.id ?? ''}:${state.auth.session?.sid ?? ''}`
  )
  const { t } = useTranslation()
  const [user, setUser] = useState<UserWalletData | null>(null)
  const [userLoading, setUserLoading] = useState(true)
  const [userError, setUserError] = useState(false)
  const userRequestVersion = useRef(0)
  const [topupAmount, setTopupAmount] = useState(0)
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null)
  const [selectedPaymentMethod, setSelectedPaymentMethod] =
    useState<PaymentMethod>()
  const [paymentConfirmation, setPaymentConfirmation] =
    useState<PaymentConfirmation | null>(null)
  const paymentSelectionVersion = useRef(0)
  const creemSelectionIdentity = useRef('')
  const [paymentLoading, setPaymentLoading] = useState<string | null>(null)
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)
  const [billingDialogOpen, setBillingDialogOpen] = useState(false)
  const [redemptionCode, setRedemptionCode] = useState('')
  const [creemDialogOpen, setCreemDialogOpen] = useState(false)
  const [selectedCreemProduct, setSelectedCreemProduct] =
    useState<CreemProduct | null>(null)
  const [showSubscriptionPanel, setShowSubscriptionPanel] = useState(true)

  const { status } = useStatus()
  // Keep shared currency metadata reactive to configuration updates.
  useSystemConfig()
  const { topupInfo, presetAmounts, loading: topupLoading } = useTopupInfo()

  // Non-token topups use system USD; token-mode requests already contain quota.
  const { meta: currencyDisplay } = getCurrencyDisplay()
  const effectiveUsdExchangeRate =
    currencyDisplay.kind === 'tokens' ? 1 : currencyDisplay.exchangeRate
  const {
    amount: paymentAmount,
    calculating,
    processing,
    calculatePaymentAmount,
    processPayment,
  } = usePayment()
  const { redeeming, redeemCode } = useRedemption()
  const { processing: creemProcessing, processCreemPayment } = useCreemPayment()
  const { processing: waffoProcessing, processWaffoPayment } = useWaffoPayment()
  const { processing: pancakeProcessing, processWaffoPancakePayment } =
    useWaffoPancakePayment()

  useEffect(() => {
    let identity = referralIdentity()
    const unsubscribe = useAuthStore.subscribe(() => {
      const currentIdentity = referralIdentity()
      if (currentIdentity === identity) return
      identity = currentIdentity
      userRequestVersion.current += 1
      setUser(null)
      setUserError(false)
      setUserLoading(!!useAuthStore.getState().auth.user?.id)
      paymentSelectionVersion.current += 1
      creemSelectionIdentity.current = ''
      setPaymentConfirmation(null)
      setSelectedPaymentMethod(undefined)
      setSelectedCreemProduct(null)
      setConfirmDialogOpen(false)
      setCreemDialogOpen(false)
      setPaymentLoading(null)
    })
    return () => {
      userRequestVersion.current += 1
      paymentSelectionVersion.current += 1
      creemSelectionIdentity.current = ''
      unsubscribe()
    }
  }, [])

  // Fetch and refresh user data
  const fetchUser = useCallback(async (throwOnError = false) => {
    const identity = referralIdentity()
    const version = ++userRequestVersion.current
    try {
      setUserLoading(true)
      setUserError(false)
      // A post-transfer refresh must not reuse a balance read started before it.
      const response = await getSelf({ disableDuplicate: true })
      if (
        referralIdentity() !== identity ||
        version !== userRequestVersion.current
      ) {
        return
      }
      requireServerSuccess(response)
      if (response.success && response.data) {
        setUser(response.data as UserWalletData)
      }
    } catch (error) {
      if (
        referralIdentity() !== identity ||
        version !== userRequestVersion.current
      ) {
        return
      }
      setUserError(true)
      if (throwOnError) throw error
    } finally {
      if (
        referralIdentity() === identity &&
        version === userRequestVersion.current
      ) {
        setUserLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (useAuthStore.getState().auth.user?.id) void fetchUser()
  }, [fetchUser, referralAccount])

  useEffect(() => {
    if (props.initialShowHistory) {
      setBillingDialogOpen(true)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [props.initialShowHistory])

  // Initialize topup amount when topup info is loaded
  const topupAmountInitializedRef = useRef(false)
  useEffect(() => {
    if (topupInfo && !topupAmountInitializedRef.current) {
      topupAmountInitializedRef.current = true
      const minTopup = getMinTopupAmount(topupInfo)
      setTopupAmount(minTopup)

      // Calculate initial payment amount with default payment type
      const defaultPaymentType = getDefaultPaymentType(topupInfo)
      calculatePaymentAmount(minTopup, defaultPaymentType)
    }
  }, [topupInfo, calculatePaymentAmount])

  // Get current payment type (selected or default)
  const getCurrentPaymentType = useCallback(() => {
    return selectedPaymentMethod?.type || getDefaultPaymentType(topupInfo)
  }, [selectedPaymentMethod, topupInfo])

  // Handle preset selection
  const handleSelectPreset = (preset: PresetAmount) => {
    paymentSelectionVersion.current += 1
    setPaymentConfirmation(null)
    setConfirmDialogOpen(false)
    setPaymentLoading(null)
    setTopupAmount(preset.value)
    setSelectedPreset(preset.value)
    calculatePaymentAmount(preset.value, getCurrentPaymentType())
  }

  // Handle topup amount change
  const handleTopupAmountChange = (amount: number) => {
    paymentSelectionVersion.current += 1
    setPaymentConfirmation(null)
    setConfirmDialogOpen(false)
    setPaymentLoading(null)
    setTopupAmount(amount)
    setSelectedPreset(null)
    calculatePaymentAmount(amount, getCurrentPaymentType())
  }

  // Handle payment method selection
  const handlePaymentMethodSelect = async (method: PaymentMethod) => {
    const identity = referralIdentity()
    const version = ++paymentSelectionVersion.current
    setPaymentConfirmation(null)
    setConfirmDialogOpen(false)
    setSelectedPaymentMethod(method)
    setPaymentLoading(method.type)

    try {
      // Validate minimum topup
      const minTopup = getPaymentMethodMinTopup(topupInfo, method)
      if (!isValidTopupAmount(topupAmount) || topupAmount < minTopup) {
        return
      }

      // Calculate payment amount and show confirmation dialog
      const quotedAmount = await calculatePaymentAmount(
        topupAmount,
        method.type
      )
      if (
        quotedAmount <= 0 ||
        identity !== referralIdentity() ||
        version !== paymentSelectionVersion.current
      ) {
        return
      }
      setPaymentConfirmation({
        identity,
        version,
        topupAmount,
        paymentAmount: quotedAmount,
        paymentMethod: method,
        waffoMethodIndex: null,
      })
      setConfirmDialogOpen(true)
    } finally {
      if (version === paymentSelectionVersion.current) setPaymentLoading(null)
    }
  }

  // Handle payment confirmation
  const handlePaymentConfirm = async () => {
    if (
      !paymentConfirmation ||
      calculating ||
      paymentConfirmation.identity !== referralIdentity() ||
      paymentConfirmation.version !== paymentSelectionVersion.current
    ) {
      return
    }

    const success = await dispatchSelectedPayment(
      paymentConfirmation.paymentMethod,
      paymentConfirmation.topupAmount,
      paymentConfirmation.waffoMethodIndex,
      {
        regular: processPayment,
        waffo: (amount, index) =>
          processWaffoPayment(amount, index, paymentConfirmation.waffoMethod),
        waffoPancake: processWaffoPancakePayment,
      }
    )

    if (
      success &&
      paymentConfirmation.identity === referralIdentity() &&
      paymentConfirmation.version === paymentSelectionVersion.current
    ) {
      setConfirmDialogOpen(false)
      await fetchUser()
    }
  }

  // Handle redemption
  const handleRedeem = async () => {
    if (!redemptionCode) return

    const success = await redeemCode(redemptionCode)
    if (success) {
      setRedemptionCode('')
      await fetchUser()
    }
  }

  // Handle Creem product selection
  const handleCreemProductSelect = (product: CreemProduct) => {
    creemSelectionIdentity.current = referralIdentity()
    setSelectedCreemProduct(product)
    setCreemDialogOpen(true)
  }

  // Handle Creem payment confirmation
  const handleCreemConfirm = async () => {
    const identity = creemSelectionIdentity.current
    if (!selectedCreemProduct || identity !== referralIdentity()) return

    const success = await processCreemPayment(selectedCreemProduct.productId)
    if (success && identity === referralIdentity()) {
      setCreemDialogOpen(false)
      setSelectedCreemProduct(null)
      await fetchUser()
    }
  }

  const handleWaffoMethodSelect = async (
    method: WaffoPayMethod,
    index: number
  ) => {
    const loadingKey = `waffo-${index}`
    const identity = referralIdentity()
    const version = ++paymentSelectionVersion.current
    const paymentMethod = {
      name: method.name,
      type: PAYMENT_TYPES.WAFFO,
      icon: method.icon,
    }
    // Freeze the provider identity together with the displayed selection.
    // A later configuration reorder must not silently reinterpret its index.
    const waffoMethod = {
      payMethodType: method.payMethodType ?? '',
      payMethodName: method.payMethodName ?? '',
    }
    setPaymentConfirmation(null)
    setConfirmDialogOpen(false)
    setSelectedPaymentMethod(paymentMethod)
    setPaymentLoading(loadingKey)

    try {
      if (
        !isValidTopupAmount(topupAmount) ||
        topupAmount < (topupInfo?.waffo_min_topup || 1)
      ) {
        return
      }
      const quotedAmount = await calculatePaymentAmount(
        topupAmount,
        PAYMENT_TYPES.WAFFO
      )
      if (
        quotedAmount <= 0 ||
        identity !== referralIdentity() ||
        version !== paymentSelectionVersion.current
      ) {
        return
      }
      setPaymentConfirmation({
        identity,
        version,
        topupAmount,
        paymentAmount: quotedAmount,
        paymentMethod,
        waffoMethodIndex: index,
        waffoMethod,
      })
      setConfirmDialogOpen(true)
    } finally {
      if (version === paymentSelectionVersion.current) setPaymentLoading(null)
    }
  }

  // Get discount rate for current topup amount
  const getDiscountRate = useCallback(() => {
    return topupInfo?.discount?.[topupAmount] || DEFAULT_DISCOUNT_RATE
  }, [topupInfo, topupAmount])

  const handleSubscriptionAvailabilityChange = useCallback(
    (available: boolean) => {
      setShowSubscriptionPanel(available)
    },
    []
  )

  return (
    <>
      <SectionPageLayout>
        <SectionPageLayout.Title>{t('Wallet')}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <div className='mx-auto flex w-full max-w-7xl flex-col gap-4 sm:gap-5'>
            {userError ? (
              <ErrorState
                className='min-h-32'
                onRetry={() => void fetchUser()}
              />
            ) : (
              <WalletStatsCard user={user} loading={userLoading} />
            )}

            <div
              className={
                showSubscriptionPanel
                  ? 'grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] xl:items-start'
                  : 'grid gap-4'
              }
            >
              <div id='wallet-add-funds' className='scroll-mt-4'>
                <RechargeFormCard
                  topupInfo={topupInfo}
                  presetAmounts={presetAmounts}
                  selectedPreset={selectedPreset}
                  onSelectPreset={handleSelectPreset}
                  topupAmount={topupAmount}
                  onTopupAmountChange={handleTopupAmountChange}
                  paymentAmount={paymentAmount}
                  paymentType={getCurrentPaymentType()}
                  calculating={calculating}
                  onPaymentMethodSelect={handlePaymentMethodSelect}
                  paymentLoading={paymentLoading}
                  redemptionCode={redemptionCode}
                  onRedemptionCodeChange={setRedemptionCode}
                  onRedeem={handleRedeem}
                  redeeming={redeeming}
                  topupLink={topupInfo?.topup_link}
                  loading={topupLoading}
                  priceRatio={(status?.price as number) || 1}
                  usdExchangeRate={effectiveUsdExchangeRate}
                  onOpenBilling={() => setBillingDialogOpen(true)}
                  creemProducts={topupInfo?.creem_products}
                  enableCreemTopup={topupInfo?.enable_creem_topup}
                  onCreemProductSelect={handleCreemProductSelect}
                  enableWaffoTopup={topupInfo?.enable_waffo_topup}
                  waffoPayMethods={topupInfo?.waffo_pay_methods}
                  waffoMinTopup={topupInfo?.waffo_min_topup}
                  onWaffoMethodSelect={handleWaffoMethodSelect}
                  enableWaffoPancakeTopup={
                    topupInfo?.enable_waffo_pancake_topup
                  }
                />
              </div>

              <SubscriptionPlansCard
                topupInfo={topupInfo}
                onAvailabilityChange={handleSubscriptionAvailabilityChange}
                userQuota={user?.quota}
                onPurchaseSuccess={fetchUser}
              />
            </div>

            <AffiliateRewardsCard
              key={referralAccount}
              onBalanceChanged={() => fetchUser(true)}
            />
          </div>
        </SectionPageLayout.Content>
      </SectionPageLayout>

      <PaymentConfirmDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        onConfirm={handlePaymentConfirm}
        topupAmount={paymentConfirmation?.topupAmount ?? topupAmount}
        paymentAmount={paymentConfirmation?.paymentAmount ?? 0}
        paymentMethod={paymentConfirmation?.paymentMethod}
        calculating={calculating}
        processing={processing || waffoProcessing || pancakeProcessing}
        discountRate={getDiscountRate()}
        usdExchangeRate={effectiveUsdExchangeRate}
      />

      <BillingHistoryDialog
        open={billingDialogOpen}
        onOpenChange={setBillingDialogOpen}
      />

      <CreemConfirmDialog
        open={creemDialogOpen}
        onOpenChange={setCreemDialogOpen}
        onConfirm={handleCreemConfirm}
        product={selectedCreemProduct}
        processing={creemProcessing}
      />
    </>
  )
}
