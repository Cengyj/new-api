package controller

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/system_setting"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"github.com/stripe/stripe-go/v81"
	"github.com/stripe/stripe-go/v81/checkout/session"
	"github.com/stripe/stripe-go/v81/webhook"
	"github.com/thanhpk/randstr"
	"gorm.io/gorm"
)

var stripeAdaptor = &StripeAdaptor{}

// StripePayRequest represents a payment request for Stripe checkout.
type StripePayRequest struct {
	// Amount is the quantity of units to purchase.
	Amount int64 `json:"amount"`
	// PaymentMethod specifies the payment method (e.g., "stripe").
	PaymentMethod string `json:"payment_method"`
	// SuccessURL is the optional custom URL to redirect after successful payment.
	// If empty, defaults to the server's console log page.
	SuccessURL string `json:"success_url,omitempty"`
	// CancelURL is the optional custom URL to redirect when payment is canceled.
	// If empty, defaults to the server's console topup page.
	CancelURL string `json:"cancel_url,omitempty"`
}

type StripeAdaptor struct {
}

func (*StripeAdaptor) RequestAmount(c *gin.Context, req *StripePayRequest) {
	common.OptionMapRWMutex.RLock()
	pricing := walletTopUpPricingLocked(setting.StripeUnitPrice, setting.StripeMinTopUp)
	common.OptionMapRWMutex.RUnlock()
	quotaPerUnit, minTopup := pricing.quotaPerUnit, pricing.minTopUp
	if req.Amount < minTopup {
		paymentError(c, common.NewMessage("Top-up amount cannot be less than {{min}}", map[string]any{"min": minTopup}))
		return
	}
	if req.Amount > 10000 {
		paymentError(c, common.NewMessage("Top-up amount cannot exceed {{max}}", map[string]any{"max": 10000}))
		return
	}
	id := c.GetInt("id")
	group, err := model.GetUserGroup(id, true)
	if err != nil {
		paymentError(c, common.NewMessage("Failed to get the user group"))
		return
	}
	chargedMoney := float64(req.Amount) * pricing.groupRatio(group)
	creditedQuota, err := getStripeCreditedQuota(chargedMoney, quotaPerUnit)
	if err == nil {
		err = model.ValidateTopUpQuotaCapacity(id, creditedQuota)
	}
	if err != nil {
		paymentError(c, err)
		return
	}
	payMoney := float64(req.Amount) * pricing.unitPrice
	if err := validateTopUpPaymentAmount(payMoney); err != nil {
		paymentError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": strconv.FormatFloat(payMoney, 'f', 2, 64)})
}

func (*StripeAdaptor) RequestPay(c *gin.Context, req *StripePayRequest) {
	common.OptionMapRWMutex.RLock()
	pricing := walletTopUpPricingLocked(setting.StripeUnitPrice, setting.StripeMinTopUp)
	checkoutConfig := stripeCheckoutConfigLocked()
	webhookConfigured := isStripeWebhookConfigured()
	common.OptionMapRWMutex.RUnlock()
	quotaPerUnit := pricing.quotaPerUnit
	if req.PaymentMethod != model.PaymentMethodStripe {
		paymentError(c, common.NewMessage("Unsupported payment channel"))
		return
	}
	if !webhookConfigured {
		paymentError(c, common.NewMessage("Stripe webhook is not configured"))
		return
	}
	if strings.TrimSpace(checkoutConfig.priceID) == "" {
		paymentError(c, common.NewMessage("Failed to start payment"))
		return
	}
	minTopup := pricing.minTopUp
	if req.Amount < minTopup {
		common.ApiErrorStatus(c, http.StatusOK, common.NewMessage("Top-up amount cannot be less than {{min}}", map[string]any{"min": minTopup}), gin.H{"data": 10})
		return
	}
	if req.Amount > 10000 {
		common.ApiErrorStatus(c, http.StatusOK, common.NewMessage("Top-up amount cannot exceed {{max}}", map[string]any{"max": 10000}), gin.H{"data": 10})
		return
	}

	if req.SuccessURL != "" && common.ValidateRedirectURL(req.SuccessURL) != nil {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Payment success redirect URL is not in the trusted domain list"), gin.H{"data": ""})
		return
	}

	if req.CancelURL != "" && common.ValidateRedirectURL(req.CancelURL) != nil {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Payment cancel redirect URL is not in the trusted domain list"), gin.H{"data": ""})
		return
	}

	id := c.GetInt("id")
	user, err := model.GetUserById(id, false)
	if err != nil || user == nil {
		paymentError(c, common.NewMessage("User does not exist"))
		return
	}
	chargedMoney := float64(req.Amount) * pricing.groupRatio(user.Group)
	creditedQuota, err := getStripeCreditedQuota(chargedMoney, quotaPerUnit)
	if err == nil {
		err = model.ValidateTopUpQuotaCapacity(id, creditedQuota)
	}
	if err != nil {
		paymentError(c, err)
		return
	}

	reference := fmt.Sprintf("new-api-ref-%d-%d-%s", user.Id, time.Now().UnixMilli(), randstr.String(4))
	referenceId := "ref_" + common.Sha1([]byte(reference))
	apiSecret := checkoutConfig.apiSecret
	if !strings.HasPrefix(apiSecret, "sk_") && !strings.HasPrefix(apiSecret, "rk_") {
		logger.LogError(c.Request.Context(), common.LogText("Stripe failed to create Checkout Session user_id=%d trade_no=%s amount=%d error=%q", id, referenceId, req.Amount, "invalid Stripe API key"))
		paymentError(c, common.NewMessage("Failed to start payment"))
		return
	}

	topUp := &model.TopUp{
		UserId:          id,
		CreditedQuota:   &creditedQuota,
		Amount:          req.Amount,
		Money:           chargedMoney,
		TradeNo:         referenceId,
		PaymentMethod:   model.PaymentMethodStripe,
		PaymentProvider: model.PaymentProviderStripe,
		CreateTime:      time.Now().Unix(),
		Status:          common.TopUpStatusPending,
	}
	err = topUp.Insert()
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Stripe failed to create top-up order user_id=%d trade_no=%s amount=%d error=%q", id, referenceId, req.Amount, err.Error()))
		paymentError(c, common.NewMessage("Failed to create order"))
		return
	}
	payLink, err := checkoutConfig.link(referenceId, user.StripeCustomer, user.Email, req.Amount, req.SuccessURL, req.CancelURL)
	if err != nil {
		knownRejection := false
		if stripeCheckoutRejected(err) {
			// Only report a definite refusal if this order actually transitioned.
			// A committed callback or a lost SQL reply needs the original ID.
			updateErr := model.UpdatePendingTopUpStatus(referenceId, model.PaymentProviderStripe, common.TopUpStatusFailed)
			knownRejection = updateErr == nil
			if updateErr != nil && !errors.Is(updateErr, model.ErrTopUpStatusInvalid) {
				logger.LogError(c.Request.Context(), common.LogText("Stripe failed to mark top-up order as failed trade_no=%s client_ip=%s error=%q", referenceId, c.ClientIP(), updateErr.Error()))
			}
		}
		logger.LogError(c.Request.Context(), common.LogText("Stripe failed to create Checkout Session user_id=%d trade_no=%s amount=%d %s", id, referenceId, req.Amount, stripeCheckoutErrorSummary(err)))
		if knownRejection {
			paymentError(c, common.NewMessage("Failed to start payment"))
		} else {
			paymentCheckoutUnknown(c, referenceId)
		}
		return
	}

	logger.LogInfo(c.Request.Context(), common.LogText("Stripe top-up order created user_id=%d trade_no=%s amount=%d money=%.2f", id, referenceId, req.Amount, chargedMoney))
	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"pay_link": payLink,
			"order_id": referenceId,
		},
	})
}

