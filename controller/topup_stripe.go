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
	_, quotaPerUnit := walletTopUpUnits()
	minTopup := getStripeMinTopup()
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
	chargedMoney := GetChargedAmount(float64(req.Amount), model.User{Group: group})
	creditedQuota, err := getStripeCreditedQuota(chargedMoney, quotaPerUnit)
	if err == nil {
		err = model.ValidateTopUpQuotaCapacity(id, creditedQuota)
	}
	if err != nil {
		paymentError(c, err)
		return
	}
	payMoney := getStripePayMoney(float64(req.Amount))
	if err := validateTopUpPaymentAmount(payMoney); err != nil {
		paymentError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": strconv.FormatFloat(payMoney, 'f', 2, 64)})
}

func (*StripeAdaptor) RequestPay(c *gin.Context, req *StripePayRequest) {
	_, quotaPerUnit := walletTopUpUnits()
	if req.PaymentMethod != model.PaymentMethodStripe {
		paymentError(c, common.NewMessage("Unsupported payment channel"))
		return
	}
	common.OptionMapRWMutex.RLock()
	webhookConfigured := isStripeWebhookConfigured()
	common.OptionMapRWMutex.RUnlock()
	if !webhookConfigured {
		paymentError(c, common.NewMessage("Stripe webhook is not configured"))
		return
	}
	minTopup := getStripeMinTopup()
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
	chargedMoney := GetChargedAmount(float64(req.Amount), *user)
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
	common.OptionMapRWMutex.RLock()
	apiSecret := setting.StripeApiSecret
	common.OptionMapRWMutex.RUnlock()
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
	payLink, err := genStripeLink(referenceId, user.StripeCustomer, user.Email, req.Amount, req.SuccessURL, req.CancelURL)
	if err != nil {
		var stripeErr *stripe.Error
		if errors.As(err, &stripeErr) && stripeErr.Type == stripe.ErrorTypeInvalidRequest &&
			(stripeErr.HTTPStatusCode == http.StatusBadRequest || stripeErr.HTTPStatusCode == http.StatusUnauthorized ||
				stripeErr.HTTPStatusCode == http.StatusForbidden) {
			// A structured parameter/authentication rejection did not create a
			// checkout. Preserve the original manual-completion boundary. Network
			// failures, conflicts and server errors remain indeterminate.
			if updateErr := model.UpdatePendingTopUpStatus(referenceId, model.PaymentProviderStripe, common.TopUpStatusFailed); updateErr != nil && !errors.Is(updateErr, model.ErrTopUpStatusInvalid) {
				err = errors.Join(err, updateErr)
			}
		}
		logger.LogError(c.Request.Context(), common.LogText("Stripe failed to create Checkout Session user_id=%d trade_no=%s amount=%d %s", id, referenceId, req.Amount, stripeCheckoutErrorSummary(err)))
		paymentError(c, common.NewMessage("Failed to start payment"))
		return
	}

	logger.LogInfo(c.Request.Context(), common.LogText("Stripe top-up order created user_id=%d trade_no=%s amount=%d money=%.2f", id, referenceId, req.Amount, chargedMoney))
	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"pay_link": payLink,
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
	switch event.Type {
	case stripe.EventTypeCheckoutSessionCompleted:
		err = sessionCompleted(ctx, event, callerIp)
	case stripe.EventTypeCheckoutSessionExpired:
		err = sessionExpired(ctx, event)
	case stripe.EventTypeCheckoutSessionAsyncPaymentSucceeded:
		err = sessionAsyncPaymentSucceeded(ctx, event, callerIp)
	case stripe.EventTypeCheckoutSessionAsyncPaymentFailed:
		err = sessionAsyncPaymentFailed(ctx, event, callerIp)
	default:
		logger.LogInfo(ctx, common.LogText("Stripe webhook ignored event event_type=%s client_ip=%s", string(event.Type), callerIp))
	}

	if err != nil {
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
		// A wallet checkout has not reached its settlement transaction yet.
		// A failed dispatch transaction must remain retryable by Stripe.
		if isStripeWalletCheckout(ctx, event) {
			return err
		}
		return nil
	}

	if !isStripeWalletCheckout(ctx, event) {
		return nil
	}

	// Missing or malformed amounts are not a free checkout. Explicit zero is
	// valid only once Stripe's signed event establishes payment completion.
	total, err := strconv.ParseInt(event.GetObjectValue("amount_total"), 10, 64)
	if err != nil || total < 0 || (zeroCheckout && total != 0) {
		return errors.New("invalid Stripe payment amount")
	}
	if err := model.Recharge(referenceId, customerId, callerIp); err != nil {
		logger.LogError(ctx, common.LogText("Stripe top-up processing failed trade_no=%s event_type=%s client_ip=%s error=%q", referenceId, string(event.Type), callerIp, err.Error()))
		return err
	}
	currency := strings.ToUpper(event.GetObjectValue("currency"))
	logger.LogInfo(ctx, common.LogText("Stripe top-up succeeded trade_no=%s amount_total=%.2f currency=%s event_type=%s client_ip=%s", referenceId, float64(total)/100, currency, string(event.Type), callerIp))
	return nil
}

func sessionExpired(ctx context.Context, event stripe.Event) error {
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
		if isStripeWalletCheckout(ctx, event) {
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
	connectedAccount := event.Account != ""
	if mode == string(stripe.CheckoutSessionModePayment) && !hasPaymentLink && !connectedAccount {
		return true
	}
	logger.LogWarn(ctx, common.LogText("Stripe wallet event ignored reason=checkout_source_mismatch trade_no=%s event_type=%s mode=%q payment_link=%t connected_account=%t", event.GetObjectValue("client_reference_id"), string(event.Type), mode, hasPaymentLink, connectedAccount))
	return false
}

// The SDK's error logger includes provider response bodies. Keep its configured
// transport, retry and telemetry behavior, while silencing only these checkout
// calls. Revisit this adapter when upgrading the SDK's deprecated backend type.
func stripeCheckoutBackend() stripe.Backend {
	backend := stripe.GetBackend(stripe.APIBackend)
	if sdkBackend, ok := backend.(*stripe.BackendImplementation); ok {
		local := *sdkBackend
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
	priceID, apiSecret := setting.StripePriceId, setting.StripeApiSecret
	allowPromotionCodes := setting.StripePromotionCodesEnabled
	common.OptionMapRWMutex.RUnlock()
	// Use custom URLs if provided, otherwise use defaults
	if successURL == "" {
		successURL = paymentReturnPath("/usage-logs")
	}
	if cancelURL == "" {
		cancelURL = paymentReturnPath("/wallet")
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
	if result == nil || result.URL == "" {
		return "", errors.New("Stripe checkout response is missing a payment URL")
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
