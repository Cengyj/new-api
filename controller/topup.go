package controller

import (
	"errors"
	"fmt"
	"maps"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/gin-gonic/gin"
	"github.com/samber/lo"
	"github.com/shopspring/decimal"
)

func GetTopUpInfo(c *gin.Context) {
	common.OptionMapRWMutex.RLock()
	complianceConfirmed := operation_setting.IsPaymentComplianceConfirmed()
	enableEpay, enableStripe := isEpayTopUpEnabled(), isStripeTopUpEnabled()
	enableWaffo, enableWaffoPancake := isWaffoTopUpEnabled(), isWaffoPancakeTopUpEnabled()
	creemProducts, enableCreem := setting.CreemProducts, isCreemTopUpEnabled()
	minTopup, stripeMinTopup := operation_setting.MinTopUp, setting.StripeMinTopUp
	waffoMinTopup, pancakeMinTopup := setting.WaffoMinTopUp, setting.WaffoPancakeMinTopUp
	topupLink := common.TopUpLink
	payMethods := slices.Clone(operation_setting.PayMethods)
	amountOptions := slices.Clone(operation_setting.GetPaymentSetting().AmountOptions)
	amountDiscount := maps.Clone(operation_setting.GetPaymentSetting().AmountDiscount)
	common.OptionMapRWMutex.RUnlock()

	// 获取支付方式
	if !complianceConfirmed {
		payMethods = []map[string]string{}
	}

	// 如果启用了 Stripe 支付，添加到支付方法列表
	if enableStripe {
		// 检查是否已经包含 Stripe
		hasStripe := false
		for _, method := range payMethods {
			if method["type"] == "stripe" {
				hasStripe = true
				break
			}
		}

		if !hasStripe {
			stripeMethod := map[string]string{
				"name":      "Stripe",
				"type":      "stripe",
				"color":     "#635BFF",
				"min_topup": strconv.Itoa(stripeMinTopup),
			}
			payMethods = append(payMethods, stripeMethod)
		}
	}

	// Waffo Pancake is displayed above the standard Waffo gateway.
	if enableWaffoPancake {
		hasWaffoPancake := false
		for _, method := range payMethods {
			if method["type"] == model.PaymentMethodWaffoPancake {
				hasWaffoPancake = true
				break
			}
		}

		if !hasWaffoPancake {
			payMethods = append(payMethods, map[string]string{
				"name":      "Waffo Pancake",
				"type":      model.PaymentMethodWaffoPancake,
				"color":     "#F97316",
				"min_topup": strconv.Itoa(pancakeMinTopup),
			})
		}
	}

	// 如果启用了 Waffo 支付，添加到支付方法列表
	if enableWaffo {
		hasWaffo := false
		for _, method := range payMethods {
			if method["type"] == model.PaymentMethodWaffo {
				hasWaffo = true
				break
			}
		}

		if !hasWaffo {
			waffoMethod := map[string]string{
				"name":      "Waffo (Global Payment)",
				"type":      model.PaymentMethodWaffo,
				"color":     "#3B82F6",
				"min_topup": strconv.Itoa(waffoMinTopup),
			}
			payMethods = append(payMethods, waffoMethod)
		}
	}

	data := gin.H{
		"enable_online_topup":              enableEpay,
		"enable_stripe_topup":              enableStripe,
		"enable_creem_topup":               enableCreem,
		"enable_waffo_topup":               enableWaffo,
		"enable_waffo_pancake_topup":       enableWaffoPancake,
		"enable_redemption":                complianceConfirmed,
		"payment_compliance_confirmed":     complianceConfirmed,
		"payment_compliance_terms_version": operation_setting.CurrentComplianceTermsVersion,
		"waffo_pay_methods": func() any {
			if enableWaffo {
				return setting.GetWaffoPayMethods()
			}
			return nil
		}(),
		"creem_products":          creemProducts,
		"pay_methods":             payMethods,
		"min_topup":               minTopup,
		"stripe_min_topup":        stripeMinTopup,
		"waffo_min_topup":         waffoMinTopup,
		"waffo_pancake_min_topup": pancakeMinTopup,
		"amount_options":          amountOptions,
		"discount":                amountDiscount,
		"topup_link":              topupLink,
	}
	common.ApiSuccess(c, data)
}