func RequestStripeAmount(c *gin.Context) {
	var req StripePayRequest
	err := c.ShouldBindJSON(&req)
	if err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}
	stripeAdaptor.RequestAmount(c, &req)
}

func RequestStripePay(c *gin.Context) {
	if !requirePaymentCompliance(c) {
		return
	}

	var req StripePayRequest
	err := c.ShouldBindJSON(&req)
	if err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}
	stripeAdaptor.RequestPay(c, &req)
}

func StripeWebhook(c *gin.Context) {
	ctx := c.Request.Context()
	common.OptionMapRWMutex.RLock()
	secret := setting.StripeWebhookSecret
	enabled := isStripeWebhookEnabled()
	walletOnly := !isStripeTopUpEnabled()
	common.OptionMapRWMutex.RUnlock()
	if !enabled || strings.TrimSpace(secret) == "" {
		logger.LogWarn(ctx, common.LogText("Stripe webhook rejected reason=webhook_disabled path=%q client_ip=%s", c.Request.URL.Path, c.ClientIP()))
		c.AbortWithStatus(http.StatusForbidden)
		return
	}

	payload, err := io.ReadAll(c.Request.Body)
	if err != nil {
		logger.LogError(ctx, common.LogText("Stripe webhook failed to read request body path=%q client_ip=%s error=%q", c.Request.URL.Path, c.ClientIP(), err.Error()))
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}

	signature := c.GetHeader("Stripe-Signature")
	logger.LogInfo(ctx, common.LogText("Stripe webhook received request path=%q client_ip=%s body_bytes=%d", c.Request.URL.Path, c.ClientIP(), len(payload)))
	event, err := webhook.ConstructEventWithOptions(payload, signature, secret, webhook.ConstructEventOptions{
		IgnoreAPIVersionMismatch: true,
	})

	if err != nil {
		logger.LogWarn(ctx, common.LogText("Stripe webhook signature verification failed path=%q client_ip=%s error=%q", c.Request.URL.Path, c.ClientIP(), err.Error()))
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}

	callerIp := c.ClientIP()
	logger.LogInfo(ctx, common.LogText("Stripe webhook signature verified event_type=%s client_ip=%s path=%q", string(event.Type), callerIp, c.Request.URL.Path))
	var handle func(context.Context, stripe.Event, string) error
	switch event.Type {
	case stripe.EventTypeCheckoutSessionCompleted:
		handle = sessionCompleted
	case stripe.EventTypeCheckoutSessionExpired:
		handle = sessionExpired
	case stripe.EventTypeCheckoutSessionAsyncPaymentSucceeded:
		handle = sessionAsyncPaymentSucceeded
	case stripe.EventTypeCheckoutSessionAsyncPaymentFailed:
		handle = sessionAsyncPaymentFailed
	default:
		logger.LogInfo(ctx, common.LogText("Stripe webhook ignored event event_type=%s client_ip=%s", string(event.Type), callerIp))
		c.Status(http.StatusOK)
		return
	}
	if event.Data == nil || event.Data.Object == nil {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	if walletOnly && !requireIssuedWalletOrder(c, event.GetObjectValue("client_reference_id"), model.PaymentProviderStripe) {
		return
	}
	if err := handle(ctx, event, callerIp); err != nil {
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	c.Status(http.StatusOK)
}

func sessionCompleted(ctx context.Context, event stripe.Event, callerIp string) error {
	customerId := event.GetObjectValue("customer")
	referenceId := event.GetObjectValue("client_reference_id")
	status := event.GetObjectValue("status")
	if "complete" != status {
		logger.LogWarn(ctx, common.LogText("Stripe checkout.completed has unexpected status, ignored trade_no=%s status=%s client_ip=%s", referenceId, status, callerIp))
		return nil
	}

	paymentStatus := event.GetObjectValue("payment_status")
	if paymentStatus != "paid" && paymentStatus != "no_payment_required" {
		logger.LogInfo(ctx, common.LogText("Stripe Checkout payment not completed, waiting for async result trade_no=%s payment_status=%s client_ip=%s", referenceId, paymentStatus, callerIp))
		return nil
	}
	return fulfillOrder(ctx, event, referenceId, customerId, callerIp)
}

// sessionAsyncPaymentSucceeded handles delayed payment methods that confirm
// payment after checkout completes. The signed event remains the payment proof.
func sessionAsyncPaymentSucceeded(ctx context.Context, event stripe.Event, callerIp string) error {
	customerId := event.GetObjectValue("customer")
	referenceId := event.GetObjectValue("client_reference_id")
	logger.LogInfo(ctx, common.LogText("Stripe async payment succeeded trade_no=%s client_ip=%s", referenceId, callerIp))
	return fulfillOrder(ctx, event, referenceId, customerId, callerIp)
}

// sessionAsyncPaymentFailed marks orders as failed when delayed payment methods
// ultimately fail (e.g. bank transfer not received, SEPA rejected).
func sessionAsyncPaymentFailed(ctx context.Context, event stripe.Event, callerIp string) error {
	referenceId := event.GetObjectValue("client_reference_id")
	logger.LogWarn(ctx, common.LogText("Stripe async payment failed trade_no=%s client_ip=%s", referenceId, callerIp))

	if len(referenceId) == 0 {
		logger.LogWarn(ctx, common.LogText("Stripe async payment failed event missing order number client_ip=%s", callerIp))
		return nil
	}
	if !isStripeWalletCheckout(ctx, event) {
		return nil
	}

	LockOrder(referenceId)
	defer UnlockOrder(referenceId)

	topUp, err := model.GetTopUpByTradeNoWithError(referenceId)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			logger.LogWarn(ctx, common.LogText("Stripe async payment failed but local order not found trade_no=%s client_ip=%s", referenceId, callerIp))
			return nil
		}
		logger.LogError(ctx, common.LogText("Stripe failed to mark top-up order as failed trade_no=%s client_ip=%s error=%q", referenceId, callerIp, err.Error()))
		return err
	}

	if topUp.PaymentProvider != model.PaymentProviderStripe {
		logger.LogWarn(ctx, common.LogText("Stripe async payment failed but order payment gateway mismatch trade_no=%s payment_provider=%s client_ip=%s", referenceId, topUp.PaymentProvider, callerIp))
		return nil
	}

	if topUp.Status != common.TopUpStatusPending {
		logger.LogInfo(ctx, common.LogText("Stripe async payment failed but order not pending, ignored trade_no=%s status=%s client_ip=%s", referenceId, topUp.Status, callerIp))
		return nil
	}

	topUp.Status = common.TopUpStatusFailed
	if err := topUp.Update(); err != nil {
		logger.LogError(ctx, common.LogText("Stripe failed to mark top-up order as failed trade_no=%s client_ip=%s error=%q", referenceId, callerIp, err.Error()))
		if errors.Is(err, model.ErrTopUpNotFound) || errors.Is(err, model.ErrTopUpStatusInvalid) || errors.Is(err, model.ErrPaymentMethodMismatch) {
			return nil
		}
		return err
	}
	logger.LogInfo(ctx, common.LogText("Stripe top-up order marked as failed trade_no=%s client_ip=%s", referenceId, callerIp))
	return nil
}

