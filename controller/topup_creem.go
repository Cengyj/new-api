package controller

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"github.com/thanhpk/randstr"
)

const CreemSignatureHeader = "creem-signature"

var creemAdaptor = &CreemAdaptor{}

// Local construction failures and documented input/authentication refusals
// establish that no checkout was created. Other failures leave the result open.
var errCreemCheckoutNotCreated = errors.New("Creem checkout was not created")

// 生成HMAC-SHA256签名
func generateCreemSignature(payload string, secret string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(payload))
	return hex.EncodeToString(h.Sum(nil))
}

// 验证Creem webhook签名
func verifyCreemSignature(payload string, signature string, secret string) bool {
	if strings.TrimSpace(secret) == "" {
		logger.LogWarn(context.Background(), common.LogText("Creem webhook secret is not configured test_mode=%t", setting.CreemTestMode))
		return false
	}

	expectedSignature := generateCreemSignature(payload, secret)
	return hmac.Equal([]byte(signature), []byte(expectedSignature))
}

// Creem uses JSON numbers for counts and minor currency units. Preserve whole
// values exactly, including decimal and exponent forms, in stored receipts.
type creemInteger int64

func (n *creemInteger) UnmarshalJSON(raw []byte) error {
	if bytes.Equal(raw, []byte("null")) {
		return nil // Match Go integer fields; optional pointers retain nil.
	}
	value, err := decimal.NewFromString(string(raw))
	if err != nil {
		return errors.New("invalid Creem integer")
	}
	if value.IsZero() {
		*n = 0
		return nil
	}
	// Reject impossible scales before rescaling: int64 has at most 19 digits,
	// and the coefficient cannot have more trailing zeros than the input length.
	exp := int64(value.Exponent())
	if exp > 18 || exp < -int64(len(raw)) {
		return errors.New("Creem number is not an int64")
	}
	integer := value.BigInt()
	if !integer.IsInt64() || !decimal.NewFromBigInt(integer, 0).Equal(value) {
		return errors.New("Creem number is not an int64")
	}
	*n = creemInteger(integer.Int64())
	return nil
}

type CreemPayRequest struct {
	ProductId     string `json:"product_id"`
	PaymentMethod string `json:"payment_method"`
	// Older clients select only by ID. Confirmation terms are a precondition, never a source of credit.
	ExpectedOffer *struct {
		Price    float64      `json:"price"`
		Currency string       `json:"currency"`
		Quota    creemInteger `json:"quota"`
	} `json:"expected_offer"`
}

type CreemProduct struct {
	ProductId string       `json:"productId"`
	Name      string       `json:"name"`
	Price     float64      `json:"price"`
	Currency  string       `json:"currency"`
	Quota     creemInteger `json:"quota"`
}

type CreemAdaptor struct {
}

