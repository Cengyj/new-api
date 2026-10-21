package controller

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"github.com/thanhpk/randstr"
)

type WaffoPancakePayRequest struct {
	Amount int64 `json:"amount"`
}

func getWaffoPancakeMinTopup() int64 {
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	return int64(setting.WaffoPancakeMinTopUp)
}

func RequestWaffoPancakeAmount(c *gin.Context) {
	var req WaffoPancakePayRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}

	displayType, quotaPerUnit := walletTopUpUnits()
	minTopup := getWaffoPancakeMinTopup()
	if req.Amount < minTopup {
		paymentError(c, common.NewMessage("Top-up amount cannot be less than {{min}}", map[string]any{"min": minTopup}))
		return
	}
	id := c.GetInt("id")
	if _, rejected := rejectInvalidTopUpQuota(c, id, req.Amount, displayType, quotaPerUnit); rejected {
		return
	}

	group, err := model.GetUserGroup(id, true)
	if err != nil {
		paymentError(c, common.NewMessage("Failed to get the user group"))
		return
	}

	payMoney := getWaffoPancakePayMoney(req.Amount, group, displayType, quotaPerUnit)
	if err := validateTopUpPaymentAmount(payMoney); err != nil {
		paymentError(c, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "success", "data": fmt.Sprintf("%.2f", payMoney)})
}

func getWaffoPancakePayMoney(amount int64, group, displayType string, quotaPerUnit float64) float64 {
	dAmount := decimal.NewFromInt(amount)
	if displayType == operation_setting.QuotaDisplayTypeTokens {
		dAmount = dAmount.Div(decimal.NewFromFloat(quotaPerUnit))
	}

	common.OptionMapRWMutex.RLock()
	topupGroupRatio := common.GetTopupGroupRatio(group)
	unitPrice := setting.WaffoPancakeUnitPrice
	configuredDiscount := operation_setting.GetPaymentSetting().AmountDiscount[int(amount)]
	common.OptionMapRWMutex.RUnlock()
	if topupGroupRatio == 0 {
		topupGroupRatio = 1
	}

	discount := 1.0
	if configuredDiscount > 0 {
		discount = configuredDiscount
	}

	payMoney := dAmount.
		Mul(decimal.NewFromFloat(unitPrice)).
		Mul(decimal.NewFromFloat(topupGroupRatio)).
		Mul(decimal.NewFromFloat(discount))

	return payMoney.InexactFloat64()
}

func normalizeWaffoPancakeTopUpAmount(amount int64, displayType string, quotaPerUnit float64) int64 {
	if displayType != operation_setting.QuotaDisplayTypeTokens {
		return amount
	}

	normalized := decimal.NewFromInt(amount).
		Div(decimal.NewFromFloat(quotaPerUnit)).
		IntPart()
	if normalized < 1 {
		return 1
	}
	return normalized
}

func formatWaffoPancakeAmount(payMoney float64) string {
	return decimal.NewFromFloat(payMoney).StringFixed(2)
}

func getWaffoPancakeBuyerEmail(user *model.User) string {
	if user != nil && strings.TrimSpace(user.Email) != "" {
		return user.Email
	}
	return ""
}

// The admin config endpoints below accept typed-but-not-yet-saved creds in
// the body and fall back to persisted creds when the body is blank (see
// resolveWaffoPancakeAdminCreds). Only SaveWaffoPancake writes to OptionMap.

type saveWaffoPancakeRequest struct {
	MerchantID string `json:"merchant_id"`
	PrivateKey string `json:"private_key"`
	ReturnURL  string `json:"return_url"`
	StoreID    string `json:"store_id"`
	ProductID  string `json:"product_id"`
}

type createWaffoPancakePairRequest struct {
	MerchantID string `json:"merchant_id"`
	PrivateKey string `json:"private_key"`
	ReturnURL  string `json:"return_url"`
}

// SaveWaffoPancake atomically persists all five operator-controlled fields.
// Catalog / pair endpoints are transient — only this one writes the OptionMap.
func SaveWaffoPancake(c *gin.Context) {
	var req saveWaffoPancakeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}
	if err := service.SaveWaffoPancakeConfig(
		c.Request.Context(),
		req.MerchantID,
		req.PrivateKey,
		req.ReturnURL,
		req.StoreID,
		req.ProductID,
	); err != nil {
		logger.LogError(c.Request.Context(), common.LogText(
			"Waffo Pancake failed to save config store_id=%q product_id=%q error=%q",
			req.StoreID, req.ProductID, err.Error(),
		))
		paymentError(c, common.NewMessage("Failed to save configuration"))
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"product_id": setting.WaffoPancakeProductID,
			"store_id":   setting.WaffoPancakeStoreID,
		},
	})
}