// fulfillOrder is the shared logic for crediting quota after payment is confirmed.
func fulfillOrder(ctx context.Context, event stripe.Event, referenceId string, customerId string, callerIp string) error {
	if len(referenceId) == 0 {
		logger.LogWarn(ctx, common.LogText("Stripe order completion missing order number client_ip=%s", callerIp))
		return errors.New("missing payment order number")
	}

	LockOrder(referenceId)
	defer UnlockOrder(referenceId)
	payload := map[string]any{
		"customer":     customerId,
		"amount_total": event.GetObjectValue("amount_total"),
		"currency":     strings.ToUpper(event.GetObjectValue("currency")),
		"event_type":   string(event.Type),
	}
	zeroCheckout := event.GetObjectValue("payment_status") == "no_payment_required"
	if zeroCheckout {
		// The new zero-payment branch applies only to wallet orders. Existing
		// subscription completion rules remain in their original paid branch.
		var count int64
		if err := model.DB.Model(&model.SubscriptionOrder{}).Where("trade_no = ?", referenceId).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return nil
		}
	} else if err := model.CompleteSubscriptionOrder(referenceId, common.GetJsonString(payload), model.PaymentProviderStripe, ""); err == nil {
		logger.LogInfo(ctx, common.LogText("Stripe subscription order processed trade_no=%s event_type=%s client_ip=%s", referenceId, string(event.Type), callerIp))
		return nil
	} else if !errors.Is(err, model.ErrSubscriptionOrderNotFound) {
		logger.LogError(ctx, common.LogText("Stripe subscription order processing failed trade_no=%s event_type=%s client_ip=%s error=%q", referenceId, string(event.Type), callerIp, err.Error()))
		// Neither a dispatch failure nor a lost commit reply proves completion.
		// Retry the original event without changing known business rejections.
		if isStripeWalletCheckout(ctx, event) || shouldRetryStripeSubscriptionEvent(event, err) {
			return err
		}
		return nil
	}

	if !isStripeWalletCheckout(ctx, event) {
		return nil
	}

	// The SDK's Object map converts JSON numbers to float64, then formats
	// large amounts in scientific notation. Read the signed integer itself.
	var receipt struct {
		AmountTotal *int64 `json:"amount_total"`
	}
	if err := common.Unmarshal(event.Data.Raw, &receipt); err != nil || receipt.AmountTotal == nil {
		return errors.New("invalid Stripe payment amount")
	}
	total := *receipt.AmountTotal
	if total < 0 || (zeroCheckout && total != 0) {
		return errors.New("invalid Stripe payment amount")
	}
	if err := model.Recharge(referenceId, customerId, callerIp); err != nil {
		logger.LogError(ctx, common.LogText("Stripe top-up processing failed trade_no=%s event_type=%s client_ip=%s error=%q", referenceId, string(event.Type), callerIp, err.Error()))
		return err
	}
	currency := strings.ToUpper(event.GetObjectValue("currency"))
	logger.LogInfo(ctx, common.LogText("Stripe top-up succeeded trade_no=%s amount_total_minor=%d currency=%s event_type=%s client_ip=%s", referenceId, total, currency, string(event.Type), callerIp))
	return nil
}

