package controller

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
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
	waffo "github.com/waffo-com/waffo-go"
	"github.com/waffo-com/waffo-go/config"
	"github.com/waffo-com/waffo-go/core"
	waffonet "github.com/waffo-com/waffo-go/net"
	"github.com/waffo-com/waffo-go/types/order"
	"gorm.io/gorm"
)

func getWaffoSDK() (*waffo.Waffo, error) {
	common.OptionMapRWMutex.RLock()
	merchantID := setting.WaffoMerchantId
	common.OptionMapRWMutex.RUnlock()
	return getWaffoSDKForMerchant(merchantID)
}

func getWaffoSDKForMerchant(merchantID string) (*waffo.Waffo, error) {
	common.OptionMapRWMutex.RLock()
	env := config.Sandbox
	apiKey := setting.WaffoSandboxApiKey
	privateKey := setting.WaffoSandboxPrivateKey
	publicKey := setting.WaffoSandboxPublicCert
	if !setting.WaffoSandbox {
		env = config.Production
		apiKey = setting.WaffoApiKey
		privateKey = setting.WaffoPrivateKey
		publicKey = setting.WaffoPublicCert
	}
	common.OptionMapRWMutex.RUnlock()
	builder := config.NewConfigBuilder().
		APIKey(apiKey).
		PrivateKey(privateKey).
		WaffoPublicKey(publicKey).
		Environment(env)
	if merchantID != "" {
		builder = builder.MerchantID(merchantID)
	}
	cfg, err := builder.Build()
	if err != nil {
		return nil, err
	}
	cfg.CustomTransport = service.WaffoHTTPTransport
	return waffo.New(cfg), nil
}

func getWaffoUserEmail(user *model.User) string {
	return fmt.Sprintf("%d@examples.com", user.Id)
}

func getWaffoCurrency() string {
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	if setting.WaffoCurrency != "" {
		return setting.WaffoCurrency
	}
	return "USD"
}

func buildWaffoTopUpGoodsInfo(amount int64) *order.GoodsInfo {
	appName := strings.TrimSpace(common.SystemName)
	if appName == "" {
		appName = "New API"
	}
	return &order.GoodsInfo{
		GoodsName: fmt.Sprintf("Recharge %d credits", amount),
		AppName:   appName,
	}
}

// zeroDecimalCurrencies 零小数位币种，金额不能带小数点
var zeroDecimalCurrencies = map[string]bool{
	"IDR": true, "JPY": true, "KRW": true, "VND": true,
}

func formatWaffoAmount(amount float64, currency string) string {
	if zeroDecimalCurrencies[currency] {
		return fmt.Sprintf("%.0f", amount)
	}
	return fmt.Sprintf("%.2f", amount)
}

// getWaffoPayMoney converts the user-facing amount to USD for Waffo payment.
// Waffo only accepts USD, so this function handles the conversion from different
// display types (USD/CNY/TOKENS) to the actual USD amount to charge.
func getWaffoPayMoney(amount float64, group, displayType string, quotaPerUnit float64) float64 {
	originalAmount := amount
	if displayType == operation_setting.QuotaDisplayTypeTokens {
		amount = amount / quotaPerUnit
	}
	common.OptionMapRWMutex.RLock()
	topupGroupRatio := common.GetTopupGroupRatio(group)
	unitPrice := setting.WaffoUnitPrice
	configuredDiscount := operation_setting.GetPaymentSetting().AmountDiscount[int(originalAmount)]
	common.OptionMapRWMutex.RUnlock()
	if topupGroupRatio == 0 {
		topupGroupRatio = 1
	}
	discount := 1.0
	if configuredDiscount > 0 {
		discount = configuredDiscount
	}
	return amount * unitPrice * topupGroupRatio * discount
}

type WaffoPayRequest struct {
	Amount         int64   `json:"amount"`
	PayMethodIndex *int    `json:"pay_method_index"` // 服务端支付方式列表的索引，nil 表示由 Waffo 自动选择
	PayMethodType  *string `json:"pay_method_type"`  // Optional selection snapshot; also supports the legacy type/name request.
	PayMethodName  *string `json:"pay_method_name"`
}

func getWaffoMinTopup() int64 {
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	return int64(setting.WaffoMinTopUp)
}