// resolveWaffoPancakeAdminCreds prefers body creds (typed-but-not-yet-saved
// values, for verification) and falls back to persisted creds when the body
// is blank (so returning admins don't have to re-paste the private key,
// which is stripped from GET /api/option/).
func resolveWaffoPancakeAdminCreds(bodyMerchantID, bodyPrivateKey string) (string, string) {
	m := strings.TrimSpace(bodyMerchantID)
	k := strings.TrimSpace(bodyPrivateKey)
	if m == "" && k == "" {
		return setting.WaffoPancakeMerchantID, setting.WaffoPancakePrivateKey
	}
	return m, k
}

// CreateWaffoPancakePair mints a Store + OnetimeProduct pair in one round-
// trip. Surfaces an orphan-store flag when the product half fails so the
// frontend can preselect / retry without losing context.
func CreateWaffoPancakePair(c *gin.Context) {
	var req createWaffoPancakePairRequest
	if c.Request.ContentLength > 0 {
		if err := c.ShouldBindJSON(&req); err != nil {
			paymentError(c, common.NewMessage("Invalid parameters"))
			return
		}
	}
	merchantID, privateKey := resolveWaffoPancakeAdminCreds(req.MerchantID, req.PrivateKey)
	if merchantID == "" || privateKey == "" {
		paymentError(c, common.NewMessage("Waffo Pancake credentials are not configured"))
		return
	}
	result, err := service.CreateWaffoPancakePrimaryPair(
		c.Request.Context(), merchantID, privateKey, req.ReturnURL,
	)
	if err != nil {
		orphan := result != nil && result.OrphanStore
		logger.LogError(c.Request.Context(), common.LogText(
			"Waffo Pancake failed to create store and product orphan_store=%t store_id=%q error=%q",
			orphan, func() string {
				if result == nil {
					return ""
				}
				return result.StoreID
			}(), err.Error(),
		))
		data := gin.H{"error": err.Error()}
		if orphan {
			data["store_id"] = result.StoreID
			data["store_name"] = result.StoreName
			data["orphan_store"] = true
		}
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": data})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"store_id":     result.StoreID,
			"store_name":   result.StoreName,
			"product_id":   result.ProductID,
			"product_name": result.ProductName,
		},
	})
}

// ListWaffoPancakeCatalog returns the merchant's Stores + OnetimeProducts.
// Doubles as a credential probe (a successful 200 proves the resolved creds
// authenticate). See resolveWaffoPancakeAdminCreds for credential resolution.
func ListWaffoPancakeCatalog(c *gin.Context) {
	// Missing query creds mean "use persisted creds".
	merchantID, privateKey := resolveWaffoPancakeAdminCreds(
		strings.TrimSpace(c.Query("merchant_id")),
		strings.TrimSpace(c.Query("private_key")),
	)
	if merchantID == "" || privateKey == "" {
		paymentError(c, common.NewMessage("Waffo Pancake credentials are not configured"))
		return
	}
	catalog, err := service.ListWaffoPancakeCatalog(c.Request.Context(), merchantID, privateKey)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText(
			"Waffo Pancake failed to fetch store and product catalog error=%q", err.Error(),
		))
		paymentError(c, common.NewMessage("Failed to fetch the catalog"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": catalog})
}

type createWaffoPancakeSubscriptionProductRequest struct {
	Name   string `json:"name"`
	Amount string `json:"amount"`
}

// CreateWaffoPancakeSubscriptionProduct mints an OnetimeProduct (not
// SubscriptionProduct — see service.CreateWaffoPancakeProductForPlan)
// sized to a plan's `name` + `amount`, using persisted Pancake credentials
// + StoreID. Reads from the form, not the plan row, so newly-typed unsaved
// plans can mint a product too.
func CreateWaffoPancakeSubscriptionProduct(c *gin.Context) {
	var req createWaffoPancakeSubscriptionProductRequest
	if c.Request.ContentLength > 0 {
		if err := c.ShouldBindJSON(&req); err != nil {
			paymentError(c, common.NewMessage("Invalid parameters"))
			return
		}
	}
	if strings.TrimSpace(req.Name) == "" {
		paymentError(c, common.NewMessage("Plan name cannot be empty"))
		return
	}
	if strings.TrimSpace(req.Amount) == "" {
		paymentError(c, common.NewMessage("Plan price cannot be empty"))
		return
	}
	merchantID, privateKey := resolveWaffoPancakeAdminCreds("", "")
	storeID := strings.TrimSpace(setting.WaffoPancakeStoreID)
	if merchantID == "" || privateKey == "" || storeID == "" {
		paymentError(c, common.NewMessage("Waffo Pancake is not fully configured. Complete the gateway binding in payment settings first."))
		return
	}
	productID, err := service.CreateWaffoPancakeProductForPlan(
		c.Request.Context(),
		merchantID,
		privateKey,
		storeID,
		req.Name,
		req.Amount,
		setting.WaffoPancakeReturnURL,
	)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText(
			"Waffo Pancake failed to create plan product store_id=%q name=%q amount=%q error=%q",
			storeID, req.Name, req.Amount, err.Error(),
		))
		paymentError(c, common.NewMessage("Failed to create the plan product"))
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"product_id":   productID,
			"product_name": req.Name,
			"store_id":     storeID,
		},
	})
}