func (*CreemAdaptor) RequestPay(c *gin.Context, req *CreemPayRequest) {
	if req.PaymentMethod != model.PaymentMethodCreem {
		paymentError(c, common.NewMessage("Unsupported payment channel"))
		return
	}
	common.OptionMapRWMutex.RLock()
	webhookConfigured := isCreemWebhookConfigured()
	productConfig := setting.CreemProducts
	checkoutConfig := creemCheckoutConfig{apiKey: setting.CreemApiKey, testMode: setting.CreemTestMode}
	common.OptionMapRWMutex.RUnlock()
	if !webhookConfigured {
		paymentError(c, common.NewMessage("Creem webhook is not configured"))
		return
	}

	if req.ProductId == "" {
		paymentError(c, common.NewMessage("Please select a product"))
		return
	}

	var products []json.RawMessage
	err := common.UnmarshalJsonStr(productConfig, &products)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Creem failed to parse product config user_id=%d error=%q", c.GetInt("id"), err.Error()))
		paymentError(c, common.NewMessage("Product configuration error"))
		return
	}

	// The buyer selects by product ID alone. An unrelated malformed offer must
	// not block it, but two different prices or credits for this ID are ambiguous.
	var selectedProduct *CreemProduct
	for _, raw := range products {
		var id struct {
			ProductID string `json:"productId"`
		}
		if common.Unmarshal(raw, &id) != nil || id.ProductID != req.ProductId {
			continue
		}
		var product struct {
			CreemProduct
			PriceJSON    json.RawMessage `json:"price"`
			CurrencyJSON json.RawMessage `json:"currency"`
		}
		if err := common.Unmarshal(raw, &product); err != nil {
			paymentError(c, common.NewMessage("Product configuration error"))
			return
		}
		// The wallet displays cents but TopUp.Money stores a float. Check the original number
		// against the representable two-decimal price; never round a different offer into it.
		if common.Unmarshal(product.PriceJSON, &product.Price) != nil || validateTopUpPaymentAmount(product.Price) != nil ||
			!creemPriceEquals(product.PriceJSON, decimal.NewFromFloat(product.Price).Round(2)) {
			paymentError(c, common.NewMessage("Product configuration error"))
			return
		}
		if product.CurrencyJSON == nil {
			product.Currency = "USD"
		} else if err := common.Unmarshal(product.CurrencyJSON, &product.Currency); err != nil || (product.Currency != "USD" && product.Currency != "EUR") {
			paymentError(c, common.NewMessage("Product configuration error"))
			return
		}
		if selectedProduct == nil {
			selectedProduct = &product.CreemProduct
		} else if selectedProduct.Price != product.Price || selectedProduct.Quota != product.Quota || selectedProduct.Currency != product.Currency {
			paymentError(c, common.NewMessage("Product configuration error"))
			return
		}
	}

	if selectedProduct == nil {
		paymentError(c, common.NewMessage("Product does not exist"))
		return
	}
	if offer := req.ExpectedOffer; offer != nil && (offer.Price != selectedProduct.Price || offer.Currency != selectedProduct.Currency || offer.Quota != selectedProduct.Quota) {
		paymentError(c, common.NewMessage("This offer has changed. Reload the wallet and review it before paying."))
		return
	}
	id := c.GetInt("id")
	if rejectInvalidCreditedQuota(c, id, decimal.NewFromInt(int64(selectedProduct.Quota))) {
		return
	}

	user, err := model.GetUserById(id, false)
	if err != nil || user == nil {
		paymentError(c, common.NewMessage("User does not exist"))
		return
	}

	// 生成唯一的订单引用ID
	reference := fmt.Sprintf("creem-api-ref-%d-%d-%s", user.Id, time.Now().UnixMilli(), randstr.String(4))
	referenceId := "ref_" + common.Sha1([]byte(reference))

	// 先创建订单记录，使用产品配置的金额和充值额度
	topUp := &model.TopUp{
		UserId:          id,
		Amount:          int64(selectedProduct.Quota), // 充值额度
		Money:           selectedProduct.Price,        // 支付金额
		TradeNo:         referenceId,
		PaymentMethod:   model.PaymentMethodCreem,
		PaymentProvider: model.PaymentProviderCreem,
		CreateTime:      time.Now().Unix(),
		Status:          common.TopUpStatusPending,
	}
	err = topUp.Insert()
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Creem failed to create top-up order user_id=%d trade_no=%s product_id=%s error=%q", id, referenceId, selectedProduct.ProductId, err.Error()))
		paymentOrderCreateError(c, referenceId, err)
		return
	}

	// 创建支付链接，传入用户邮箱
	checkoutUrl, err := checkoutConfig.link(c.Request.Context(), referenceId, selectedProduct, user.Email, user.Username, true)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Creem failed to create payment link user_id=%d trade_no=%s product_id=%s error_type=%T", id, referenceId, selectedProduct.ProductId, err))
		if errors.Is(err, errCreemCheckoutNotCreated) {
			// Creem preserves pending orders on a definite rejection. A callback
			// can already have settled this one before the create response arrived.
			stored, lookupErr := model.GetTopUpByTradeNoWithError(referenceId)
			if lookupErr == nil && stored.Status == common.TopUpStatusPending {
				paymentError(c, common.NewMessage("Failed to start payment"))
				return
			}
		}
		paymentCheckoutUnknown(c, referenceId)
		return
	}

	logger.LogInfo(c.Request.Context(), common.LogText("Creem top-up order created user_id=%d trade_no=%s product_id=%s product_name=%q quota=%d money=%.2f", id, referenceId, selectedProduct.ProductId, selectedProduct.Name, selectedProduct.Quota, selectedProduct.Price))

	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"checkout_url": checkoutUrl,
			"order_id":     referenceId,
		},
	})
}