func RequestWaffoAmount(c *gin.Context) {
	var req WaffoPayRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}

	displayType, quotaPerUnit := walletTopUpUnits()
	waffoMinTopup := getWaffoMinTopup()
	if req.Amount < waffoMinTopup {
		paymentError(c, common.NewMessage("Top-up amount cannot be less than {{min}}", map[string]any{"min": waffoMinTopup}))
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

	payMoney := getWaffoPayMoney(float64(req.Amount), group, displayType, quotaPerUnit)
	if err := validateTopUpPaymentAmount(payMoney); err != nil {
		paymentError(c, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "success", "data": strconv.FormatFloat(payMoney, 'f', 2, 64)})
}

// RequestWaffoPay 创建 Waffo 支付订单
func RequestWaffoPay(c *gin.Context) {
	if !requirePaymentCompliance(c) {
		return
	}

	common.OptionMapRWMutex.RLock()
	enabled := setting.WaffoEnabled
	common.OptionMapRWMutex.RUnlock()
	if !enabled {
		paymentError(c, common.NewMessage("Waffo payment is not enabled"))
		return
	}

	var req WaffoPayRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}
	displayType, quotaPerUnit := walletTopUpUnits()
	waffoMinTopup := getWaffoMinTopup()
	if req.Amount < waffoMinTopup {
		paymentError(c, common.NewMessage("Top-up amount cannot be less than {{min}}", map[string]any{"min": waffoMinTopup}))
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

	// 从服务端配置查找支付方式，客户端只传索引或旧字段
	var resolvedPayMethodType, resolvedPayMethodName string
	methods := setting.GetWaffoPayMethods()
	if req.PayMethodIndex != nil {
		// 新协议：按索引查找
		idx := *req.PayMethodIndex
		if idx < 0 || idx >= len(methods) {
			logger.LogWarn(c.Request.Context(), common.LogText("Waffo invalid payment method index user_id=%d pay_method_index=%d method_count=%d", id, idx, len(methods)))
			paymentError(c, common.NewMessage("Unsupported payment method"))
			return
		}
		resolvedPayMethodType = methods[idx].PayMethodType
		resolvedPayMethodName = methods[idx].PayMethodName
		// Retain index-only clients. New clients bind the index to the method
		// the user confirmed, including an explicitly empty automatic choice.
		if req.PayMethodType != nil || req.PayMethodName != nil {
			if req.PayMethodType == nil || req.PayMethodName == nil ||
				*req.PayMethodType != resolvedPayMethodType || *req.PayMethodName != resolvedPayMethodName {
				paymentError(c, common.NewMessage("Unsupported payment method"))
				return
			}
		}
	} else if req.PayMethodType != nil && *req.PayMethodType != "" {
		// 兼容旧前端：验证客户端传的值在服务端列表中
		name := ""
		if req.PayMethodName != nil {
			name = *req.PayMethodName
		}
		valid := false
		for _, m := range methods {
			if m.PayMethodType == *req.PayMethodType && m.PayMethodName == name {
				valid = true
				resolvedPayMethodType = m.PayMethodType
				resolvedPayMethodName = m.PayMethodName
				break
			}
		}
		if !valid {
			logger.LogWarn(c.Request.Context(), common.LogText("Waffo invalid payment method user_id=%d pay_method_type=%s pay_method_name=%q", id, *req.PayMethodType, name))
			paymentError(c, common.NewMessage("Unsupported payment method"))
			return
		}
	}
	// resolvedPayMethodType/Name 为空时，Waffo 自动选择支付方式

	group, err := model.GetUserGroup(id, true)
	if err != nil {
		paymentError(c, common.NewMessage("Failed to get the user group"))
		return
	}
	payMoney := getWaffoPayMoney(float64(req.Amount), group, displayType, quotaPerUnit)
	if err := validateTopUpPaymentAmount(payMoney); err != nil {
		paymentError(c, err)
		return
	}

	// Both IDs share Waffo's 32-character paymentRequestId limit. The user
	// binding is persisted below; it must not make this identifier grow.
	merchantOrderId := "WAFFO-" + randstr.String(26)
	paymentRequestId := merchantOrderId

	// Token 模式下归一化 Amount（存等价美元/CNY 数量，避免 RechargeWaffo 双重放大）
	amount := req.Amount
	if displayType == operation_setting.QuotaDisplayTypeTokens {
		amount = max(decimal.NewFromInt(req.Amount).Div(decimal.NewFromFloat(quotaPerUnit)).IntPart(), 1)
	}

	// Freeze the merchant sent to this checkout, including SDK auto-injection.
	common.OptionMapRWMutex.RLock()
	merchantID := setting.WaffoMerchantId
	configuredNotifyURL, configuredReturnURL := setting.WaffoNotifyUrl, setting.WaffoReturnUrl
	common.OptionMapRWMutex.RUnlock()
	// 创建本地订单
	topUp := &model.TopUp{
		UserId:          id,
		CreditedQuota:   &creditedQuota,
		Amount:          amount,
		Money:           payMoney,
		TradeNo:         merchantOrderId,
		PaymentMethod:   model.PaymentMethodWaffo,
		PaymentProvider: model.PaymentProviderWaffo,
		WaffoMerchantID: &merchantID,
		CreateTime:      time.Now().Unix(),
		Status:          common.TopUpStatusPending,
	}
	if err := topUp.Insert(); err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Waffo failed to create top-up order user_id=%d trade_no=%s amount=%d error=%q", id, merchantOrderId, req.Amount, err.Error()))
		paymentError(c, common.NewMessage("Failed to create order"))
		return
	}

	sdk, err := getWaffoSDKForMerchant(merchantID)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Waffo SDK initialization failed user_id=%d trade_no=%s error=%q", id, merchantOrderId, err.Error()))
		topUp.Status = common.TopUpStatusFailed
		_ = topUp.Update()
		paymentError(c, common.NewMessage("Payment configuration error"))
		return
	}

	callbackAddr := service.GetCallbackAddress()
	notifyUrl := callbackAddr + "/api/waffo/webhook"
	if configuredNotifyURL != "" {
		notifyUrl = configuredNotifyURL
	}
	returnUrl := paymentReturnPath("/wallet?show_history=true")
	if configuredReturnURL != "" {
		returnUrl = configuredReturnURL
	}

	currency := getWaffoCurrency()
	goodsInfo := buildWaffoTopUpGoodsInfo(req.Amount)
	createParams := &order.CreateOrderParams{
		PaymentRequestID: paymentRequestId,
		MerchantOrderID:  merchantOrderId,
		OrderAmount:      formatWaffoAmount(payMoney, currency),
		OrderCurrency:    currency,
		OrderDescription: goodsInfo.GoodsName,
		OrderRequestedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		NotifyURL:        notifyUrl,
		MerchantInfo: &order.MerchantInfo{
			MerchantID: merchantID,
		},
		UserInfo: &order.UserInfo{
			UserID:       strconv.Itoa(user.Id),
			UserEmail:    getWaffoUserEmail(user),
			UserTerminal: "WEB",
		},
		PaymentInfo: &order.PaymentInfo{
			ProductName:   "ONE_TIME_PAYMENT",
			PayMethodType: resolvedPayMethodType,
			PayMethodName: resolvedPayMethodName,
		},
		GoodsInfo:          goodsInfo,
		SuccessRedirectURL: returnUrl,
		FailedRedirectURL:  returnUrl,
	}
	resp, err := sdk.Order().Create(c.Request.Context(), createParams, nil)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Waffo failed to create order user_id=%d trade_no=%s error_type=%T", id, merchantOrderId, err))
		// The provider may have accepted an interrupted request. Keep the frozen
		// pending order available for its eventual verified notification.
		paymentError(c, common.NewMessage("Failed to start payment"))
		return
	}
	paymentUrl, err := resolveWaffoCheckoutResponse(topUp, resp)
	if err != nil {
		if resp != nil && strings.TrimSpace(resp.Code) != "" && !resp.IsSuccess() {
			logger.LogWarn(c.Request.Context(), common.LogText("Waffo order creation rejected user_id=%d trade_no=%s code=%s", id, merchantOrderId, resp.Code))
		} else {
			logger.LogError(c.Request.Context(), common.LogText("Waffo failed to create order user_id=%d trade_no=%s error_type=%T", id, merchantOrderId, err))
		}
		paymentError(c, common.NewMessage("Failed to start payment"))
		return
	}
	logger.LogInfo(c.Request.Context(), common.LogText("Waffo top-up order created user_id=%d trade_no=%s amount=%d money=%.2f pay_method_type=%s pay_method_name=%q", id, merchantOrderId, req.Amount, payMoney, resolvedPayMethodType, resolvedPayMethodName))

	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"payment_url": paymentUrl,
			"order_id":    merchantOrderId,
		},
	})
}