// ListWaffoPancakeSubscriptionProductOptions returns the OnetimeProducts
// in the saved Pancake store, for the subscription-plan dropdown. The name
// reflects new-api's plan concept; under the hood it's still OnetimeProducts.
func ListWaffoPancakeSubscriptionProductOptions(c *gin.Context) {
	merchantID, privateKey := resolveWaffoPancakeAdminCreds("", "")
	storeID := strings.TrimSpace(setting.WaffoPancakeStoreID)
	if merchantID == "" || privateKey == "" || storeID == "" {
		paymentError(c, common.NewMessage("Waffo Pancake is not fully configured. Complete the gateway binding in payment settings first."))
		return
	}
	catalog, err := service.ListWaffoPancakeCatalog(c.Request.Context(), merchantID, privateKey)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText(
			"Waffo Pancake failed to fetch subscription product list store_id=%q error=%q", storeID, err.Error(),
		))
		paymentError(c, common.NewMessage("Failed to fetch the product list"))
		return
	}
	products := []service.WaffoPancakeCatalogProduct{}
	for _, store := range catalog.Stores {
		if store.ID == storeID {
			products = store.OnetimeProducts
			break
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"store_id": storeID,
			"products": products,
		},
	})
}

func getWaffoPancakeBuyerIdentity(user *model.User) string {
	if user == nil {
		return ""
	}
	return service.WaffoPancakeBuyerIdentityFromUserID(user.Id)
}