type EpayRequest struct {
	Amount        int64  `json:"amount"`
	PaymentMethod string `json:"payment_method"`
}

type AmountRequest struct {
	Amount int64 `json:"amount"`
}

func GetEpayClient() *epay.Client {
	common.OptionMapRWMutex.RLock()
	address, partnerID, key := operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey
	common.OptionMapRWMutex.RUnlock()
	if strings.TrimSpace(address) == "" || strings.TrimSpace(partnerID) == "" || strings.TrimSpace(key) == "" {
		return nil
	}
	withUrl, err := epay.NewClient(&epay.Config{
		PartnerID: partnerID,
		Key:       key,
	}, address)
	if err != nil {
		return nil
	}
	return withUrl
}

// walletTopUpUnits freezes the amount unit and conversion rate before validation.
// Release the option lock before any database or payment-provider operation.
func walletTopUpUnits() (string, float64) {
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	return operation_setting.GetQuotaDisplayType(), common.QuotaPerUnit
}

func getPayMoney(amount int64, group, displayType string, quotaPerUnit float64) float64 {
	dAmount := decimal.NewFromInt(amount)
	// 充值金额以“展示类型”为准：
	// - USD/CNY: 前端传 amount 为金额单位；TOKENS: 前端传 tokens，需要换成 USD 金额
	if displayType == operation_setting.QuotaDisplayTypeTokens {
		dQuotaPerUnit := decimal.NewFromFloat(quotaPerUnit)
		dAmount = dAmount.Div(dQuotaPerUnit)
	}

	common.OptionMapRWMutex.RLock()
	topupGroupRatio := common.GetTopupGroupRatio(group)
	price := operation_setting.Price
	configuredDiscount := operation_setting.GetPaymentSetting().AmountDiscount[int(amount)]
	common.OptionMapRWMutex.RUnlock()
	if topupGroupRatio == 0 {
		topupGroupRatio = 1
	}

	dTopupGroupRatio := decimal.NewFromFloat(topupGroupRatio)
	dPrice := decimal.NewFromFloat(price)
	// apply optional preset discount by the original request amount (if configured), default 1.0
	discount := 1.0
	if configuredDiscount > 0 {
		discount = configuredDiscount
	}
	dDiscount := decimal.NewFromFloat(discount)

	payMoney := dAmount.Mul(dPrice).Mul(dTopupGroupRatio).Mul(dDiscount)

	return payMoney.InexactFloat64()
}

func getMinTopup(displayType string, quotaPerUnit float64) int64 {
	common.OptionMapRWMutex.RLock()
	minTopup := operation_setting.MinTopUp
	common.OptionMapRWMutex.RUnlock()
	if displayType == operation_setting.QuotaDisplayTypeTokens {
		dMinTopup := decimal.NewFromInt(int64(minTopup))
		dQuotaPerUnit := decimal.NewFromFloat(quotaPerUnit)
		quota, err := common.WalletQuotaFromDecimalStrict(dMinTopup.Mul(dQuotaPerUnit))
		if err != nil {
			return common.MaxWalletQuota
		}
		minTopup = quota
	}
	return int64(minTopup)
}

func getTopUpQuota(amount int64, displayType string, quotaPerUnit float64) (int, error) {
	quota := decimal.NewFromInt(amount)
	if displayType == operation_setting.QuotaDisplayTypeTokens {
		dQuotaPerUnit := decimal.NewFromFloat(quotaPerUnit)
		quota = decimal.NewFromInt(quota.Div(dQuotaPerUnit).IntPart()).Mul(dQuotaPerUnit)
	} else {
		quota = quota.Mul(decimal.NewFromFloat(quotaPerUnit))
	}
	return common.WalletQuotaFromDecimalStrict(quota)
}