// resolveWaffoCheckoutResponse only fails the stored order when the provider
// supplies an explicit rejection. Missing results must remain recoverable by
// a later verified notification, including JSON null decoded by the SDK.
func resolveWaffoCheckoutResponse(topUp *model.TopUp, resp *core.ApiResponse[order.CreateOrderData]) (string, error) {
	if resp == nil || strings.TrimSpace(resp.Code) == "" {
		return "", common.NewMessage("Failed to start payment")
	}
	if !resp.IsSuccess() {
		topUp.Status = common.TopUpStatusFailed
		return "", errors.Join(common.NewMessage("Failed to start payment"), topUp.Update())
	}

	orderData := resp.GetData()
	paymentURL := ""
	if orderData != nil {
		paymentURL = orderData.FetchRedirectURL()
		if paymentURL == "" {
			paymentURL = orderData.OrderAction
		}
	}
	if paymentURL == "" {
		// An incomplete response does not prove the provider rejected the order.
		return "", common.NewMessage("Failed to start payment")
	}
	return paymentURL, nil
}

// webhookPayloadWithSubInfo 扩展 PAYMENT_NOTIFICATION，包含 SDK 未定义的 subscriptionInfo 字段
type webhookPayloadWithSubInfo struct {
	EventType string `json:"eventType"`
	Result    struct {
		core.PaymentNotificationResult
		SubscriptionInfo *webhookSubscriptionInfo `json:"subscriptionInfo,omitempty"`
	} `json:"result"`
}