func RequestWaffoPancakePay(c *gin.Context) {
	common.OptionMapRWMutex.RLock()
	enabled := isWaffoPancakeTopUpEnabled()
	productID := setting.WaffoPancakeProductID
	common.OptionMapRWMutex.RUnlock()
	if !enabled {
		paymentError(c, common.NewMessage("Waffo Pancake configuration is incomplete"))
		return
	}

	var req WaffoPancakePayRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}
	displayType, quotaPerUnit := walletTopUpUnits()
	minTopup := getWaffoPancakeMinTopup()
	if req.Amount < minTopup {
		paymentError(c, common.NewMessage("Top-up amount cannot be less than {{min}}", map[string]any{"min": minTopup}))
		return
	}
	id := c.GetInt("id")
	creditedQuota, rejected := rejectInvalidTopUpQuota(c, id, req.Amount, displayType, quotaPerUnit)
	if rejected {
		return
	}

	user, err := model.GetUserById(id, false)
	if err != nil || user == nil {
		paymentError(c, common.NewMessage("User does not exist"))
		return
	}

	group, err := model.GetUserGroup(id, true)
	if err != nil {
		paymentError(c, common.NewMessage("Failed to get the user group"))
		return
	}

	payMoney := getWaffoPancakePayMoney(req.Amount, group, displayType, quotaPerUnit)
	if err := validateTopUpPaymentAmount(payMoney); err != nil {
		paymentError(c, err)
		return
	}

	tradeNo := fmt.Sprintf("WAFFO_PANCAKE-%d-%d-%s", id, time.Now().UnixMilli(), randstr.String(6))
	topUp := &model.TopUp{
		UserId:          id,
		CreditedQuota:   &creditedQuota,
		Amount:          normalizeWaffoPancakeTopUpAmount(req.Amount, displayType, quotaPerUnit),
		Money:           payMoney,
		TradeNo:         tradeNo,
		PaymentMethod:   model.PaymentMethodWaffoPancake,
		PaymentProvider: model.PaymentProviderWaffoPancake,
		CreateTime:      time.Now().Unix(),
		Status:          common.TopUpStatusPending,
	}
	if err := topUp.Insert(); err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Waffo Pancake failed to create top-up order user_id=%d trade_no=%s amount=%d error=%q", id, tradeNo, req.Amount, err.Error()))
		paymentError(c, common.NewMessage("Failed to create order"))
		return
	}

	expiresInSeconds := 45 * 60
	session, err := service.CreateWaffoPancakeCheckoutSession(c.Request.Context(), &service.WaffoPancakeCreateSessionParams{
		ProductID:     productID,
		BuyerIdentity: getWaffoPancakeBuyerIdentity(user),
		PriceSnapshot: &service.WaffoPancakePriceSnapshot{
			Amount:      formatWaffoPancakeAmount(payMoney),
			TaxCategory: "saas",
		},
		BuyerEmail:              getWaffoPancakeBuyerEmail(user),
		ExpiresInSeconds:        &expiresInSeconds,
		OrderMerchantExternalID: tradeNo,
	})
	if err != nil {
		if errors.Is(err, service.ErrWaffoPancakeCheckoutNotStarted) {
			// A local configuration failure cannot later become a paid checkout.
			// Preserve the original failed-order/manual-completion policy.
			if updateErr := model.UpdatePendingTopUpStatus(tradeNo, model.PaymentProviderWaffoPancake, common.TopUpStatusFailed); updateErr != nil && !errors.Is(updateErr, model.ErrTopUpStatusInvalid) {
				err = errors.Join(err, updateErr)
			}
		}
		logger.LogError(c.Request.Context(), common.LogText("Waffo Pancake failed to create checkout session user_id=%d trade_no=%s error_type=%T", id, tradeNo, err))
		// Only uncertain remote outcomes retain the frozen pending order for a
		// later verified notification; local rejections were marked failed above.
		paymentError(c, common.NewMessage("Failed to start payment"))
		return
	}
	logger.LogInfo(c.Request.Context(), common.LogText("Waffo Pancake top-up order created user_id=%d trade_no=%s session_id=%s amount=%d money=%.2f", id, tradeNo, session.SessionID, req.Amount, payMoney))

	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"checkout_url":     session.CheckoutURL,
			"session_id":       session.SessionID,
			"expires_at":       session.ExpiresAt,
			"order_id":         tradeNo,
			"token":            session.Token,
			"token_expires_at": session.TokenExpiresAt,
		},
	})
}