func RequestCreemPay(c *gin.Context) {
	if !requirePaymentCompliance(c) {
		return
	}

	var req CreemPayRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}
	creemAdaptor.RequestPay(c, &req)
}

// Creem can send just the ID or an expanded object. In shared order receipts,
// keep that distinction and only retain the expanded fields declared below.
type creemResource[T any] struct {
	id       *string
	expanded T
}

func (r *creemResource[T]) UnmarshalJSON(data []byte) error {
	if common.GetJsonType(data) == "string" {
		return common.Unmarshal(data, &r.id)
	}
	r.id = nil
	return common.Unmarshal(data, &r.expanded)
}

func (r creemResource[T]) MarshalJSON() ([]byte, error) {
	if r.id != nil {
		return common.Marshal(*r.id)
	}
	return common.Marshal(r.expanded)
}

type CreemWebhookEvent struct {
	Id        string       `json:"id"`
	EventType string       `json:"eventType"`
	CreatedAt creemInteger `json:"created_at"`
	Object    struct {
		Id        string `json:"id"`
		Object    string `json:"object"`
		RequestId string `json:"request_id"`
		Order     struct {
			Object      string        `json:"object"`
			Id          string        `json:"id"`
			Customer    string        `json:"customer"`
			Product     string        `json:"product"`
			Amount      *creemInteger `json:"amount"`
			Currency    string        `json:"currency"`
			SubTotal    creemInteger  `json:"sub_total"`
			TaxAmount   creemInteger  `json:"tax_amount"`
			AmountDue   creemInteger  `json:"amount_due"`
			AmountPaid  *creemInteger `json:"amount_paid"`
			Status      string        `json:"status"`
			Type        string        `json:"type"`
			Transaction string        `json:"transaction"`
			CreatedAt   string        `json:"created_at"`
			UpdatedAt   string        `json:"updated_at"`
			Mode        string        `json:"mode"`
		} `json:"order"`
		Product creemResource[struct {
			Id                string       `json:"id"`
			Object            string       `json:"object"`
			Name              string       `json:"name"`
			Description       string       `json:"description"`
			Price             creemInteger `json:"price"`
			Currency          string       `json:"currency"`
			BillingType       string       `json:"billing_type"`
			BillingPeriod     string       `json:"billing_period"`
			Status            string       `json:"status"`
			TaxMode           string       `json:"tax_mode"`
			TaxCategory       string       `json:"tax_category"`
			DefaultSuccessUrl *string      `json:"default_success_url"`
			CreatedAt         string       `json:"created_at"`
			UpdatedAt         string       `json:"updated_at"`
			Mode              string       `json:"mode"`
		}] `json:"product"`
		Units        *creemInteger    `json:"units"`
		Subscription *json.RawMessage `json:"subscription,omitempty"`
		Customer     creemResource[struct {
			Id        string `json:"id"`
			Object    string `json:"object"`
			Email     string `json:"email"`
			Name      string `json:"name"`
			Country   string `json:"country"`
			CreatedAt string `json:"created_at"`
			UpdatedAt string `json:"updated_at"`
			Mode      string `json:"mode"`
		}] `json:"customer"`
		Status   string                     `json:"status"`
		Metadata map[string]json.RawMessage `json:"metadata"`
		Mode     string                     `json:"mode"`
	} `json:"object"`
}