type webhookSubscriptionInfo struct {
	Period              string `json:"period,omitempty"`
	MerchantRequest     string `json:"merchantRequest,omitempty"`
	SubscriptionID      string `json:"subscriptionId,omitempty"`
	SubscriptionRequest string `json:"subscriptionRequest,omitempty"`
}

// WaffoWebhook 处理 Waffo 回调通知（支付/退款/订阅）
func WaffoWebhook(c *gin.Context) {
	common.OptionMapRWMutex.RLock()
	enabled := isWaffoWebhookEnabled()
	common.OptionMapRWMutex.RUnlock()
	if !enabled {
		logger.LogWarn(c.Request.Context(), common.LogText("Waffo webhook rejected reason=webhook_disabled path=%q client_ip=%s", c.Request.URL.Path, c.ClientIP()))
		c.AbortWithStatus(http.StatusForbidden)
		return
	}

	bodyBytes, err := io.ReadAll(c.Request.Body)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Waffo webhook failed to read request body path=%q client_ip=%s error=%q", c.Request.URL.Path, c.ClientIP(), err.Error()))
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}

	sdk, err := getWaffoSDK()
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Waffo webhook SDK initialization failed path=%q client_ip=%s error=%q", c.Request.URL.Path, c.ClientIP(), err.Error()))
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}

	wh := sdk.Webhook()
	bodyStr := string(bodyBytes)
	signature := c.GetHeader("X-SIGNATURE")
	logger.LogInfo(c.Request.Context(), common.LogText("Waffo webhook received request path=%q client_ip=%s body_bytes=%d", c.Request.URL.Path, c.ClientIP(), len(bodyBytes)))

	// 验证请求签名
	if !wh.VerifySignature(bodyStr, signature) {
		logger.LogWarn(c.Request.Context(), common.LogText("Waffo webhook signature verification failed path=%q client_ip=%s body_bytes=%d", c.Request.URL.Path, c.ClientIP(), len(bodyBytes)))
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}

	var event core.WebhookEvent
	if err := common.Unmarshal(bodyBytes, &event); err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Waffo webhook failed to parse path=%q client_ip=%s error_type=%T", c.Request.URL.Path, c.ClientIP(), err))
		sendWaffoWebhookResponse(c, wh, false, "invalid payload")
		return
	}

	switch event.EventType {
	case core.EventPayment:
		// 解析为扩展类型，区分普通支付和订阅支付
		var payload webhookPayloadWithSubInfo
		if err := common.Unmarshal(bodyBytes, &payload); err != nil {
			logger.LogError(c.Request.Context(), common.LogText("Waffo failed to parse payment callback payload event_type=%s client_ip=%s error_type=%T", event.EventType, c.ClientIP(), err))
			sendWaffoWebhookResponse(c, wh, false, "invalid payment payload")
			return
		}
		logger.LogInfo(c.Request.Context(), common.LogText("Waffo webhook verified and parsed event_type=%s merchant_order_id=%s order_status=%s client_ip=%s", event.EventType, payload.Result.MerchantOrderID, payload.Result.OrderStatus, c.ClientIP()))
		handleWaffoPayment(c, sdk, wh, &payload.Result.PaymentNotificationResult)
	default:
		logger.LogInfo(c.Request.Context(), common.LogText("Waffo webhook ignored event event_type=%s client_ip=%s", event.EventType, c.ClientIP()))
		sendWaffoWebhookResponse(c, wh, true, "")
	}
}