func sessionExpired(ctx context.Context, event stripe.Event, _ string) error {
	referenceId := event.GetObjectValue("client_reference_id")
	status := event.GetObjectValue("status")
	if "expired" != status {
		logger.LogWarn(ctx, common.LogText("Stripe checkout.expired has unexpected status, ignored trade_no=%s status=%s", referenceId, status))
		return nil
	}

	if len(referenceId) == 0 {
		logger.LogWarn(ctx, common.LogText("Stripe checkout.expired missing order number"))
		return nil
	}

	// Subscription order expiration
	LockOrder(referenceId)
	defer UnlockOrder(referenceId)
	if err := model.ExpireSubscriptionOrder(referenceId, model.PaymentProviderStripe); err == nil {
		logger.LogInfo(ctx, common.LogText("Stripe subscription order expired trade_no=%s", referenceId))
		return nil
	} else if err != nil && !errors.Is(err, model.ErrSubscriptionOrderNotFound) {
		logger.LogError(ctx, common.LogText("Stripe subscription order expiry processing failed trade_no=%s error=%q", referenceId, err.Error()))
		if isStripeWalletCheckout(ctx, event) || shouldRetryStripeSubscriptionEvent(event, err) {
			return err
		}
		return nil
	}

	if !isStripeWalletCheckout(ctx, event) {
		return nil
	}
	err := model.UpdatePendingTopUpStatus(referenceId, model.PaymentProviderStripe, common.TopUpStatusExpired)
	if errors.Is(err, model.ErrTopUpNotFound) {
		logger.LogWarn(ctx, common.LogText("Stripe top-up order not found, cannot mark as expired trade_no=%s", referenceId))
		return nil
	}
	if err != nil {
		logger.LogError(ctx, common.LogText("Stripe top-up order expiry processing failed trade_no=%s error=%q", referenceId, err.Error()))
		if errors.Is(err, model.ErrTopUpStatusInvalid) || errors.Is(err, model.ErrPaymentMethodMismatch) {
			return nil
		}
		return err
	}

	logger.LogInfo(ctx, common.LogText("Stripe top-up order expired trade_no=%s", referenceId))
	return nil
}