func CreemWebhook(c *gin.Context) {
	common.OptionMapRWMutex.RLock()
	secret := setting.CreemWebhookSecret
	enabled := isCreemWebhookEnabled()
	walletOnly := !isCreemTopUpEnabled()
	common.OptionMapRWMutex.RUnlock()
	if !enabled || strings.TrimSpace(secret) == "" {
		logger.LogWarn(c.Request.Context(), common.LogText("Creem webhook rejected reason=webhook_disabled path=%q client_ip=%s", c.Request.URL.Path, c.ClientIP()))
		c.AbortWithStatus(http.StatusForbidden)
		return
	}

	// Preserve the exact signed body for verification and decoding.
	bodyBytes, err := io.ReadAll(c.Request.Body)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Creem webhook failed to read request body path=%q client_ip=%s error=%q", c.Request.URL.Path, c.ClientIP(), err.Error()))
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// 获取签名头
	signature := c.GetHeader(CreemSignatureHeader)
	logger.LogInfo(c.Request.Context(), common.LogText("Creem webhook received request path=%q client_ip=%s body_bytes=%d", c.Request.URL.Path, c.ClientIP(), len(bodyBytes)))
	if signature == "" {
		logger.LogWarn(c.Request.Context(), common.LogText("Creem webhook missing signature path=%q client_ip=%s", c.Request.URL.Path, c.ClientIP()))
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}

	// 验证签名
	if !verifyCreemSignature(string(bodyBytes), signature, secret) {
		logger.LogWarn(c.Request.Context(), common.LogText("Creem webhook signature verification failed path=%q client_ip=%s body_bytes=%d", c.Request.URL.Path, c.ClientIP(), len(bodyBytes)))
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}

	logger.LogInfo(c.Request.Context(), common.LogText("Creem webhook signature verified path=%q client_ip=%s", c.Request.URL.Path, c.ClientIP()))

	// Other signed events have different object schemas (for example an order ID, not an order object).
	var envelope struct {
		EventType string          `json:"eventType"`
		ID        string          `json:"id"`
		CreatedAt creemInteger    `json:"created_at"`
		Object    json.RawMessage `json:"object"`
	}
	if err := common.Unmarshal(bodyBytes, &envelope); err != nil || envelope.EventType == "" {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	if envelope.EventType != "checkout.completed" {
		logger.LogInfo(c.Request.Context(), common.LogText("Creem webhook ignored event event_type=%s event_id=%s", envelope.EventType, envelope.ID))
		c.Status(http.StatusOK)
		return
	}
	webhookEvent := CreemWebhookEvent{Id: envelope.ID, EventType: envelope.EventType, CreatedAt: envelope.CreatedAt}
	if err := common.Unmarshal(envelope.Object, &webhookEvent.Object); err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Creem webhook failed to parse path=%q client_ip=%s error_type=%T", c.Request.URL.Path, c.ClientIP(), err))
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}

	logger.LogInfo(c.Request.Context(), common.LogText("Creem webhook parsed event_type=%s event_id=%s request_id=%s order_id=%s order_status=%s", webhookEvent.EventType, webhookEvent.Id, webhookEvent.Object.RequestId, webhookEvent.Object.Order.Id, webhookEvent.Object.Order.Status))

	if walletOnly && !requireIssuedWalletOrder(c, webhookEvent.Object.RequestId, model.PaymentProviderCreem) {
		return
	}
	handleCheckoutCompleted(c, &webhookEvent)
}