// The SDK decodes JSON even on HTTP authentication/server failures. Such a
// reply cannot prove that the merchant-authenticated order inquiry succeeded.
type waffoInquiryTransport struct {
	transport waffonet.HttpTransport
}

func (transport waffoInquiryTransport) Send(ctx context.Context, request *waffonet.HttpRequest) (*waffonet.HttpResponse, error) {
	response, err := transport.transport.Send(ctx, request)
	if err != nil {
		return nil, err
	}
	if response == nil {
		return nil, errors.New("Waffo inquiry returned no HTTP response")
	}
	if !response.IsSuccess() {
		return nil, fmt.Errorf("Waffo inquiry returned HTTP %d", response.StatusCode)
	}
	// The SDK verifies response signatures only when present; require one.
	if response.GetHeader(core.HeaderSignature) == "" {
		return nil, errors.New("Waffo inquiry response signature is missing")
	}
	return response, nil
}

// handleWaffoPayment 处理支付完成通知
func handleWaffoPayment(c *gin.Context, sdk *waffo.Waffo, wh *core.WebhookHandler, result *core.PaymentNotificationResult) {
	if result.OrderStatus == core.OrderStatusPaySuccess || result.OrderStatus == core.OrderStatusOrderClose {
		topUp, err := model.GetTopUpByTradeNoWithError(result.MerchantOrderID)
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			logger.LogError(c.Request.Context(), common.LogText("Waffo webhook order lookup failed trade_no=%s error=%q", result.MerchantOrderID, err.Error()))
			sendWaffoWebhookResponse(c, wh, false, "order lookup failed")
			return
		}
		// A platform signature alone does not bind an optional merchant field
		// to this checkout. Query the original paymentRequestId using the same
		// merchant credentials/environment that verified this notification.
		// Both old and new checkouts use tradeNo as paymentRequestId.
		merchantID, _ := result.MerchantInfo["merchantId"].(string)
		buyerID, _ := result.UserInfo["userId"].(string)
		if topUp != nil && topUp.PaymentProvider == model.PaymentProviderWaffo {
			if (merchantID != "" && topUp.WaffoMerchantID != nil && *topUp.WaffoMerchantID != "" && *topUp.WaffoMerchantID != merchantID) ||
				(result.PaymentRequestID != "" && result.PaymentRequestID != topUp.TradeNo) ||
				(buyerID != "" && buyerID != strconv.Itoa(topUp.UserId)) {
				sendWaffoWebhookResponse(c, wh, false, "payment identity mismatch")
				return
			}
			// A committed order only needs the existing idempotent settlement /
			// cache recovery path. Provider availability cannot revoke that fact.
			if topUp.Status == common.TopUpStatusPending {
				queryConfig := *sdk.GetConfig()
				if queryConfig.CustomTransport == nil {
					queryConfig.CustomTransport = waffonet.NewDefaultHttpTransportWithTimeouts(queryConfig.ConnectTimeout, queryConfig.ReadTimeout)
				}
				queryConfig.CustomTransport = waffoInquiryTransport{transport: queryConfig.CustomTransport}
				response, err := waffo.New(&queryConfig).Order().Inquiry(c.Request.Context(), &order.InquiryOrderParams{PaymentRequestID: topUp.TradeNo}, nil)
				// SDK v1.3.2 represents transport/verification failures as E0001
				// with nil error; a non-nil response is not proof of success.
				if err != nil || response == nil || !response.IsSuccess() || response.Data == nil {
					sendWaffoWebhookResponse(c, wh, false, "order inquiry unavailable")
					return
				}
				verified := response.Data
				if verified.PaymentRequestID != topUp.TradeNo || verified.MerchantOrderID != topUp.TradeNo ||
					verified.OrderStatus != result.OrderStatus ||
					(verified.SubscriptionInfo != nil && (verified.SubscriptionInfo.SubscriptionID != "" || verified.SubscriptionInfo.SubscriptionRequest != "" || verified.SubscriptionInfo.MerchantRequest != "")) ||
					(result.OrderStatus == core.OrderStatusPaySuccess && (verified.AcquiringOrderID == "" || verified.OrderCurrency == "")) ||
					(result.AcquiringOrderID != "" && result.AcquiringOrderID != verified.AcquiringOrderID) ||
					(result.OrderCurrency != "" && !strings.EqualFold(result.OrderCurrency, verified.OrderCurrency)) ||
					(verified.MerchantInfo != nil && topUp.WaffoMerchantID != nil && *topUp.WaffoMerchantID != "" && verified.MerchantInfo.MerchantID != *topUp.WaffoMerchantID) ||
					(verified.UserInfo != nil && verified.UserInfo.UserID != "" && verified.UserInfo.UserID != strconv.Itoa(topUp.UserId)) {
					sendWaffoWebhookResponse(c, wh, false, "order inquiry mismatch")
					return
				}
				if result.OrderStatus == core.OrderStatusPaySuccess {
					paid, paymentErr := decimal.NewFromString(result.OrderAmount)
					verifiedPaid, verifiedErr := decimal.NewFromString(verified.OrderAmount)
					// Compare final provider amounts, not the undiscounted checkout
					// quote: Waffo coupons legitimately permit a zero final amount.
					if paymentErr != nil || verifiedErr != nil || paid.IsNegative() || !paid.Equal(verifiedPaid) {
						sendWaffoWebhookResponse(c, wh, false, "payment amount mismatch")
						return
					}
				}
			}
		}
	}
	if result.OrderStatus != core.OrderStatusPaySuccess {
		logger.LogInfo(c.Request.Context(), common.LogText("Waffo order not successful, top-up skipped trade_no=%s order_status=%s client_ip=%s", result.MerchantOrderID, result.OrderStatus, c.ClientIP()))
		// Only a closed order is terminal. Authorization, capture and other
		// in-progress notifications must still allow a later payment success.
		if result.OrderStatus == core.OrderStatusOrderClose && result.MerchantOrderID != "" {
			if err := model.UpdatePendingTopUpStatus(result.MerchantOrderID, model.PaymentProviderWaffo, common.TopUpStatusFailed); err != nil &&
				!errors.Is(err, model.ErrTopUpNotFound) &&
				!errors.Is(err, model.ErrTopUpStatusInvalid) {
				logger.LogError(c.Request.Context(), common.LogText("Waffo failed to mark order as failed trade_no=%s error=%q", result.MerchantOrderID, err.Error()))
				if !errors.Is(err, model.ErrPaymentMethodMismatch) {
					sendWaffoWebhookResponse(c, wh, false, "order status update failed")
					return
				}
			}
		}
		sendWaffoWebhookResponse(c, wh, true, "")
		return
	}

	paid, amountErr := decimal.NewFromString(result.OrderAmount)
	if amountErr != nil || paid.IsNegative() {
		sendWaffoWebhookResponse(c, wh, false, "invalid payment amount")
		return
	}

	merchantOrderId := result.MerchantOrderID

	LockOrder(merchantOrderId)
	defer UnlockOrder(merchantOrderId)

	if err := model.RechargeWaffo(merchantOrderId, c.ClientIP()); err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Waffo top-up processing failed trade_no=%s client_ip=%s error=%q", merchantOrderId, c.ClientIP(), err.Error()))
		sendWaffoWebhookResponse(c, wh, false, err.Error())
		return
	}

	logger.LogInfo(c.Request.Context(), common.LogText("Waffo top-up succeeded trade_no=%s client_ip=%s", merchantOrderId, c.ClientIP()))
	sendWaffoWebhookResponse(c, wh, true, "")
}

// sendWaffoWebhookResponse 发送签名响应
func sendWaffoWebhookResponse(c *gin.Context, wh *core.WebhookHandler, success bool, msg string) {
	var body, sig string
	if success {
		body, sig = wh.BuildSuccessResponse()
	} else {
		body, sig = wh.BuildFailedResponse(msg)
	}
	c.Header("X-SIGNATURE", sig)
	c.Data(http.StatusOK, "application/json", []byte(body))
}