// Wallet checkouts are API-created one-time sessions on the configured account;
// genStripeLink does not send Stripe-Account. Payment Links and Connect-owned
// sessions can carry another party's client_reference_id, so their valid
// signatures alone cannot bind them to a local wallet order. Subscription
// dispatch happens first and retains its existing rules.
func isStripeWalletCheckout(ctx context.Context, event stripe.Event) bool {
	mode := event.GetObjectValue("mode")
	hasPaymentLink := event.GetObjectValue("payment_link") != ""
	hasSubscription := event.Data.Object["subscription"] != nil
	connectedAccount := event.Account != ""
	if mode != string(stripe.CheckoutSessionModePayment) || hasPaymentLink || hasSubscription || connectedAccount {
		logger.LogWarn(ctx, common.LogText("Stripe wallet event ignored reason=checkout_source_mismatch trade_no=%s event_type=%s mode=%q payment_link=%t subscription=%t connected_account=%t", event.GetObjectValue("client_reference_id"), string(event.Type), mode, hasPaymentLink, hasSubscription, connectedAccount))
		return false
	}
	// A delayed result follows completion. Don't let the event name override
	// conflicting session data, or terminate a session that reports payment.
	status, payment := event.GetObjectValue("status"), event.GetObjectValue("payment_status")
	completeOrOmitted := status == "" || status == "complete"
	consistent := true
	switch event.Type {
	case stripe.EventTypeCheckoutSessionAsyncPaymentSucceeded:
		consistent = completeOrOmitted && (payment == "" || payment == "paid" || payment == "no_payment_required")
	case stripe.EventTypeCheckoutSessionAsyncPaymentFailed:
		consistent = completeOrOmitted && payment != "paid"
	case stripe.EventTypeCheckoutSessionExpired:
		consistent = payment != "paid"
	}
	if !consistent {
		logger.LogWarn(ctx, common.LogText("Stripe wallet event ignored reason=checkout_status_mismatch trade_no=%s event_type=%s", event.GetObjectValue("client_reference_id"), string(event.Type)))
	}
	return consistent
}