func getMaxTopUpAmount(displayType string, quotaPerUnit float64) int64 {
	if quotaPerUnit <= 0 {
		return 0
	}
	dQuotaPerUnit := decimal.NewFromFloat(quotaPerUnit)
	maxStoredAmount := decimal.NewFromInt(common.MaxWalletQuota).
		Div(dQuotaPerUnit).
		Floor()
	if displayType == operation_setting.QuotaDisplayTypeTokens {
		return maxStoredAmount.Add(decimal.NewFromInt(1)).
			Mul(dQuotaPerUnit).
			Ceil().
			Sub(decimal.NewFromInt(1)).
			IntPart()
	}
	return maxStoredAmount.IntPart()
}

func validateCreditedQuota(quota decimal.Decimal) (int, error) {
	value, err := common.WalletQuotaFromDecimalStrict(quota)
	if err != nil {
		return 0, common.NewMessage("Top-up quota exceeds the range the system can represent")
	}
	if value <= 0 {
		return 0, common.NewMessage("Top-up quota must be greater than 0")
	}
	return value, nil
}

func validateTopUpQuota(amount int64, displayType string, quotaPerUnit float64) (int, error) {
	quota, err := getTopUpQuota(amount, displayType, quotaPerUnit)
	if err == nil && quota > 0 {
		return quota, nil
	}
	maxAmount := getMaxTopUpAmount(displayType, quotaPerUnit)
	if maxAmount > 0 && amount > maxAmount {
		return 0, common.NewMessage("Top-up amount cannot exceed {{max}}", map[string]any{"max": maxAmount})
	}
	return 0, common.NewMessage("Invalid top-up amount")
}

// validateTopUpPaymentAmount also rejects multiplication overflow from finite
// price inputs before a quote, local order or provider request is created.
func validateTopUpPaymentAmount(amount float64) error {
	if math.IsNaN(amount) || math.IsInf(amount, 0) {
		return common.NewMessage("Invalid top-up amount")
	}
	if amount < 0.01 {
		return common.NewMessage("Payment amount is too low")
	}
	return nil
}

// paymentError answers payment endpoints in their {"message": "error",
// "data": text} shape. When err is or wraps a *common.Message, the response
// also carries message_key and message_params for the web console.
func paymentError(c *gin.Context, err error) {
	body := gin.H{"message": "error", "data": err.Error()}
	var message *common.Message
	if errors.As(err, &message) {
		maps.Copy(body, message.Fields())
	}
	c.JSON(http.StatusOK, body)
}

func rejectInvalidCreditedQuota(c *gin.Context, userId int, quota decimal.Decimal) bool {
	creditedQuota, err := validateCreditedQuota(quota)
	if err == nil {
		err = model.ValidateTopUpQuotaCapacity(userId, creditedQuota)
	}
	if err != nil {
		paymentError(c, err)
		return true
	}
	return false
}

func rejectInvalidTopUpQuota(c *gin.Context, userId int, amount int64, displayType string, quotaPerUnit float64) (int, bool) {
	creditedQuota, err := validateTopUpQuota(amount, displayType, quotaPerUnit)
	if err == nil {
		err = model.ValidateTopUpQuotaCapacity(userId, creditedQuota)
	}
	if err != nil {
		paymentError(c, err)
		return 0, true
	}
	return creditedQuota, false
}