// 处理支付完成事件
func handleCheckoutCompleted(c *gin.Context, event *CreemWebhookEvent) {
	// 验证订单状态
	if event.Object.Order.Status != "paid" {
		logger.LogInfo(c.Request.Context(), common.LogText("Creem order not paid, ignored request_id=%s order_id=%s order_status=%s", event.Object.RequestId, event.Object.Order.Id, event.Object.Order.Status))
		c.Status(http.StatusOK)
		return
	}

	// 获取引用ID（这是我们创建订单时传递的request_id）
	referenceId := event.Object.RequestId
	if referenceId == "" {
		logger.LogWarn(c.Request.Context(), common.LogText("Creem webhook missing request_id event_id=%s order_id=%s", event.Id, event.Object.Order.Id))
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Try complete subscription order first
	LockOrder(referenceId)
	defer UnlockOrder(referenceId)
	// Only the presence of a subscription is relevant to wallet proof. Keep expanded subscription data out of the shared receipt.
	hasSubscription := event.Object.Subscription != nil
	event.Object.Subscription = nil
	// Historical subscription receipts serialized an omitted quantity as zero.
	units := event.Object.Units
	if units == nil {
		event.Object.Units = new(creemInteger)
	}
	if err := model.CompleteSubscriptionOrder(referenceId, common.GetJsonString(event), model.PaymentProviderCreem, ""); err == nil {
		logger.LogInfo(c.Request.Context(), common.LogText("Creem subscription order processed trade_no=%s creem_order_id=%s", referenceId, event.Object.Order.Id))
		c.Status(http.StatusOK)
		return
	} else if err != nil && !errors.Is(err, model.ErrSubscriptionOrderNotFound) {
		logger.LogError(c.Request.Context(), common.LogText("Creem subscription order processing failed trade_no=%s creem_order_id=%s error=%q", referenceId, event.Object.Order.Id, err.Error()))
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}

	// 验证订单类型，目前只处理一次性付款（充值）
	if event.Object.Order.Type != "onetime" {
		logger.LogInfo(c.Request.Context(), common.LogText("Creem order type not supported, ignored request_id=%s creem_order_id=%s order_type=%s", referenceId, event.Object.Order.Id, event.Object.Order.Type))
		c.Status(http.StatusOK)
		return
	}
	// Wallet checkout requests buy one unit. Older signed notifications can
	// omit these fields, but explicit values must describe the same purchase.
	if units != nil && *units != 1 ||
		event.Object.Object != "" && event.Object.Object != "checkout" ||
		event.Object.Order.Object != "" && event.Object.Order.Object != "order" {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	product := event.Object.Product
	productID := product.expanded.Id
	if product.id != nil {
		productID = *product.id
	}
	if event.Object.Status != "" && event.Object.Status != "completed" || hasSubscription ||
		product.expanded.BillingType != "" && product.expanded.BillingType != "onetime" ||
		productID != "" && event.Object.Order.Product != "" && productID != event.Object.Order.Product {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Creem's OrderEntity makes amount_paid optional; older completed
	// checkouts provide the required order amount instead. Neither field is
	// payment proof: the verified signature and paid/onetime checks above are.
	// Retain presence so a missing amount cannot silently become a free order.
	amount, amountField := event.Object.Order.AmountPaid, "amount_paid"
	if amount == nil {
		amount, amountField = event.Object.Order.Amount, "amount"
	}
	if amount == nil || *amount < 0 || event.Object.Order.Amount != nil && *event.Object.Order.Amount < 0 {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	logger.LogInfo(c.Request.Context(), common.LogText("Creem wallet payment verified trade_no=%s creem_order_id=%s amount=%d amount_field=%s currency=%s", referenceId, event.Object.Order.Id, *amount, amountField, event.Object.Order.Currency))

	err := model.RechargeCreem(referenceId, "", "", c.ClientIP())
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Creem top-up processing failed trade_no=%s creem_order_id=%s client_ip=%s error=%q", referenceId, event.Object.Order.Id, c.ClientIP(), err.Error()))
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}

	logger.LogInfo(c.Request.Context(), common.LogText("Creem top-up succeeded trade_no=%s creem_order_id=%s client_ip=%s", referenceId, event.Object.Order.Id, c.ClientIP()))
	c.Status(http.StatusOK)
}

type CreemCheckoutRequest struct {
	ProductId string `json:"product_id"`
	RequestId string `json:"request_id"`
	Customer  struct {
		Email string `json:"email"`
	} `json:"customer"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

type CreemCheckoutResponse struct {
	Object       string           `json:"object"`
	CheckoutUrl  string           `json:"checkout_url"`
	Id           string           `json:"id"`
	RequestID    json.RawMessage  `json:"request_id"`
	Status       string           `json:"status"`
	Error        string           `json:"error"`
	Mode         string           `json:"mode"`
	Units        *creemInteger    `json:"units"`
	CustomPrice  *json.RawMessage `json:"custom_price"`
	Subscription *json.RawMessage `json:"subscription"`
	Order        *struct {
		Object  string `json:"object"`
		Product string `json:"product"`
		Type    string `json:"type"`
		Status  string `json:"status"`
	} `json:"order"`
	Product *creemResource[struct {
		ID          string          `json:"id"`
		BillingType string          `json:"billing_type"`
		Price       json.RawMessage `json:"price"`
		Currency    json.RawMessage `json:"currency"`
	}] `json:"product"`
}

// Compare a JSON number exactly, including decimal or exponent notation.
func creemPriceEquals(raw json.RawMessage, expected decimal.Decimal) bool {
	price, ok := new(big.Rat).SetString(string(raw))
	return ok && price.Cmp(expected.Rat()) == 0
}

type creemCheckoutConfig struct {
	apiKey   string
	testMode bool
}

func genCreemLink(ctx context.Context, referenceId string, product *CreemProduct, email string, username string) (string, error) {
	common.OptionMapRWMutex.RLock()
	config := creemCheckoutConfig{apiKey: setting.CreemApiKey, testMode: setting.CreemTestMode}
	common.OptionMapRWMutex.RUnlock()
	return config.link(ctx, referenceId, product, email, username, false)
}

func (config creemCheckoutConfig) link(ctx context.Context, referenceId string, product *CreemProduct, email, username string, oneTimeOnly bool) (string, error) {
	apiKey, testMode := config.apiKey, config.testMode
	if apiKey == "" {
		return "", fmt.Errorf("%w: API key is not configured", errCreemCheckoutNotCreated)
	}

	// 根据测试模式选择 API 端点
	apiUrl := "https://api.creem.io/v1/checkouts"
	if testMode {
		apiUrl = "https://test-api.creem.io/v1/checkouts"
		logger.LogInfo(ctx, common.LogText("Creem using test environment api_url=%s", apiUrl))
	}

	// 构建请求数据，确保包含用户邮箱
	requestData := CreemCheckoutRequest{
		ProductId: product.ProductId,
		RequestId: referenceId, // 这个作为订单ID传递给Creem
		Customer: struct {
			Email string `json:"email"`
		}{
			Email: email, // 用户邮箱会在支付页面预填充
		},
		Metadata: map[string]string{
			"username":     username,
			"reference_id": referenceId,
			"product_name": product.Name,
			"quota":        fmt.Sprintf("%d", product.Quota),
		},
	}

	// 序列化请求数据
	jsonData, err := common.Marshal(requestData)
	if err != nil {
		return "", fmt.Errorf("%w: marshal request data: %w", errCreemCheckoutNotCreated, err)
	}

	// 创建 HTTP 请求
	req, err := http.NewRequest("POST", apiUrl, bytes.NewBuffer(jsonData))
	if err != nil {
		return "", fmt.Errorf("%w: create HTTP request: %w", errCreemCheckoutNotCreated, err)
	}

	// 设置请求头
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)

	logger.LogInfo(ctx, common.LogText("Creem payment request sent api_url=%s product_id=%s trade_no=%s", apiUrl, product.ProductId, referenceId))

	// 发送请求
	client := &http.Client{
		Timeout: 30 * time.Second,
		// Checkout uses a fixed API endpoint. Do not forward the merchant key
		// or replay its POST after a redirect; the original outcome is unknown.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to send HTTP request: %v", err)
	}
	defer resp.Body.Close()

	// 读取响应
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response: %v", err)
	}

	logger.LogInfo(ctx, common.LogText("Creem API response received trade_no=%s status_code=%d body_bytes=%d", referenceId, resp.StatusCode, len(body)))

	if resp.StatusCode/100 != 2 {
		if creemCheckoutRejected(resp.StatusCode, body) {
			return "", fmt.Errorf("%w: HTTP %d", errCreemCheckoutNotCreated, resp.StatusCode)
		}
		return "", fmt.Errorf("Creem API http status %d", resp.StatusCode)
	}
	var checkoutResp CreemCheckoutResponse
	if err := common.Unmarshal(body, &checkoutResp); err != nil {
		return "", fmt.Errorf("failed to parse response: %v", err)
	}
	var returnedID string
	if checkoutResp.RequestID != nil && (common.Unmarshal(checkoutResp.RequestID, &returnedID) != nil || returnedID != referenceId) {
		return "", errors.New("Creem checkout response refers to a different order")
	}
	if checkoutResp.Error != "" || checkoutResp.Status != "" && checkoutResp.Status != "pending" {
		return "", errors.New("Creem checkout is not awaiting payment")
	}
	if mode := checkoutResp.Mode; mode != "" && (testMode && mode != "test" && mode != "sandbox" || !testMode && mode != "prod") {
		return "", errors.New("Creem checkout environment does not match the request")
	}
	// This request omits units, which Creem defines as a single unit.
	if checkoutResp.Units != nil && *checkoutResp.Units != 1 {
		return "", errors.New("Creem checkout quantity does not match the request")
	}
	var catalogPrice, catalogCurrency json.RawMessage
	if p := checkoutResp.Product; p != nil {
		id := p.expanded.ID
		if p.id != nil {
			id = *p.id
		}
		if id != product.ProductId || oneTimeOnly && p.expanded.BillingType != "" && p.expanded.BillingType != "onetime" {
			return "", errors.New("Creem checkout product does not match the purchase")
		}
		catalogPrice, catalogCurrency = p.expanded.Price, p.expanded.Currency
	}
	if oneTimeOnly {
		if o := checkoutResp.Order; checkoutResp.Object != "" && checkoutResp.Object != "checkout" || checkoutResp.Subscription != nil ||
			o != nil && (o.Object != "" && o.Object != "order" || o.Product != "" && o.Product != product.ProductId ||
				o.Type != "" && o.Type != "onetime" || o.Status != "" && o.Status != "pending") {
			return "", errors.New("Creem did not return a pending one-time order for this wallet product")
		}
		// USD/EUR product and custom prices are cents per unit, not the tax- or discount-adjusted order total.
		expected := decimal.NewFromFloat(product.Price).Shift(2)
		if catalogPrice != nil && !creemPriceEquals(catalogPrice, expected) ||
			checkoutResp.CustomPrice != nil && !creemPriceEquals(*checkoutResp.CustomPrice, expected) {
			return "", errors.New("Creem unit price does not match the wallet offer")
		}
		var currency string
		if catalogCurrency != nil && (common.Unmarshal(catalogCurrency, &currency) != nil || currency != product.Currency) {
			return "", errors.New("Creem product currency does not match the wallet offer")
		}
	}

	if strings.TrimSpace(checkoutResp.CheckoutUrl) == "" {
		return "", fmt.Errorf("Creem API resp no checkout url ")
	}

	logger.LogInfo(ctx, common.LogText("Creem payment link created trade_no=%s response_id=%s", referenceId, checkoutResp.Id))
	return checkoutResp.CheckoutUrl, nil
}

func creemCheckoutRejected(status int, body []byte) bool {
	switch status {
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
	default:
		return false
	}
	var refusal struct {
		CreemCheckoutResponse
		Status  *int            `json:"status"`
		Message json.RawMessage `json:"message"`
	}
	if common.Unmarshal(body, &refusal) != nil || refusal.Object == "checkout" || refusal.Id != "" || refusal.CheckoutUrl != "" || refusal.RequestID != nil || refusal.Product != nil || refusal.Order != nil || refusal.Subscription != nil ||
		refusal.Units != nil || refusal.CustomPrice != nil || refusal.Status != nil && *refusal.Status != status {
		return false
	}
	var messages []string
	if common.GetJsonType(refusal.Message) == "string" {
		var text string
		if common.Unmarshal(refusal.Message, &text) != nil {
			return false
		}
		messages = []string{text}
	} else if len(refusal.Message) != 0 && common.Unmarshal(refusal.Message, &messages) != nil {
		return false
	}
	if status != http.StatusBadRequest {
		return strings.TrimSpace(refusal.Error) != "" || len(messages) > 0 && strings.TrimSpace(messages[0]) != ""
	}
	// Creem also uses 400/Bad Request for existing resources. Only an explicit
	// input refusal (including the legacy string form) rules out a checkout.
	for _, text := range messages {
		switch strings.TrimSpace(text) {
		case "Product not found", "The 'product_id' field is required.", "product_id must be a string", "success_url must be a valid URL":
		default:
			return false
		}
	}
	return len(messages) != 0
}