// API-created subscription sessions need retryable completion/expiry failures
// too. Preserve the existing ACK for known business refusals and other sources.
func shouldRetryStripeSubscriptionEvent(event stripe.Event, err error) bool {
	if err == nil || event.GetObjectValue("mode") != string(stripe.CheckoutSessionModeSubscription) ||
		event.GetObjectValue("payment_link") != "" || event.Account != "" {
		return false
	}
	var message *common.Message
	return !errors.Is(err, model.ErrPaymentMethodMismatch) &&
		!errors.Is(err, model.ErrSubscriptionOrderStatusInvalid) && !errors.As(err, &message)
}

// The SDK's error logger includes provider response bodies. Keep its configured
// transport, retry and telemetry behavior, while silencing only these checkout
// calls. Redirects must not forward checkout credentials or accept a session
// from another endpoint. Revisit this adapter when upgrading the SDK's
// deprecated backend type.
func stripeCheckoutBackend() stripe.Backend {
	backend := stripe.GetBackend(stripe.APIBackend)
	if sdkBackend, ok := backend.(*stripe.BackendImplementation); ok {
		local := *sdkBackend
		client := *sdkBackend.HTTPClient
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		local.HTTPClient = &client
		local.LeveledLogger = &stripe.LeveledLogger{Level: stripe.LevelNull}
		return &local
	}
	return backend
}

func stripeCheckoutErrorSummary(err error) string {
	var stripeErr *stripe.Error
	if errors.As(err, &stripeErr) {
		return fmt.Sprintf("http_status=%d stripe_type=%q stripe_code=%q request_id=%q", stripeErr.HTTPStatusCode, stripeErr.Type, stripeErr.Code, stripeErr.RequestID)
	}
	return fmt.Sprintf("error_type=%T", err)
}