func RequestEpay(c *gin.Context) {
	if !requirePaymentCompliance(c) {
		return
	}

	var req EpayRequest
	err := c.ShouldBindJSON(&req)
	if err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}
	displayType, quotaPerUnit := walletTopUpUnits()
	minTopup := getMinTopup(displayType, quotaPerUnit)
	if req.Amount < minTopup {
		paymentError(c, common.NewMessage("Top-up amount cannot be less than {{min}}", map[string]any{"min": minTopup}))
		return
	}
	id := c.GetInt("id")
	creditedQuota, rejected := rejectInvalidTopUpQuota(c, id, req.Amount, displayType, quotaPerUnit)
	if rejected {
		return
	}

	group, err := model.GetUserGroup(id, true)
	if err != nil {
		paymentError(c, common.NewMessage("Failed to get the user group"))
		return
	}
	payMoney := getPayMoney(req.Amount, group, displayType, quotaPerUnit)
	if err := validateTopUpPaymentAmount(payMoney); err != nil {
		paymentError(c, err)
		return
	}

	common.OptionMapRWMutex.RLock()
	allowedPayMethod := operation_setting.ContainsPayMethod(req.PaymentMethod)
	common.OptionMapRWMutex.RUnlock()
	if !allowedPayMethod {
		paymentError(c, common.NewMessage("Payment method does not exist"))
		return
	}

	callBackAddress := service.GetCallbackAddress()
	returnUrl, _ := url.Parse(paymentReturnPath("/usage-logs"))
	notifyUrl, _ := url.Parse(callBackAddress + "/api/user/epay/notify")
	tradeNo := fmt.Sprintf("%s%d", common.GetRandomString(6), time.Now().Unix())
	tradeNo = fmt.Sprintf("USR%dNO%s", id, tradeNo)
	client := GetEpayClient()
	if client == nil {
		paymentError(c, common.NewMessage("Payment information has not been configured by administrator"))
		return
	}
	// Purchase only validates/signs local parameters; it makes no network call.
	uri, params, err := client.Purchase(&epay.PurchaseArgs{
		Type:           req.PaymentMethod,
		ServiceTradeNo: tradeNo,
		Name:           fmt.Sprintf("TUC%d", req.Amount),
		Money:          strconv.FormatFloat(payMoney, 'f', 2, 64),
		Device:         epay.PC,
		NotifyUrl:      notifyUrl,
		ReturnUrl:      returnUrl,
	})
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Epay failed to start payment user_id=%d trade_no=%s payment_method=%s amount=%d error=%q", id, tradeNo, req.PaymentMethod, req.Amount, err.Error()))
		paymentError(c, common.NewMessage("Failed to start payment"))
		return
	}
	amount := req.Amount
	if displayType == operation_setting.QuotaDisplayTypeTokens {
		dAmount := decimal.NewFromInt(int64(amount))
		dQuotaPerUnit := decimal.NewFromFloat(quotaPerUnit)
		amount = dAmount.Div(dQuotaPerUnit).IntPart()
	}
	topUp := &model.TopUp{
		UserId:          id,
		CreditedQuota:   &creditedQuota,
		Amount:          amount,
		Money:           payMoney,
		TradeNo:         tradeNo,
		PaymentMethod:   req.PaymentMethod,
		PaymentProvider: model.PaymentProviderEpay,
		CreateTime:      time.Now().Unix(),
		Status:          common.TopUpStatusPending,
	}
	err = topUp.Insert()
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Epay failed to create top-up order user_id=%d trade_no=%s payment_method=%s amount=%d error=%q", id, tradeNo, req.PaymentMethod, req.Amount, err.Error()))
		paymentError(c, common.NewMessage("Failed to create order"))
		return
	}
	logger.LogInfo(c.Request.Context(), common.LogText("Epay top-up order created user_id=%d trade_no=%s payment_method=%s amount=%d money=%.2f", id, tradeNo, req.PaymentMethod, req.Amount, payMoney))
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": params, "url": uri})
}

// tradeNo lock
var orderLocks sync.Map
var createLock sync.Mutex

// refCountedMutex 带引用计数的互斥锁，确保最后一个使用者才从 map 中删除
type refCountedMutex struct {
	mu       sync.Mutex
	refCount int
}

// LockOrder 尝试对给定订单号加锁
func LockOrder(tradeNo string) {
	createLock.Lock()
	var rcm *refCountedMutex
	if v, ok := orderLocks.Load(tradeNo); ok {
		rcm = v.(*refCountedMutex)
	} else {
		rcm = &refCountedMutex{}
		orderLocks.Store(tradeNo, rcm)
	}
	rcm.refCount++
	createLock.Unlock()
	rcm.mu.Lock()
}

// UnlockOrder 释放给定订单号的锁
func UnlockOrder(tradeNo string) {
	v, ok := orderLocks.Load(tradeNo)
	if !ok {
		return
	}
	rcm := v.(*refCountedMutex)
	rcm.mu.Unlock()

	createLock.Lock()
	rcm.refCount--
	if rcm.refCount == 0 {
		orderLocks.Delete(tradeNo)
	}
	createLock.Unlock()
}