func WaffoPancakeWebhook(c *gin.Context) {
	common.OptionMapRWMutex.RLock()
	enabled := isWaffoPancakeWebhookEnabled()
	common.OptionMapRWMutex.RUnlock()
	if !enabled {
		logger.LogWarn(c.Request.Context(), common.LogText("Waffo Pancake webhook rejected reason=webhook_disabled path=%q client_ip=%s", c.Request.URL.Path, c.ClientIP()))
		c.String(http.StatusForbidden, "webhook disabled")
		return
	}

	// :env splits test vs prod traffic at the routing layer — operator
	// registers each URL in the matching webhook slot in Pancake's dashboard.
	// We then enforce event.mode == expectedEnv to catch mis-registrations.
	expectedEnv := strings.TrimSpace(c.Param("env"))
	if expectedEnv != "test" && expectedEnv != "prod" {
		logger.LogWarn(c.Request.Context(), common.LogText(
			"Waffo Pancake webhook invalid env path segment env=%q path=%q client_ip=%s",
			expectedEnv, c.Request.URL.Path, c.ClientIP(),
		))
		c.String(http.StatusNotFound, "unknown env")
		return
	}

	bodyBytes, err := io.ReadAll(c.Request.Body)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Waffo Pancake webhook failed to read request body path=%q client_ip=%s error=%q", c.Request.URL.Path, c.ClientIP(), err.Error()))
		c.String(http.StatusBadRequest, "bad request")
		return
	}

	signature := c.GetHeader("X-Waffo-Signature")
	logger.LogInfo(c.Request.Context(), common.LogText("Waffo Pancake webhook received request path=%q client_ip=%s body_bytes=%d", c.Request.URL.Path, c.ClientIP(), len(bodyBytes)))

	event, err := service.VerifyConfiguredWaffoPancakeWebhook(string(bodyBytes), signature)
	if err != nil {
		logger.LogWarn(c.Request.Context(), common.LogText("Waffo Pancake webhook signature verification failed path=%q client_ip=%s error_type=%T", c.Request.URL.Path, c.ClientIP(), err))
		c.String(http.StatusUnauthorized, "invalid signature")
		return
	}

	if !strings.EqualFold(strings.TrimSpace(event.Mode), expectedEnv) {
		logger.LogError(c.Request.Context(), common.LogText(
			"Waffo Pancake webhook env mismatch expected=%q actual_mode=%q event_id=%s order_id=%s client_ip=%s",
			expectedEnv, event.Mode, event.ID, event.Data.OrderID, c.ClientIP(),
		))
		c.String(http.StatusOK, "OK")
		return
	}

	logger.LogInfo(c.Request.Context(), common.LogText("Waffo Pancake webhook signature verified event_type=%s event_id=%s order_id=%s client_ip=%s", event.NormalizedEventType(), event.ID, event.Data.OrderID, c.ClientIP()))
	if event.NormalizedEventType() != "order.completed" {
		c.String(http.StatusOK, "OK")
		return
	}

	// Dispatch by trade_no prefix. OrderMerchantExternalID = our trade_no;
	// OrderID is Pancake's internal ORD_* (logs only).
	rawTradeNo := strings.TrimSpace(event.Data.OrderMerchantExternalID)
	isSubscription := strings.HasPrefix(rawTradeNo, "WAFFO_PANCAKE_SUB-")

	if isSubscription {
		tradeNo, err := service.ResolveWaffoPancakeSubscriptionTradeNo(event)
		if err != nil {
			logger.LogError(c.Request.Context(), common.LogText(
				"Waffo Pancake webhook failed to resolve subscription order event_id=%s order_id=%s buyer_identity=%q client_ip=%s error=%q",
				event.ID, event.Data.OrderID, event.Data.MerchantProvidedBuyerIdentity, c.ClientIP(), err.Error(),
			))
			c.String(http.StatusOK, "OK")
			return
		}
		LockOrder(tradeNo)
		defer UnlockOrder(tradeNo)
		if err := model.CompleteSubscriptionOrder(tradeNo, string(bodyBytes), model.PaymentProviderWaffoPancake, ""); err != nil {
			logger.LogError(c.Request.Context(), common.LogText("Waffo Pancake subscription completion failed trade_no=%s event_id=%s order_id=%s client_ip=%s error=%q", tradeNo, event.ID, event.Data.OrderID, c.ClientIP(), err.Error()))
			c.String(http.StatusInternalServerError, "retry")
			return
		}
		logger.LogInfo(c.Request.Context(), common.LogText("Waffo Pancake subscription completed trade_no=%s event_id=%s order_id=%s client_ip=%s", tradeNo, event.ID, event.Data.OrderID, c.ClientIP()))
		c.String(http.StatusOK, "OK")
		return
	}

	paid, amountErr := decimal.NewFromString(event.Data.Amount)
	if amountErr != nil || paid.IsNegative() {
		c.String(http.StatusBadRequest, "invalid payment amount")
		return
	}

	tradeNo, err := service.ResolveWaffoPancakeTradeNo(event)
	if err != nil {
		if errors.Is(err, service.ErrWaffoPancakeOrderLookup) {
			c.String(http.StatusInternalServerError, "retry")
			return
		}
		// LogError (not LogWarn): covers order-not-found and buyer-identity
		// mismatch — both warrant human attention. 200 OK so Waffo doesn't
		// retry a permanently-unresolvable webhook.
		logger.LogError(c.Request.Context(), common.LogText(
			"Waffo Pancake webhook failed to resolve order event_id=%s order_id=%s buyer_identity=%q client_ip=%s error=%q",
			event.ID, event.Data.OrderID, event.Data.MerchantProvidedBuyerIdentity, c.ClientIP(), err.Error(),
		))
		c.String(http.StatusOK, "OK")
		return
	}

	LockOrder(tradeNo)
	defer UnlockOrder(tradeNo)

	if err := model.RechargeWaffoPancake(tradeNo); err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Waffo Pancake top-up processing failed trade_no=%s event_id=%s order_id=%s client_ip=%s error=%q", tradeNo, event.ID, event.Data.OrderID, c.ClientIP(), err.Error()))
		c.String(http.StatusInternalServerError, "retry")
		return
	}

	logger.LogInfo(c.Request.Context(), common.LogText("Waffo Pancake top-up succeeded trade_no=%s event_id=%s order_id=%s client_ip=%s", tradeNo, event.ID, event.Data.OrderID, c.ClientIP()))
	c.String(http.StatusOK, "OK")
}