func stripeCheckoutRejected(err error) bool {
	var e *stripe.Error
	if !errors.As(err, &e) || e.Type != stripe.ErrorTypeInvalidRequest || e.LastResponse == nil {
		return false
	}
	switch e.HTTPStatusCode {
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden:
	default:
		return false
	}
	if e.Code == stripe.ErrorCodeIdempotencyKeyInUse || e.Code == stripe.ErrorCodeResourceAlreadyExists || e.LastResponse.Header.Get("Stripe-Should-Retry") == "true" {
		return false
	}
	// v81 decodes only the error member on HTTP failures. A mixed session and
	// error body isn't the provider's error envelope and cannot close the order.
	var envelope map[string]common.RawMessage
	return common.Unmarshal(e.LastResponse.RawJSON, &envelope) == nil && len(envelope) == 1 && envelope["error"] != nil
}

type stripeCheckoutConfig struct {
	priceID, apiSecret, serverAddress string
	allowPromotionCodes               bool
}

func stripeCheckoutConfigLocked() stripeCheckoutConfig {
	return stripeCheckoutConfig{priceID: setting.StripePriceId, apiSecret: setting.StripeApiSecret,
		serverAddress: system_setting.ServerAddress, allowPromotionCodes: setting.StripePromotionCodesEnabled}
}

// genStripeLink generates a Stripe Checkout session URL for payment.
// It creates a new checkout session with the specified parameters and returns the payment URL.
//
// Parameters:
//   - referenceId: unique reference identifier for the transaction
//   - customerId: existing Stripe customer ID (empty string if new customer)
//   - email: customer email address for new customer creation
//   - amount: quantity of units to purchase
//   - successURL: custom URL to redirect after successful payment (empty for default)
//   - cancelURL: custom URL to redirect when payment is canceled (empty for default)
//
// Returns the checkout session URL or an error if the session creation fails.
func genStripeLink(referenceId string, customerId string, email string, amount int64, successURL string, cancelURL string) (string, error) {
	common.OptionMapRWMutex.RLock()
	config := stripeCheckoutConfigLocked()
	common.OptionMapRWMutex.RUnlock()
	return config.link(referenceId, customerId, email, amount, successURL, cancelURL)
}