func EpayNotify(c *gin.Context) {
	common.OptionMapRWMutex.RLock()
	enabled := isEpayWebhookEnabled()
	common.OptionMapRWMutex.RUnlock()
	if !enabled {
		logger.LogWarn(c.Request.Context(), common.LogText("Epay webhook rejected reason=webhook_disabled path=%q client_ip=%s", c.Request.URL.Path, c.ClientIP()))
		_, _ = c.Writer.Write([]byte("fail"))
		return
	}

	var params map[string]string

	if c.Request.Method == "POST" {
		// POST 请求：从 POST body 解析参数
		if err := c.Request.ParseForm(); err != nil {
			logger.LogError(c.Request.Context(), common.LogText("Epay webhook failed to parse POST form path=%q client_ip=%s error=%q", c.Request.URL.Path, c.ClientIP(), err.Error()))
			_, _ = c.Writer.Write([]byte("fail"))
			return
		}
		params = lo.Reduce(lo.Keys(c.Request.PostForm), func(r map[string]string, t string, i int) map[string]string {
			r[t] = c.Request.PostForm.Get(t)
			return r
		}, map[string]string{})
	} else {
		// GET 请求：从 URL Query 解析参数
		params = lo.Reduce(lo.Keys(c.Request.URL.Query()), func(r map[string]string, t string, i int) map[string]string {
			r[t] = c.Request.URL.Query().Get(t)
			return r
		}, map[string]string{})
	}
	logger.LogInfo(c.Request.Context(), common.LogText("Epay webhook received request path=%q client_ip=%s method=%s param_count=%d", c.Request.URL.Path, c.ClientIP(), c.Request.Method, len(params)))

	if len(params) == 0 {
		logger.LogWarn(c.Request.Context(), common.LogText("Epay webhook params are empty path=%q client_ip=%s", c.Request.URL.Path, c.ClientIP()))
		_, _ = c.Writer.Write([]byte("fail"))
		return
	}
	client := GetEpayClient()
	if client == nil {
		logger.LogError(c.Request.Context(), common.LogText("Epay client is not initialized path=%q client_ip=%s", c.Request.URL.Path, c.ClientIP()))
		_, err := c.Writer.Write([]byte("fail"))
		if err != nil {
			logger.LogError(c.Request.Context(), common.LogText("Epay webhook failed to write response path=%q client_ip=%s error=%q", c.Request.URL.Path, c.ClientIP(), err.Error()))
		}
		return
	}
	verifyInfo, err := client.Verify(params)
	if err != nil || !verifyInfo.VerifyStatus {
		if _, writeErr := c.Writer.Write([]byte("fail")); writeErr != nil {
			logger.LogError(c.Request.Context(), common.LogText("Epay webhook failed to write response path=%q client_ip=%s error=%q", c.Request.URL.Path, c.ClientIP(), writeErr.Error()))
		}
		if err != nil {
			logger.LogWarn(c.Request.Context(), common.LogText("Epay webhook signature verification failed path=%q client_ip=%s verify_error=%q", c.Request.URL.Path, c.ClientIP(), err.Error()))
		} else {
			logger.LogWarn(c.Request.Context(), common.LogText("Epay webhook signature verification failed path=%q client_ip=%s verify_status=false", c.Request.URL.Path, c.ClientIP()))
		}
		return
	}
	logger.LogInfo(c.Request.Context(), common.LogText("Epay webhook signature verified trade_no=%s callback_type=%s trade_status=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, verifyInfo.TradeStatus, c.ClientIP()))

	if verifyInfo.TradeStatus == epay.StatusTradeSuccess {
		paid, amountErr := decimal.NewFromString(verifyInfo.Money)
		if amountErr != nil || paid.IsNegative() {
			_, _ = c.Writer.Write([]byte("fail"))
			return
		}
		// 进程内锁只是优化；重复/并发回调的正确性由 RechargeEpay 的
		// 数据库行锁 + 事务内状态校验保证（多实例部署下同样安全）。
		LockOrder(verifyInfo.ServiceTradeNo)
		defer UnlockOrder(verifyInfo.ServiceTradeNo)
		alreadyDone, err := model.RechargeEpay(verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP())
		if err != nil {
			switch {
			case errors.Is(err, model.ErrTopUpNotFound):
				logger.LogWarn(c.Request.Context(), common.LogText("Epay callback order not found trade_no=%s callback_type=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP()))
			case errors.Is(err, model.ErrPaymentMethodMismatch):
				logger.LogWarn(c.Request.Context(), common.LogText("Epay order payment gateway mismatch trade_no=%s callback_type=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP()))
			case errors.Is(err, model.ErrTopUpStatusInvalid):
				logger.LogWarn(c.Request.Context(), common.LogText("Epay order status invalid trade_no=%s callback_type=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP()))
			default:
				logger.LogError(c.Request.Context(), common.LogText("Epay top-up processing failed trade_no=%s client_ip=%s error=%q", verifyInfo.ServiceTradeNo, c.ClientIP(), err.Error()))
			}
			if _, writeErr := c.Writer.Write([]byte("fail")); writeErr != nil {
				logger.LogError(c.Request.Context(), common.LogText("Epay webhook failed to write response trade_no=%s client_ip=%s error=%q", verifyInfo.ServiceTradeNo, c.ClientIP(), writeErr.Error()))
			}
			return
		}
		if alreadyDone {
			logger.LogInfo(c.Request.Context(), common.LogText("Epay duplicate callback ignored trade_no=%s callback_type=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP()))
		} else {
			logger.LogInfo(c.Request.Context(), common.LogText("Epay top-up succeeded trade_no=%s callback_type=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP()))
		}
	} else {
		logger.LogInfo(c.Request.Context(), common.LogText("Epay webhook ignored event trade_no=%s callback_type=%s trade_status=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, verifyInfo.TradeStatus, c.ClientIP()))
	}
	if _, writeErr := c.Writer.Write([]byte("success")); writeErr != nil {
		logger.LogError(c.Request.Context(), common.LogText("Epay webhook failed to write response trade_no=%s client_ip=%s error=%q", verifyInfo.ServiceTradeNo, c.ClientIP(), writeErr.Error()))
	}
}

func RequestAmount(c *gin.Context) {
	var req AmountRequest
	err := c.ShouldBindJSON(&req)
	if err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}

	displayType, quotaPerUnit := walletTopUpUnits()
	minTopup := getMinTopup(displayType, quotaPerUnit)
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
	payMoney := getPayMoney(req.Amount, group, displayType, quotaPerUnit)
	if err := validateTopUpPaymentAmount(payMoney); err != nil {
		paymentError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": strconv.FormatFloat(payMoney, 'f', 2, 64)})
}

func GetUserTopUps(c *gin.Context) {
	userId := c.GetInt("id")
	pageInfo := common.GetPageQuery(c)
	keyword := c.Query("keyword")

	var (
		topups []*model.TopUp
		total  int64
		err    error
	)
	if keyword != "" {
		topups, total, err = model.SearchUserTopUps(c.Request.Context(), userId, keyword, pageInfo)
	} else {
		topups, total, err = model.GetUserTopUps(c.Request.Context(), userId, pageInfo)
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}

	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(topups)
	common.ApiSuccess(c, pageInfo)
}

// GetAllTopUps 管理员获取全平台充值记录
func GetAllTopUps(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	keyword := c.Query("keyword")

	var (
		topups []*model.TopUp
		total  int64
		err    error
	)
	if keyword != "" {
		topups, total, err = model.SearchAllTopUps(c.Request.Context(), keyword, pageInfo)
	} else {
		topups, total, err = model.GetAllTopUps(c.Request.Context(), pageInfo)
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}

	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(topups)
	common.ApiSuccess(c, pageInfo)
}

type AdminCompleteTopupRequest struct {
	TradeNo string `json:"trade_no"`
}

// AdminCompleteTopUp 管理员补单接口
func AdminCompleteTopUp(c *gin.Context) {
	var req AdminCompleteTopupRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.TradeNo == "" {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}

	// 订单级互斥，防止并发补单
	LockOrder(req.TradeNo)
	defer UnlockOrder(req.TradeNo)

	if err := model.ManualCompleteTopUp(req.TradeNo, c.ClientIP()); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}