func (config stripeCheckoutConfig) link(referenceId, customerId, email string, amount int64, successURL, cancelURL string) (string, error) {
	priceID, apiSecret, allowPromotionCodes := config.priceID, config.apiSecret, config.allowPromotionCodes
	// Use custom URLs if provided, otherwise use defaults
	if successURL == "" {
		successURL = strings.TrimRight(config.serverAddress, "/") + "/usage-logs"
	}
	if cancelURL == "" {
		cancelURL = strings.TrimRight(config.serverAddress, "/") + "/wallet"
	}

	params := &stripe.CheckoutSessionParams{
		ClientReferenceID: stripe.String(referenceId),
		SuccessURL:        stripe.String(successURL),
		CancelURL:         stripe.String(cancelURL),
		LineItems: []*stripe.CheckoutSessionLineItemParams{
			{
				Price:    stripe.String(priceID),
				Quantity: stripe.Int64(amount),
			},
		},
		Mode:                stripe.String(string(stripe.CheckoutSessionModePayment)),
		AllowPromotionCodes: stripe.Bool(allowPromotionCodes),
	}
	params.AddExpand("line_items")

	if "" == customerId {
		if "" != email {
			params.CustomerEmail = stripe.String(email)
		}

		params.CustomerCreation = stripe.String(string(stripe.CheckoutSessionCustomerCreationAlways))
	} else {
		params.Customer = stripe.String(customerId)
	}

	client := session.Client{B: stripeCheckoutBackend(), Key: apiSecret}
	result, err := client.New(params)
	if err != nil {
		return "", err
	}
	if result == nil || strings.TrimSpace(result.URL) == "" {
		return "", errors.New("Stripe checkout response is missing a payment URL")
	}
	// With redirects disabled v81 can still decode a 3xx body as a session.
	if result.LastResponse == nil || result.LastResponse.StatusCode/100 != 2 {
		return "", errors.New("Stripe did not confirm checkout creation")
	}
	// The SDK ignores an error alongside a session and maps an omitted livemode
	// to false. Validate what the endpoint actually returned against this key.
	var wire struct {
		Error             *common.RawMessage `json:"error"`
		Livemode          *bool              `json:"livemode"`
		ClientReferenceID common.RawMessage  `json:"client_reference_id"`
		Customer          common.RawMessage  `json:"customer"`
	}
	if err := common.Unmarshal(result.LastResponse.RawJSON, &wire); err != nil || wire.Error != nil {
		return "", errors.New("Stripe did not confirm checkout creation")
	}
	if wire.Livemode != nil {
		_, mode, _ := strings.Cut(apiSecret, "_")
		if strings.HasPrefix(mode, "test_") && *wire.Livemode || strings.HasPrefix(mode, "live_") && !*wire.Livemode {
			return "", errors.New("Stripe checkout environment does not match the request")
		}
	}
	if wire.ClientReferenceID != nil && result.ClientReferenceID != referenceId {
		return "", errors.New("Stripe checkout response refers to a different order")
	}
	if customerId != "" && wire.Customer != nil && (result.Customer == nil || result.Customer.ID != customerId) {
		return "", errors.New("Stripe checkout customer does not match the request")
	}
	// Line items are expandable. When returned, they must describe the one
	// Price and quantity we sent; discounts and tax do not change either.
	if items := result.LineItems; items != nil {
		if items.HasMore || len(items.Data) != 1 {
			return "", errors.New("Stripe checkout items do not match the purchase")
		}
		item := items.Data[0]
		if item == nil || item.Price == nil || item.Price.ID != priceID || item.Quantity != amount ||
			item.Price.Type != "" && item.Price.Type != stripe.PriceTypeOneTime || item.Price.Recurring != nil {
			return "", errors.New("Stripe checkout item does not match the purchase")
		}
	}
	if result.Object != "" && result.Object != "checkout.session" || result.Mode != "" && result.Mode != stripe.CheckoutSessionModePayment || result.PaymentLink != nil || result.Subscription != nil ||
		result.Status != "" && result.Status != stripe.CheckoutSessionStatusOpen {
		return "", errors.New("Stripe did not return an open wallet checkout")
	}

	return result.URL, nil
}

func GetChargedAmount(count float64, user model.User) float64 {
	topUpGroupRatio := common.GetTopupGroupRatio(user.Group)
	if topUpGroupRatio == 0 {
		topUpGroupRatio = 1
	}

	return count * topUpGroupRatio
}

func getStripeCreditedQuota(chargedMoney, quotaPerUnit float64) (int, error) {
	// Both quote and checkout use GetChargedAmount's existing multiplication
	// before integer quota rounding. Reject overflow before decimal conversion.
	if math.IsNaN(chargedMoney) || math.IsInf(chargedMoney, 0) ||
		math.IsNaN(quotaPerUnit) || math.IsInf(quotaPerUnit, 0) {
		return 0, common.NewMessage("Top-up quota exceeds the range the system can represent")
	}
	return validateCreditedQuota(decimal.NewFromFloat(chargedMoney).Mul(decimal.NewFromFloat(quotaPerUnit)))
}

// Stripe sells a quantity of its configured Price. Local wallet group ratios
// affect credit, and local preset discounts are not sent to Stripe. The quote
// is the configured product price before any provider promotion.
func getStripePayMoney(amount float64) float64 {
	common.OptionMapRWMutex.RLock()
	unitPrice := setting.StripeUnitPrice
	common.OptionMapRWMutex.RUnlock()
	return amount * unitPrice
}

func getStripeMinTopup() int64 {
	// Stripe amount is a product quantity, independent of wallet display units.
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	return int64(setting.StripeMinTopUp)
}
