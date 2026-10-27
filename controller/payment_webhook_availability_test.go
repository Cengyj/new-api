package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/stripe/stripe-go/v81"
	"github.com/stripe/stripe-go/v81/webhook"
	waffo "github.com/waffo-com/waffo-go"
	"github.com/waffo-com/waffo-go/core"
	waffonet "github.com/waffo-com/waffo-go/net"
	"github.com/waffo-com/waffo-go/types/order"
	waffoutils "github.com/waffo-com/waffo-go/utils"
	"gorm.io/gorm"
)

func confirmPaymentComplianceForTest(t *testing.T) {
	t.Helper()
	paymentSetting := operation_setting.GetPaymentSetting()
	originalConfirmed := paymentSetting.ComplianceConfirmed
	originalTermsVersion := paymentSetting.ComplianceTermsVersion
	t.Cleanup(func() {
		paymentSetting.ComplianceConfirmed = originalConfirmed
		paymentSetting.ComplianceTermsVersion = originalTermsVersion
	})
	paymentSetting.ComplianceConfirmed = true
	paymentSetting.ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
}

// The callback gate already requires compliance. New checkouts must obey the
// same condition so a hidden method cannot sell an order whose callback the
// server rejects. Authentication is covered separately by router tests.
func TestWalletCheckoutRequiresPaymentComplianceBeforeCreatingOrder(t *testing.T) {
	for _, provider := range []string{model.PaymentProviderEpay, model.PaymentProviderStripe, model.PaymentProviderCreem, model.PaymentProviderWaffo} {
		t.Run(provider, func(t *testing.T) {
			router, keys := walletCheckoutFixture(t)
			existing := walletWebhookOrder(t, provider, "existing-before-compliance-pause")
			operation_setting.GetPaymentSetting().ComplianceConfirmed = false
			oldBackend := stripe.GetBackend(stripe.APIBackend)
			oldTransport := http.DefaultTransport
			oldWaffoPrice, oldWaffoMin := setting.WaffoUnitPrice, setting.WaffoMinTopUp
			t.Cleanup(func() {
				stripe.SetBackend(stripe.APIBackend, oldBackend)
				http.DefaultTransport = oldTransport
				setting.WaffoUnitPrice, setting.WaffoMinTopUp = oldWaffoPrice, oldWaffoMin
			})
			setting.WaffoUnitPrice, setting.WaffoMinTopUp = 1, 1
			var externalRequests atomic.Int32
			transport := walletCheckoutTransport(func(request *http.Request) (*http.Response, error) {
				externalRequests.Add(1)
				body := "{\"id\":\"checkout_fixture\",\"url\":\"https://checkout.example.invalid/fixture\",\"checkout_url\":\"https://checkout.example.invalid/fixture\"}"
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			http.DefaultTransport = transport
			stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{HTTPClient: &http.Client{Transport: transport}, MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false)}))
			handler, body := RequestEpay, "{\"amount\":100,\"payment_method\":\"alipay\"}"
			switch provider {
			case model.PaymentProviderStripe:
				handler, body = RequestStripePay, "{\"amount\":100,\"payment_method\":\"stripe\"}"
			case model.PaymentProviderCreem:
				handler, body = RequestCreemPay, "{\"product_id\":\"fixture\",\"payment_method\":\"creem\"}"
				setting.CreemProducts = "[{\"productId\":\"fixture\",\"price\":100,\"currency\":\"USD\",\"quota\":1000}]"
			case model.PaymentProviderWaffo:
				handler, body = RequestWaffoPay, "{\"amount\":100}"
				// Waffo constructs its own HTTP transport. Keep this precondition
				// test offline even before the fix; local validation occurs only
				// after the old path has persisted an unwanted failed order.
				setting.WaffoPrivateKey = "invalid-local-fixture-key"
			}
			router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, handler)
			request := httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			assert.Contains(t, recorder.Body.String(), "Payment, redemption, subscription, and invitation reward features are disabled.")
			assert.NotContains(t, recorder.Body.String(), "https://checkout.example.invalid/fixture")
			assert.Zero(t, externalRequests.Load())
			var orders []model.TopUp
			require.NoError(t, model.DB.Find(&orders).Error)
			assert.Len(t, orders, 1, "disabled checkout must not create an order or make it manually completable")
			callback := httptest.NewRecorder()
			router.ServeHTTP(callback, walletWebhookRequest(t, keys, provider, existing.TradeNo, "90", true))
			if provider == model.PaymentProviderEpay {
				assert.Equal(t, "fail", callback.Body.String())
			} else {
				assert.Equal(t, http.StatusForbidden, callback.Code)
			}
			var invitee, inviter model.User
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			assert.Equal(t, -10, invitee.Quota)
			assert.Equal(t, 7, inviter.AffQuota)
			require.NoError(t, model.DB.First(existing, existing.Id).Error)
			assert.Equal(t, common.TopUpStatusPending, existing.Status, "the gate must not alter an existing order")
			var facts int64
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			assert.Zero(t, facts)
		})
	}
}

func TestWalletWaffoCheckoutRejectsFailedPricingGroupLookup(t *testing.T) {
	router, _ := walletCheckoutFixture(t)
	oldPrice, oldMin := setting.WaffoUnitPrice, setting.WaffoMinTopUp
	t.Cleanup(func() { setting.WaffoUnitPrice, setting.WaffoMinTopUp = oldPrice, oldMin })
	setting.WaffoUnitPrice, setting.WaffoMinTopUp = 1, 1
	setting.WaffoPrivateKey = "invalid-local-fixture-key"
	require.NoError(t, common.UpdateTopupGroupRatioByJSONString("{\"default\":1,\"premium\":2}"))
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 902).Update("group", "premium").Error)
	var groupLookupFailures atomic.Int32
	require.NoError(t, model.DB.Callback().Query().Before("gorm:query").Register("fixture:waffo_pricing_group_failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "users" && len(tx.Statement.Selects) == 1 && strings.Contains(tx.Statement.Selects[0], "group") {
			groupLookupFailures.Add(1)
			tx.AddError(errors.New("isolated pricing group lookup failure"))
		}
	}))
	t.Cleanup(func() { _ = model.DB.Callback().Query().Remove("fixture:waffo_pricing_group_failure") })
	router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestWaffoPay)
	request := httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader("{\"amount\":100}"))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	assert.EqualValues(t, 1, groupLookupFailures.Load())
	assert.Contains(t, recorder.Body.String(), "Failed to get the user group")
	var orders []model.TopUp
	require.NoError(t, model.DB.Find(&orders).Error)
	assert.Empty(t, orders, "a pricing read failure must not persist an order priced using the default group")
	if len(orders) > 0 {
		t.Logf("unexpected stored payment amount=%v; the user's premium group requires %v", orders[0].Money, getWaffoPayMoney(100, "premium", operation_setting.GetQuotaDisplayType(), common.QuotaPerUnit))
	}
	var invitee model.User
	require.NoError(t, model.DB.First(&invitee, 902).Error)
	assert.Equal(t, -10, invitee.Quota)
	var facts int64
	require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
	assert.Zero(t, facts)
}

func TestWalletWaffoCheckoutBindsSelectedMethodIdentity(t *testing.T) {
	for _, scenario := range []struct {
		name, fields string
		automatic    bool
		rejected     bool
	}{
		{name: "selected_method_matches", fields: `"pay_method_index":0,"pay_method_type":"CARD","pay_method_name":"Card"`},
		{name: "reordered_method", fields: `"pay_method_index":0,"pay_method_type":"BANK_TRANSFER","pay_method_name":"Bank"`, rejected: true},
		{name: "changed_method_name", fields: `"pay_method_index":0,"pay_method_type":"CARD","pay_method_name":"Different card"`, rejected: true},
		{name: "automatic_method_matches", fields: `"pay_method_index":0,"pay_method_type":"","pay_method_name":""`, automatic: true},
		{name: "automatic_replaced_by_card", fields: `"pay_method_index":0,"pay_method_type":"","pay_method_name":""`, rejected: true},
		{name: "partial_identity", fields: `"pay_method_index":0,"pay_method_type":"CARD"`, rejected: true},
		{name: "partial_null_identity", fields: `"pay_method_index":0,"pay_method_type":"CARD","pay_method_name":null`, rejected: true},
		{name: "legacy_index_only", fields: `"pay_method_index":0`},
		{name: "null_identity_is_legacy_index_only", fields: `"pay_method_index":0,"pay_method_type":null,"pay_method_name":null`},
		{name: "legacy_type_and_name", fields: `"pay_method_type":"BANK_TRANSFER","pay_method_name":"Bank"`},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			router, _ := walletCheckoutFixture(t)
			oldPrice, oldMin, oldOptions := setting.WaffoUnitPrice, setting.WaffoMinTopUp, common.OptionMap
			t.Cleanup(func() {
				setting.WaffoUnitPrice, setting.WaffoMinTopUp, common.OptionMap = oldPrice, oldMin, oldOptions
			})
			setting.WaffoUnitPrice, setting.WaffoMinTopUp = 1, 1
			common.OptionMap = make(map[string]string)
			methods := []constant.WaffoPayMethod{{PayMethodType: "CARD", PayMethodName: "Card"}, {PayMethodType: "BANK_TRANSFER", PayMethodName: "Bank"}}
			if scenario.automatic {
				methods[0] = constant.WaffoPayMethod{}
			}
			require.NoError(t, setting.SetWaffoPayMethods(methods))
			// An accepted selection reaches order creation. Deliberately fail the
			// SDK's local key validation immediately after that to keep this
			// selection-contract test offline, without replacing the entry point.
			setting.WaffoPrivateKey = "invalid-local-fixture-key"
			router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestWaffoPay)
			request := httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader(`{"amount":100,`+scenario.fields+`}`))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			var orders []model.TopUp
			require.NoError(t, model.DB.Find(&orders).Error)
			if scenario.rejected {
				assert.Contains(t, response.Body.String(), "Unsupported payment method")
				assert.Empty(t, orders, "a changed selection must not create an order")
			} else {
				assert.Contains(t, response.Body.String(), "Payment configuration error")
				require.Len(t, orders, 1, "matching and legacy selections retain the existing checkout path")
				assert.Equal(t, common.TopUpStatusFailed, orders[0].Status)
				require.NotNil(t, orders[0].CreditedQuota)
				assert.Equal(t, 1000, *orders[0].CreditedQuota)
			}
			var invitee, inviter model.User
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			assert.Equal(t, -10, invitee.Quota)
			assert.Equal(t, 7, inviter.AffQuota)
			var facts int64
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			assert.Zero(t, facts)
		})
	}
}

func TestStripeWebhookEnabledRequiresTopUpAndWebhookConfig(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalAPISecret := setting.StripeApiSecret
	originalWebhookSecret := setting.StripeWebhookSecret
	originalPriceID := setting.StripePriceId
	t.Cleanup(func() {
		setting.StripeApiSecret = originalAPISecret
		setting.StripeWebhookSecret = originalWebhookSecret
		setting.StripePriceId = originalPriceID
	})

	setting.StripeWebhookSecret = ""
	setting.StripeApiSecret = "sk_test_123"
	setting.StripePriceId = "price_123"
	require.False(t, isStripeWebhookEnabled())

	setting.StripeWebhookSecret = "whsec_test"
	require.True(t, isStripeWebhookEnabled())

	setting.StripePriceId = ""
	require.False(t, isStripeWebhookEnabled())
}

func TestCreemWebhookEnabledRequiresTopUpAndWebhookConfig(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalAPIKey := setting.CreemApiKey
	originalProducts := setting.CreemProducts
	originalWebhookSecret := setting.CreemWebhookSecret
	t.Cleanup(func() {
		setting.CreemApiKey = originalAPIKey
		setting.CreemProducts = originalProducts
		setting.CreemWebhookSecret = originalWebhookSecret
	})

	setting.CreemWebhookSecret = ""
	setting.CreemApiKey = "creem_api_key"
	setting.CreemProducts = `[{"productId":"prod_123"}]`
	require.False(t, isCreemWebhookEnabled())

	setting.CreemWebhookSecret = "creem_secret"
	require.True(t, isCreemWebhookEnabled())

	setting.CreemProducts = "[]"
	require.False(t, isCreemWebhookEnabled())
}

func TestWaffoWebhookEnabledRequiresTopUpAndWebhookConfig(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalEnabled := setting.WaffoEnabled
	originalSandbox := setting.WaffoSandbox
	originalAPIKey := setting.WaffoApiKey
	originalPrivateKey := setting.WaffoPrivateKey
	originalPublicCert := setting.WaffoPublicCert
	originalSandboxAPIKey := setting.WaffoSandboxApiKey
	originalSandboxPrivateKey := setting.WaffoSandboxPrivateKey
	originalSandboxPublicCert := setting.WaffoSandboxPublicCert
	t.Cleanup(func() {
		setting.WaffoEnabled = originalEnabled
		setting.WaffoSandbox = originalSandbox
		setting.WaffoApiKey = originalAPIKey
		setting.WaffoPrivateKey = originalPrivateKey
		setting.WaffoPublicCert = originalPublicCert
		setting.WaffoSandboxApiKey = originalSandboxAPIKey
		setting.WaffoSandboxPrivateKey = originalSandboxPrivateKey
		setting.WaffoSandboxPublicCert = originalSandboxPublicCert
	})

	setting.WaffoEnabled = true
	setting.WaffoSandbox = false
	setting.WaffoApiKey = ""
	setting.WaffoPrivateKey = "private"
	setting.WaffoPublicCert = "public"
	require.False(t, isWaffoWebhookEnabled())

	setting.WaffoApiKey = "api"
	require.True(t, isWaffoWebhookEnabled())

	setting.WaffoEnabled = false
	require.False(t, isWaffoWebhookEnabled())

	setting.WaffoEnabled = true
	setting.WaffoSandbox = true
	setting.WaffoSandboxApiKey = ""
	setting.WaffoSandboxPrivateKey = "sandbox_private"
	setting.WaffoSandboxPublicCert = "sandbox_public"
	require.False(t, isWaffoWebhookEnabled())

	setting.WaffoSandboxApiKey = "sandbox_api"
	require.True(t, isWaffoWebhookEnabled())
}

func TestWaffoPancakeWebhookEnabledRequiresTopUpAndWebhookConfig(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalMerchantID := setting.WaffoPancakeMerchantID
	originalPrivateKey := setting.WaffoPancakePrivateKey
	originalProductID := setting.WaffoPancakeProductID
	t.Cleanup(func() {
		setting.WaffoPancakeMerchantID = originalMerchantID
		setting.WaffoPancakePrivateKey = originalPrivateKey
		setting.WaffoPancakeProductID = originalProductID
	})

	// Presence of all three credentials enables the gateway. Webhook public
	// keys are bundled in the SDK and there is no separate Enabled toggle —
	// clear any of the three fields to disable.
	setting.WaffoPancakeMerchantID = ""
	setting.WaffoPancakePrivateKey = "private"
	setting.WaffoPancakeProductID = "product"
	require.False(t, isWaffoPancakeWebhookEnabled())

	setting.WaffoPancakeMerchantID = "merchant"
	require.True(t, isWaffoPancakeWebhookEnabled())

	setting.WaffoPancakeProductID = ""
	require.False(t, isWaffoPancakeWebhookEnabled())

	setting.WaffoPancakeProductID = "product"
	setting.WaffoPancakePrivateKey = ""
	require.False(t, isWaffoPancakeWebhookEnabled())
}

func TestEpayWebhookEnabledRequiresTopUpAndWebhookConfig(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalPayAddress := operation_setting.PayAddress
	originalEpayID := operation_setting.EpayId
	originalEpayKey := operation_setting.EpayKey
	originalPayMethods := operation_setting.PayMethods
	t.Cleanup(func() {
		operation_setting.PayAddress = originalPayAddress
		operation_setting.EpayId = originalEpayID
		operation_setting.EpayKey = originalEpayKey
		operation_setting.PayMethods = originalPayMethods
	})

	operation_setting.PayAddress = "https://pay.example.com"
	operation_setting.EpayId = "epay_id"
	operation_setting.EpayKey = ""
	operation_setting.PayMethods = []map[string]string{{"type": "alipay"}}
	require.False(t, isEpayWebhookEnabled())

	operation_setting.EpayKey = "epay_key"
	require.True(t, isEpayWebhookEnabled())

	operation_setting.PayMethods = nil
	require.False(t, isEpayWebhookEnabled())
}

func TestEpayCallbacksVerifyBeforeSettlement(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalPayAddress := operation_setting.PayAddress
	originalEpayID := operation_setting.EpayId
	originalEpayKey := operation_setting.EpayKey
	originalPayMethods := operation_setting.PayMethods
	originalServerAddress := system_setting.ServerAddress
	originalDB := model.DB
	t.Cleanup(func() {
		operation_setting.PayAddress = originalPayAddress
		operation_setting.EpayId = originalEpayID
		operation_setting.EpayKey = originalEpayKey
		operation_setting.PayMethods = originalPayMethods
		system_setting.ServerAddress = originalServerAddress
		model.DB = originalDB
	})
	operation_setting.PayAddress = "https://pay.example.com"
	operation_setting.EpayId = "epay_id"
	operation_setting.EpayKey = "test-key"
	operation_setting.PayMethods = []map[string]string{{"type": "alipay"}}
	system_setting.ServerAddress = "https://dashboard.example.com"
	// Rejected callbacks and valid non-success events must never reach settlement.
	// A nil database makes an accidental attempt to settle fail the test.
	model.DB = nil
	require.True(t, isEpayWebhookEnabled())

	// Both ambiguous maps below had this same valid signing string in v0.0.4.
	// This must fail because of parameter ambiguity, not a mismatched signature.
	ambiguousSign := epay.MD5String("money=1.00&name=item&out_trade_no=other&out_trade_no=order&pid=epay_id&trade_status=TRADE_SUCCESS&type=alipay", "test-key")
	pendingSign := epay.MD5String("money=1.00&name=item%26other&out_trade_no=order&pid=epay_id&trade_status=WAIT_BUYER_PAY&type=alipay", "test-key")
	cases := []struct {
		name         string
		productName  string
		tradeNo      string
		status       string
		sign         string
		validPending bool
	}{
		{"separator in product name", "item&out_trade_no=other", "order", epay.StatusTradeSuccess, ambiguousSign, false},
		{"separator in order number", "item", "other&out_trade_no=order", epay.StatusTradeSuccess, ambiguousSign, false},
		{"invalid signature", "item", "order", epay.StatusTradeSuccess, "invalid", false},
		{"missing signature", "item", "order", epay.StatusTradeSuccess, "", false},
		{"valid pending with literal percent escape", "item%26other", "order", "WAIT_BUYER_PAY", pendingSign, true},
	}
	endpoints := []struct {
		name             string
		path             string
		handler          gin.HandlerFunc
		status           int
		rejectedBody     string
		pendingBody      string
		rejectedLocation string
		pendingLocation  string
	}{
		{
			name: "topup notify", path: "/api/user/epay/notify", handler: EpayNotify,
			status: http.StatusOK, rejectedBody: "fail", pendingBody: "success",
		},
		{
			name: "subscription notify", path: "/api/subscription/epay/notify", handler: SubscriptionEpayNotify,
			status: http.StatusOK, rejectedBody: "fail", pendingBody: "fail",
		},
		{
			name: "subscription return", path: "/api/subscription/epay/return", handler: SubscriptionEpayReturn,
			status:           http.StatusFound,
			rejectedLocation: "https://dashboard.example.com/wallet?pay=fail",
			pendingLocation:  "https://dashboard.example.com/wallet?pay=pending",
		},
	}
	router := gin.New()
	for _, endpoint := range endpoints {
		router.Any(endpoint.path, endpoint.handler)
	}
	for _, endpoint := range endpoints {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			for _, tc := range cases {
				t.Run(endpoint.name+"/"+method+"/"+tc.name, func(t *testing.T) {
					params := url.Values{
						"pid": {"epay_id"}, "type": {"alipay"}, "money": {"1.00"},
						"name": {tc.productName}, "out_trade_no": {tc.tradeNo},
						"trade_status": {tc.status}, "sign_type": {"MD5"},
					}
					if tc.sign != "" {
						params.Set("sign", tc.sign)
					}
					request := httptest.NewRequest(method, endpoint.path+"?"+params.Encode(), nil)
					if method == http.MethodPost {
						request = httptest.NewRequest(method, endpoint.path, strings.NewReader(params.Encode()))
						request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
					}
					recorder := httptest.NewRecorder()
					require.NotPanics(t, func() { router.ServeHTTP(recorder, request) })
					assert.Equal(t, endpoint.status, recorder.Code)
					wantBody, wantLocation := endpoint.rejectedBody, endpoint.rejectedLocation
					if tc.validPending {
						wantBody, wantLocation = endpoint.pendingBody, endpoint.pendingLocation
					}
					if wantBody != "" {
						assert.Equal(t, wantBody, recorder.Body.String())
					}
					assert.Equal(t, wantLocation, recorder.Header().Get("Location"))
				})
			}
		}
	}
}

// walletWebhookFixture uses real controllers, the providers' real signature
// verification, and a disposable database. These are local protocol
// fixtures; platform sandbox and cross-process database tests are separate.
func walletWebhookFixture(t *testing.T) (*gin.Engine, *waffoutils.KeyPair) {
	t.Helper()
	confirmPaymentComplianceForTest(t)
	oldDB, oldLogDB := model.DB, model.LOG_DB
	oldMainType, oldLogType := common.MainDatabaseType(), common.LogDatabaseType()
	oldQuota, oldRedis := common.QuotaPerUnit, common.RedisEnabled
	dialect := os.Getenv("NEW_API_PAYMENT_TEST_DIALECT")
	if dialect == "" {
		dialect = "sqlite"
	}
	require.Contains(t, []string{"sqlite", "mysql", "postgres"}, dialect)
	db, _ := newAuditTestDatabase(t, dialect, os.Getenv("TEST_"+strings.ToUpper(dialect)+"_DSN"))
	databaseType := common.DatabaseType(dialect)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.TopUp{}, &model.SubscriptionOrder{}, &model.Option{}, &model.ReferralRebate{}, &model.Log{}))
	model.DB, model.LOG_DB = db, db
	common.SetDatabaseTypes(databaseType, databaseType)
	common.QuotaPerUnit, common.RedisEnabled = 10, false
	t.Cleanup(func() {
		model.DB, model.LOG_DB = oldDB, oldLogDB
		common.SetDatabaseTypes(oldMainType, oldLogType)
		common.QuotaPerUnit, common.RedisEnabled = oldQuota, oldRedis
		require.NoError(t, sqlDB.Close())
	})
	require.NoError(t, model.InitializeReferralRebateRule(db))
	require.NoError(t, model.SaveReferralRebateRule(model.ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 30}))
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.User{Id: 901, Username: "wallet_inviter", AffCode: "w901", Status: common.UserStatusEnabled, AffQuota: 7, AffHistoryQuota: 11}).Error)
	require.NoError(t, db.Create(&model.User{Id: 902, Username: "wallet_invitee", AffCode: "w902", Status: common.UserStatusEnabled, Quota: -10, InviterId: 901, CreatedAt: now - 60, ReferralRateBPS: 1000, ReferralExpiresAt: now + 3600}).Error)

	keys, err := waffoutils.GenerateKeyPair()
	require.NoError(t, err)
	stringsToRestore := []*string{
		&setting.StripeApiSecret, &setting.StripeWebhookSecret, &setting.StripePriceId,
		&setting.CreemApiKey, &setting.CreemProducts, &setting.CreemWebhookSecret,
		&setting.WaffoApiKey, &setting.WaffoPrivateKey, &setting.WaffoPublicCert,
		&setting.WaffoPancakeMerchantID, &setting.WaffoPancakePrivateKey, &setting.WaffoPancakeProductID, &setting.WaffoPancakeStoreID,
		&operation_setting.PayAddress, &operation_setting.EpayId, &operation_setting.EpayKey,
	}
	values := make([]string, len(stringsToRestore))
	for i, value := range stringsToRestore {
		values[i] = *value
	}
	oldWaffoEnabled, oldSandbox, oldCreemTest, oldMethods := setting.WaffoEnabled, setting.WaffoSandbox, setting.CreemTestMode, operation_setting.PayMethods
	t.Cleanup(func() {
		for i, pointer := range stringsToRestore {
			*pointer = values[i]
		}
		setting.WaffoEnabled, setting.WaffoSandbox, setting.CreemTestMode, operation_setting.PayMethods = oldWaffoEnabled, oldSandbox, oldCreemTest, oldMethods
	})
	setting.StripeApiSecret, setting.StripeWebhookSecret, setting.StripePriceId = "sk_test_fixture", "whsec_fixture", "price_fixture"
	setting.CreemApiKey, setting.CreemProducts, setting.CreemWebhookSecret, setting.CreemTestMode = "fixture", `[{"productId":"fixture"}]`, "creem_fixture", false
	setting.WaffoEnabled, setting.WaffoSandbox = true, false
	setting.WaffoApiKey, setting.WaffoPrivateKey, setting.WaffoPublicCert = "fixture", keys.PrivateKey, keys.PublicKey
	oldWaffoTransport := service.WaffoHTTPTransport
	service.WaffoHTTPTransport = &walletWaffoInquiryTransport{t: t, keys: keys}
	t.Cleanup(func() { service.WaffoHTTPTransport = oldWaffoTransport })
	setting.WaffoPancakeMerchantID, setting.WaffoPancakePrivateKey, setting.WaffoPancakeProductID, setting.WaffoPancakeStoreID = "MER_AbCdEfGhIjKlMnOpQrStUv", keys.PrivateKey, "product_fixture", "store_fixture"
	oldPancakeClient := http.DefaultClient
	pancakeClient := *oldPancakeClient
	pancakeClient.Transport = &walletPancakeInquiryTransport{t: t, next: oldPancakeClient.Transport}
	http.DefaultClient = &pancakeClient
	t.Cleanup(func() { http.DefaultClient = oldPancakeClient })
	t.Setenv("WAFFO_WEBHOOK_TEST_PUBLIC_KEY", keys.PublicKey)
	operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey = "https://pay.example.invalid", "epay_fixture", "epay_fixture_key"
	operation_setting.PayMethods = []map[string]string{{"type": "alipay"}}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/epay", EpayNotify)
	router.POST("/stripe", StripeWebhook)
	router.POST("/creem", CreemWebhook)
	router.POST("/waffo", WaffoWebhook)
	router.POST("/waffo_pancake/:env", WaffoPancakeWebhook)
	router.POST("/manual", AdminCompleteTopUp)
	return router, keys
}

func walletWebhookOrder(t *testing.T, provider, tradeNo string) *model.TopUp {
	t.Helper()
	amount := int64(100)
	if provider == model.PaymentProviderCreem {
		amount = 1000 // Creem's Amount is already quota, not currency units.
	}
	topup := &model.TopUp{UserId: 902, Amount: amount, Money: 100, TradeNo: tradeNo, PaymentMethod: provider, PaymentProvider: provider, CreateTime: time.Now().Unix(), Status: common.TopUpStatusPending}
	require.NoError(t, topup.Insert())
	require.NotNil(t, topup.CreditedQuota)
	require.Equal(t, 1000, *topup.CreditedQuota)
	return topup
}

func walletWebhookRequest(t *testing.T, keys *waffoutils.KeyPair, provider, tradeNo, amount string, paid bool) *http.Request {
	t.Helper()
	if provider == model.PaymentProviderEpay {
		status := "TRADE_SUCCESS"
		if !paid {
			status = "WAIT_BUYER_PAY"
		}
		params := url.Values{"pid": {"epay_fixture"}, "type": {"alipay"}, "name": {"fixture"}, "out_trade_no": {tradeNo}, "trade_status": {status}, "sign_type": {"MD5"}}
		if amount != "" {
			params.Set("money", amount)
		}
		var signed []string
		for _, key := range []string{"money", "name", "out_trade_no", "pid", "trade_status", "type"} {
			if params.Get(key) != "" {
				signed = append(signed, key+"="+params.Get(key))
			}
		}
		params.Set("sign", epay.MD5String(strings.Join(signed, "&"), operation_setting.EpayKey))
		request := httptest.NewRequest(http.MethodPost, "/epay", strings.NewReader(params.Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		return request
	}
	var payload map[string]any
	switch provider {
	case model.PaymentProviderStripe:
		status := "paid"
		if !paid {
			status = "unpaid"
		} else if amount == "0" {
			status = "no_payment_required"
		}
		object := map[string]any{"mode": "payment", "payment_link": nil, "status": "complete", "payment_status": status, "client_reference_id": tradeNo, "customer": "cus_fixture", "currency": "usd"}
		if amount != "" {
			if value, err := strconv.ParseInt(amount, 10, 64); err == nil {
				object["amount_total"] = value
			} else {
				object["amount_total"] = amount
			}
		}
		payload = map[string]any{"id": "evt_fixture", "object": "event", "type": "checkout.session.completed", "data": map[string]any{"object": object}}
	case model.PaymentProviderCreem:
		status := "paid"
		if !paid {
			status = "pending"
		}
		order := map[string]any{"id": "order_fixture", "status": status, "type": "onetime", "currency": "USD"}
		if amount != "" {
			if value, err := strconv.ParseInt(amount, 10, 64); err == nil {
				order["amount_paid"] = value
			} else {
				order["amount_paid"] = amount
			}
		}
		payload = map[string]any{"id": "event_fixture", "eventType": "checkout.completed", "object": map[string]any{"request_id": tradeNo, "order": order}}
	case model.PaymentProviderWaffo:
		status := "PAY_SUCCESS"
		if !paid {
			status = "ORDER_CLOSE"
		}
		payload = map[string]any{"eventType": "PAYMENT_NOTIFICATION", "result": map[string]any{"merchantOrderId": tradeNo, "paymentRequestId": tradeNo, "orderStatus": status, "orderAmount": amount, "orderCurrency": "USD"}}
	case model.PaymentProviderWaffoPancake:
		eventType := "order.completed"
		if !paid {
			eventType = "order.pending"
		}
		payload = map[string]any{"id": "event_fixture", "eventType": eventType, "mode": "test", "storeId": "store_fixture", "data": map[string]any{"orderId": "ORD_fixture", "orderMerchantExternalId": tradeNo, "merchantProvidedBuyerIdentity": "new-api-user-902", "amount": amount, "currency": "USD"}}
	}
	return signedWalletWebhookRequest(t, keys, provider, payload)
}

func signedWalletWebhookRequest(t *testing.T, keys *waffoutils.KeyPair, provider string, payload map[string]any) *http.Request {
	t.Helper()
	body, err := common.Marshal(payload)
	require.NoError(t, err)
	path := "/" + provider
	if provider == model.PaymentProviderWaffoPancake {
		path += "/test"
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	switch provider {
	case model.PaymentProviderStripe:
		signed := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{Payload: body, Secret: setting.StripeWebhookSecret})
		request.Header.Set("Stripe-Signature", signed.Header)
	case model.PaymentProviderCreem:
		request.Header.Set(CreemSignatureHeader, generateCreemSignature(string(body), setting.CreemWebhookSecret))
	case model.PaymentProviderWaffo:
		if transport, ok := service.WaffoHTTPTransport.(*walletWaffoInquiryTransport); ok {
			transport.setResult(payload["result"].(map[string]any))
		}
		signature, err := waffoutils.Sign(string(body), keys.PrivateKey)
		require.NoError(t, err)
		request.Header.Set("X-SIGNATURE", signature)
	case model.PaymentProviderWaffoPancake:
		if transport, ok := http.DefaultClient.Transport.(*walletPancakeInquiryTransport); ok {
			transport.setResult(payload)
		}
		timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
		signature, err := waffoutils.Sign(timestamp+"."+string(body), keys.PrivateKey)
		require.NoError(t, err)
		request.Header.Set("X-Waffo-Signature", "t="+timestamp+",v1="+signature)
	}
	return request
}

func TestWalletPancakeWebhookPreservesOfficialRetryWindow(t *testing.T) {
	t.Run("delayed original signature settles only once", func(t *testing.T) {
		router, keys := walletWebhookFixture(t)
		order := walletWebhookOrder(t, model.PaymentProviderWaffoPancake, "pancake-delayed-original-signature")
		request := walletWebhookRequest(t, keys, model.PaymentProviderWaffoPancake, order.TradeNo, "90", true)
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		// Waffo retries reuse the first delivery's signature header. Their
		// documented schedule can deliver a timestamp over 31 minutes old.
		timestamp := strconv.FormatInt(time.Now().Add(-32*time.Minute).UnixMilli(), 10)
		signature, err := waffoutils.Sign(timestamp+"."+string(body), keys.PrivateKey)
		require.NoError(t, err)
		for range 2 {
			retry := httptest.NewRequest(http.MethodPost, request.URL.Path, bytes.NewReader(body))
			retry.Header.Set("X-Waffo-Signature", "t="+timestamp+",v1="+signature)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, retry)
			assert.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		}
		var invitee, inviter model.User
		require.NoError(t, model.DB.First(&invitee, 902).Error)
		require.NoError(t, model.DB.First(&inviter, 901).Error)
		assert.Equal(t, 990, invitee.Quota)
		assert.Equal(t, 107, inviter.AffQuota)
		assert.Equal(t, 111, inviter.AffHistoryQuota)
		var facts []model.ReferralRebate
		require.NoError(t, model.DB.Find(&facts).Error)
		assert.Len(t, facts, 1)
		stored, err := model.GetTopUpByTradeNoWithError(order.TradeNo)
		require.NoError(t, err)
		assert.Equal(t, common.TopUpStatusSuccess, stored.Status)
	})

	t.Run("bounded signature timestamp", func(t *testing.T) {
		_, keys := walletWebhookFixture(t)
		request := walletWebhookRequest(t, keys, model.PaymentProviderWaffoPancake, "window-boundary", "90", true)
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		// The fake clock also freezes the installed SDK's time.Now, so exact
		// millisecond boundaries need neither sleeps nor production test hooks.
		synctest.Test(t, func(t *testing.T) {
			for _, tc := range []struct {
				name    string
				offset  time.Duration
				wantErr bool
			}{
				{"current", 0, false},
				{"last retry", -32 * time.Minute, false},
				{"old boundary", -45 * time.Minute, false},
				{"too old", -45*time.Minute - time.Millisecond, true},
				{"future boundary", time.Minute, false},
				{"too far in future", time.Minute + time.Millisecond, true},
			} {
				timestamp := strconv.FormatInt(time.Now().Add(tc.offset).UnixMilli(), 10)
				signature, err := waffoutils.Sign(timestamp+"."+string(body), keys.PrivateKey)
				require.NoError(t, err)
				header := "t=" + timestamp + ",v1=" + signature
				_, err = service.VerifyConfiguredWaffoPancakeWebhook(string(body), header)
				if tc.wantErr {
					assert.Error(t, err, tc.name)
				} else {
					assert.NoError(t, err, tc.name)
				}
				// Match the SDK's last-value parsing; an earlier duplicate t
				// must not override the signed final timestamp.
				_, duplicateErr := service.VerifyConfiguredWaffoPancakeWebhook(string(body), "t=invalid, "+header)
				assert.Equal(t, err != nil, duplicateErr != nil, tc.name)
			}
			for _, header := range []string{"", "v1=missing-t", "t=1", "t=invalid,v1=invalid", "t=9223372036854775808,v1=invalid"} {
				_, err := service.VerifyConfiguredWaffoPancakeWebhook(string(body), header)
				assert.Error(t, err, header)
			}
		})
	})

	t.Run("subscription dispatch remains separate", func(t *testing.T) {
		router, keys := walletWebhookFixture(t)
		sqlDB, err := model.DB.DB()
		require.NoError(t, err)
		sqlDB.SetMaxOpenConns(2)
		require.NoError(t, model.DB.AutoMigrate(&model.SubscriptionPlan{}, &model.UserSubscription{}))
		plan := model.SubscriptionPlan{Id: 904, Title: "Pancake retry dispatch fixture", PriceAmount: 100, Enabled: true, DurationUnit: model.SubscriptionDurationMonth, DurationValue: 1}
		require.NoError(t, model.DB.Create(&plan).Error)
		model.InvalidateSubscriptionPlanCache(plan.Id)
		t.Cleanup(func() { model.InvalidateSubscriptionPlanCache(plan.Id) })
		order := model.SubscriptionOrder{UserId: 902, PlanId: plan.Id, TradeNo: "WAFFO_PANCAKE_SUB-delayed-retry", PaymentProvider: model.PaymentProviderWaffoPancake, PaymentMethod: model.PaymentMethodWaffoPancake, Status: common.TopUpStatusPending}
		require.NoError(t, model.DB.Create(&order).Error)
		request := walletWebhookRequest(t, keys, model.PaymentProviderWaffoPancake, order.TradeNo, "90", true)
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		timestamp := strconv.FormatInt(time.Now().Add(-32*time.Minute).UnixMilli(), 10)
		signature, err := waffoutils.Sign(timestamp+"."+string(body), keys.PrivateKey)
		require.NoError(t, err)
		for range 2 {
			retry := httptest.NewRequest(http.MethodPost, request.URL.Path, bytes.NewReader(body))
			retry.Header.Set("X-Waffo-Signature", "t="+timestamp+",v1="+signature)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, retry)
			assert.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		}
		require.NoError(t, model.DB.First(&order, order.Id).Error)
		assert.Equal(t, common.TopUpStatusSuccess, order.Status)
		var subscriptions, rebates int64
		require.NoError(t, model.DB.Model(&model.UserSubscription{}).Count(&subscriptions).Error)
		assert.EqualValues(t, 1, subscriptions)
		require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&rebates).Error)
		assert.Zero(t, rebates)
		var invitee model.User
		require.NoError(t, model.DB.First(&invitee, 902).Error)
		assert.Equal(t, -10, invitee.Quota)
	})
}

func TestWalletReferralSignedCallbacksAndManualCompletion(t *testing.T) {
	providers := []string{model.PaymentProviderEpay, model.PaymentProviderStripe, model.PaymentProviderCreem, model.PaymentProviderWaffo, model.PaymentProviderWaffoPancake}
	for _, provider := range providers {
		for _, manualFirst := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/manual_first_%t", provider, manualFirst), func(t *testing.T) {
				router, keys := walletWebhookFixture(t)
				order := walletWebhookOrder(t, provider, "wallet_fixture")
				common.QuotaPerUnit = 20 // Frozen new orders must not be repriced.
				if manualFirst {
					recorder := httptest.NewRecorder()
					request := httptest.NewRequest(http.MethodPost, "/manual", strings.NewReader(`{"trade_no":"wallet_fixture"}`))
					request.Header.Set("Content-Type", "application/json")
					router.ServeHTTP(recorder, request)
					assert.Contains(t, recorder.Body.String(), `"success":true`)
				}
				for range 2 {
					recorder := httptest.NewRecorder()
					router.ServeHTTP(recorder, walletWebhookRequest(t, keys, provider, order.TradeNo, "90", true))
					require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
					assert.NotContains(t, recorder.Body.String(), "fail")
				}
				require.NoError(t, model.ManualCompleteTopUp(order.TradeNo, "127.0.0.1"))
				// A late failure cannot overwrite success or clear its snapshot.
				order.Status = common.TopUpStatusFailed
				require.ErrorIs(t, order.Update(), model.ErrTopUpStatusInvalid)
				var invitee, inviter model.User
				require.NoError(t, model.DB.First(&invitee, 902).Error)
				require.NoError(t, model.DB.First(&inviter, 901).Error)
				assert.Equal(t, 990, invitee.Quota)
				assert.Equal(t, 107, inviter.AffQuota)
				assert.Equal(t, 111, inviter.AffHistoryQuota)
				var facts []model.ReferralRebate
				require.NoError(t, model.DB.Find(&facts).Error)
				require.Len(t, facts, 1)
				assert.EqualValues(t, 1000, facts[0].CreditedQuota)
				assert.EqualValues(t, 100, facts[0].RewardQuota)
				reloaded, err := model.GetTopUpByTradeNoWithError(order.TradeNo)
				require.NoError(t, err)
				assert.Equal(t, common.TopUpStatusSuccess, reloaded.Status)
				assert.Equal(t, facts[0].SettledAt, reloaded.CompleteTime)
				assert.Equal(t, 1000, *reloaded.CreditedQuota)
			})
		}
	}
}

func TestWalletReferralCallbacksPaymentProofAndRollback(t *testing.T) {
	for _, provider := range []string{model.PaymentProviderEpay, model.PaymentProviderStripe, model.PaymentProviderCreem, model.PaymentProviderWaffo, model.PaymentProviderWaffoPancake} {
		for _, scenario := range []string{"unpaid", "missing_amount", "invalid_amount", "zero_paid", "reward_overflow", "wrong_provider", "bad_signature", "paused", "lookup_failure", "subscription_lookup_failure", "redis_capture_failure"} {
			t.Run(provider+"/"+scenario, func(t *testing.T) {
				router, keys := walletWebhookFixture(t)
				order := walletWebhookOrder(t, provider, "wallet_proof")
				amount, paid := "90", true
				var faultRedis *redis.Client
				var faultKey string
				switch scenario {
				case "unpaid":
					paid = false
				case "missing_amount":
					amount = ""
				case "invalid_amount":
					amount = "invalid"
				case "zero_paid":
					amount = "0"
				case "reward_overflow":
					require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 901).Update("aff_quota", common.MaxWalletQuota).Error)
				case "wrong_provider":
					require.NoError(t, model.DB.Model(&model.TopUp{}).Where("id = ?", order.Id).Update("payment_provider", "other").Error)
				case "paused":
					require.NoError(t, model.SaveReferralRebateRule(model.ReferralRebateRule{RateBPS: 1000, ValidDays: 30}))
				case "redis_capture_failure":
					address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
					if address == "" {
						t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
					}
					// DB 13 is isolated from the model fixtures. Own only this key;
					// never flush the server or overwrite an existing fixture.
					faultRedis = redis.NewClient(&redis.Options{Addr: address, DB: 13, MaxRetries: -1})
					t.Cleanup(func() { assert.NoError(t, faultRedis.Close()) })
					require.NoError(t, faultRedis.Ping(t.Context()).Err())
					faultKey = fmt.Sprintf("user:%d", order.UserId)
					owned, err := faultRedis.SetNX(t.Context(), faultKey, "wrong-type-fixture", time.Minute).Result()
					require.NoError(t, err)
					require.True(t, owned, "the Redis fixture key must not already belong to another test")
					oldClient, oldEnabled := common.RDB, common.RedisEnabled
					common.RDB, common.RedisEnabled = faultRedis, true
					t.Cleanup(func() {
						common.RDB, common.RedisEnabled = oldClient, oldEnabled
						assert.NoError(t, faultRedis.Del(context.Background(), faultKey).Err())
					})
					require.ErrorContains(t, faultRedis.HGet(t.Context(), faultKey, "Quota").Err(), "WRONGTYPE")
				case "lookup_failure", "subscription_lookup_failure":
					require.NoError(t, model.DB.Callback().Query().Before("gorm:query").Register("test:wallet_lookup_outage", func(tx *gorm.DB) {
						if scenario == "lookup_failure" && tx.Statement.Table == "top_ups" || scenario == "subscription_lookup_failure" && tx.Statement.Table == "subscription_orders" {
							tx.AddError(errors.New("injected wallet lookup outage"))
						}
					}))
				}
				request := walletWebhookRequest(t, keys, provider, order.TradeNo, amount, paid)
				var notificationBody []byte
				if scenario == "redis_capture_failure" {
					var err error
					notificationBody, err = io.ReadAll(request.Body)
					require.NoError(t, err)
					request.Body = io.NopCloser(bytes.NewReader(notificationBody))
				}
				if scenario == "bad_signature" {
					if provider == model.PaymentProviderEpay {
						require.NoError(t, request.ParseForm())
						request.PostForm.Set("sign", "invalid")
					} else {
						for _, header := range []string{"Stripe-Signature", CreemSignatureHeader, "X-SIGNATURE", "X-Waffo-Signature"} {
							request.Header.Set(header, "invalid")
						}
					}
				}
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				if scenario == "redis_capture_failure" {
					switch provider {
					case model.PaymentProviderEpay:
						assert.Equal(t, http.StatusOK, recorder.Code)
						assert.Equal(t, "fail", recorder.Body.String())
					case model.PaymentProviderWaffo:
						assert.Equal(t, http.StatusOK, recorder.Code)
						assert.JSONEq(t, `{"message":"failed"}`, recorder.Body.String())
						assert.True(t, waffoutils.Verify(recorder.Body.String(), recorder.Header().Get("X-SIGNATURE"), keys.PublicKey))
					case model.PaymentProviderWaffoPancake:
						assert.Equal(t, http.StatusInternalServerError, recorder.Code)
						assert.Equal(t, "retry", recorder.Body.String())
					default:
						assert.Equal(t, http.StatusInternalServerError, recorder.Code)
						assert.Empty(t, recorder.Body.String())
					}
					t.Logf("precommit capture failure response: HTTP %d, body %q", recorder.Code, recorder.Body.String())
				}
				if scenario == "lookup_failure" || scenario == "subscription_lookup_failure" {
					require.NoError(t, model.DB.Callback().Query().Remove("test:wallet_lookup_outage"))
					if provider == model.PaymentProviderEpay || provider == model.PaymentProviderWaffo {
						assert.Contains(t, recorder.Body.String(), "fail")
					} else {
						assert.Equal(t, http.StatusInternalServerError, recorder.Code)
					}
				}
				var invitee model.User
				require.NoError(t, model.DB.First(&invitee, 902).Error)
				var facts int64
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
				if scenario == "zero_paid" {
					assert.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
					assert.Equal(t, 990, invitee.Quota)
					assert.EqualValues(t, 1, facts)
					return
				}
				if scenario == "paused" {
					assert.Equal(t, 990, invitee.Quota)
					require.NoError(t, model.SaveReferralRebateRule(model.ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 30}))
					router.ServeHTTP(httptest.NewRecorder(), walletWebhookRequest(t, keys, provider, order.TradeNo, amount, paid))
					require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
					assert.Zero(t, facts, "a paused settlement must never be backfilled by replay")
					return
				}
				assert.Equal(t, -10, invitee.Quota)
				assert.Zero(t, facts)
				reloaded, err := model.GetTopUpByTradeNoWithError(order.TradeNo)
				require.NoError(t, err)
				assert.NotEqual(t, common.TopUpStatusSuccess, reloaded.Status)
				assert.Zero(t, reloaded.CompleteTime)
				if scenario == "redis_capture_failure" {
					var inviter model.User
					require.NoError(t, model.DB.First(&inviter, 901).Error)
					assert.Equal(t, 7, inviter.AffQuota)
					assert.Equal(t, 11, inviter.AffHistoryQuota)
					assert.Equal(t, common.TopUpStatusPending, reloaded.Status)
					require.NotNil(t, reloaded.CreditedQuota)
					assert.Equal(t, 1000, *reloaded.CreditedQuota)
					require.NoError(t, faultRedis.Del(t.Context(), faultKey).Err())
					common.QuotaPerUnit = 20 // The retry still uses the order's frozen quota.
				}
				if scenario == "reward_overflow" {
					if provider == model.PaymentProviderEpay || provider == model.PaymentProviderWaffo {
						assert.Contains(t, recorder.Body.String(), "fail")
					} else {
						assert.Equal(t, http.StatusInternalServerError, recorder.Code)
					}
					// Rollback leaves no successful timestamp; the same identity can retry.
					require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 901).Update("aff_quota", 7).Error)
				}
				if scenario == "reward_overflow" || scenario == "lookup_failure" || scenario == "subscription_lookup_failure" || scenario == "redis_capture_failure" {
					attempts := 1
					if scenario == "redis_capture_failure" {
						attempts = 2
					}
					for range attempts {
						retried := httptest.NewRecorder()
						var retryRequest *http.Request
						if scenario == "redis_capture_failure" {
							// Replay the same signed notification, including its body and headers.
							retryRequest = request.Clone(t.Context())
							retryRequest.Body = io.NopCloser(bytes.NewReader(notificationBody))
						} else {
							retryRequest = walletWebhookRequest(t, keys, provider, order.TradeNo, amount, paid)
						}
						router.ServeHTTP(retried, retryRequest)
						require.Equal(t, http.StatusOK, retried.Code, retried.Body.String())
						assert.NotContains(t, retried.Body.String(), "fail")
						if scenario == "redis_capture_failure" {
							switch provider {
							case model.PaymentProviderEpay:
								assert.Equal(t, "success", retried.Body.String())
							case model.PaymentProviderWaffo:
								assert.JSONEq(t, `{"message":"success"}`, retried.Body.String())
								assert.True(t, waffoutils.Verify(retried.Body.String(), retried.Header().Get("X-SIGNATURE"), keys.PublicKey))
							case model.PaymentProviderWaffoPancake:
								assert.Equal(t, "OK", retried.Body.String())
							default:
								assert.Empty(t, retried.Body.String())
							}
							t.Logf("same-notification retry response: HTTP %d, body %q", retried.Code, retried.Body.String())
						}
					}
					require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
					assert.EqualValues(t, 1, facts)
					require.NoError(t, model.DB.First(&invitee, 902).Error)
					assert.Equal(t, 990, invitee.Quota)
					if scenario == "redis_capture_failure" {
						var inviter model.User
						require.NoError(t, model.DB.First(&inviter, 901).Error)
						assert.Equal(t, 107, inviter.AffQuota)
						assert.Equal(t, 111, inviter.AffHistoryQuota)
						require.NoError(t, model.DB.First(reloaded, order.Id).Error)
						assert.Equal(t, common.TopUpStatusSuccess, reloaded.Status)
						assert.Positive(t, reloaded.CompleteTime)
						require.NotNil(t, reloaded.CreditedQuota)
						assert.Equal(t, 1000, *reloaded.CreditedQuota)
						var fact model.ReferralRebate
						require.NoError(t, model.DB.First(&fact).Error)
						assert.Equal(t, order.Id, fact.TopUpID)
						assert.Equal(t, reloaded.CompleteTime, fact.SettledAt)
						assert.EqualValues(t, 1000, fact.CreditedQuota)
						assert.EqualValues(t, 100, fact.RewardQuota)
					}
				}
			})
		}
	}
}

func TestWalletReferralStripePersistsCreditBeforeCheckoutAndLateFailure(t *testing.T) {
	router, keys := walletWebhookFixture(t)
	originalBackend, originalKey := stripe.GetBackend(stripe.APIBackend), stripe.Key
	oldMin, oldRatio, oldDisplay := setting.StripeMinTopUp, common.TopupGroupRatio2JSONString(), operation_setting.GetGeneralSetting().QuotaDisplayType
	setting.StripeMinTopUp = 1
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
	require.NoError(t, common.UpdateTopupGroupRatioByJSONString(`{"default":1}`))
	t.Cleanup(func() {
		stripe.SetBackend(stripe.APIBackend, originalBackend)
		stripe.Key = originalKey
		setting.StripeMinTopUp = oldMin
		operation_setting.GetGeneralSetting().QuotaDisplayType = oldDisplay
		require.NoError(t, common.UpdateTopupGroupRatioByJSONString(oldRatio))
	})
	// A real local HTTP server delivers the authenticated success while the
	// checkout request is in flight, then simulates a lost/error response.
	var observed model.TopUp
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if err := request.ParseForm(); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		tradeNo := request.Form.Get("client_reference_id")
		if err := model.DB.Where("trade_no = ?", tradeNo).First(&observed).Error; err != nil {
			t.Error("checkout reached the provider before its credit was persisted", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		assert.Equal(t, "price_fixture", request.Form.Get("line_items[0][price]"))
		assert.Equal(t, "100", request.Form.Get("line_items[0][quantity]"))
		assert.Equal(t, common.TopUpStatusPending, observed.Status)
		assert.Equal(t, 1000, *observed.CreditedQuota)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, walletWebhookRequest(t, keys, model.PaymentProviderStripe, tradeNo, "90", true))
		assert.Equal(t, http.StatusOK, recorder.Code)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{"message":"simulated response loss","type":"api_error"}}`))
	}))
	defer server.Close()
	stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{URL: stripe.String(server.URL), HTTPClient: server.Client(), MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false)}))
	router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestStripePay)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader(`{"amount":100,"payment_method":"stripe"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	assert.Contains(t, recorder.Body.String(), `"message":"error"`)
	require.NotZero(t, observed.Id)
	reloaded, err := model.GetTopUpByTradeNoWithError(observed.TradeNo)
	require.NoError(t, err)
	assert.Equal(t, common.TopUpStatusSuccess, reloaded.Status)
	assert.Equal(t, 1000, *reloaded.CreditedQuota)
	var invitee model.User
	require.NoError(t, model.DB.First(&invitee, 902).Error)
	assert.Equal(t, 990, invitee.Quota)
	var facts int64
	require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
	assert.EqualValues(t, 1, facts)
}

type walletCheckoutTransport func(*http.Request) (*http.Response, error)

func TestWalletWaffoPaymentNotificationStateSequence(t *testing.T) {
	for _, tc := range []struct {
		name       string
		states     []string
		wantStatus string
		wantQuota  int
	}{
		{"payment in progress then paid", []string{"PAY_IN_PROGRESS", "PAY_SUCCESS"}, common.TopUpStatusSuccess, 990},
		{"authorization required then paid", []string{"AUTHORIZATION_REQUIRED", "PAY_SUCCESS"}, common.TopUpStatusSuccess, 990},
		{"awaiting capture then paid", []string{"AUTHED_WAITING_CAPTURE", "PAY_SUCCESS"}, common.TopUpStatusSuccess, 990},
		{"unknown then paid", []string{"FUTURE_INTERMEDIATE_STATUS", "PAY_SUCCESS"}, common.TopUpStatusSuccess, 990},
		{"closed then late payment", []string{"ORDER_CLOSE", "PAY_SUCCESS"}, common.TopUpStatusFailed, -10},
		{"paid then progress and close", []string{"PAY_SUCCESS", "PAY_IN_PROGRESS", "ORDER_CLOSE"}, common.TopUpStatusSuccess, 990},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router, keys := walletWebhookFixture(t)
			router.POST("/api/waffo/webhook", WaffoWebhook)
			order := walletWebhookOrder(t, model.PaymentProviderWaffo, "waffo_state_sequence")
			for _, state := range tc.states {
				payload := map[string]any{"eventType": "PAYMENT_NOTIFICATION", "result": map[string]any{"merchantOrderId": order.TradeNo, "paymentRequestId": order.TradeNo, "orderStatus": state, "orderAmount": "100.00", "orderCurrency": "USD"}}
				request := signedWalletWebhookRequest(t, keys, model.PaymentProviderWaffo, payload)
				request.URL.Path, request.RequestURI = "/api/waffo/webhook", "/api/waffo/webhook"
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				require.Equal(t, http.StatusOK, recorder.Code)
				if state != "PAY_SUCCESS" {
					assert.NotContains(t, recorder.Body.String(), "FAIL")
				}
			}
			require.NoError(t, model.DB.First(order, order.Id).Error)
			assert.Equal(t, tc.wantStatus, order.Status)
			var user model.User
			require.NoError(t, model.DB.First(&user, 902).Error)
			assert.Equal(t, tc.wantQuota, user.Quota)
			var rebates int64
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&rebates).Error)
			if tc.wantStatus == common.TopUpStatusSuccess {
				assert.EqualValues(t, 1, rebates)
			} else {
				assert.Zero(t, rebates)
			}
		})
	}
}

func walletPaymentLogCapture(t *testing.T) *bytes.Buffer {
	t.Helper()
	var output bytes.Buffer
	common.LogWriterMu.Lock()
	oldOutput, oldErrors := gin.DefaultWriter, gin.DefaultErrorWriter
	gin.DefaultWriter, gin.DefaultErrorWriter = &output, &output
	common.LogWriterMu.Unlock()
	t.Cleanup(func() {
		common.LogWriterMu.Lock()
		gin.DefaultWriter, gin.DefaultErrorWriter = oldOutput, oldErrors
		common.LogWriterMu.Unlock()
	})
	return &output
}

func TestWalletPaymentWebhookLogsExcludeRequestSecrets(t *testing.T) {
	for _, provider := range []string{model.PaymentProviderEpay, model.PaymentProviderStripe, model.PaymentProviderCreem, model.PaymentProviderWaffo, model.PaymentProviderWaffoPancake} {
		for _, verified := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/verified_%t", provider, verified), func(t *testing.T) {
				router, keys := walletWebhookFixture(t)
				order := walletWebhookOrder(t, provider, "payment_log_order")
				request := walletWebhookRequest(t, keys, provider, order.TradeNo, "100", true)
				const privateBody = "private-customer-email@example.invalid"
				const privateQuery = "private-query-credential"
				var signature string
				if provider == model.PaymentProviderEpay {
					require.NoError(t, request.ParseForm())
					params := request.PostForm
					params.Set("name", privateBody)
					params.Set("private_query", privateQuery)
					var signed []string
					for _, key := range []string{"money", "name", "out_trade_no", "pid", "private_query", "trade_status", "type"} {
						signed = append(signed, key+"="+params.Get(key))
					}
					signature = epay.MD5String(strings.Join(signed, "&"), operation_setting.EpayKey)
					if !verified {
						signature = "private-invalid-signature"
					}
					params.Set("sign", signature)
					request = httptest.NewRequest(http.MethodGet, "/api/user/epay/notify?"+params.Encode(), nil)
					router.GET("/api/user/epay/notify", EpayNotify)
				} else {
					var payload map[string]any
					require.NoError(t, common.DecodeJson(request.Body, &payload))
					payload["private_customer_data"] = privateBody
					request = signedWalletWebhookRequest(t, keys, provider, payload)
					header, path, handler := "Stripe-Signature", "/api/stripe/webhook", StripeWebhook
					switch provider {
					case model.PaymentProviderCreem:
						header, path, handler = CreemSignatureHeader, "/api/creem/webhook", CreemWebhook
					case model.PaymentProviderWaffo:
						header, path, handler = "X-SIGNATURE", "/api/waffo/webhook", WaffoWebhook
					case model.PaymentProviderWaffoPancake:
						header, path, handler = "X-Waffo-Signature", "/api/waffo-pancake/webhook/test", WaffoPancakeWebhook
					}
					if !verified {
						request.Header.Set(header, "private-invalid-signature")
					}
					signature = request.Header.Get(header)
					request.URL.Path = path
					if provider == model.PaymentProviderWaffoPancake {
						path = "/api/waffo-pancake/webhook/:env"
					}
					router.POST(path, handler)
				}
				query := request.URL.Query()
				query.Set("private_query", privateQuery)
				request.URL.RawQuery = query.Encode()
				request.RequestURI = request.URL.RequestURI()
				output := walletPaymentLogCapture(t)
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				assert.NotEmpty(t, output.String(), "payment diagnostics remain available")
				assert.NotContains(t, output.String(), privateBody)
				assert.NotContains(t, output.String(), privateQuery)
				assert.NotContains(t, output.String(), signature)
				require.NoError(t, model.DB.First(order, order.Id).Error)
				if verified {
					assert.Equal(t, http.StatusOK, recorder.Code)
					assert.Equal(t, common.TopUpStatusSuccess, order.Status)
					assert.Contains(t, output.String(), order.TradeNo)
				} else {
					assert.Equal(t, common.TopUpStatusPending, order.Status)
				}
			})
		}
	}
}

func TestWalletPaymentCheckoutLogsExcludeCustomerAndCheckoutSecrets(t *testing.T) {
	for _, provider := range []string{model.PaymentProviderEpay, model.PaymentProviderCreem} {
		t.Run(provider, func(t *testing.T) {
			router, _ := walletCheckoutFixture(t)
			const customerEmail = "private-checkout-customer@example.invalid"
			const checkoutURL = "https://checkout.example.invalid/?token=private-checkout-token"
			require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 902).Update("email", customerEmail).Error)
			path, handler := "/api/user/self/pay", RequestEpay
			body := "{\"amount\":100,\"payment_method\":\"alipay\"}"
			if provider == model.PaymentProviderCreem {
				path, handler = "/api/user/self/creem/pay", RequestCreemPay
				body = "{\"product_id\":\"fixture\",\"payment_method\":\"creem\",\"private_input\":\"private-checkout-input\"}"
				setting.CreemProducts = "[{\"productId\":\"fixture\",\"price\":100,\"currency\":\"USD\",\"quota\":1000}]"
				originalTransport := http.DefaultTransport
				t.Cleanup(func() { http.DefaultTransport = originalTransport })
				http.DefaultTransport = walletCheckoutTransport(func(request *http.Request) (*http.Response, error) {
					assert.Equal(t, "api.creem.io", request.URL.Host)
					assert.Equal(t, "/v1/checkouts", request.URL.Path)
					var checkout CreemCheckoutRequest
					require.NoError(t, common.DecodeJson(request.Body, &checkout))
					assert.Equal(t, customerEmail, checkout.Customer.Email)
					responseBody, err := common.Marshal(map[string]string{"id": "checkout_fixture", "checkout_url": checkoutURL, "customer_email": customerEmail})
					require.NoError(t, err)
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(responseBody))}, nil
				})
			}
			router.POST(path, func(c *gin.Context) { c.Set("id", 902) }, handler)
			output := walletPaymentLogCapture(t)
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusOK, recorder.Code)
			var response struct {
				Message string
				Data    map[string]string
			}
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			require.Equal(t, "success", response.Message)
			assert.NotContains(t, output.String(), customerEmail)
			assert.NotContains(t, output.String(), checkoutURL)
			assert.NotContains(t, output.String(), "private-checkout-input")
			if provider == model.PaymentProviderEpay {
				require.NotEmpty(t, response.Data["sign"])
				assert.NotContains(t, output.String(), response.Data["sign"])
			} else {
				assert.Equal(t, checkoutURL, response.Data["checkout_url"])
			}
			var order model.TopUp
			require.NoError(t, model.DB.First(&order).Error)
			assert.Equal(t, common.TopUpStatusPending, order.Status)
			assert.Contains(t, output.String(), order.TradeNo)
		})
	}
}

// Only the network endpoint is replaced. Production JSON generation, HTTP
// transmission, response parsing and raw-body webhook verification all run.
func TestWalletCreemCheckoutHTTPPreservesFrozenOrderAndRecovery(t *testing.T) {
	for _, scenario := range []string{
		"success", "explicit_rejection", "malformed_json", "missing_checkout_url",
		"truncated_body", "response_lost", "response_timeout", "callback_before_response",
		"callback_before_response_loss", "caller_cancelled_after_acceptance",
	} {
		t.Run(scenario, func(t *testing.T) {
			router, keys := walletCheckoutFixture(t)
			const checkoutURL = "https://checkout.example.invalid/creem-fixture"
			const customerEmail = "creem-checkout@example.invalid"
			setting.CreemProducts = `[{"productId":"fixture","name":"Wallet fixture","price":100,"currency":"USD","quota":1000}]`
			require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 902).Update("email", customerEmail).Error)
			router.POST("/api/creem/webhook", CreemWebhook)
			router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestCreemPay)
			application := httptest.NewServer(router)
			defer application.Close()
			applicationURL, err := url.Parse(application.URL)
			require.NoError(t, err)
			localTransport := &http.Transport{DisableKeepAlives: true}
			defer localTransport.CloseIdleConnections()
			localClient := &http.Client{Transport: localTransport, Timeout: 10 * time.Second}
			sendPaidCallback := func(tradeNo string) {
				request := walletWebhookRequest(t, keys, model.PaymentProviderCreem, tradeNo, "9000", true)
				request.URL.Scheme, request.URL.Host, request.URL.Path = applicationURL.Scheme, applicationURL.Host, "/api/creem/webhook"
				request.RequestURI = ""
				response, err := localClient.Do(request)
				if !assert.NoError(t, err) {
					return
				}
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				assert.NoError(t, err)
				assert.Equal(t, http.StatusOK, response.StatusCode, string(body))
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			observed := make(chan model.TopUp, 1)
			providerDone := make(chan struct{})
			var completeProvider sync.Once
			var requests atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				defer completeProvider.Do(func() { close(providerDone) })
				if !assert.EqualValues(t, 1, requests.Add(1), "checkout POST must not be reissued with a new payment identity") {
					w.WriteHeader(http.StatusConflict)
					return
				}
				assert.Equal(t, http.MethodPost, request.Method)
				assert.Equal(t, "/v1/checkouts", request.URL.Path)
				assert.Equal(t, "application/json", request.Header.Get("Content-Type"))
				assert.Equal(t, "fixture", request.Header.Get("x-api-key"))
				var checkout CreemCheckoutRequest
				if !assert.NoError(t, common.DecodeJson(request.Body, &checkout)) {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				assert.Equal(t, "fixture", checkout.ProductId)
				assert.Equal(t, customerEmail, checkout.Customer.Email)
				assert.Equal(t, "wallet_invitee", checkout.Metadata["username"])
				assert.Equal(t, "1000", checkout.Metadata["quota"])
				assert.Equal(t, "Wallet fixture", checkout.Metadata["product_name"])
				assert.Equal(t, checkout.RequestId, checkout.Metadata["reference_id"])
				assert.True(t, strings.HasPrefix(checkout.RequestId, "ref_"))
				var order model.TopUp
				if !assert.NoError(t, model.DB.Where("trade_no = ?", checkout.RequestId).First(&order).Error) {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				assert.Equal(t, 902, order.UserId)
				assert.Equal(t, common.TopUpStatusPending, order.Status)
				assert.Equal(t, model.PaymentProviderCreem, order.PaymentProvider)
				assert.Equal(t, model.PaymentMethodCreem, order.PaymentMethod)
				assert.EqualValues(t, 1000, order.Amount)
				assert.Equal(t, float64(100), order.Money)
				if assert.NotNil(t, order.CreditedQuota) {
					assert.Equal(t, 1000, *order.CreditedQuota)
				}
				observed <- order
				if strings.HasPrefix(scenario, "callback_before_") {
					sendPaidCallback(order.TradeNo)
				}
				if scenario == "response_timeout" {
					// Exercise the real production client timeout, without replacing
					// its duration or injecting a synthetic transport error.
					<-request.Context().Done()
					return
				}
				if scenario == "caller_cancelled_after_acceptance" {
					// Cancelling the caller cannot undo the provider's receipt of this
					// order. Lose its response and later recover using the same ID.
					cancel()
				}
				if scenario == "response_lost" || scenario == "callback_before_response_loss" || scenario == "caller_cancelled_after_acceptance" {
					connection, _, err := w.(http.Hijacker).Hijack()
					if assert.NoError(t, err) {
						assert.NoError(t, connection.Close())
					}
					return
				}
				w.Header().Set("Content-Type", "application/json")
				switch scenario {
				case "explicit_rejection":
					w.WriteHeader(http.StatusBadRequest)
					_, _ = io.WriteString(w, `{"message":"Product not found"}`)
				case "malformed_json":
					_, _ = io.WriteString(w, `{"checkout_url":`)
				case "missing_checkout_url":
					_, _ = io.WriteString(w, `{"id":"ch_fixture"}`)
				case "truncated_body":
					w.Header().Set("Content-Length", "1000")
					_, _ = io.WriteString(w, `{"checkout_url":`)
				default:
					_, _ = io.WriteString(w, `{"id":"ch_fixture","checkout_url":"`+checkoutURL+`"}`)
				}
			}))
			defer provider.Close()
			endpoint, err := url.Parse(provider.URL)
			require.NoError(t, err)
			originalTransport := http.DefaultTransport
			t.Cleanup(func() { http.DefaultTransport = originalTransport })
			http.DefaultTransport = walletCheckoutTransport(func(request *http.Request) (*http.Response, error) {
				if request.URL.Host != "api.creem.io" || request.URL.Scheme != "https" {
					return nil, fmt.Errorf("unexpected checkout endpoint: %s", request.URL.Host)
				}
				local := request.Clone(request.Context())
				local.URL.Scheme, local.URL.Host = endpoint.Scheme, endpoint.Host
				response, err := localTransport.RoundTrip(local)
				// TCP close is not a Go race-detector barrier. Wait for the simulated
				// provider's callback and body write to finish.
				select {
				case <-providerDone:
				case <-t.Context().Done():
					return nil, t.Context().Err()
				}
				return response, err
			})
			request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/checkout", strings.NewReader(`{"product_id":"fixture","payment_method":"creem","quota":999999,"request_id":"client-forged-id"}`))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusOK, recorder.Code)
			var response struct {
				Message string          `json:"message"`
				Data    json.RawMessage `json:"data"`
			}
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			var data map[string]string
			if scenario == "success" || scenario == "callback_before_response" {
				require.NoError(t, common.Unmarshal(response.Data, &data))
				assert.Equal(t, "success", response.Message)
				assert.Equal(t, checkoutURL, data["checkout_url"])
			} else {
				assert.Equal(t, "error", response.Message)
				assert.NotContains(t, recorder.Body.String(), checkoutURL)
			}
			var order model.TopUp
			select {
			case order = <-observed:
			default:
				t.Fatal("checkout did not reach the isolated HTTP provider")
			}
			if response.Message == "success" {
				assert.Equal(t, order.TradeNo, data["order_id"])
			}
			require.NoError(t, model.DB.First(&order, order.Id).Error)
			var invitee, inviter model.User
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			var facts []model.ReferralRebate
			require.NoError(t, model.DB.Find(&facts).Error)
			if strings.HasPrefix(scenario, "callback_before_") {
				assert.Equal(t, common.TopUpStatusSuccess, order.Status)
				assert.Equal(t, 990, invitee.Quota)
				assert.Equal(t, 107, inviter.AffQuota)
				require.Len(t, facts, 1)
			} else {
				// Creem historically retains even explicit create failures as pending.
				// An operator-completable local order is not proof of platform payment.
				assert.Equal(t, common.TopUpStatusPending, order.Status)
				assert.Zero(t, order.CompleteTime)
				assert.Equal(t, -10, invitee.Quota)
				assert.Equal(t, 7, inviter.AffQuota)
				assert.Equal(t, 11, inviter.AffHistoryQuota)
				assert.Empty(t, facts)
			}
			common.QuotaPerUnit = 20
			setting.CreemProducts = `[{"productId":"fixture","price":200,"currency":"USD","quota":10000}]`
			if scenario == "explicit_rejection" {
				// Do not invent platform success after explicit rejection. Exercise
				// only the original authorized manual-completion path.
				manual := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPost, "/manual", strings.NewReader(fmt.Sprintf(`{"trade_no":%q}`, order.TradeNo)))
				request.Header.Set("Content-Type", "application/json")
				router.ServeHTTP(manual, request)
				assert.Contains(t, manual.Body.String(), `"success":true`)
			} else {
				for range 2 {
					sendPaidCallback(order.TradeNo)
				}
			}
			require.NoError(t, model.DB.First(&order, order.Id).Error)
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			require.NoError(t, model.DB.Find(&facts).Error)
			assert.Equal(t, common.TopUpStatusSuccess, order.Status)
			require.NotNil(t, order.CreditedQuota)
			assert.Equal(t, 1000, *order.CreditedQuota)
			assert.Equal(t, 990, invitee.Quota)
			assert.Equal(t, 107, inviter.AffQuota)
			assert.Equal(t, 111, inviter.AffHistoryQuota)
			require.Len(t, facts, 1)
			assert.Equal(t, order.Id, facts[0].TopUpID)
			assert.EqualValues(t, 1000, facts[0].CreditedQuota)
			assert.EqualValues(t, 100, facts[0].RewardQuota)
			assert.Equal(t, order.CompleteTime, facts[0].SettledAt)
			assert.EqualValues(t, 1, requests.Load())
		})
	}
}

func TestWalletStripeCheckoutSDKLogsExcludeProviderResponse(t *testing.T) {
	for _, flow := range []string{"wallet", "subscription"} {
		for _, responseStatus := range []int{http.StatusOK, http.StatusBadRequest} {
			t.Run(flow+"/"+strconv.Itoa(responseStatus), func(t *testing.T) {
				router, _ := walletCheckoutFixture(t)
				originalBackend, originalKey, originalStderr := stripe.GetBackend(stripe.APIBackend), stripe.Key, os.Stderr
				stderr, err := os.CreateTemp(t.TempDir(), "stripe-stderr-*")
				require.NoError(t, err)
				os.Stderr = stderr
				t.Cleanup(func() {
					os.Stderr = originalStderr
					stripe.SetBackend(stripe.APIBackend, originalBackend)
					stripe.Key = originalKey
					require.NoError(t, stderr.Close())
				})
				const privateData = "private-stripe-customer@example.invalid"
				seen := make(chan url.Values, 1)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
					require.NoError(t, request.ParseForm())
					seen <- request.PostForm
					w.Header().Set("Request-Id", "req_safe_fixture")
					w.WriteHeader(responseStatus)
					if responseStatus == http.StatusOK {
						_, _ = w.Write([]byte("invalid checkout response: " + privateData))
						return
					}
					payload, err := common.Marshal(map[string]any{"error": map[string]string{"type": "invalid_request_error", "code": "parameter_invalid_empty", "message": privateData}})
					require.NoError(t, err)
					_, _ = w.Write(payload)
				}))
				defer server.Close()
				configuredBackend := stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{URL: stripe.String(server.URL), HTTPClient: server.Client(), MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false)})
				stripe.SetBackend(stripe.APIBackend, configuredBackend)
				path, handler := "/api/user/self/stripe/pay", RequestStripePay
				body, err := common.Marshal(StripePayRequest{Amount: 100, PaymentMethod: "stripe"})
				require.NoError(t, err)
				if flow == "subscription" {
					require.NoError(t, model.DB.AutoMigrate(&model.SubscriptionPlan{}))
					plan := model.SubscriptionPlan{Id: 903, Title: "Stripe fixture plan", PriceAmount: 100, Enabled: true, StripePriceId: "price_fixture"}
					require.NoError(t, model.DB.Create(&plan).Error)
					model.InvalidateSubscriptionPlanCache(plan.Id)
					t.Cleanup(func() { model.InvalidateSubscriptionPlanCache(plan.Id) })
					path, handler = "/api/subscription/stripe/pay", SubscriptionRequestStripePay
					body, err = common.Marshal(SubscriptionStripePayRequest{PlanId: plan.Id})
					require.NoError(t, err)
				}
				router.POST(path, func(c *gin.Context) { c.Set("id", 902) }, handler)
				output := walletPaymentLogCapture(t)
				request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				assert.Contains(t, recorder.Body.String(), "\"message\":\"error\"")
				var upstreamForm url.Values
				select {
				case upstreamForm = <-seen:
				default:
					t.Fatal("checkout did not reach the configured Stripe HTTP backend")
				}
				wantMode := "payment"
				if flow == "subscription" {
					wantMode = "subscription"
				}
				assert.Equal(t, wantMode, upstreamForm.Get("mode"))
				assert.Contains(t, output.String(), upstreamForm.Get("client_reference_id"))
				assert.Same(t, configuredBackend, stripe.GetBackend(stripe.APIBackend))
				configuredBackend.(*stripe.BackendImplementation).LeveledLogger.Errorf("unrelated Stripe SDK diagnostic")
				logged, err := os.ReadFile(stderr.Name())
				require.NoError(t, err)
				assert.Contains(t, string(logged), "unrelated Stripe SDK diagnostic")
				assert.NotContains(t, string(logged), privateData)
				assert.NotContains(t, output.String(), privateData)
				if responseStatus == http.StatusBadRequest {
					assert.Contains(t, output.String(), "req_safe_fixture")
					assert.Contains(t, output.String(), "parameter_invalid_empty")
					assert.Contains(t, output.String(), "400")
				}
				if flow == "subscription" {
					var count int64
					require.NoError(t, model.DB.Model(&model.SubscriptionOrder{}).Count(&count).Error)
					assert.Zero(t, count)
					return
				}
				var order model.TopUp
				require.NoError(t, model.DB.First(&order).Error)
				if responseStatus == http.StatusOK {
					assert.Equal(t, common.TopUpStatusPending, order.Status)
				} else {
					assert.Equal(t, common.TopUpStatusFailed, order.Status)
				}
			})
		}
	}
}

func TestWalletReferralStripeCheckoutRejectionPreservesCompletionPolicy(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     int
		body       string
		wantStatus string
	}{
		{"invalid_price", http.StatusBadRequest, `{"error":{"type":"invalid_request_error","code":"resource_missing","param":"line_items[0][price]","message":"No such price"}}`, common.TopUpStatusFailed},
		{"authentication_rejected", http.StatusUnauthorized, `{"error":{"type":"invalid_request_error","message":"Invalid API Key provided"}}`, common.TopUpStatusFailed},
		{"permission_rejected", http.StatusForbidden, `{"error":{"type":"invalid_request_error","message":"This API key does not have permission"}}`, common.TopUpStatusFailed},
		{"idempotency_conflict", http.StatusConflict, `{"error":{"type":"idempotency_error","message":"Request is still in progress"}}`, common.TopUpStatusPending},
		{"server_error", http.StatusInternalServerError, `{"error":{"type":"api_error","message":"Unknown checkout result"}}`, common.TopUpStatusPending},
		{"unstructured_error", http.StatusBadRequest, "unstructured gateway response", common.TopUpStatusPending},
		{"missing_checkout_url", http.StatusOK, `{}`, common.TopUpStatusPending},
		{"empty_checkout_url", http.StatusOK, `{"url":""}`, common.TopUpStatusPending},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router, keys := walletCheckoutFixture(t)
			originalBackend, originalKey := stripe.GetBackend(stripe.APIBackend), stripe.Key
			t.Cleanup(func() {
				stripe.SetBackend(stripe.APIBackend, originalBackend)
				stripe.Key = originalKey
			})
			observed := make(chan model.TopUp, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if !assert.NoError(t, request.ParseForm()) {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				var order model.TopUp
				if !assert.NoError(t, model.DB.Where("trade_no = ?", request.Form.Get("client_reference_id")).First(&order).Error) {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				observed <- order
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{URL: stripe.String(server.URL), HTTPClient: server.Client(), MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false)}))
			router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestStripePay)
			request := httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader(`{"amount":100,"payment_method":"stripe"}`))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			assert.Contains(t, recorder.Body.String(), `"message":"error"`)
			var order model.TopUp
			select {
			case order = <-observed:
			default:
				t.Fatal("checkout did not reach the isolated Stripe HTTP fixture")
			}
			require.Equal(t, common.TopUpStatusPending, order.Status)
			require.NotNil(t, order.CreditedQuota)
			assert.Equal(t, 1000, *order.CreditedQuota)
			require.NoError(t, model.DB.First(&order, order.Id).Error)
			assert.Equal(t, tc.wantStatus, order.Status)
			assert.Zero(t, order.CompleteTime)
			assert.Equal(t, 1000, *order.CreditedQuota)
			if tc.wantStatus == common.TopUpStatusFailed {
				recorder = httptest.NewRecorder()
				request = httptest.NewRequest(http.MethodPost, "/manual", strings.NewReader(fmt.Sprintf(`{"trade_no":%q}`, order.TradeNo)))
				request.Header.Set("Content-Type", "application/json")
				router.ServeHTTP(recorder, request)
				assert.Contains(t, recorder.Body.String(), `"success":false`)
			}
			var invitee, inviter model.User
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			assert.Equal(t, -10, invitee.Quota)
			assert.Equal(t, 7, inviter.AffQuota)
			var facts int64
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			assert.Zero(t, facts)
			if tc.name == "missing_checkout_url" || tc.name == "empty_checkout_url" {
				for range 2 {
					recorder = httptest.NewRecorder()
					router.ServeHTTP(recorder, walletWebhookRequest(t, keys, model.PaymentProviderStripe, order.TradeNo, "90", true))
					assert.Equal(t, http.StatusOK, recorder.Code)
				}
				require.NoError(t, model.DB.First(&invitee, 902).Error)
				assert.Equal(t, 990, invitee.Quota)
				require.NoError(t, model.DB.First(&order, order.Id).Error)
				assert.Equal(t, common.TopUpStatusSuccess, order.Status)
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
				assert.EqualValues(t, 1, facts)
			}
		})
	}
}

func (transport walletCheckoutTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func walletCheckoutFixture(t *testing.T) (*gin.Engine, *waffoutils.KeyPair) {
	t.Helper()
	router, keys := walletWebhookFixture(t)
	// Initialize the reserved-column quoting used by GetUserGroup through the
	// normal startup path, without opening another DB or running migrations.
	t.Setenv("LOG_SQL_DSN", "")
	master := common.IsMasterNode
	common.IsMasterNode = false
	err := model.InitLogDB()
	common.IsMasterNode = master
	require.NoError(t, err)
	oldPrice, oldMin := operation_setting.Price, operation_setting.MinTopUp
	oldPancakePrice, oldPancakeMin, oldStripeMin := setting.WaffoPancakeUnitPrice, setting.WaffoPancakeMinTopUp, setting.StripeMinTopUp
	oldRatio, oldDisplay := common.TopupGroupRatio2JSONString(), operation_setting.GetGeneralSetting().QuotaDisplayType
	oldDiscounts := operation_setting.GetPaymentSetting().AmountDiscount
	t.Cleanup(func() {
		operation_setting.Price, operation_setting.MinTopUp = oldPrice, oldMin
		setting.WaffoPancakeUnitPrice, setting.WaffoPancakeMinTopUp, setting.StripeMinTopUp = oldPancakePrice, oldPancakeMin, oldStripeMin
		operation_setting.GetGeneralSetting().QuotaDisplayType = oldDisplay
		operation_setting.GetPaymentSetting().AmountDiscount = oldDiscounts
		require.NoError(t, common.UpdateTopupGroupRatioByJSONString(oldRatio))
	})
	operation_setting.Price, operation_setting.MinTopUp = 1, 1
	setting.WaffoPancakeUnitPrice, setting.WaffoPancakeMinTopUp, setting.StripeMinTopUp = 1, 1, 1
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
	operation_setting.GetPaymentSetting().AmountDiscount = map[int]float64{}
	require.NoError(t, common.UpdateTopupGroupRatioByJSONString(`{"default":1}`))
	setting.WaffoPancakeMerchantID = "MER_" + strings.Repeat("a", 22)
	setting.WaffoPancakeProductID = "PROD_" + strings.Repeat("b", 22)
	return router, keys
}

func TestWalletReferralCheckoutLocalFailurePreservesCompletionPolicy(t *testing.T) {
	for _, scenario := range []string{"epay_signing", "stripe_api_key", "pancake_store", "pancake_merchant", "pancake_private_key", "pancake_product"} {
		t.Run(scenario, func(t *testing.T) {
			router, _ := walletCheckoutFixture(t)
			oldClient := http.DefaultClient
			var requests atomic.Int32
			http.DefaultClient = &http.Client{Transport: walletCheckoutTransport(func(*http.Request) (*http.Response, error) {
				requests.Add(1)
				return nil, errors.New("unexpected external request in local failure fixture")
			})}
			t.Cleanup(func() { http.DefaultClient = oldClient })
			handler, method := RequestWaffoPancakePay, model.PaymentMethodWaffoPancake
			switch scenario {
			case "epay_signing":
				operation_setting.EpayId = "invalid&partner"
				handler, method = RequestEpay, "alipay"
			case "stripe_api_key":
				setting.StripeApiSecret = "configured-but-invalid"
				handler, method = RequestStripePay, model.PaymentMethodStripe
			case "pancake_store":
				setting.WaffoPancakeStoreID = ""
			case "pancake_merchant":
				setting.WaffoPancakeMerchantID = "configured-but-invalid"
			case "pancake_private_key":
				setting.WaffoPancakePrivateKey = "configured-but-invalid"
			case "pancake_product":
				setting.WaffoPancakeProductID = "configured-but-invalid"
			}
			router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, handler)
			request := httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader(fmt.Sprintf(`{"amount":100,"payment_method":%q}`, method)))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			assert.Contains(t, recorder.Body.String(), `"message":"error"`)
			assert.Zero(t, requests.Load(), "these failures must happen before any provider request")
			var orders []model.TopUp
			require.NoError(t, model.DB.Find(&orders).Error)
			tradeNo := "no-checkout-created"
			if strings.HasPrefix(scenario, "pancake_") {
				require.Len(t, orders, 1)
				assert.Equal(t, common.TopUpStatusFailed, orders[0].Status)
				require.NotNil(t, orders[0].CreditedQuota)
				assert.Equal(t, 1000, *orders[0].CreditedQuota)
				assert.Zero(t, orders[0].CompleteTime)
				tradeNo = orders[0].TradeNo
			} else {
				assert.Empty(t, orders, "the original Epay/Stripe local rejection created no order")
				if len(orders) > 0 {
					tradeNo = orders[0].TradeNo
				}
			}
			recorder = httptest.NewRecorder()
			request = httptest.NewRequest(http.MethodPost, "/manual", strings.NewReader(fmt.Sprintf(`{"trade_no":%q}`, tradeNo)))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(recorder, request)
			assert.Contains(t, recorder.Body.String(), `"success":false`)
			var invitee model.User
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			assert.Equal(t, -10, invitee.Quota)
			var facts int64
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			assert.Zero(t, facts)
		})
	}
}

func TestWalletReferralPancakeUnknownCheckoutKeepsFrozenPendingOrder(t *testing.T) {
	for _, scenario := range []string{"late_callback", "manual_then_callback", "callback_before_response_loss", "non_json_remote_error"} {
		t.Run(scenario, func(t *testing.T) {
			router, keys := walletCheckoutFixture(t)
			observed := make(chan model.TopUp, 1)
			providerDone := make(chan struct{})
			var observeCheckout, completeProvider sync.Once
			var firstOrder model.TopUp
			var remoteOrder atomic.Pointer[model.TopUp]
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/v1/graphql" {
					stored := remoteOrder.Load()
					if !assert.NotNil(t, stored) {
						w.WriteHeader(http.StatusInternalServerError)
						return
					}
					body, err := common.Marshal(map[string]any{"data": map[string]any{"onetimeOrder": map[string]any{
						"id": "ORD_fixture", "orderMerchantExternalId": stored.TradeNo, "status": "completed", "testMode": true, "currency": "USD",
						"store": map[string]string{"id": "store_fixture"}, "priceSnapshot": map[string]string{"currency": "USD", "subtotal": formatWaffoPancakeAmount(stored.Money)},
					}}})
					if assert.NoError(t, err) {
						_, _ = w.Write(body)
					}
					return
				}
				if request.URL.Path == "/v1/actions/auth/issue-session-token" {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"data":{"token":"fixture","expiresAt":"2099-01-01T00:00:00Z"}}`))
					return
				}
				defer completeProvider.Do(func() { close(providerDone) })
				if !assert.Equal(t, "/v1/actions/checkout/create-session", request.URL.Path) {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				var payload struct {
					OrderMerchantExternalID string `json:"orderMerchantExternalId"`
				}
				if !assert.NoError(t, common.DecodeJson(request.Body, &payload)) {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				var order model.TopUp
				if !assert.NoError(t, model.DB.Where("trade_no = ?", payload.OrderMerchantExternalID).First(&order).Error) {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				remoteOrder.Store(&order)
				// The SDK's idempotency header allows net/http to retry after a
				// reused connection loses its response. Observe the original
				// checkout once, but verify every attempt keeps its local order.
				observeCheckout.Do(func() {
					firstOrder = order
					assert.Equal(t, common.TopUpStatusPending, order.Status)
					assert.Equal(t, 1000, *order.CreditedQuota)
					observed <- order
					if scenario == "callback_before_response_loss" {
						recorder := httptest.NewRecorder()
						router.ServeHTTP(recorder, walletWebhookRequest(t, keys, model.PaymentProviderWaffoPancake, order.TradeNo, "90", true))
						assert.Equal(t, http.StatusOK, recorder.Code)
					}
				})
				assert.Equal(t, firstOrder.Id, order.Id)
				assert.Equal(t, firstOrder.TradeNo, order.TradeNo)
				if scenario == "non_json_remote_error" {
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte("remote response is not JSON"))
					return
				}
				// The provider received the signed create request, then its TCP
				// response was lost. No API rejection is invented by the fixture.
				connection, _, err := w.(http.Hijacker).Hijack()
				if assert.NoError(t, err) {
					_ = connection.Close()
				}
			}))
			defer server.Close()
			target, err := url.Parse(server.URL)
			require.NoError(t, err)
			oldClient := http.DefaultClient
			http.DefaultClient = &http.Client{Transport: walletCheckoutTransport(func(request *http.Request) (*http.Response, error) {
				if request.URL.Host != "api.waffo.ai" {
					return nil, fmt.Errorf("unexpected checkout host: %s", request.URL.Host)
				}
				local := request.Clone(request.Context())
				local.URL.Scheme, local.URL.Host = target.Scheme, target.Host
				response, err := server.Client().Transport.RoundTrip(local)
				if request.URL.Path == "/v1/actions/checkout/create-session" {
					// Establish a Go synchronization edge after callback logging;
					// closing a TCP connection alone is not a race-detector barrier.
					select {
					case <-providerDone:
					case <-request.Context().Done():
						return nil, request.Context().Err()
					}
				}
				return response, err
			})}
			t.Cleanup(func() { http.DefaultClient = oldClient })
			router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestWaffoPancakePay)
			recorder := httptest.NewRecorder()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/checkout", strings.NewReader(`{"amount":100}`))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(recorder, request)
			assert.Contains(t, recorder.Body.String(), `"message":"error"`)
			var order model.TopUp
			select {
			case order = <-observed:
			default:
				t.Fatal("checkout did not reach the isolated HTTP provider fixture")
			}
			require.NoError(t, model.DB.First(&order, order.Id).Error)
			if scenario == "callback_before_response_loss" {
				assert.Equal(t, common.TopUpStatusSuccess, order.Status)
			} else {
				assert.Equal(t, common.TopUpStatusPending, order.Status)
				assert.Zero(t, order.CompleteTime)
			}
			common.QuotaPerUnit = 20
			if scenario == "manual_then_callback" {
				recorder = httptest.NewRecorder()
				request = httptest.NewRequest(http.MethodPost, "/manual", strings.NewReader(fmt.Sprintf(`{"trade_no":%q}`, order.TradeNo)))
				request.Header.Set("Content-Type", "application/json")
				router.ServeHTTP(recorder, request)
				assert.Contains(t, recorder.Body.String(), `"success":true`)
			}
			recorder = httptest.NewRecorder()
			router.ServeHTTP(recorder, walletWebhookRequest(t, keys, model.PaymentProviderWaffoPancake, order.TradeNo, "90", true))
			require.Equal(t, http.StatusOK, recorder.Code)
			require.NoError(t, model.DB.First(&order, order.Id).Error)
			assert.Equal(t, common.TopUpStatusSuccess, order.Status)
			assert.Equal(t, 1000, *order.CreditedQuota)
			var invitee, inviter model.User
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			assert.Equal(t, 990, invitee.Quota)
			assert.Equal(t, 107, inviter.AffQuota)
			var facts []model.ReferralRebate
			require.NoError(t, model.DB.Find(&facts).Error)
			require.Len(t, facts, 1)
			assert.EqualValues(t, 1000, facts[0].CreditedQuota)
			assert.EqualValues(t, 100, facts[0].RewardQuota)
		})
	}
}

func TestWalletReferralManualCompletionRejectsSubscriptionDisplayOrder(t *testing.T) {
	router, _ := walletWebhookFixture(t)
	order := walletWebhookOrder(t, model.PaymentProviderStripe, "subscription_display")
	require.NoError(t, model.DB.Create(&model.SubscriptionOrder{UserId: 902, PlanId: 1, TradeNo: order.TradeNo, PaymentProvider: model.PaymentProviderStripe, Status: common.TopUpStatusPending}).Error)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/manual", strings.NewReader(`{"trade_no":"subscription_display"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	var user model.User
	require.NoError(t, model.DB.First(&user, 902).Error)
	assert.Equal(t, -10, user.Quota)
	reloaded, err := model.GetTopUpByTradeNoWithError(order.TradeNo)
	require.NoError(t, err)
	assert.Equal(t, common.TopUpStatusPending, reloaded.Status)
	assert.Zero(t, reloaded.CompleteTime)
	var facts int64
	require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
	assert.Zero(t, facts)
}

func TestWalletReferralStripeDelayedPaymentSettlesOnlyAfterSuccessEvent(t *testing.T) {
	router, keys := walletWebhookFixture(t)
	order := walletWebhookOrder(t, model.PaymentProviderStripe, "stripe-delayed-payment")
	object := map[string]any{"mode": "payment", "payment_link": nil, "status": "complete", "payment_status": "unpaid", "client_reference_id": order.TradeNo, "amount_total": 9000, "customer": "cus_fixture", "currency": "usd"}
	payload := map[string]any{"id": "evt_delayed", "object": "event", "type": "checkout.session.completed", "data": map[string]any{"object": object}}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderStripe, payload))
	require.Equal(t, http.StatusOK, recorder.Code)
	stored, err := model.GetTopUpByTradeNoWithError(order.TradeNo)
	require.NoError(t, err)
	assert.Equal(t, common.TopUpStatusPending, stored.Status)
	assert.Zero(t, stored.CompleteTime)
	var invitee model.User
	require.NoError(t, model.DB.First(&invitee, 902).Error)
	assert.Equal(t, -10, invitee.Quota)
	var count int64
	require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&count).Error)
	assert.Zero(t, count)

	// Stripe documents async_payment_succeeded as the success event for delayed
	// methods; its paid Checkout Session may follow an unpaid completed event.
	object["payment_status"] = "paid"
	for _, eventType := range []string{"checkout.session.async_payment_succeeded", "checkout.session.async_payment_succeeded", "checkout.session.completed"} {
		payload["type"] = eventType
		recorder = httptest.NewRecorder()
		router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderStripe, payload))
		require.Equal(t, http.StatusOK, recorder.Code)
	}
	require.NoError(t, model.DB.First(&invitee, 902).Error)
	assert.Equal(t, 990, invitee.Quota)
	var inviter model.User
	require.NoError(t, model.DB.First(&inviter, 901).Error)
	assert.Equal(t, 107, inviter.AffQuota)
	var facts []model.ReferralRebate
	require.NoError(t, model.DB.Find(&facts).Error)
	require.Len(t, facts, 1)
	assert.EqualValues(t, 100, facts[0].RewardQuota)
	stored, err = model.GetTopUpByTradeNoWithError(order.TradeNo)
	require.NoError(t, err)
	assert.Equal(t, common.TopUpStatusSuccess, stored.Status)
	assert.Equal(t, facts[0].SettledAt, stored.CompleteTime)
}

// These signed local fixtures model documented Checkout fields; they do not
// claim an attacker can forge a Stripe signature. A public Payment Link on the
// same account/environment accepts a payer-provided client_reference_id. A
// Connect endpoint can also receive API-created sessions owned by a connected
// account; this application's wallet checkout never uses Stripe-Account.
func TestWalletStripeCheckoutSourceCannotSettleOrTerminateAnotherOrder(t *testing.T) {
	for _, source := range []struct {
		name        string
		mode        string
		paymentLink any
		account     string
		wallet      bool
	}{
		{name: "api_payment", mode: "payment", wallet: true},
		{name: "connected_account_payment", mode: "payment", account: "acct_other_merchant"},
		{name: "public_payment_link", mode: "payment", paymentLink: "plink_public_low_price"},
		{name: "expanded_payment_link", mode: "payment", paymentLink: map[string]any{"id": "plink_public_low_price"}},
		{name: "subscription", mode: "subscription"},
		{name: "setup", mode: "setup"},
		{name: "missing_mode"},
	} {
		for _, eventType := range []string{"checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"} {
			t.Run(source.name+"/"+eventType, func(t *testing.T) {
				router, keys := walletWebhookFixture(t)
				order := walletWebhookOrder(t, model.PaymentProviderStripe, "stripe-source-order")
				object := map[string]any{"id": "cs_fixture", "object": "checkout.session", "mode": source.mode, "payment_link": source.paymentLink, "status": "complete", "payment_status": "paid", "client_reference_id": order.TradeNo, "amount_total": 100, "customer": "cus_fixture", "currency": "usd"}
				wantStatus := common.TopUpStatusPending
				if source.wallet {
					wantStatus = common.TopUpStatusSuccess
				}
				switch eventType {
				case "checkout.session.expired":
					object["status"], object["payment_status"] = "expired", "unpaid"
					if source.wallet {
						wantStatus = common.TopUpStatusExpired
					}
				case "checkout.session.async_payment_failed":
					object["payment_status"] = "unpaid"
					if source.wallet {
						wantStatus = common.TopUpStatusFailed
					}
				}
				payload := map[string]any{"id": "evt_source", "object": "event", "type": eventType, "account": source.account, "data": map[string]any{"object": object}}
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderStripe, payload))
				require.Equal(t, http.StatusOK, recorder.Code)
				stored, err := model.GetTopUpByTradeNoWithError(order.TradeNo)
				require.NoError(t, err)
				assert.Equal(t, wantStatus, stored.Status)
				var user model.User
				require.NoError(t, model.DB.First(&user, 902).Error)
				var rebates int64
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&rebates).Error)
				if wantStatus == common.TopUpStatusSuccess {
					assert.Equal(t, 990, user.Quota)
					assert.EqualValues(t, 1, rebates)
				} else {
					assert.Equal(t, -10, user.Quota)
					assert.Zero(t, rebates)
				}
				if source.wallet {
					return
				}

				// Ignoring an unrelated Checkout must preserve the legitimate
				// API-created checkout and its discounted payment, including retries.
				for range 2 {
					recorder = httptest.NewRecorder()
					router.ServeHTTP(recorder, walletWebhookRequest(t, keys, model.PaymentProviderStripe, order.TradeNo, "9000", true))
					require.Equal(t, http.StatusOK, recorder.Code)
				}
				require.NoError(t, model.DB.First(&user, 902).Error)
				assert.Equal(t, 990, user.Quota)
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&rebates).Error)
				assert.EqualValues(t, 1, rebates)
				stored, err = model.GetTopUpByTradeNoWithError(order.TradeNo)
				require.NoError(t, err)
				assert.Equal(t, common.TopUpStatusSuccess, stored.Status)
			})
		}
	}
}

func TestWalletStripeSourceCheckPreservesSubscriptionDispatch(t *testing.T) {
	for _, eventType := range []string{"checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"} {
		t.Run(eventType, func(t *testing.T) {
			router, keys := walletWebhookFixture(t)
			// Subscription completion reads database time using a second connection.
			sqlDB, err := model.DB.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(2)
			require.NoError(t, model.DB.AutoMigrate(&model.SubscriptionPlan{}, &model.UserSubscription{}))
			plan := model.SubscriptionPlan{Id: 904, Title: "Stripe dispatch fixture", PriceAmount: 100, Enabled: true, StripePriceId: "price_fixture", DurationUnit: model.SubscriptionDurationMonth, DurationValue: 1}
			require.NoError(t, model.DB.Create(&plan).Error)
			model.InvalidateSubscriptionPlanCache(plan.Id)
			t.Cleanup(func() { model.InvalidateSubscriptionPlanCache(plan.Id) })
			_, err = model.GetSubscriptionPlanById(plan.Id)
			require.NoError(t, err)
			order := model.SubscriptionOrder{UserId: 902, PlanId: plan.Id, TradeNo: "stripe-subscription-dispatch", PaymentProvider: model.PaymentProviderStripe, PaymentMethod: model.PaymentMethodStripe, Status: common.TopUpStatusPending}
			require.NoError(t, model.DB.Create(&order).Error)
			object := map[string]any{"id": "cs_subscription_fixture", "object": "checkout.session", "mode": "subscription", "payment_link": nil, "status": "complete", "payment_status": "paid", "client_reference_id": order.TradeNo, "amount_total": 9000, "currency": "usd"}
			wantStatus, wantSubscriptions := common.TopUpStatusSuccess, int64(1)
			switch eventType {
			case "checkout.session.expired":
				object["status"], object["payment_status"] = "expired", "unpaid"
				wantStatus, wantSubscriptions = common.TopUpStatusExpired, 0
			case "checkout.session.async_payment_failed":
				object["payment_status"] = "unpaid"
				wantStatus, wantSubscriptions = common.TopUpStatusPending, 0
			}
			payload := map[string]any{"id": "evt_subscription_source", "object": "event", "type": eventType, "data": map[string]any{"object": object}}
			for range 2 {
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderStripe, payload))
				require.Equal(t, http.StatusOK, recorder.Code)
			}
			require.NoError(t, model.DB.First(&order, order.Id).Error)
			assert.Equal(t, wantStatus, order.Status)
			var subscriptions, rebates int64
			require.NoError(t, model.DB.Model(&model.UserSubscription{}).Count(&subscriptions).Error)
			assert.Equal(t, wantSubscriptions, subscriptions)
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&rebates).Error)
			assert.Zero(t, rebates)
			var user model.User
			require.NoError(t, model.DB.First(&user, 902).Error)
			assert.Equal(t, -10, user.Quota)
		})
	}
}

func TestWalletReferralStripeZeroPaymentRequiresExplicitCompletedAmount(t *testing.T) {
	for _, tc := range []struct {
		name           string
		amount         any
		status         string
		paymentStatus  string
		subscription   bool
		wantHTTP       int
		wantSettlement bool
	}{
		{name: "completed free wallet", amount: 0, status: "complete", paymentStatus: "no_payment_required", wantHTTP: http.StatusOK, wantSettlement: true},
		{name: "paid zero wallet", amount: 0, status: "complete", paymentStatus: "paid", wantHTTP: http.StatusOK, wantSettlement: true},
		{name: "free checkout null amount", status: "complete", paymentStatus: "no_payment_required", wantHTTP: http.StatusInternalServerError},
		{name: "free checkout nonzero amount", amount: 9000, status: "complete", paymentStatus: "no_payment_required", wantHTTP: http.StatusInternalServerError},
		{name: "free checkout not complete", amount: 0, status: "open", paymentStatus: "no_payment_required", wantHTTP: http.StatusOK},
		{name: "zero still unpaid", amount: 0, status: "complete", paymentStatus: "unpaid", wantHTTP: http.StatusOK},
		{name: "free subscription retains original branch", amount: 0, status: "complete", paymentStatus: "no_payment_required", subscription: true, wantHTTP: http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router, keys := walletWebhookFixture(t)
			tradeNo := "stripe-zero-payment"
			if tc.subscription {
				require.NoError(t, model.DB.Create(&model.SubscriptionOrder{UserId: 902, PlanId: 1, TradeNo: tradeNo, PaymentProvider: model.PaymentProviderStripe, Status: common.TopUpStatusPending}).Error)
			} else {
				walletWebhookOrder(t, model.PaymentProviderStripe, tradeNo)
			}
			object := map[string]any{"mode": "payment", "payment_link": nil, "status": tc.status, "payment_status": tc.paymentStatus, "client_reference_id": tradeNo, "amount_total": tc.amount, "currency": "usd"}
			if tc.subscription {
				object["mode"] = "subscription"
			}
			payload := map[string]any{"id": "evt_zero", "object": "event", "type": "checkout.session.completed", "data": map[string]any{"object": object}}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderStripe, payload))
			assert.Equal(t, tc.wantHTTP, recorder.Code)
			var invitee model.User
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			var facts int64
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			stored, err := model.GetTopUpByTradeNoWithError(tradeNo)
			if tc.subscription {
				require.ErrorIs(t, err, gorm.ErrRecordNotFound)
				var subscription model.SubscriptionOrder
				require.NoError(t, model.DB.Where("trade_no = ?", tradeNo).First(&subscription).Error)
				assert.Equal(t, common.TopUpStatusPending, subscription.Status)
				assert.Zero(t, subscription.CompleteTime)
				assert.Equal(t, -10, invitee.Quota)
				assert.Zero(t, facts)
				return
			}
			require.NoError(t, err)
			if tc.wantSettlement {
				assert.Equal(t, 990, invitee.Quota)
				assert.Equal(t, common.TopUpStatusSuccess, stored.Status)
				assert.EqualValues(t, 1, facts)
			} else {
				assert.Equal(t, -10, invitee.Quota)
				assert.Equal(t, common.TopUpStatusPending, stored.Status)
				assert.Zero(t, stored.CompleteTime)
				assert.Zero(t, facts)
			}
		})
	}
}

// walletPancakeInquiryTransport supplies normal provider order snapshots for
// existing callback/transaction fixtures. The dedicated inquiry regression
// below overrides this boundary with independent mismatches and failures.
type walletPancakeInquiryTransport struct {
	t         *testing.T
	next      http.RoundTripper
	mu        sync.Mutex
	responses map[string][]byte
}

func (transport *walletPancakeInquiryTransport) setResult(payload map[string]any) {
	transport.t.Helper()
	data := payload["data"].(map[string]any)
	tradeNo, _ := data["orderMerchantExternalId"].(string)
	orderID, _ := data["orderId"].(string)
	price := "100.00"
	if topUp, err := model.GetTopUpByTradeNoWithError(tradeNo); err == nil {
		price = formatWaffoPancakeAmount(topUp.Money)
	}
	body, err := common.Marshal(map[string]any{"data": map[string]any{"onetimeOrder": map[string]any{
		"id": orderID, "orderMerchantExternalId": tradeNo, "status": "completed",
		"testMode": payload["mode"] == "test", "currency": "USD", "store": map[string]any{"id": payload["storeId"]},
		"priceSnapshot": map[string]string{"currency": "USD", "subtotal": price},
	}}})
	require.NoError(transport.t, err)
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.responses == nil {
		transport.responses = make(map[string][]byte)
	}
	transport.responses[orderID] = body
}

func (transport *walletPancakeInquiryTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Host != "api.waffo.ai" || request.URL.Path != "/v1/graphql" {
		next := transport.next
		if next == nil {
			next = http.DefaultTransport
		}
		return next.RoundTrip(request)
	}
	var query struct {
		Variables map[string]string `json:"variables"`
	}
	if err := common.DecodeJson(request.Body, &query); err != nil {
		return nil, err
	}
	transport.mu.Lock()
	body := transport.responses[query.Variables["id"]]
	transport.mu.Unlock()
	if body == nil {
		return nil, fmt.Errorf("missing Pancake inquiry fixture for %s", query.Variables["id"])
	}
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
}

func TestWalletPancakeQueriesMerchantOrderBeforeSettlement(t *testing.T) {
	for _, scenario := range []string{
		"discount and tax", "zero charged", "other environment", "missing environment",
		"other order", "other external order", "other store", "other currency", "not completed", "missing order",
		"query errors", "empty response", "null response", "nil response", "malformed response", "credential rejected", "rejected with data", "server error with data", "lost response",
	} {
		t.Run(scenario, func(t *testing.T) {
			router, platformKeys := walletWebhookFixture(t)
			merchantKeys, err := waffoutils.GenerateKeyPair()
			require.NoError(t, err)
			setting.WaffoPancakeMerchantID = "MER_AbCdEfGhIjKlMnOpQrStUv"
			setting.WaffoPancakePrivateKey = merchantKeys.PrivateKey
			order := walletWebhookOrder(t, model.PaymentProviderWaffoPancake, "pancake-inquiry-original-order")
			charged := "90.00"
			if scenario == "zero charged" {
				charged = "0"
			}
			price := map[string]any{"currency": "USD", "subtotal": "100.00", "taxAmount": "10.00", "total": "110.00"}
			remoteOrder := map[string]any{"id": "ORD_fixture", "orderMerchantExternalId": order.TradeNo, "status": "completed", "testMode": true, "currency": "USD", "priceSnapshot": price, "store": map[string]string{"id": "store_fixture"}}
			response := map[string]any{"data": map[string]any{"onetimeOrder": remoteOrder}}
			switch scenario {
			case "other environment":
				remoteOrder["testMode"] = false
			case "missing environment":
				delete(remoteOrder, "testMode")
			case "other order":
				remoteOrder["id"] = "ORD_other"
			case "other external order":
				remoteOrder["orderMerchantExternalId"] = "another-local-order"
			case "other store":
				remoteOrder["store"] = map[string]string{"id": "another-store"}
			case "other currency":
				remoteOrder["currency"] = "EUR"
			case "not completed":
				remoteOrder["status"] = "pending"
			case "missing order":
				response["data"] = map[string]any{"onetimeOrder": nil}
			case "query errors":
				response["errors"] = []map[string]string{{"message": "not authorized"}}
			}
			body, err := common.Marshal(response)
			require.NoError(t, err)
			switch scenario {
			case "empty response":
				body = nil
			case "null response":
				body = []byte("null")
			case "malformed response":
				body = []byte("{")
			}
			request := walletWebhookRequest(t, platformKeys, model.PaymentProviderWaffoPancake, order.TradeNo, charged, true)
			oldClient := http.DefaultClient
			t.Cleanup(func() { http.DefaultClient = oldClient })
			queries := 0
			recovered := false
			http.DefaultClient = &http.Client{Transport: walletCheckoutTransport(func(req *http.Request) (*http.Response, error) {
				queries++
				assert.Equal(t, "https://api.waffo.ai/v1/graphql", req.URL.String())
				assert.Equal(t, http.MethodPost, req.Method)
				assert.Equal(t, setting.WaffoPancakeMerchantID, req.Header.Get("X-Merchant-Id"))
				assert.Empty(t, req.Header.Get("X-Idempotency-Key"), "read queries must not reuse the checkout action cache")
				raw, err := io.ReadAll(req.Body)
				if !assert.NoError(t, err) {
					return nil, err
				}
				hash := sha256.Sum256(raw)
				canonical := "POST\n/v1/graphql\n" + req.Header.Get("X-Timestamp") + "\n" + base64.StdEncoding.EncodeToString(hash[:])
				assert.True(t, waffoutils.Verify(canonical, req.Header.Get("X-Signature"), merchantKeys.PublicKey), "the installed SDK must sign the actual query body")
				var query struct {
					Query     string            `json:"query"`
					Variables map[string]string `json:"variables"`
				}
				assert.NoError(t, common.Unmarshal(raw, &query))
				assert.Contains(t, query.Query, "onetimeOrder")
				assert.Contains(t, query.Query, "orderMerchantExternalId")
				assert.Contains(t, query.Query, "testMode")
				assert.Equal(t, "ORD_fixture", query.Variables["id"])
				if recovered {
					body = []byte(`{"data":{"onetimeOrder":{"id":"ORD_fixture","orderMerchantExternalId":"pancake-inquiry-original-order","status":"completed","testMode":true,"currency":"USD","store":{"id":"store_fixture"},"priceSnapshot":{"currency":"USD","subtotal":"100.00","taxAmount":"10.00","total":"110.00"}}}}`)
				} else if scenario == "lost response" {
					return nil, io.ErrUnexpectedEOF
				} else if scenario == "nil response" {
					return nil, nil
				} else if scenario == "rejected with data" {
					return &http.Response{StatusCode: http.StatusUnauthorized, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
				} else if scenario == "server error with data" {
					return &http.Response{StatusCode: http.StatusInternalServerError, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
				} else if scenario == "credential rejected" {
					return &http.Response{StatusCode: http.StatusUnauthorized, Body: io.NopCloser(strings.NewReader(`{"errors":[{"message":"credential rejected"}]}`)), Header: make(http.Header)}, nil
				}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
			})}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			valid := scenario == "discount and tax" || scenario == "zero charged"
			wantStatus := http.StatusInternalServerError
			if valid {
				wantStatus = http.StatusOK
			}
			assert.Equal(t, wantStatus, recorder.Code, recorder.Body.String())
			assert.Equal(t, 1, queries)
			var buyer, inviter model.User
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			var facts int64
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			if !valid {
				assert.Equal(t, -10, buyer.Quota)
				assert.Equal(t, 7, inviter.AffQuota)
				assert.Zero(t, facts)
				stored, err := model.GetTopUpByTradeNoWithError(order.TradeNo)
				require.NoError(t, err)
				assert.Equal(t, common.TopUpStatusPending, stored.Status)
				assert.Zero(t, stored.CompleteTime)
			}
			// Corrected provider data or restored credentials retry the original
			// order. A known SQL success remains recoverable without the API.
			recovered = true
			for range 2 {
				retry := httptest.NewRecorder()
				router.ServeHTTP(retry, walletWebhookRequest(t, platformKeys, model.PaymentProviderWaffoPancake, order.TradeNo, charged, true))
				assert.Equal(t, http.StatusOK, retry.Code, retry.Body.String())
			}
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			assert.Equal(t, 990, buyer.Quota)
			assert.Equal(t, 107, inviter.AffQuota)
			assert.EqualValues(t, 1, facts)
			wantQueries := 2
			if valid {
				wantQueries = 1
			}
			assert.Equal(t, wantQueries, queries)
		})
	}
}

func TestWalletReferralPancakePreservesStoreEnvironmentAndBuyerBinding(t *testing.T) {
	for _, scenario := range []string{"other store", "other buyer", "missing buyer", "missing local order", "other environment", "test signature for production", "production signature for test", "valid production", "missing environment"} {
		t.Run(scenario, func(t *testing.T) {
			router, keys := walletWebhookFixture(t)
			productionKeys, err := waffoutils.GenerateKeyPair()
			require.NoError(t, err)
			t.Setenv("WAFFO_WEBHOOK_PROD_PUBLIC_KEY", productionKeys.PublicKey)
			order := walletWebhookOrder(t, model.PaymentProviderWaffoPancake, "pancake-bound-order")
			data := map[string]any{"orderId": "ORD_fixture", "orderMerchantExternalId": order.TradeNo, "merchantProvidedBuyerIdentity": "new-api-user-902", "amount": "90.00", "currency": "USD"}
			payload := map[string]any{"id": "evt_bound_order", "eventType": "order.completed", "mode": "test", "storeId": "store_fixture", "data": data}
			wantHTTP := http.StatusOK
			switch scenario {
			case "other store":
				payload["storeId"] = "other_store"
				wantHTTP = http.StatusUnauthorized
			case "other buyer":
				data["merchantProvidedBuyerIdentity"] = "new-api-user-901"
			case "missing buyer":
				delete(data, "merchantProvidedBuyerIdentity")
			case "missing local order":
				data["orderMerchantExternalId"] = "unknown_order"
			case "test signature for production":
				payload["mode"] = "prod"
				wantHTTP = http.StatusUnauthorized
			case "production signature for test":
				keys = productionKeys
				wantHTTP = http.StatusUnauthorized
			case "valid production":
				payload["mode"] = "prod"
				keys = productionKeys
			case "missing environment":
				delete(payload, "mode")
				wantHTTP = http.StatusUnauthorized
			}
			request := signedWalletWebhookRequest(t, keys, model.PaymentProviderWaffoPancake, payload)
			if scenario == "other environment" || payload["mode"] == "prod" {
				request.URL.Path = "/waffo_pancake/prod"
			}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			assert.Equal(t, wantHTTP, recorder.Code)
			var invitee model.User
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			stored, err := model.GetTopUpByTradeNoWithError(order.TradeNo)
			require.NoError(t, err)
			var facts int64
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			if scenario == "valid production" {
				assert.Equal(t, 990, invitee.Quota)
				assert.Equal(t, common.TopUpStatusSuccess, stored.Status)
				assert.NotZero(t, stored.CompleteTime)
				assert.EqualValues(t, 1, facts)
			} else {
				assert.Equal(t, -10, invitee.Quota)
				assert.Equal(t, common.TopUpStatusPending, stored.Status)
				assert.Zero(t, stored.CompleteTime)
				assert.Zero(t, facts)
			}
		})
	}
}

func TestWalletCheckoutDisplaySnapshotPreservesPricingAndCapacity(t *testing.T) {
	for _, provider := range []string{model.PaymentProviderEpay, model.PaymentProviderWaffo, model.PaymentProviderWaffoPancake} {
		for _, display := range []struct {
			before, after                  string
			quota                          int
			money                          float64
			quotaPerUnit, nextQuotaPerUnit float64
			amount, normalized             int64
		}{
			{operation_setting.QuotaDisplayTypeTokens, operation_setting.QuotaDisplayTypeUSD, 100, 10, 10, 10, 100, 10},
			{operation_setting.QuotaDisplayTypeUSD, operation_setting.QuotaDisplayTypeTokens, 1000, 100, 10, 10, 100, 100},
			{operation_setting.QuotaDisplayTypeUSD, operation_setting.QuotaDisplayTypeUSD, 1000, 100, 10, 100, 100, 100},
			{operation_setting.QuotaDisplayTypeTokens, operation_setting.QuotaDisplayTypeTokens, 100, 10, 10, 100, 100, 10},
			{operation_setting.QuotaDisplayTypeTokens, operation_setting.QuotaDisplayTypeTokens, 110, 100, 1.1, 1.1, 110, 100},
		} {
			for _, capacity := range []string{"exact_capacity", "exceeds_capacity"} {
				t.Run(fmt.Sprintf("%s/%s/%g_to_%g/%s", provider, display.before, display.quotaPerUnit, display.nextQuotaPerUnit, capacity), func(t *testing.T) {
					router, keys := walletCheckoutFixture(t)
					oldOptions := common.OptionMap
					common.OptionMap = make(map[string]string)
					t.Cleanup(func() { common.OptionMap = oldOptions })
					operation_setting.GetGeneralSetting().QuotaDisplayType = display.before
					common.QuotaPerUnit = display.quotaPerUnit
					initialQuota := common.MaxWalletQuota - display.quota
					if capacity == "exceeds_capacity" {
						initialQuota++
					}
					require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 902).Update("quota", initialQuota).Error)
					changed := false
					const callbackName = "test:checkout_display_change"
					require.NoError(t, model.DB.Callback().Query().After("gorm:query").Register(callbackName, func(tx *gorm.DB) {
						if tx.Statement.Table == "users" && !changed {
							changed = true
							// Run the real option persistence/runtime update after the first
							// user read, before pricing and order creation.
							assert.NoError(t, model.UpdateOption("general_setting.quota_display_type", display.after))
							assert.NoError(t, model.UpdateOption("QuotaPerUnit", strconv.FormatFloat(display.nextQuotaPerUnit, 'f', -1, 64)))
						}
					}))
					t.Cleanup(func() { assert.NoError(t, model.DB.Callback().Query().Remove(callbackName)) })
					oldClient := http.DefaultClient
					oldWaffoPrice, oldWaffoMin := setting.WaffoUnitPrice, setting.WaffoMinTopUp
					t.Cleanup(func() {
						http.DefaultClient = oldClient
						setting.WaffoUnitPrice, setting.WaffoMinTopUp = oldWaffoPrice, oldWaffoMin
					})
					setting.WaffoUnitPrice, setting.WaffoMinTopUp = 1, 1
					var externalRequests atomic.Int32
					var checkoutAmount atomic.Value
					var checkoutExternalID atomic.Value
					http.DefaultClient = &http.Client{Transport: walletCheckoutTransport(func(request *http.Request) (*http.Response, error) {
						externalRequests.Add(1)
						if request.URL.Path == "/v1/graphql" {
							// Preserve the provider's original checkout snapshot even
							// after local display/rate settings change during the request.
							response, err := common.Marshal(map[string]any{"data": map[string]any{"onetimeOrder": map[string]any{
								"id": "ORD_fixture", "orderMerchantExternalId": checkoutExternalID.Load(), "status": "completed", "testMode": true, "currency": "USD",
								"store": map[string]string{"id": "store_fixture"}, "priceSnapshot": map[string]any{"currency": "USD", "subtotal": checkoutAmount.Load()},
							}}})
							if err != nil {
								return nil, err
							}
							return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(response))}, nil
						}
						body := "{\"data\":{\"token\":\"fixture\",\"expiresAt\":\"2099-01-01T00:00:00Z\"}}"
						if request.URL.Path == "/v1/actions/checkout/create-session" {
							var payload map[string]any
							if err := common.DecodeJson(request.Body, &payload); err != nil {
								return nil, err
							}
							price, ok := payload["priceSnapshot"].(map[string]any)
							if !ok {
								return nil, errors.New("missing checkout price snapshot")
							}
							checkoutAmount.Store(price["amount"])
							checkoutExternalID.Store(payload["orderMerchantExternalId"])
							assert.Equal(t, "USD", payload["currency"])
							assert.Equal(t, setting.WaffoPancakeProductID, payload["productId"])
							assert.NotEqual(t, "client-chosen-order", payload["orderMerchantExternalId"])
							body = "{\"data\":{\"sessionId\":\"ses_fixture\",\"checkoutUrl\":\"https://checkout.example.invalid/fixture\",\"expiresAt\":\"2099-01-01T00:00:00Z\"}}"
						}
						return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
					})}
					handler, body := RequestEpay, fmt.Sprintf("{\"amount\":%d,\"payment_method\":\"alipay\"}", display.amount)
					if provider == model.PaymentProviderWaffo {
						handler, body = RequestWaffoPay, fmt.Sprintf("{\"amount\":%d}", display.amount)
						// Waffo owns its transport. Fail local SDK validation to keep the
						// permanent test offline after the frozen order has been created.
						setting.WaffoPrivateKey = "invalid-local-fixture-key"
					} else if provider == model.PaymentProviderWaffoPancake {
						handler = RequestWaffoPancakePay
						// Client-supplied checkout identities, currency and prices cannot
						// replace the original server-generated order and quote.
						body = fmt.Sprintf(`{"amount":%d,"orderMerchantExternalId":"client-chosen-order","productId":"PROD_client","currency":"EUR","priceSnapshot":{"amount":"0"}}`, display.amount)
					}
					router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, handler)
					request := httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader(body))
					request.Header.Set("Content-Type", "application/json")
					recorder := httptest.NewRecorder()
					router.ServeHTTP(recorder, request)
					require.True(t, changed)
					require.Equal(t, display.after, operation_setting.GetQuotaDisplayType())
					require.Equal(t, display.nextQuotaPerUnit, common.QuotaPerUnit)
					var orders []model.TopUp
					require.NoError(t, model.DB.Find(&orders).Error)
					if capacity == "exceeds_capacity" {
						assert.Contains(t, recorder.Body.String(), "Top-up quota limit exceeded")
						assert.Empty(t, orders)
						assert.Zero(t, externalRequests.Load())
						return
					}
					require.Len(t, orders, 1)
					order := orders[0]
					assert.InDelta(t, display.money, order.Money, 0.000001)
					assert.Equal(t, display.normalized, order.Amount)
					require.NotNil(t, order.CreditedQuota)
					assert.Equal(t, display.quota, *order.CreditedQuota)
					if provider == model.PaymentProviderWaffo {
						assert.Equal(t, common.TopUpStatusFailed, order.Status)
						assert.Zero(t, externalRequests.Load())
						return
					}
					if provider == model.PaymentProviderEpay {
						var response struct{ Data map[string]string }
						require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
						assert.Equal(t, fmt.Sprintf("%.2f", display.money), response.Data["money"])
					} else {
						assert.Equal(t, fmt.Sprintf("%.2f", display.money), checkoutAmount.Load())
						assert.Equal(t, order.TradeNo, checkoutExternalID.Load())
						assert.EqualValues(t, 2, externalRequests.Load())
					}
					for range 2 {
						callback := httptest.NewRecorder()
						router.ServeHTTP(callback, walletWebhookRequest(t, keys, provider, order.TradeNo, fmt.Sprintf("%.2f", display.money), true))
						assert.Equal(t, http.StatusOK, callback.Code)
					}
					var invitee, inviter model.User
					require.NoError(t, model.DB.First(&invitee, 902).Error)
					require.NoError(t, model.DB.First(&inviter, 901).Error)
					assert.Equal(t, common.MaxWalletQuota, invitee.Quota)
					assert.Equal(t, 7+display.quota/10, inviter.AffQuota)
					assert.Equal(t, 11+display.quota/10, inviter.AffHistoryQuota)
					var facts []model.ReferralRebate
					require.NoError(t, model.DB.Find(&facts).Error)
					require.Len(t, facts, 1)
					assert.EqualValues(t, display.quota, facts[0].CreditedQuota)
					assert.EqualValues(t, display.quota/10, facts[0].RewardQuota)
				})
			}
		}
	}
}

// A failed BeginTx happens before the subscription lookup can distinguish a
// wallet order. A paid wallet event must be retried, while existing unrelated
// source and subscription acknowledgements retain their original contract.
func TestWalletStripeDispatchTransactionFailureRemainsRetryable(t *testing.T) {
	for _, eventType := range []string{"checkout.session.completed", "checkout.session.async_payment_succeeded"} {
		for _, source := range []struct {
			name, mode, paymentLink, account string
			wallet                           bool
		}{
			{name: "wallet", mode: "payment", wallet: true},
			{name: "subscription", mode: "subscription"},
			{name: "payment_link", mode: "payment", paymentLink: "plink_other"},
			{name: "connected_account", mode: "payment", account: "acct_other"},
		} {
			t.Run(eventType+"/"+source.name, func(t *testing.T) {
				router, keys := walletWebhookFixture(t)
				order := walletWebhookOrder(t, model.PaymentProviderStripe, "stripe-dispatch-outage")
				healthy := model.DB
				unavailable, err := gorm.Open(healthy.Dialector, &gorm.Config{})
				require.NoError(t, err)
				sqlDB, err := unavailable.DB()
				require.NoError(t, err)
				// Close only an independent pool owned by this test. The real
				// driver now fails BeginTx; the original fixture remains usable.
				require.NoError(t, sqlDB.Close())
				payload := map[string]any{
					"id": "evt_dispatch_outage", "object": "event", "type": eventType,
					"account": source.account,
					"data": map[string]any{"object": map[string]any{
						"mode": source.mode, "payment_link": source.paymentLink,
						"status": "complete", "payment_status": "paid",
						"client_reference_id": order.TradeNo, "customer": "cus_fixture",
						"currency": "usd", "amount_total": 10000,
					}},
				}
				model.DB = unavailable
				t.Cleanup(func() { model.DB = healthy })
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderStripe, payload))
				model.DB = healthy
				wantStatus := http.StatusOK
				if source.wallet {
					wantStatus = http.StatusInternalServerError
				}
				assert.Equal(t, wantStatus, recorder.Code)
				require.NoError(t, model.DB.First(order, order.Id).Error)
				assert.Equal(t, common.TopUpStatusPending, order.Status)
				assert.Zero(t, order.CompleteTime)
				var user, inviter model.User
				require.NoError(t, model.DB.First(&user, 902).Error)
				require.NoError(t, model.DB.First(&inviter, 901).Error)
				assert.Equal(t, -10, user.Quota)
				assert.Equal(t, 7, inviter.AffQuota)
				assert.Equal(t, 11, inviter.AffHistoryQuota)
				var facts int64
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
				assert.Zero(t, facts)

				for range 2 {
					recorder = httptest.NewRecorder()
					router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderStripe, payload))
					require.Equal(t, http.StatusOK, recorder.Code)
				}
				require.NoError(t, model.DB.First(order, order.Id).Error)
				require.NoError(t, model.DB.First(&user, 902).Error)
				require.NoError(t, model.DB.First(&inviter, 901).Error)
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
				if source.wallet {
					assert.Equal(t, common.TopUpStatusSuccess, order.Status)
					assert.Positive(t, order.CompleteTime)
					assert.Equal(t, 990, user.Quota)
					assert.Equal(t, 107, inviter.AffQuota)
					assert.Equal(t, 111, inviter.AffHistoryQuota)
					assert.EqualValues(t, 1, facts)
				} else {
					assert.Equal(t, common.TopUpStatusPending, order.Status)
					assert.Zero(t, order.CompleteTime)
					assert.Equal(t, -10, user.Quota)
					assert.Equal(t, 7, inviter.AffQuota)
					assert.Equal(t, 11, inviter.AffHistoryQuota)
					assert.Zero(t, facts)
				}
			})
		}
	}
}

func TestWalletTerminalNotificationsRetryDatabaseFailures(t *testing.T) {
	for _, tc := range []struct {
		name, provider, eventType, wantStatus string
		faults                                []string
	}{
		{"stripe_expired", model.PaymentProviderStripe, "checkout.session.expired", common.TopUpStatusExpired, []string{"subscription_lookup", "order_lookup", "order_update"}},
		{"stripe_async_failed", model.PaymentProviderStripe, "checkout.session.async_payment_failed", common.TopUpStatusFailed, []string{"order_lookup", "order_update"}},
		{"waffo_closed", model.PaymentProviderWaffo, "PAYMENT_NOTIFICATION", common.TopUpStatusFailed, []string{"order_lookup", "order_update"}},
	} {
		for _, fault := range tc.faults {
			t.Run(tc.name+"/"+fault, func(t *testing.T) {
				router, keys := walletWebhookFixture(t)
				order := walletWebhookOrder(t, tc.provider, "terminal-retry")
				payload := map[string]any{"id": "evt_terminal", "object": "event", "type": tc.eventType, "data": map[string]any{"object": map[string]any{"mode": "payment", "status": "complete", "payment_status": "unpaid", "payment_link": nil, "client_reference_id": order.TradeNo}}}
				if tc.name == "stripe_expired" {
					payload["data"].(map[string]any)["object"].(map[string]any)["status"] = "expired"
				}
				if tc.provider == model.PaymentProviderWaffo {
					payload = map[string]any{"eventType": tc.eventType, "result": map[string]any{"merchantOrderId": order.TradeNo, "orderStatus": "ORDER_CLOSE"}}
				}
				faultTable := "top_ups"
				if fault == "subscription_lookup" {
					faultTable = "subscription_orders"
				}
				callback := func(tx *gorm.DB) {
					if tx.Statement.Table == faultTable {
						tx.AddError(errors.New("injected terminal notification database outage"))
					}
				}
				const callbackName = "test:terminal_notification_outage"
				processor := model.DB.Callback().Query()
				callbackAnchor := "gorm:query"
				if fault == "order_update" {
					processor = model.DB.Callback().Update()
					callbackAnchor = "gorm:update"
				}
				require.NoError(t, processor.Before(callbackAnchor).Register(callbackName, callback))
				t.Cleanup(func() { assert.NoError(t, processor.Remove(callbackName)) })
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, tc.provider, payload))
				if tc.provider == model.PaymentProviderWaffo {
					assert.Equal(t, http.StatusOK, recorder.Code)
					assert.JSONEq(t, "{\"message\":\"failed\"}", recorder.Body.String())
					assert.True(t, waffoutils.Verify(recorder.Body.String(), recorder.Header().Get("X-SIGNATURE"), keys.PublicKey))
				} else {
					assert.Equal(t, http.StatusInternalServerError, recorder.Code)
				}
				require.NoError(t, processor.Remove(callbackName))
				require.NoError(t, model.DB.First(&order, order.Id).Error)
				assert.Equal(t, common.TopUpStatusPending, order.Status)
				require.NotNil(t, order.CreditedQuota)
				assert.Equal(t, 1000, *order.CreditedQuota)
				assert.Zero(t, order.CompleteTime)
				for range 2 {
					recorder = httptest.NewRecorder()
					router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, tc.provider, payload))
					assert.Equal(t, http.StatusOK, recorder.Code)
					if tc.provider == model.PaymentProviderWaffo {
						assert.JSONEq(t, "{\"message\":\"success\"}", recorder.Body.String())
					}
				}
				require.NoError(t, model.DB.First(&order, order.Id).Error)
				assert.Equal(t, tc.wantStatus, order.Status)
				assert.Zero(t, order.CompleteTime)
				assert.ErrorContains(t, model.ManualCompleteTopUp(order.TradeNo, "127.0.0.1"), "Order is not pending payment and cannot be completed")
				var user model.User
				require.NoError(t, model.DB.First(&user, 902).Error)
				assert.Equal(t, -10, user.Quota)
				var facts int64
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
				assert.Zero(t, facts)
			})
		}
	}
}

func TestWalletTerminalNotificationsAcknowledgeUnrelatedAndFinalOrders(t *testing.T) {
	for _, tc := range []struct {
		name, provider, eventType string
	}{
		{"stripe_expired", model.PaymentProviderStripe, "checkout.session.expired"},
		{"stripe_async_failed", model.PaymentProviderStripe, "checkout.session.async_payment_failed"},
		{"waffo_closed", model.PaymentProviderWaffo, "PAYMENT_NOTIFICATION"},
	} {
		for _, state := range []string{"unknown_order", "other_provider", "expired", "failed", "paid", "manually_completed"} {
			t.Run(tc.name+"/"+state, func(t *testing.T) {
				router, keys := walletWebhookFixture(t)
				provider := tc.provider
				if state == "other_provider" {
					provider = model.PaymentProviderCreem
				}
				order := walletWebhookOrder(t, provider, "terminal-ack")
				wantQuota, wantFacts := -10, int64(0)
				switch state {
				case "expired":
					require.NoError(t, model.UpdatePendingTopUpStatus(order.TradeNo, provider, common.TopUpStatusExpired))
				case "failed":
					require.NoError(t, model.UpdatePendingTopUpStatus(order.TradeNo, provider, common.TopUpStatusFailed))
				case "paid":
					recorder := httptest.NewRecorder()
					router.ServeHTTP(recorder, walletWebhookRequest(t, keys, provider, order.TradeNo, "9000", true))
					require.Equal(t, http.StatusOK, recorder.Code)
					wantQuota, wantFacts = 990, 1
				case "manually_completed":
					require.NoError(t, model.ManualCompleteTopUp(order.TradeNo, "127.0.0.1"))
					wantQuota, wantFacts = 990, 1
				}
				require.NoError(t, model.DB.First(order, order.Id).Error)
				before := *order
				tradeNo := order.TradeNo
				if state == "unknown_order" {
					tradeNo = "absent-terminal-order"
				}
				payload := map[string]any{"id": "evt_terminal_ack", "object": "event", "type": tc.eventType, "data": map[string]any{"object": map[string]any{"mode": "payment", "status": "complete", "payment_status": "unpaid", "payment_link": nil, "client_reference_id": tradeNo}}}
				if tc.name == "stripe_expired" {
					payload["data"].(map[string]any)["object"].(map[string]any)["status"] = "expired"
				}
				if tc.provider == model.PaymentProviderWaffo {
					payload = map[string]any{"eventType": tc.eventType, "result": map[string]any{"merchantOrderId": tradeNo, "orderStatus": "ORDER_CLOSE"}}
				}
				for range 2 {
					recorder := httptest.NewRecorder()
					router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, tc.provider, payload))
					assert.Equal(t, http.StatusOK, recorder.Code)
					if tc.provider == model.PaymentProviderWaffo {
						assert.JSONEq(t, "{\"message\":\"success\"}", recorder.Body.String())
						assert.True(t, waffoutils.Verify(recorder.Body.String(), recorder.Header().Get("X-SIGNATURE"), keys.PublicKey))
					}
				}
				require.NoError(t, model.DB.First(order, order.Id).Error)
				assert.Equal(t, before, *order)
				var user model.User
				require.NoError(t, model.DB.First(&user, 902).Error)
				assert.Equal(t, wantQuota, user.Quota)
				var facts int64
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
				assert.Equal(t, wantFacts, facts)
			})
		}
	}
}

func TestWalletExpirySharedHelperPreservesSubscriptionCallers(t *testing.T) {
	for _, caller := range []string{"stripe_subscription", "epay_checkout_rejection"} {
		for _, fault := range []string{"none", "lookup", "update"} {
			t.Run(caller+"/"+fault, func(t *testing.T) {
				router, keys := walletWebhookFixture(t)
				if caller == "stripe_subscription" {
					order := model.SubscriptionOrder{UserId: 902, PlanId: 904, TradeNo: "subscription-expiry", PaymentProvider: model.PaymentProviderStripe, PaymentMethod: model.PaymentMethodStripe, Status: common.TopUpStatusPending}
					require.NoError(t, model.DB.Create(&order).Error)
				} else {
					require.NoError(t, model.DB.AutoMigrate(&model.SubscriptionPlan{}))
					// The payment SDK rejects ambiguous signed parameters. This
					// exercises the existing local checkout-failure expiry branch.
					plan := model.SubscriptionPlan{Id: 904, Title: "Plan&out_trade_no=other", PriceAmount: 100, Enabled: true}
					require.NoError(t, model.DB.Create(&plan).Error)
					model.InvalidateSubscriptionPlanCache(plan.Id)
					t.Cleanup(func() { model.InvalidateSubscriptionPlanCache(plan.Id) })
					router.POST("/subscription-checkout", func(c *gin.Context) { c.Set("id", 902) }, SubscriptionRequestEpay)
				}
				const callbackName = "test:shared_subscription_expiry_outage"
				processor := model.DB.Callback().Query()
				callbackAnchor := "gorm:query"
				if fault == "update" {
					processor = model.DB.Callback().Update()
					callbackAnchor = "gorm:update"
				}
				faultCount := 0
				if fault != "none" {
					require.NoError(t, processor.Before(callbackAnchor).Register(callbackName, func(tx *gorm.DB) {
						if tx.Statement.Table == "subscription_orders" {
							faultCount++
							tx.AddError(errors.New("injected shared subscription expiry outage"))
						}
					}))
				}
				recorder := httptest.NewRecorder()
				if caller == "stripe_subscription" {
					payload := map[string]any{"id": "evt_subscription_expiry", "object": "event", "type": "checkout.session.expired", "data": map[string]any{"object": map[string]any{"mode": "subscription", "status": "expired", "payment_status": "unpaid", "client_reference_id": "subscription-expiry"}}}
					router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderStripe, payload))
					assert.Empty(t, recorder.Body.String())
				} else {
					request := httptest.NewRequest(http.MethodPost, "/subscription-checkout", strings.NewReader("{\"plan_id\":904,\"payment_method\":\"alipay\"}"))
					request.Header.Set("Content-Type", "application/json")
					router.ServeHTTP(recorder, request)
					assert.Contains(t, recorder.Body.String(), "Failed to start payment")
				}
				assert.Equal(t, http.StatusOK, recorder.Code)
				if fault != "none" {
					require.NoError(t, processor.Remove(callbackName))
					assert.Positive(t, faultCount)
				}
				var orders []model.SubscriptionOrder
				require.NoError(t, model.DB.Find(&orders).Error)
				require.Len(t, orders, 1)
				if fault == "none" {
					assert.Equal(t, common.TopUpStatusExpired, orders[0].Status)
					assert.Positive(t, orders[0].CompleteTime)
				} else {
					assert.Equal(t, common.TopUpStatusPending, orders[0].Status)
					assert.Zero(t, orders[0].CompleteTime)
				}
				var topUps, rebates int64
				require.NoError(t, model.DB.Model(&model.TopUp{}).Count(&topUps).Error)
				assert.Zero(t, topUps)
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&rebates).Error)
				assert.Zero(t, rebates)
				var user model.User
				require.NoError(t, model.DB.First(&user, 902).Error)
				assert.Equal(t, -10, user.Quota)
			})
		}
	}
}

type walletWebhookCredentialChangeReader struct {
	io.Reader
	beforeRead func()
}

func (reader *walletWebhookCredentialChangeReader) Read(p []byte) (int, error) {
	if reader.beforeRead != nil {
		change := reader.beforeRead
		reader.beforeRead = nil
		change()
	}
	return reader.Reader.Read(p)
}

func TestWalletWebhookCredentialRemovalDuringBodyRead(t *testing.T) {
	for _, tc := range []struct {
		name, provider, option string
		handler                gin.HandlerFunc
		creemTestMode          bool
	}{
		{"stripe", model.PaymentProviderStripe, "StripeWebhookSecret", StripeWebhook, false},
		{"creem_production", model.PaymentProviderCreem, "CreemWebhookSecret", CreemWebhook, false},
		{"creem_test", model.PaymentProviderCreem, "CreemWebhookSecret", CreemWebhook, true},
		{"epay", model.PaymentProviderEpay, "EpayKey", EpayNotify, false},
		{"waffo", model.PaymentProviderWaffo, "WaffoPublicCert", WaffoWebhook, false},
		{"waffo_pancake", model.PaymentProviderWaffoPancake, "WaffoPancakeMerchantID", WaffoPancakeWebhook, false},
	} {
		for _, surface := range []string{"handler_only", "default_512kb", "disabled_body_limit"} {
			for _, removed := range []string{"", "   "} {
				label := "empty"
				if removed != "" {
					label = "whitespace"
				}
				t.Run(tc.name+"/"+surface+"/"+label, func(t *testing.T) {
					_, keys := walletWebhookFixture(t)
					setting.CreemTestMode = tc.creemTestMode
					order := walletWebhookOrder(t, tc.provider, "credential-transition")
					request := walletWebhookRequest(t, keys, tc.provider, order.TradeNo, "9000", true)
					body, err := io.ReadAll(request.Body)
					require.NoError(t, err)
					switch tc.provider {
					case model.PaymentProviderStripe:
						signed := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{Payload: body, Secret: removed})
						request.Header.Set("Stripe-Signature", signed.Header)
					case model.PaymentProviderCreem:
						request.Header.Set(CreemSignatureHeader, generateCreemSignature(string(body), removed))
					case model.PaymentProviderEpay:
						params, err := url.ParseQuery(string(body))
						require.NoError(t, err)
						var signed []string
						for _, key := range []string{"money", "name", "out_trade_no", "pid", "trade_status", "type"} {
							signed = append(signed, key+"="+params.Get(key))
						}
						params.Set("sign", epay.MD5String(strings.Join(signed, "&"), removed))
						body = []byte(params.Encode())
					case model.PaymentProviderWaffo:
						request.Header.Set("X-SIGNATURE", "invalid")
					case model.PaymentProviderWaffoPancake:
						request.Header.Set("X-Waffo-Signature", "t=1,v1=invalid")
					}
					common.OptionMapRWMutex.Lock()
					optionsWereNil := common.OptionMap == nil
					if optionsWereNil {
						common.OptionMap = make(map[string]string)
					}
					oldOption, existed := common.OptionMap[tc.option]
					common.OptionMapRWMutex.Unlock()
					t.Cleanup(func() {
						common.OptionMapRWMutex.Lock()
						defer common.OptionMapRWMutex.Unlock()
						if optionsWereNil {
							common.OptionMap = nil
						} else if existed {
							common.OptionMap[tc.option] = oldOption
						} else {
							delete(common.OptionMap, tc.option)
						}
					})
					request.Body = io.NopCloser(&walletWebhookCredentialChangeReader{Reader: bytes.NewReader(body), beforeRead: func() {
						// Deterministically run the real runtime option setter at the
						// first read; default middleware reads before the handler gate.
						require.NoError(t, model.UpdateOption(tc.option, removed))
					}})
					request.ContentLength = int64(len(body))
					oldLimit := constant.AnonymousRequestBodyLimitKB
					t.Cleanup(func() { constant.AnonymousRequestBodyLimitKB = oldLimit })
					constant.AnonymousRequestBodyLimitKB = 0
					router := gin.New()
					path := "/" + tc.provider
					if tc.provider == model.PaymentProviderWaffoPancake {
						path += "/:env"
					}
					if surface == "handler_only" {
						router.POST(path, tc.handler)
					} else {
						if surface == "default_512kb" {
							constant.AnonymousRequestBodyLimitKB = 512
						}
						router.POST(path, middleware.AnonymousRequestBodyLimit(), tc.handler)
					}
					recorder := httptest.NewRecorder()
					router.ServeHTTP(recorder, request)
					if tc.provider == model.PaymentProviderEpay {
						assert.Equal(t, "fail", recorder.Body.String())
					} else {
						assert.GreaterOrEqual(t, recorder.Code, http.StatusBadRequest)
					}
					var user, inviter model.User
					require.NoError(t, model.DB.First(&user, 902).Error)
					require.NoError(t, model.DB.First(&inviter, 901).Error)
					assert.Equal(t, -10, user.Quota)
					assert.Equal(t, 7, inviter.AffQuota)
					assert.Equal(t, 11, inviter.AffHistoryQuota)
					require.NoError(t, model.DB.First(order, order.Id).Error)
					assert.Equal(t, common.TopUpStatusPending, order.Status)
					assert.Zero(t, order.CompleteTime)
					require.NotNil(t, order.CreditedQuota)
					assert.Equal(t, 1000, *order.CreditedQuota)
					var facts int64
					require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
					assert.Zero(t, facts)
					t.Logf("surface=%s limit_kb=%d HTTP=%d quota=%d order_status=%s referral_facts=%d", surface, constant.AnonymousRequestBodyLimitKB, recorder.Code, user.Quota, order.Status, facts)
				})
			}
		}
	}
}

func TestWalletStripeConcurrentCheckoutsKeepClientCredentialsIsolated(t *testing.T) {
	originalBackend, originalKey := stripe.GetBackend(stripe.APIBackend), stripe.Key
	originalSecret, originalPriceID := setting.StripeApiSecret, setting.StripePriceId
	t.Cleanup(func() {
		stripe.SetBackend(stripe.APIBackend, originalBackend)
		stripe.Key = originalKey
		setting.StripeApiSecret, setting.StripePriceId = originalSecret, originalPriceID
	})
	setting.StripeApiSecret = "sk_test_wallet_checkout"
	setting.StripePriceId = "price_wallet_checkout"
	stripe.Key = "sk_test_unrelated_client"
	seen := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		seen <- request.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"url\":\"https://checkout.stripe.test/wallet\"}"))
	}))
	defer server.Close()
	stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{URL: stripe.String(server.URL), HTTPClient: server.Client(), MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false)}))
	type checkoutResult struct {
		url string
		err error
	}
	start := make(chan struct{})
	results := make(chan checkoutResult, 2)
	for i := range 2 {
		go func() {
			<-start
			checkoutURL, err := genStripeLink(fmt.Sprintf("concurrent-wallet-%d", i), "", "", 1, "https://example.test/success", "https://example.test/cancel")
			results <- checkoutResult{url: checkoutURL, err: err}
		}()
	}
	close(start)
	completed := []checkoutResult{<-results, <-results}
	for _, result := range completed {
		require.NoError(t, result.err)
		assert.Equal(t, "https://checkout.stripe.test/wallet", result.url)
		assert.Equal(t, "Bearer "+setting.StripeApiSecret, <-seen)
	}
	assert.Equal(t, "sk_test_unrelated_client", stripe.Key)
}

func TestWalletTopUpQueriesRejectCancelledAndInvalidPagination(t *testing.T) {
	router, _ := walletWebhookFixture(t)
	walletWebhookOrder(t, model.PaymentProviderStripe, "query-owned-1")
	walletWebhookOrder(t, model.PaymentProviderStripe, "query-owned-2")
	other := &model.TopUp{UserId: 901, Amount: 100, Money: 100, TradeNo: "query-other-1", PaymentMethod: model.PaymentMethodStripe, PaymentProvider: model.PaymentProviderStripe, Status: common.TopUpStatusPending}
	require.NoError(t, other.Insert())
	router.GET("/history/user", func(c *gin.Context) { c.Set("id", 902) }, GetUserTopUps)
	router.GET("/history/admin", GetAllTopUps)
	for _, route := range []struct {
		name, path, keyword, wantTrade string
		wantTotal                      int
	}{
		{"user", "/history/user", "", "query-owned-1", 2},
		{"user_search", "/history/user", "query%", "query-owned-1", 2},
		{"admin", "/history/admin", "", "query-owned-2", 3},
		{"admin_search", "/history/admin", "query-owned%", "query-owned-1", 2},
	} {
		t.Run(route.name, func(t *testing.T) {
			for _, query := range []string{"p=-1&page_size=1", "p=1&page_size=-1", "p=1&ps=-1", "p=1&size=-1", "p=2147483649&page_size=100", "p=9223372036854775807&page_size=100", "cancel_before_request", "cancel_after_count"} {
				t.Run(query, func(t *testing.T) {
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					if query == "cancel_before_request" {
						cancel()
					}
					if query == "cancel_after_count" {
						require.NoError(t, model.DB.Callback().Query().After("gorm:query").Register("test:topup_cancel_after_count", func(tx *gorm.DB) {
							if tx.Statement.Table == "top_ups" && strings.Contains(strings.ToLower(tx.Statement.SQL.String()), "count(") {
								cancel()
							}
						}))
						defer func() { require.NoError(t, model.DB.Callback().Query().Remove("test:topup_cancel_after_count")) }()
					}
					request := httptest.NewRequest(http.MethodGet, route.path+"?"+query+"&keyword="+url.QueryEscape(route.keyword), nil).WithContext(ctx)
					recorder := httptest.NewRecorder()
					router.ServeHTTP(recorder, request)
					var response struct{ Success bool }
					require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
					assert.False(t, response.Success, recorder.Body.String())
					assert.NotContains(t, recorder.Body.String(), "query-owned-")
					assert.NotContains(t, recorder.Body.String(), "query-other-")
				})
			}
			// A subsequent request must still use the connection successfully;
			// aliases retain ordinary pagination, search and user isolation.
			for _, sizeName := range []string{"page_size", "ps", "size"} {
				recorder := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodGet, route.path+"?p=2&"+sizeName+"=1&keyword="+url.QueryEscape(route.keyword), nil)
				router.ServeHTTP(recorder, request)
				var response struct {
					Success bool
					Data    struct {
						Total int
						Items []model.TopUp
					}
				}
				require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
				require.True(t, response.Success, recorder.Body.String())
				assert.Equal(t, route.wantTotal, response.Data.Total)
				require.Len(t, response.Data.Items, 1)
				assert.Equal(t, route.wantTrade, response.Data.Items[0].TradeNo)
				if strings.HasPrefix(route.name, "user") {
					assert.Equal(t, 902, response.Data.Items[0].UserId)
				}
			}
		})
	}
}

// Fail only the post-commit Redis finalization command before it reaches Redis.
// Capture/fencing, SQL commits, retries and the eventual Lua execution stay real.
type walletFinishFailureHook struct {
	fail    atomic.Bool
	blocked atomic.Int32
}

func (hook *walletFinishFailureHook) BeforeProcess(ctx context.Context, cmd redis.Cmder) (context.Context, error) {
	if hook.fail.Load() && cmd.Name() == "eval" && len(cmd.Args()) > 1 {
		if script, ok := cmd.Args()[1].(string); ok && strings.Contains(script, "local marker = redis.call(") {
			hook.blocked.Add(1)
			return ctx, errors.New("isolated post-commit Redis command not executed")
		}
	}
	return ctx, nil
}

func (*walletFinishFailureHook) AfterProcess(context.Context, redis.Cmder) error { return nil }
func (*walletFinishFailureHook) BeforeProcessPipeline(ctx context.Context, _ []redis.Cmder) (context.Context, error) {
	return ctx, nil
}
func (*walletFinishFailureHook) AfterProcessPipeline(context.Context, []redis.Cmder) error {
	return nil
}

func TestWalletCallbacksRetryPostCommitCacheFailure(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	for _, entry := range []string{model.PaymentProviderEpay, model.PaymentProviderStripe, model.PaymentProviderCreem, model.PaymentProviderWaffo, model.PaymentProviderWaffoPancake, "manual"} {
		t.Run(entry, func(t *testing.T) {
			router, keys := walletWebhookFixture(t)
			provider := entry
			if entry == "manual" {
				provider = model.PaymentProviderStripe
			}
			order := walletWebhookOrder(t, provider, "post-commit-cache-"+entry)
			client := redis.NewClient(&redis.Options{Addr: address, DB: 13, MaxRetries: -1})
			require.NoError(t, client.Ping(t.Context()).Err())
			cacheKey, fillKey := "user:902", "wallet:user:fill:902"
			count, err := client.Exists(t.Context(), cacheKey, fillKey).Result()
			require.NoError(t, err)
			require.Zero(t, count, "never overwrite another Redis fixture")
			oldClient, oldRedis := common.RDB, common.RedisEnabled
			common.RDB, common.RedisEnabled = client, true
			t.Cleanup(func() {
				common.RDB, common.RedisEnabled = oldClient, oldRedis
				assert.NoError(t, client.Del(context.Background(), cacheKey, fillKey).Err())
				assert.NoError(t, client.Close())
			})
			cache, err := model.GetUserCache(902)
			require.NoError(t, err)
			require.Equal(t, -10, cache.Quota)
			hook := &walletFinishFailureHook{}
			hook.fail.Store(true)
			client.AddHook(hook)
			for attempt := range 3 {
				request := walletWebhookRequest(t, keys, provider, order.TradeNo, "90", true)
				if entry == "manual" {
					request = httptest.NewRequest(http.MethodPost, "/manual", strings.NewReader(fmt.Sprintf(`{"trade_no":%q}`, order.TradeNo)))
					request.Header.Set("Content-Type", "application/json")
				}
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				wantSuccess := attempt > 0
				switch entry {
				case model.PaymentProviderEpay:
					if wantSuccess {
						assert.Equal(t, "success", response.Body.String())
					} else {
						assert.Equal(t, "fail", response.Body.String())
					}
				case model.PaymentProviderWaffo:
					if wantSuccess {
						assert.JSONEq(t, `{"message":"success"}`, response.Body.String())
					} else {
						assert.JSONEq(t, `{"message":"failed"}`, response.Body.String())
					}
					assert.True(t, waffoutils.Verify(response.Body.String(), response.Header().Get("X-SIGNATURE"), keys.PublicKey))
				case "manual":
					assert.Contains(t, response.Body.String(), fmt.Sprintf(`"success":%t`, wantSuccess))
				default:
					if wantSuccess {
						assert.Equal(t, http.StatusOK, response.Code)
					} else {
						assert.Equal(t, http.StatusInternalServerError, response.Code)
					}
				}
				var invitee, inviter model.User
				require.NoError(t, model.DB.First(&invitee, 902).Error)
				require.NoError(t, model.DB.First(&inviter, 901).Error)
				require.NoError(t, model.DB.First(order, order.Id).Error)
				assert.Equal(t, common.TopUpStatusSuccess, order.Status)
				assert.Equal(t, 990, invitee.Quota)
				assert.Equal(t, 107, inviter.AffQuota)
				assert.Equal(t, 111, inviter.AffHistoryQuota)
				var facts int64
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
				assert.EqualValues(t, 1, facts)
				cached, err := client.HGet(t.Context(), cacheKey, "Quota").Int()
				require.NoError(t, err)
				if wantSuccess {
					assert.Equal(t, 990, cached)
				} else {
					assert.Equal(t, -10, cached)
				}
				hook.fail.Store(false)
			}
			assert.EqualValues(t, 1, hook.blocked.Load())
			marker, err := client.HExists(t.Context(), cacheKey, fmt.Sprintf("WalletCredit:topup:%d", order.Id)).Result()
			require.NoError(t, err)
			assert.False(t, marker)
		})
	}
}

func TestWalletStripeProductQuantityQuoteAndFrozenCredit(t *testing.T) {
	for _, scenario := range []struct {
		display         string
		ratio, discount float64
	}{
		{operation_setting.QuotaDisplayTypeUSD, 1, 1},
		{operation_setting.QuotaDisplayTypeCNY, 0.5, 0.25},
		{operation_setting.QuotaDisplayTypeTokens, 2, 0.5},
	} {
		t.Run(scenario.display, func(t *testing.T) {
			router, keys := walletCheckoutFixture(t)
			oldPrice, oldPromotion := setting.StripeUnitPrice, setting.StripePromotionCodesEnabled
			oldOptions, oldBackend := common.OptionMap, stripe.GetBackend(stripe.APIBackend)
			setting.StripeUnitPrice, setting.StripePromotionCodesEnabled = 2.5, true
			common.OptionMap = make(map[string]string)
			common.QuotaPerUnit = 500000
			operation_setting.GetGeneralSetting().QuotaDisplayType = scenario.display
			operation_setting.GetPaymentSetting().AmountDiscount = map[int]float64{1: scenario.discount}
			require.NoError(t, common.UpdateTopupGroupRatioByJSONString(fmt.Sprintf(`{"default":%g}`, scenario.ratio)))
			t.Cleanup(func() {
				setting.StripeUnitPrice, setting.StripePromotionCodesEnabled = oldPrice, oldPromotion
				common.OptionMap = oldOptions
				stripe.SetBackend(stripe.APIBackend, oldBackend)
			})
			credit := int(500000 * scenario.ratio)
			require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 902).Update("quota", common.MaxWalletQuota-credit).Error)
			router.POST("/quote", func(c *gin.Context) { c.Set("id", 902) }, RequestStripeAmount)
			router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestStripePay)
			quote := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/quote", strings.NewReader(`{"amount":1}`))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(quote, request)
			assert.JSONEq(t, `{"message":"success","data":"2.50"}`, quote.Body.String(), "quantity is priced independently of wallet display, local group credit and preset discount")
			changed := false
			require.NoError(t, model.DB.Callback().Query().After("gorm:query").Register("test:stripe_unit_change", func(tx *gorm.DB) {
				if tx.Statement.Table == "users" && len(tx.Statement.Selects) == 1 && tx.Statement.Selects[0] == "quota" && !changed {
					changed = true
					assert.NoError(t, model.UpdateOption("QuotaPerUnit", "1000000"))
				}
			}))
			t.Cleanup(func() { assert.NoError(t, model.DB.Callback().Query().Remove("test:stripe_unit_change")) })
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				requests.Add(1)
				if err := request.ParseForm(); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				assert.Equal(t, "1", request.Form.Get("line_items[0][quantity]"))
				assert.Equal(t, "price_fixture", request.Form.Get("line_items[0][price]"))
				assert.Equal(t, "true", request.Form.Get("allow_promotion_codes"))
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"id":"cs_quantity_fixture","url":"https://checkout.example.invalid/quantity"}`)
			}))
			defer server.Close()
			stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{URL: stripe.String(server.URL), HTTPClient: server.Client(), MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false)}))
			recorder := httptest.NewRecorder()
			request = httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader(`{"amount":1,"payment_method":"stripe"}`))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(recorder, request)
			require.Contains(t, recorder.Body.String(), `"message":"success"`)
			require.True(t, changed)
			assert.EqualValues(t, 1, requests.Load())
			var orders []model.TopUp
			require.NoError(t, model.DB.Find(&orders).Error)
			require.Len(t, orders, 1)
			assert.EqualValues(t, 1, orders[0].Amount)
			assert.Equal(t, scenario.ratio, orders[0].Money, "preserve the historical Stripe wallet credit basis")
			require.NotNil(t, orders[0].CreditedQuota)
			assert.Equal(t, credit, *orders[0].CreditedQuota)
			for range 2 {
				callback := httptest.NewRecorder()
				router.ServeHTTP(callback, walletWebhookRequest(t, keys, model.PaymentProviderStripe, orders[0].TradeNo, "250", true))
				assert.Equal(t, http.StatusOK, callback.Code)
			}
			var invitee, inviter model.User
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			assert.Equal(t, common.MaxWalletQuota, invitee.Quota)
			assert.Equal(t, 7+credit/10, inviter.AffQuota)
			var facts []model.ReferralRebate
			require.NoError(t, model.DB.Find(&facts).Error)
			require.Len(t, facts, 1)
			assert.EqualValues(t, credit, facts[0].CreditedQuota)
			assert.EqualValues(t, credit/10, facts[0].RewardQuota)
		})
	}
}

func TestWalletCheckoutRequiresWebhookCredentialBeforeCreatingOrder(t *testing.T) {
	for _, channel := range []struct {
		name, provider string
		creemTestMode  bool
	}{
		{name: "stripe", provider: model.PaymentProviderStripe},
		{name: "creem_production", provider: model.PaymentProviderCreem},
		{name: "creem_test", provider: model.PaymentProviderCreem, creemTestMode: true},
	} {
		for _, credential := range []struct {
			name, value string
			configured  bool
		}{
			{name: "missing"},
			{name: "whitespace", value: " \t\n"},
			{name: "configured", value: "whsec_wallet_fixture", configured: true},
		} {
			t.Run(channel.name+"/"+credential.name, func(t *testing.T) {
				router, keys := walletCheckoutFixture(t)
				oldBackend, oldTransport := stripe.GetBackend(stripe.APIBackend), http.DefaultTransport
				t.Cleanup(func() {
					stripe.SetBackend(stripe.APIBackend, oldBackend)
					http.DefaultTransport = oldTransport
				})
				var requests atomic.Int32
				transport := walletCheckoutTransport(func(request *http.Request) (*http.Response, error) {
					requests.Add(1)
					response := "{\"id\":\"checkout_fixture\",\"url\":\"https://checkout.example.invalid/fixture\",\"checkout_url\":\"https://checkout.example.invalid/fixture\"}"
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(response))}, nil
				})
				http.DefaultTransport = transport
				stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{
					HTTPClient: &http.Client{Transport: transport}, MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false),
				}))
				handler, body := RequestStripePay, "{\"amount\":100,\"payment_method\":\"stripe\"}"
				if channel.provider == model.PaymentProviderStripe {
					setting.StripeWebhookSecret = credential.value
				} else {
					setting.CreemWebhookSecret, setting.CreemTestMode = credential.value, channel.creemTestMode
					setting.CreemProducts = "[{\"productId\":\"fixture\",\"price\":100,\"currency\":\"USD\",\"quota\":1000}]"
					handler, body = RequestCreemPay, "{\"product_id\":\"fixture\",\"payment_method\":\"creem\"}"
				}
				router.GET("/topup-info", GetTopUpInfo)
				infoRecorder := httptest.NewRecorder()
				router.ServeHTTP(infoRecorder, httptest.NewRequest(http.MethodGet, "/topup-info", nil))
				var info struct{ Data map[string]any }
				require.NoError(t, common.Unmarshal(infoRecorder.Body.Bytes(), &info))
				assert.Equal(t, credential.configured, info.Data["enable_"+channel.provider+"_topup"])

				router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, handler)
				request := httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				require.Equal(t, http.StatusOK, recorder.Code)
				var orders []model.TopUp
				require.NoError(t, model.DB.Find(&orders).Error)
				if !credential.configured {
					assert.Contains(t, recorder.Body.String(), "webhook is not configured")
					assert.NotContains(t, recorder.Body.String(), "https://checkout.example.invalid/fixture")
					assert.Zero(t, requests.Load(), "missing verification configuration must fail before any provider request")
					assert.Empty(t, orders, "no unprocessable pending checkout may be created")
				} else {
					require.Contains(t, recorder.Body.String(), "\"message\":\"success\"")
					require.Contains(t, recorder.Body.String(), "https://checkout.example.invalid/fixture")
					require.EqualValues(t, 1, requests.Load())
					require.Len(t, orders, 1)
					require.NotNil(t, orders[0].CreditedQuota)
					require.Equal(t, 1000, *orders[0].CreditedQuota)
					for range 2 {
						callback := httptest.NewRecorder()
						router.ServeHTTP(callback, walletWebhookRequest(t, keys, channel.provider, orders[0].TradeNo, "10000", true))
						require.Equal(t, http.StatusOK, callback.Code)
					}
					require.NoError(t, model.DB.First(&orders[0], orders[0].Id).Error)
					assert.Equal(t, common.TopUpStatusSuccess, orders[0].Status)
				}
				var user, inviter model.User
				require.NoError(t, model.DB.First(&user, 902).Error)
				require.NoError(t, model.DB.First(&inviter, 901).Error)
				var facts int64
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
				if credential.configured {
					assert.Equal(t, 990, user.Quota)
					assert.Equal(t, 107, inviter.AffQuota)
					assert.Equal(t, 111, inviter.AffHistoryQuota)
					assert.EqualValues(t, 1, facts)
				} else {
					assert.Equal(t, -10, user.Quota)
					assert.Equal(t, 7, inviter.AffQuota)
					assert.Equal(t, 11, inviter.AffHistoryQuota)
					assert.Zero(t, facts)
				}
			})
		}
	}
}

func TestWalletStripeQuoteUsesCheckoutCreditRounding(t *testing.T) {
	for _, remaining := range []int{2833330, 2833329} {
		t.Run(fmt.Sprint(remaining), func(t *testing.T) {
			router, keys := walletCheckoutFixture(t)
			oldPrice, oldBackend := setting.StripeUnitPrice, stripe.GetBackend(stripe.APIBackend)
			setting.StripeUnitPrice = 2.5
			t.Cleanup(func() { setting.StripeUnitPrice = oldPrice; stripe.SetBackend(stripe.APIBackend, oldBackend) })
			common.QuotaPerUnit = 500000
			require.NoError(t, common.UpdateTopupGroupRatioByJSONString("{\"default\":0.333333}"))
			require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 902).Update("quota", common.MaxWalletQuota-remaining).Error)
			router.POST("/quote", func(c *gin.Context) { c.Set("id", 902) }, RequestStripeAmount)
			router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestStripePay)
			var externalRequests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				externalRequests.Add(1)
				if err := request.ParseForm(); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				assert.Equal(t, "17", request.Form.Get("line_items[0][quantity]"))
				assert.Equal(t, "price_fixture", request.Form.Get("line_items[0][price]"))
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, "{\"id\":\"cs_rounding_fixture\",\"url\":\"https://checkout.example.invalid/rounding\"}")
			}))
			defer server.Close()
			stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{URL: stripe.String(server.URL), HTTPClient: server.Client(), MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false)}))
			quote := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/quote", strings.NewReader("{\"amount\":17}"))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(quote, request)
			checkout := httptest.NewRecorder()
			request = httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader("{\"amount\":17,\"payment_method\":\"stripe\"}"))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(checkout, request)
			var orders []model.TopUp
			require.NoError(t, model.DB.Find(&orders).Error)
			if remaining == 2833329 {
				assert.Contains(t, quote.Body.String(), "Top-up quota limit exceeded")
				assert.Contains(t, checkout.Body.String(), "Top-up quota limit exceeded")
				assert.Zero(t, externalRequests.Load())
				assert.Empty(t, orders)
				return
			}
			assert.JSONEq(t, "{\"message\":\"success\",\"data\":\"42.50\"}", quote.Body.String(), "a quote must accept the same frozen credit that checkout uses")
			require.Contains(t, checkout.Body.String(), "\"message\":\"success\"")
			require.EqualValues(t, 1, externalRequests.Load())
			require.Len(t, orders, 1)
			require.NotNil(t, orders[0].CreditedQuota)
			assert.Equal(t, 2833330, *orders[0].CreditedQuota, "preserve the existing Stripe float multiplication and final integer rounding")
			for range 2 {
				callback := httptest.NewRecorder()
				router.ServeHTTP(callback, walletWebhookRequest(t, keys, model.PaymentProviderStripe, orders[0].TradeNo, "4250", true))
				assert.Equal(t, http.StatusOK, callback.Code)
			}
			var invitee, inviter model.User
			require.NoError(t, model.DB.First(&invitee, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			assert.Equal(t, common.MaxWalletQuota, invitee.Quota)
			assert.Equal(t, 283340, inviter.AffQuota)
			var facts []model.ReferralRebate
			require.NoError(t, model.DB.Find(&facts).Error)
			require.Len(t, facts, 1)
			assert.EqualValues(t, 2833330, facts[0].CreditedQuota)
			assert.EqualValues(t, 283333, facts[0].RewardQuota)
			t.Logf("quote=%s frozen_credit=%d wallet=%d rebate=%d facts=%d", quote.Body.String(), *orders[0].CreditedQuota, invitee.Quota, facts[0].RewardQuota, len(facts))
		})
	}
}

func TestWalletStripeRejectsNonFiniteCreditBeforeCheckout(t *testing.T) {
	router, _ := walletCheckoutFixture(t)
	oldBackend := stripe.GetBackend(stripe.APIBackend)
	t.Cleanup(func() { stripe.SetBackend(stripe.APIBackend, oldBackend) })
	var externalRequests atomic.Int32
	transport := walletCheckoutTransport(func(*http.Request) (*http.Response, error) {
		externalRequests.Add(1)
		return nil, errors.New("unexpected provider request for invalid credit")
	})
	stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{HTTPClient: &http.Client{Transport: transport}, MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false)}))
	require.NoError(t, common.UpdateTopupGroupRatioByJSONString("{\"default\":1e308}"))
	common.QuotaPerUnit = 500000
	router.POST("/quote", func(c *gin.Context) { c.Set("id", 902) }, RequestStripeAmount)
	router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestStripePay)
	for _, path := range []string{"/quote", "/checkout"} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{\"amount\":17,\"payment_method\":\"stripe\"}"))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			if assert.NotPanics(t, func() { router.ServeHTTP(response, request) }) {
				assert.Equal(t, http.StatusOK, response.Code)
				assert.Contains(t, response.Body.String(), "Top-up quota exceeds the range the system can represent")
			}
			var orders int64
			require.NoError(t, model.DB.Model(&model.TopUp{}).Count(&orders).Error)
			assert.Zero(t, orders)
			assert.Zero(t, externalRequests.Load())
		})
	}
}

// Quote endpoints must not reject the one-cent boundary accepted by the
// checkout endpoints. Provider-specific quantities and credit remain unchanged.
func TestWalletCheckoutMinimumChargeQuoteMatchesCheckout(t *testing.T) {
	for _, provider := range []string{model.PaymentProviderEpay, model.PaymentProviderStripe, model.PaymentProviderWaffo, model.PaymentProviderWaffoPancake} {
		t.Run(provider, func(t *testing.T) {
			router, keys := walletCheckoutFixture(t)
			oldStripePrice, oldWaffoPrice := setting.StripeUnitPrice, setting.WaffoUnitPrice
			oldWaffoMin := setting.WaffoMinTopUp
			t.Cleanup(func() {
				setting.StripeUnitPrice, setting.WaffoUnitPrice = oldStripePrice, oldWaffoPrice
				setting.WaffoMinTopUp = oldWaffoMin
			})
			setting.WaffoMinTopUp = 1
			handler := RequestAmount
			switch provider {
			case model.PaymentProviderStripe:
				handler = RequestStripeAmount
			case model.PaymentProviderWaffo:
				handler = RequestWaffoAmount
			case model.PaymentProviderWaffoPancake:
				handler = RequestWaffoPancakeAmount
			}
			router.POST("/quote", func(c *gin.Context) { c.Set("id", 902) }, handler)
			for _, price := range []float64{0.009, 0.01} {
				operation_setting.Price, setting.StripeUnitPrice = price, price
				setting.WaffoUnitPrice, setting.WaffoPancakeUnitPrice = price, price
				request := httptest.NewRequest(http.MethodPost, "/quote", strings.NewReader(`{"amount":1}`))
				request.Header.Set("Content-Type", "application/json")
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				if price < 0.01 {
					assert.Contains(t, recorder.Body.String(), `"message":"error"`)
				} else {
					assert.JSONEq(t, `{"message":"success","data":"0.01"}`, recorder.Body.String())
				}
			}
			var count int64
			require.NoError(t, model.DB.Model(&model.TopUp{}).Count(&count).Error)
			assert.Zero(t, count, "quoting cannot create a payment order")
			t.Run("finite_price_overflow", func(t *testing.T) {
				oldOptions, oldClient := common.OptionMap, http.DefaultClient
				oldWaffoKey := setting.WaffoPrivateKey
				common.OptionMap = make(map[string]string)
				t.Cleanup(func() {
					common.OptionMap, http.DefaultClient = oldOptions, oldClient
					setting.WaffoPrivateKey = oldWaffoKey
					operation_setting.Price, setting.StripeUnitPrice, setting.WaffoUnitPrice, setting.WaffoPancakeUnitPrice = 0.01, 0.01, 0.01, 0.01
				})
				key, checkout := "Price", RequestEpay
				paths := []string{"/quote", "/overflow-checkout"}
				if provider == model.PaymentProviderStripe {
					key = "StripeUnitPrice"
					// StripeUnitPrice is a display quote; checkout uses the configured product quantity.
					paths = paths[:1]
				} else if provider == model.PaymentProviderWaffo {
					key, checkout = "WaffoUnitPrice", RequestWaffoPay
					// The SDK owns its transport. This offline guard only applies
					// if the regression reaches construction after creating an order.
					setting.WaffoPrivateKey = "invalid-local-fixture-key"
				} else if provider == model.PaymentProviderWaffoPancake {
					key, checkout = "WaffoPancakeUnitPrice", RequestWaffoPancakePay
				}
				// The configuration itself is finite and permitted; only the
				// amount * price result is outside the payment representation.
				require.NoError(t, model.UpdateOption(key, "1e308"))
				var externalRequests atomic.Int32
				http.DefaultClient = &http.Client{Transport: walletCheckoutTransport(func(*http.Request) (*http.Response, error) {
					externalRequests.Add(1)
					return nil, errors.New("unexpected external request for overflowing payment")
				})}
				router.POST("/overflow-checkout", func(c *gin.Context) { c.Set("id", 902) }, checkout)
				for _, path := range paths {
					request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"amount":100,"payment_method":"alipay"}`))
					request.Header.Set("Content-Type", "application/json")
					response := httptest.NewRecorder()
					assert.NotPanics(t, func() { router.ServeHTTP(response, request) })
					assert.Contains(t, response.Body.String(), `"message":"error"`)
					assert.Contains(t, response.Body.String(), "Invalid top-up amount")
				}
				require.NoError(t, model.DB.Model(&model.TopUp{}).Count(&count).Error)
				assert.Zero(t, count)
				assert.Zero(t, externalRequests.Load())
			})
			if provider != model.PaymentProviderEpay {
				return
			}
			// Epay prepares/signs checkout locally. Verify the same minimum through
			// its actual checkout and callback without making an external payment.
			router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestEpay)
			request := httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader(`{"amount":1,"payment_method":"alipay"}`))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			assert.Contains(t, recorder.Body.String(), `"message":"success"`)
			var order model.TopUp
			require.NoError(t, model.DB.First(&order).Error)
			assert.Equal(t, 0.01, order.Money)
			require.NotNil(t, order.CreditedQuota)
			assert.Equal(t, 10, *order.CreditedQuota)
			for range 2 {
				recorder = httptest.NewRecorder()
				router.ServeHTTP(recorder, walletWebhookRequest(t, keys, provider, order.TradeNo, "0.01", true))
				assert.Equal(t, "success", recorder.Body.String())
			}
			var buyer, inviter model.User
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			assert.Zero(t, buyer.Quota)
			assert.Equal(t, 8, inviter.AffQuota)
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&count).Error)
			assert.EqualValues(t, 1, count)
		})
	}
}

func TestWalletWaffoFrozenMerchantGuardsSignedNotifications(t *testing.T) {
	for _, tc := range []struct {
		name          string
		merchant      string
		orderStatus   string
		legacy        bool
		lookupFailure bool
		wantStatus    string
		wantMessage   string
	}{
		{name: "different_merchant_paid", merchant: "merchant_other", orderStatus: "PAY_SUCCESS", wantStatus: common.TopUpStatusPending, wantMessage: "failed"},
		{name: "different_merchant_closed", merchant: "merchant_other", orderStatus: "ORDER_CLOSE", wantStatus: common.TopUpStatusPending, wantMessage: "failed"},
		{name: "frozen_merchant_after_config_change", merchant: "merchant_at_checkout", orderStatus: "PAY_SUCCESS", wantStatus: common.TopUpStatusSuccess, wantMessage: "success"},
		{name: "frozen_merchant_close_after_config_change", merchant: "merchant_at_checkout", orderStatus: "ORDER_CLOSE", wantStatus: common.TopUpStatusFailed, wantMessage: "success"},
		{name: "legacy_without_snapshot", merchant: "merchant_at_checkout", orderStatus: "PAY_SUCCESS", legacy: true, wantStatus: common.TopUpStatusSuccess, wantMessage: "success"},
		{name: "notification_without_merchant", orderStatus: "PAY_SUCCESS", wantStatus: common.TopUpStatusSuccess, wantMessage: "success"},
		{name: "lookup_failure_is_retryable", merchant: "merchant_at_checkout", orderStatus: "PAY_SUCCESS", lookupFailure: true, wantStatus: common.TopUpStatusPending, wantMessage: "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router, keys := walletWebhookFixture(t)
			oldMerchant := setting.WaffoMerchantId
			setting.WaffoMerchantId = "merchant_after_config_change"
			t.Cleanup(func() { setting.WaffoMerchantId = oldMerchant })
			order := walletWebhookOrder(t, model.PaymentProviderWaffo, "merchant_bound_order")
			if !tc.legacy {
				require.NoError(t, model.DB.Model(order).Update("waffo_merchant_id", "merchant_at_checkout").Error)
			}
			result := map[string]any{"merchantOrderId": order.TradeNo, "paymentRequestId": order.TradeNo, "orderStatus": tc.orderStatus, "orderAmount": "90.00", "orderCurrency": "USD"}
			if tc.merchant != "" {
				result["merchantInfo"] = map[string]any{"merchantId": tc.merchant}
			}
			payload := map[string]any{"eventType": "PAYMENT_NOTIFICATION", "result": result}
			callbackName := "test:waffo_merchant_lookup_failure"
			if tc.lookupFailure {
				require.NoError(t, model.DB.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
					if tx.Statement.Table == "top_ups" {
						tx.AddError(errors.New("injected topup merchant lookup outage"))
					}
				}))
			}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderWaffo, payload))
			if tc.lookupFailure {
				require.NoError(t, model.DB.Callback().Query().Remove(callbackName))
			}
			assert.Equal(t, http.StatusOK, recorder.Code)
			assert.JSONEq(t, fmt.Sprintf(`{"message":%q}`, tc.wantMessage), recorder.Body.String())
			assert.True(t, waffoutils.Verify(recorder.Body.String(), recorder.Header().Get("X-SIGNATURE"), keys.PublicKey))
			var persisted model.TopUp
			require.NoError(t, model.DB.First(&persisted, order.Id).Error)
			assert.Equal(t, tc.wantStatus, persisted.Status)
			if !tc.legacy {
				require.NotNil(t, persisted.WaffoMerchantID)
				assert.Equal(t, "merchant_at_checkout", *persisted.WaffoMerchantID)
			}
			var buyer, inviter model.User
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			var facts int64
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			if tc.wantStatus == common.TopUpStatusSuccess {
				assert.Equal(t, 990, buyer.Quota)
				assert.Equal(t, 107, inviter.AffQuota)
				assert.EqualValues(t, 1, facts)
			} else {
				assert.Equal(t, -10, buyer.Quota)
				assert.Equal(t, 7, inviter.AffQuota)
				assert.Zero(t, facts)
			}
			// Retrying an accepted order or a failed lookup must not credit twice.
			if tc.wantStatus == common.TopUpStatusSuccess || tc.lookupFailure {
				for range 2 {
					recorder = httptest.NewRecorder()
					router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderWaffo, payload))
					assert.JSONEq(t, `{"message":"success"}`, recorder.Body.String())
				}
				require.NoError(t, model.DB.First(&buyer, 902).Error)
				require.NoError(t, model.DB.First(&inviter, 901).Error)
				assert.Equal(t, 990, buyer.Quota)
				assert.Equal(t, 107, inviter.AffQuota)
				require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
				assert.EqualValues(t, 1, facts)
			}
			encoded, err := common.Marshal(persisted)
			require.NoError(t, err)
			assert.NotContains(t, string(encoded), "merchant_at_checkout", "the private settlement snapshot must not be added to public topup records")
		})
	}
}

// Creem's documented checkout OrderEntity requires amount but makes
// amount_paid optional (docs.creem.io/api-reference/endpoint/get-checkout).
// Exercise the actual signed HTTP handler and assert
// durable principal/rebate facts; a valid amount alone never proves payment.
func TestWalletCreemOptionalPaidAmountPreservesDocumentedCheckout(t *testing.T) {
	for _, tc := range []struct {
		name             string
		amounts          map[string]any
		status           string
		invalidSignature bool
		wantSuccess      bool
	}{
		{name: "documented_order_amount", amounts: map[string]any{"amount": 9000}, wantSuccess: true},
		{name: "existing_paid_amount", amounts: map[string]any{"amount_paid": 9000}, wantSuccess: true},
		{name: "explicit_free_paid_order", amounts: map[string]any{"amount": 0}, wantSuccess: true},
		{name: "paid_amount_zero_with_discount", amounts: map[string]any{"amount": 9000, "amount_paid": 0}, wantSuccess: true},
		{name: "missing_both_amounts"},
		{name: "null_both_amounts", amounts: map[string]any{"amount": nil, "amount_paid": nil}},
		{name: "negative_order_amount", amounts: map[string]any{"amount": -1}},
		{name: "negative_paid_amount_does_not_fall_back", amounts: map[string]any{"amount": 9000, "amount_paid": -1}},
		{name: "malformed_paid_amount_does_not_fall_back", amounts: map[string]any{"amount": 9000, "amount_paid": "invalid"}},
		{name: "fractional_paid_amount_does_not_fall_back", amounts: map[string]any{"amount": 9000, "amount_paid": 0.5}},
		{name: "overflow_paid_amount_does_not_fall_back", amounts: map[string]any{"amount": 9000, "amount_paid": json.Number("9223372036854775808")}},
		{name: "malformed_order_amount", amounts: map[string]any{"amount": "invalid"}},
		{name: "fractional_order_amount", amounts: map[string]any{"amount": 0.5}},
		{name: "overflow_order_amount", amounts: map[string]any{"amount": json.Number("9223372036854775808")}},
		{name: "unpaid_order_amount", amounts: map[string]any{"amount": 9000}, status: "pending"},
		{name: "invalid_signature", amounts: map[string]any{"amount": 9000}, invalidSignature: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router, keys := walletWebhookFixture(t)
			topUp := walletWebhookOrder(t, model.PaymentProviderCreem, "creem-optional-amount-paid")
			order := map[string]any{
				"id": "ord_documented", "mode": "test", "object": "order", "product": "prod_documented",
				"currency": "USD", "status": "paid", "type": "onetime",
				"created_at": "2026-10-20T00:00:00Z", "updated_at": "2026-10-20T00:00:00Z",
			}
			if tc.status != "" {
				order["status"] = tc.status
			}
			for key, value := range tc.amounts {
				order[key] = value
			}
			payload := map[string]any{
				"id": "evt_documented_optional_amount_paid", "eventType": "checkout.completed", "created_at": time.Now().UnixMilli(),
				"object": map[string]any{
					"id": "ch_documented", "mode": "test", "object": "checkout", "status": "completed", "request_id": topUp.TradeNo, "order": order,
					"product": map[string]any{
						"id": "prod_documented", "mode": "test", "object": "product", "name": "Wallet credits", "description": "Wallet credits",
						"price": 9000, "currency": "USD", "billing_type": "onetime", "billing_period": "once", "status": "active", "tax_mode": "inclusive", "tax_category": "saas",
						"created_at": "2026-10-20T00:00:00Z", "updated_at": "2026-10-20T00:00:00Z",
					},
				},
			}
			request := signedWalletWebhookRequest(t, keys, model.PaymentProviderCreem, payload)
			if tc.invalidSignature {
				request.Header.Set(CreemSignatureHeader, "invalid")
			}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if tc.wantSuccess {
				require.Equal(t, http.StatusOK, recorder.Code)
				// The optional amount is validation/logging only. It must neither
				// reprice the frozen 1000 quota nor change the 100 quota rebate.
				common.QuotaPerUnit = 20
				replay := httptest.NewRecorder()
				router.ServeHTTP(replay, signedWalletWebhookRequest(t, keys, model.PaymentProviderCreem, payload))
				assert.Equal(t, http.StatusOK, replay.Code)
				require.NoError(t, model.ManualCompleteTopUp(topUp.TradeNo, "127.0.0.1"))
			} else if tc.status == "pending" {
				assert.Equal(t, http.StatusOK, recorder.Code)
			} else {
				assert.GreaterOrEqual(t, recorder.Code, http.StatusBadRequest)
			}
			var buyer, inviter model.User
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			require.NoError(t, model.DB.First(topUp, topUp.Id).Error)
			var facts []model.ReferralRebate
			require.NoError(t, model.DB.Find(&facts).Error)
			if tc.wantSuccess {
				assert.Equal(t, 990, buyer.Quota)
				assert.Equal(t, 107, inviter.AffQuota)
				assert.Equal(t, 111, inviter.AffHistoryQuota)
				assert.Equal(t, common.TopUpStatusSuccess, topUp.Status)
				require.Len(t, facts, 1)
				assert.EqualValues(t, 1000, facts[0].CreditedQuota)
				assert.EqualValues(t, 100, facts[0].RewardQuota)
			} else {
				assert.Equal(t, -10, buyer.Quota)
				assert.Equal(t, 7, inviter.AffQuota)
				assert.Equal(t, 11, inviter.AffHistoryQuota)
				assert.Equal(t, common.TopUpStatusPending, topUp.Status)
				assert.Zero(t, topUp.CompleteTime)
				assert.Empty(t, facts)
			}
		})
	}

	t.Run("subscription_dispatch_unchanged", func(t *testing.T) {
		router, keys := walletWebhookFixture(t)
		sqlDB, err := model.DB.DB()
		require.NoError(t, err)
		sqlDB.SetMaxOpenConns(2)
		require.NoError(t, model.DB.AutoMigrate(&model.SubscriptionPlan{}, &model.UserSubscription{}))
		plan := model.SubscriptionPlan{Id: 904, Title: "Creem dispatch fixture", PriceAmount: 100, Enabled: true, DurationUnit: model.SubscriptionDurationMonth, DurationValue: 1}
		require.NoError(t, model.DB.Create(&plan).Error)
		model.InvalidateSubscriptionPlanCache(plan.Id)
		t.Cleanup(func() { model.InvalidateSubscriptionPlanCache(plan.Id) })
		_, err = model.GetSubscriptionPlanById(plan.Id)
		require.NoError(t, err)
		order := model.SubscriptionOrder{UserId: 902, PlanId: plan.Id, TradeNo: "creem-subscription-dispatch", PaymentProvider: model.PaymentProviderCreem, PaymentMethod: model.PaymentMethodCreem, Status: common.TopUpStatusPending}
		require.NoError(t, model.DB.Create(&order).Error)
		payload := map[string]any{"id": "evt_subscription", "eventType": "checkout.completed", "object": map[string]any{
			"request_id": order.TradeNo, "order": map[string]any{"id": "ord_subscription", "amount": 9000, "status": "paid", "type": "recurring", "currency": "USD"},
		}}
		for range 2 {
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, signedWalletWebhookRequest(t, keys, model.PaymentProviderCreem, payload))
			require.Equal(t, http.StatusOK, recorder.Code)
		}
		require.NoError(t, model.DB.First(&order, order.Id).Error)
		assert.Equal(t, common.TopUpStatusSuccess, order.Status)
		var subscriptions, rebates int64
		require.NoError(t, model.DB.Model(&model.UserSubscription{}).Count(&subscriptions).Error)
		assert.EqualValues(t, 1, subscriptions)
		require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&rebates).Error)
		assert.Zero(t, rebates)
		var buyer, inviter model.User
		require.NoError(t, model.DB.First(&buyer, 902).Error)
		require.NoError(t, model.DB.First(&inviter, 901).Error)
		assert.Equal(t, -10, buyer.Quota)
		assert.Equal(t, 7, inviter.AffQuota)
	})
}

func TestWalletPricingFailedSaveRetainsLastValidPrice(t *testing.T) {
	for _, scenario := range []struct {
		name, key, initial, value string
		failWrite                 bool
	}{
		{name: "invalid_json", value: `{"default":0.2`},
		{name: "partially_decodable", value: `{"default":0.2,"vip":"invalid"}`},
		{name: "database_write_fails", value: `{"default":0.2}`, failWrite: true},
		{name: "epay_price_database_write_fails", key: "Price", initial: "2", value: "0.2", failWrite: true},
		{name: "conversion_database_write_fails", key: "QuotaPerUnit", initial: "10", value: "100", failWrite: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			key, initialValue := scenario.key, scenario.initial
			if key == "" {
				key, initialValue = "TopupGroupRatio", `{"default":2}`
			}
			router, keys := walletCheckoutFixture(t)
			require.NoError(t, model.DB.AutoMigrate(&model.UserSession{}, &model.AuditLog{}, &model.UserAccessToken{}))
			oldOptions := common.OptionMap
			common.OptionMap = make(map[string]string)
			t.Cleanup(func() { common.OptionMap = oldOptions })
			require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 901).Updates(map[string]any{"role": common.RoleRootUser, "auth_version": 1, "group": "default"}).Error)
			require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 902).Updates(map[string]any{"role": common.RoleCommonUser, "auth_version": 1, "group": "default"}).Error)
			_, rootToken := createAccessTokenTestSession(t, 901, "topup-ratio-root")
			_, userToken := createAccessTokenTestSession(t, 902, "topup-ratio-user")
			router.PUT("/api/option/", middleware.RootAuth(), UpdateOption)
			router.POST("/api/user/amount", middleware.DisableCache(), middleware.UserAuth(), RequestAmount)
			router.POST("/api/user/pay", middleware.DisableCache(), middleware.UserAuth(), RequestEpay)
			initialBody, err := common.Marshal(map[string]string{"key": key, "value": initialValue})
			require.NoError(t, err)
			denied := accessTokenRequest(router, http.MethodPut, "/api/option/", userToken, "", string(initialBody))
			require.Equal(t, http.StatusForbidden, denied.Code, denied.Body.String())
			initial := accessTokenRequest(router, http.MethodPut, "/api/option/", rootToken, "", string(initialBody))
			require.Contains(t, initial.Body.String(), `"success":true`)
			wantPrice, wantQuote, wantMoney := 2.0, `"data":"200.00"`, 200.0
			if key == "QuotaPerUnit" {
				wantPrice, wantQuote, wantMoney = 10, `"data":"100.00"`, 100
			}
			before := accessTokenRequest(router, http.MethodPost, "/api/user/amount", userToken, "", `{"amount":100}`)
			require.Contains(t, before.Body.String(), wantQuote)
			var failures atomic.Int32
			if scenario.failWrite {
				require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register("fixture:topup_ratio_write_failure", func(tx *gorm.DB) {
					if tx.Statement.Table == "options" {
						failures.Add(1)
						tx.AddError(errors.New("isolated TopupGroupRatio write failure"))
					}
				}))
				t.Cleanup(func() { _ = model.DB.Callback().Update().Remove("fixture:topup_ratio_write_failure") })
			}
			failedBody, err := common.Marshal(map[string]string{"key": key, "value": scenario.value})
			require.NoError(t, err)
			response := accessTokenRequest(router, http.MethodPut, "/api/option/", rootToken, "", string(failedBody))
			if scenario.failWrite {
				require.EqualValues(t, 1, failures.Load())
				require.NoError(t, model.DB.Callback().Update().Remove("fixture:topup_ratio_write_failure"))
			}
			if !scenario.failWrite {
				// Option reloads use this parser directly, so a failed parse must
				// also leave the last complete effective price intact.
				require.Error(t, common.UpdateTopupGroupRatioByJSONString(scenario.value))
				assert.Equal(t, 2.0, common.GetTopupGroupRatio("default"))
			}
			var stored model.Option
			require.NoError(t, model.DB.Where(&model.Option{Key: key}).First(&stored).Error)
			quoted := accessTokenRequest(router, http.MethodPost, "/api/user/amount", userToken, "", `{"amount":100}`)
			checkout := accessTokenRequest(router, http.MethodPost, "/api/user/pay", userToken, "", `{"amount":100,"payment_method":"alipay"}`)
			require.Contains(t, checkout.Body.String(), `"message":"success"`)
			var order model.TopUp
			require.NoError(t, model.DB.First(&order).Error)
			effectivePrice := common.GetTopupGroupRatio("default")
			if key == "Price" {
				effectivePrice = operation_setting.Price
			} else if key == "QuotaPerUnit" {
				effectivePrice = common.QuotaPerUnit
			}
			t.Logf("observed save_response=%s persisted=%q effective_ratio=%v quote=%s order_money=%v credited_quota=%v", response.Body.String(), stored.Value, effectivePrice, quoted.Body.String(), order.Money, *order.CreditedQuota)
			assert.Contains(t, response.Body.String(), `"success":false`, "failed persistence must not claim success")
			assert.Equal(t, initialValue, stored.Value, "failed validation/write must retain durable previous pricing")
			assert.Equal(t, wantPrice, effectivePrice, "failed save must preserve effective pricing")
			assert.Contains(t, quoted.Body.String(), wantQuote)
			assert.Equal(t, wantMoney, order.Money)
			require.Equal(t, 1000, *order.CreditedQuota)
			paid := httptest.NewRecorder()
			router.ServeHTTP(paid, walletWebhookRequest(t, keys, model.PaymentProviderEpay, order.TradeNo, strconv.FormatFloat(order.Money, 'f', 2, 64), true))
			require.Equal(t, "success", paid.Body.String())
			var buyer, inviter model.User
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			require.NoError(t, model.DB.First(&order, order.Id).Error)
			t.Logf("after local signed notification: charged=%v wallet=%d inviter_reward=%d status=%s", order.Money, buyer.Quota, inviter.AffQuota, order.Status)
			assert.Equal(t, 990, buyer.Quota)
			assert.Equal(t, 107, inviter.AffQuota)
			assert.Equal(t, common.TopUpStatusSuccess, order.Status)
		})
	}
}

func TestWalletTopupRatioSettingsPreserveDatabaseKeyAndValueContracts(t *testing.T) {
	router, _ := walletCheckoutFixture(t)
	require.NoError(t, model.DB.AutoMigrate(&model.UserSession{}, &model.AuditLog{}))
	previous := common.OptionMap
	common.OptionMap = make(map[string]string)
	t.Cleanup(func() { common.OptionMap = previous })
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 901).Updates(map[string]any{"role": common.RoleRootUser, "auth_version": 1, "group": "default"}).Error)
	_, credential := createAccessTokenTestSession(t, 901, "topup-ratio-settings-root")
	router.PUT("/api/option/", middleware.RootAuth(), UpdateOption)
	const ordinaryKey = "payment-regression-unrelated-option"
	for _, method := range []string{"single", "bulk"} {
		for _, key := range []string{"topupgroupratio", "TopupGroupRatio ", "TópupGroupRatio", "ＴopupGroupRatio"} {
			t.Run(method+"/"+key, func(t *testing.T) {
				require.NoError(t, model.UpdateOption("TopupGroupRatio", `{"default":2}`))
				require.NoError(t, model.UpdateOption(ordinaryKey, "before"))
				var matched model.Option
				lookup := model.DB.Where(&model.Option{Key: key}).First(&matched).Error
				require.True(t, lookup == nil || errors.Is(lookup, gorm.ErrRecordNotFound))
				protected := lookup == nil && matched.Key == "TopupGroupRatio"
				const malformed = `{"default":0.2,"vip":"invalid"}`
				if method == "single" {
					body, err := common.Marshal(map[string]string{"key": key, "value": malformed})
					require.NoError(t, err)
					response := accessTokenRequest(router, http.MethodPut, "/api/option/", credential, "", string(body))
					require.Equal(t, http.StatusOK, response.Code)
					if protected {
						assert.Contains(t, response.Body.String(), `"success":false`)
					} else {
						assert.Contains(t, response.Body.String(), `"success":true`)
					}
				} else {
					err := model.UpdateOptionsBulk(map[string]string{"TopupGroupRatio": `{"default":0.5}`, key: malformed, ordinaryKey: "after"})
					if protected {
						assert.Error(t, err)
					} else {
						require.NoError(t, err)
					}
				}
				var actual, ordinary model.Option
				require.NoError(t, model.DB.Where(&model.Option{Key: "TopupGroupRatio"}).First(&actual).Error)
				require.NoError(t, model.DB.Where(&model.Option{Key: ordinaryKey}).First(&ordinary).Error)
				expected, expectedRatio, expectedOrdinary := `{"default":2}`, 2.0, "before"
				if method == "bulk" && !protected {
					expected, expectedRatio, expectedOrdinary = `{"default":0.5}`, 0.5, "after"
				}
				assert.Equal(t, expected, actual.Value, "database-equivalent aliases cannot bypass recharge validation")
				assert.Equal(t, expectedRatio, common.GetTopupGroupRatio("default"))
				assert.Equal(t, expectedOrdinary, ordinary.Value, "alias rejection must leave the complete bulk write unchanged")
				assert.Equal(t, expectedOrdinary, common.OptionMap[ordinaryKey])
			})
		}
	}
	// This repair preserves the accepted recharge configuration policy. In
	// particular, null and an empty map still select the existing fallback.
	for _, value := range []string{"null", "{}", `{"default":0}`, `{"default":-1}`, `{"default":1.25}`} {
		t.Run("existing_value/"+value, func(t *testing.T) {
			body, err := common.Marshal(map[string]string{"key": "TopupGroupRatio", "value": value})
			require.NoError(t, err)
			response := accessTokenRequest(router, http.MethodPut, "/api/option/", credential, "", string(body))
			require.Contains(t, response.Body.String(), `"success":true`)
			var stored model.Option
			require.NoError(t, model.DB.Where(&model.Option{Key: "TopupGroupRatio"}).First(&stored).Error)
			assert.Equal(t, value, stored.Value)
			assert.JSONEq(t, value, common.TopupGroupRatio2JSONString())
			if value == "null" || value == "{}" {
				assert.Equal(t, 1.0, common.GetTopupGroupRatio("default"))
			}
		})
	}
}

func TestWalletTopupRatioFirstSaveAndHistoricalAliasReload(t *testing.T) {
	router, _ := walletCheckoutFixture(t)
	require.NoError(t, model.DB.AutoMigrate(&model.UserSession{}, &model.AuditLog{}))
	oldOptions := common.OptionMap
	common.OptionMap = make(map[string]string)
	t.Cleanup(func() { common.OptionMap = oldOptions })
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 901).Updates(map[string]any{"role": common.RoleRootUser, "auth_version": 1, "group": "default"}).Error)
	_, token := createAccessTokenTestSession(t, 901, "topup-first-key")
	router.PUT("/api/option/", middleware.RootAuth(), UpdateOption)
	const ordinaryKey = "topup-first-save-unrelated-option"
	for _, key := range []string{"topupgroupratio", "TopupGroupRatio ", "TópupGroupRatio", "ＴopupGroupRatio"} {
		t.Run(key, func(t *testing.T) {
			require.NoError(t, model.DB.Where(map[string]any{"key": []string{"TopupGroupRatio", key}}).Delete(&model.Option{}).Error)
			// Determine this fixture's real column equality independently of
			// the alias guard, then remove the row before the first request.
			require.NoError(t, model.DB.Create(&model.Option{Key: key, Value: `{"default":0.2}`}).Error)
			var matched model.Option
			lookup := model.DB.Where(&model.Option{Key: "TopupGroupRatio"}).First(&matched).Error
			require.True(t, lookup == nil || errors.Is(lookup, gorm.ErrRecordNotFound))
			equivalent := lookup == nil
			require.NoError(t, model.DB.Where(&model.Option{Key: key}).Delete(&model.Option{}).Error)
			body, err := common.Marshal(map[string]string{"key": key, "value": `{"default":0.2}`})
			require.NoError(t, err)
			response := accessTokenRequest(router, http.MethodPut, "/api/option/", token, "", string(body))
			if equivalent {
				assert.Contains(t, response.Body.String(), `"success":false`)
			} else {
				assert.Contains(t, response.Body.String(), `"success":true`)
			}
			var canonicalCount int64
			require.NoError(t, model.DB.Model(&model.Option{}).Where(&model.Option{Key: "TopupGroupRatio"}).Count(&canonicalCount).Error)
			assert.Zero(t, canonicalCount, "a first alias request cannot create an effective recharge configuration")

			// A pre-fix database may already contain the alias. An explicit,
			// valid canonical save must remain effective after normal startup.
			require.NoError(t, model.DB.Where(&model.Option{Key: key}).Delete(&model.Option{}).Error)
			require.NoError(t, model.DB.Create(&model.Option{Key: key, Value: `{"default":0.2}`}).Error)
			canonical, err := common.Marshal(map[string]string{"key": "TopupGroupRatio", "value": `{"default":2}`})
			require.NoError(t, err)
			saved := accessTokenRequest(router, http.MethodPut, "/api/option/", token, "", string(canonical))
			require.Contains(t, saved.Body.String(), `"success":true`)
			var stored model.Option
			require.NoError(t, model.DB.Where(&model.Option{Key: "TopupGroupRatio"}).First(&stored).Error)
			assert.Equal(t, "TopupGroupRatio", stored.Key)
			require.NoError(t, common.UpdateTopupGroupRatioByJSONString(`{"default":1}`))
			model.InitOptionMap()
			assert.Equal(t, 2.0, common.GetTopupGroupRatio("default"))

			// The entire first bulk save must also reject equivalent aliases,
			// regardless of map iteration order, without touching other keys.
			require.NoError(t, model.DB.Where(map[string]any{"key": []string{"TopupGroupRatio", key}}).Delete(&model.Option{}).Error)
			require.NoError(t, model.UpdateOption(ordinaryKey, "before"))
			require.NoError(t, common.UpdateTopupGroupRatioByJSONString(`{"default":1}`))
			err = model.UpdateOptionsBulk(map[string]string{"TopupGroupRatio": `{"default":2}`, key: `{"default":0.2,"vip":"invalid"}`, ordinaryKey: "after"})
			var ordinary model.Option
			require.NoError(t, model.DB.Where(&model.Option{Key: ordinaryKey}).First(&ordinary).Error)
			if equivalent {
				assert.Error(t, err)
				assert.Equal(t, "before", ordinary.Value)
				require.NoError(t, model.DB.Model(&model.Option{}).Where(&model.Option{Key: "TopupGroupRatio"}).Count(&canonicalCount).Error)
				assert.Zero(t, canonicalCount)
				assert.Equal(t, 1.0, common.GetTopupGroupRatio("default"))
			} else {
				require.NoError(t, err)
				assert.Equal(t, "after", ordinary.Value)
				assert.Equal(t, 2.0, common.GetTopupGroupRatio("default"))
			}
		})
	}
}

// Pause after a real commit releases its SQL connection, before the saving
// request can publish its price. This does not mock persistence or settlement.
type walletRatioCommitPool struct {
	gorm.ConnPool
	committed *atomic.Bool
	reached   chan struct{}
	release   chan struct{}
}

func (pool walletRatioCommitPool) BeginTx(ctx context.Context, options *sql.TxOptions) (gorm.ConnPool, error) {
	tx, err := pool.ConnPool.(gorm.TxBeginner).BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return &walletRatioCommitTx{Tx: tx, pool: pool}, nil
}

type walletRatioCommitTx struct {
	*sql.Tx
	pool walletRatioCommitPool
}

func (tx walletRatioCommitTx) Commit() error {
	if err := tx.Tx.Commit(); err != nil {
		return err
	}
	if tx.pool.committed.CompareAndSwap(false, true) {
		close(tx.pool.reached)
		<-tx.pool.release
	}
	return nil
}

func TestWalletPricingConcurrentSaveAndReloadKeepLatestPrice(t *testing.T) {
	for _, scenario := range []struct{ name, key, initial, latest string }{
		{"ratio/save_after_commit", "TopupGroupRatio", `{"default":0.2}`, `{"default":2}`},
		{"ratio/reload_after_read", "TopupGroupRatio", `{"default":0.2}`, `{"default":2}`},
		{"price/save_after_commit", "Price", "0.2", "2"},
		{"price/reload_after_read", "Price", "0.2", "2"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			router, keys := walletCheckoutFixture(t)
			oldOptions := common.OptionMap
			common.OptionMap = make(map[string]string)
			t.Cleanup(func() { common.OptionMap = oldOptions })
			require.NoError(t, model.UpdateOption(scenario.key, scenario.initial))
			reached, release := make(chan struct{}), make(chan struct{})
			var workers sync.WaitGroup
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
				workers.Wait()
			}()
			firstDone, laterDone := make(chan error, 1), make(chan error, 1)
			healthy := model.DB
			t.Cleanup(func() { model.DB = healthy })
			laterPreflight := make(chan struct{})
			var laterStarted, laterObserved atomic.Bool
			require.NoError(t, healthy.Callback().Query().After("gorm:after_query").Register("fixture:topup_ratio_preflight", func(tx *gorm.DB) {
				if tx.Statement.Table != "options" || !laterStarted.Load() {
					return
				}
				if _, ok := tx.Statement.Dest.(*int64); ok && laterObserved.CompareAndSwap(false, true) {
					close(laterPreflight)
				}
			}))
			t.Cleanup(func() { _ = healthy.Callback().Query().Remove("fixture:topup_ratio_preflight") })
			if strings.HasSuffix(scenario.name, "save_after_commit") {
				wrapped := healthy.Session(&gorm.Session{NewDB: true})
				wrapped.Statement = &gorm.Statement{DB: wrapped, Context: context.Background(), ConnPool: walletRatioCommitPool{
					ConnPool: healthy.Statement.ConnPool, committed: &atomic.Bool{}, reached: reached, release: release,
				}}
				model.DB = wrapped
				workers.Go(func() { firstDone <- model.UpdateOption(scenario.key, scenario.initial) })
			} else {
				var blocked atomic.Bool
				require.NoError(t, model.DB.Callback().Query().After("gorm:after_query").Register("fixture:topup_ratio_reload", func(tx *gorm.DB) {
					if tx.Statement.Table != "options" {
						return
					}
					if _, ok := tx.Statement.Dest.(*[]*model.Option); ok && blocked.CompareAndSwap(false, true) {
						close(reached)
						<-release
					}
				}))
				t.Cleanup(func() { _ = healthy.Callback().Query().Remove("fixture:topup_ratio_reload") })
				// InitOptionMap uses the same database reload as SyncOptions.
				workers.Go(func() { model.InitOptionMap(); firstDone <- nil })
			}
			select {
			case <-reached:
			case <-time.After(5 * time.Second):
				t.Fatal("first operation did not reach the controlled interleaving")
			}
			laterStarted.Store(true)
			workers.Go(func() { laterDone <- model.UpdateOption(scenario.key, scenario.latest) })
			select {
			case <-laterPreflight:
			case <-time.After(5 * time.Second):
				t.Fatal("second save did not reach its database preflight")
			}
			laterFinished := false
			select {
			case err := <-laterDone:
				require.NoError(t, err)
				laterFinished = true
			case <-time.After(time.Second):
				// Correct serialization holds the second save until the first
				// publication finishes. The bound releases that deliberate pause.
			}
			close(release)
			require.NoError(t, <-firstDone)
			if !laterFinished {
				require.NoError(t, <-laterDone)
			}
			model.DB = healthy

			var stored model.Option
			require.NoError(t, model.DB.Where(&model.Option{Key: scenario.key}).First(&stored).Error)
			assert.Equal(t, scenario.latest, stored.Value)
			if scenario.key == "Price" {
				assert.Equal(t, 2.0, operation_setting.Price)
			} else {
				assert.Equal(t, 2.0, common.GetTopupGroupRatio("default"))
			}
			common.OptionMapRWMutex.RLock()
			published := common.OptionMap[scenario.key]
			common.OptionMapRWMutex.RUnlock()
			assert.Equal(t, stored.Value, published)
			router.POST("/ratio-quote", func(c *gin.Context) { c.Set("id", 902); RequestAmount(c) })
			router.POST("/ratio-checkout", func(c *gin.Context) { c.Set("id", 902); RequestEpay(c) })
			quote := httptest.NewRecorder()
			router.ServeHTTP(quote, httptest.NewRequest(http.MethodPost, "/ratio-quote", strings.NewReader(`{"amount":100}`)))
			require.Contains(t, quote.Body.String(), `"data":"200.00"`)
			checkout := httptest.NewRecorder()
			router.ServeHTTP(checkout, httptest.NewRequest(http.MethodPost, "/ratio-checkout", strings.NewReader(`{"amount":100,"payment_method":"alipay"}`)))
			require.Contains(t, checkout.Body.String(), `"message":"success"`)
			var order model.TopUp
			require.NoError(t, model.DB.First(&order).Error)
			assert.Equal(t, 200.0, order.Money)
			require.NotNil(t, order.CreditedQuota)
			assert.Equal(t, 1000, *order.CreditedQuota)
			for range 2 {
				paid := httptest.NewRecorder()
				router.ServeHTTP(paid, walletWebhookRequest(t, keys, model.PaymentProviderEpay, order.TradeNo, "200.00", true))
				require.Equal(t, "success", paid.Body.String())
			}
			var buyer, inviter model.User
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			require.NoError(t, model.DB.First(&order, order.Id).Error)
			assert.Equal(t, common.TopUpStatusSuccess, order.Status)
			assert.Equal(t, 990, buyer.Quota)
			assert.Equal(t, 107, inviter.AffQuota)
			assert.Equal(t, 111, inviter.AffHistoryQuota)
			var facts []model.ReferralRebate
			require.NoError(t, model.DB.Find(&facts).Error)
			require.Len(t, facts, 1)
			assert.EqualValues(t, 1000, facts[0].CreditedQuota)
			assert.EqualValues(t, 100, facts[0].RewardQuota)
		})
	}
}

func walletPricingOptionRuntime(t *testing.T, key string) string {
	t.Helper()
	switch key {
	case "TopupGroupRatio":
		return common.TopupGroupRatio2JSONString()
	case "Price":
		return strconv.FormatFloat(operation_setting.Price, 'g', -1, 64)
	case "QuotaPerUnit":
		return strconv.FormatFloat(common.QuotaPerUnit, 'g', -1, 64)
	case "StripeUnitPrice":
		return strconv.FormatFloat(setting.StripeUnitPrice, 'g', -1, 64)
	case "WaffoUnitPrice":
		return strconv.FormatFloat(setting.WaffoUnitPrice, 'g', -1, 64)
	case "WaffoPancakeUnitPrice":
		return strconv.FormatFloat(setting.WaffoPancakeUnitPrice, 'g', -1, 64)
	case "CreemProducts":
		return setting.CreemProducts
	case "payment_setting.amount_discount":
		return common.GetJsonString(operation_setting.GetPaymentSetting().AmountDiscount)
	default:
		t.Fatalf("unsupported wallet pricing key %s", key)
		return ""
	}
}

func TestWalletPricingOptionsPreserveFailedSaveAndValueContracts(t *testing.T) {
	for _, option := range []struct{ key, initial, replacement string }{
		{"TopupGroupRatio", `{"default":2}`, `{"default":0.2}`},
		{"Price", "2", "0.2"}, {"StripeUnitPrice", "2", "0.2"},
		{"QuotaPerUnit", "10", "100"},
		{"WaffoUnitPrice", "2", "0.2"}, {"WaffoPancakeUnitPrice", "2", "0.2"},
		{"CreemProducts", `[{"productId":"fixture","price":100,"quota":1000}]`, `[{"productId":"fixture","price":100,"quota":10000}]`},
		{"payment_setting.amount_discount", `{"100":0.9}`, `{"100":0.1}`},
	} {
		t.Run(option.key, func(t *testing.T) {
			walletCheckoutFixture(t)
			oldOptions := common.OptionMap
			common.OptionMap = make(map[string]string)
			oldStripe, oldWaffo := setting.StripeUnitPrice, setting.WaffoUnitPrice
			t.Cleanup(func() {
				common.OptionMap = oldOptions
				setting.StripeUnitPrice, setting.WaffoUnitPrice = oldStripe, oldWaffo
			})
			require.NoError(t, model.UpdateOption(option.key, option.initial))
			before := walletPricingOptionRuntime(t, option.key)
			for _, firstSave := range []bool{false, true} {
				if firstSave {
					require.NoError(t, model.DB.Where(&model.Option{Key: option.key}).Delete(&model.Option{}).Error)
				}
				var failures atomic.Int32
				failWrite := func(tx *gorm.DB) {
					if tx.Statement.Table == "options" {
						failures.Add(1)
						tx.AddError(errors.New("isolated wallet pricing write failure"))
					}
				}
				if firstSave {
					require.NoError(t, model.DB.Callback().Create().Before("gorm:create").Register("fixture:wallet_price_failure", failWrite))
				} else {
					require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register("fixture:wallet_price_failure", failWrite))
				}
				err := model.UpdateOption(option.key, option.replacement)
				if firstSave {
					require.NoError(t, model.DB.Callback().Create().Remove("fixture:wallet_price_failure"))
				} else {
					require.NoError(t, model.DB.Callback().Update().Remove("fixture:wallet_price_failure"))
				}
				require.Error(t, err)
				require.EqualValues(t, 1, failures.Load())
				assert.Equal(t, before, walletPricingOptionRuntime(t, option.key))
				assert.Equal(t, option.initial, common.OptionMap[option.key])
				var stored model.Option
				lookup := model.DB.Where(&model.Option{Key: option.key}).First(&stored).Error
				if firstSave {
					require.ErrorIs(t, lookup, gorm.ErrRecordNotFound)
				} else {
					require.NoError(t, lookup)
					assert.Equal(t, option.initial, stored.Value)
				}
				require.NoError(t, model.UpdateOption(option.key, option.initial))
			}
			alias := strings.ToUpper(option.key)
			var matched model.Option
			equivalent := model.DB.Where(&model.Option{Key: alias}).First(&matched).Error == nil
			aliasErr := model.UpdateOption(alias, option.replacement)
			if equivalent {
				require.Error(t, aliasErr)
			} else {
				require.NoError(t, aliasErr)
			}
			assert.Equal(t, before, walletPricingOptionRuntime(t, option.key))
			var stored model.Option
			require.NoError(t, model.DB.Where(&model.Option{Key: option.key}).First(&stored).Error)
			assert.Equal(t, option.initial, stored.Value)
			if equivalent {
				require.NoError(t, model.DB.Where(&model.Option{Key: option.key}).Delete(&model.Option{}).Error)
				require.NoError(t, model.DB.Create(&model.Option{Key: alias, Value: option.initial}).Error)
				require.NoError(t, model.UpdateOption(option.key, option.replacement))
				require.NoError(t, model.DB.Where(&model.Option{Key: option.key}).First(&stored).Error)
				assert.Equal(t, option.key, stored.Key)
				assert.Equal(t, option.replacement, stored.Value)
			}
			require.NoError(t, model.UpdateOption(option.key, option.initial))
			var invalid, valid []string
			switch option.key {
			case "Price", "StripeUnitPrice", "WaffoUnitPrice", "WaffoPancakeUnitPrice", "QuotaPerUnit":
				invalid = []string{"broken", "NaN", "+Inf", "1e309"}
				valid = []string{"0", "-1", "0.000001", "2.5"}
			case "payment_setting.amount_discount":
				invalid = []string{`{"100":0.1`, `{"100":0.1,"200":"invalid"}`}
				valid = []string{"null", "{}", `{"100":0,"200":-1,"300":0.85}`}
			}
			for _, value := range invalid {
				require.Error(t, model.UpdateOption(option.key, value))
				assert.Equal(t, before, walletPricingOptionRuntime(t, option.key))
				require.NoError(t, model.DB.Where(&model.Option{Key: option.key}).First(&stored).Error)
				assert.Equal(t, option.initial, stored.Value)
			}
			for _, value := range valid {
				require.NoError(t, model.UpdateOption(option.key, value))
				require.NoError(t, model.DB.Where(&model.Option{Key: option.key}).First(&stored).Error)
				assert.Equal(t, value, stored.Value)
				if option.key == "payment_setting.amount_discount" {
					assert.JSONEq(t, value, walletPricingOptionRuntime(t, option.key))
				} else {
					number, err := strconv.ParseFloat(value, 64)
					require.NoError(t, err)
					assert.Equal(t, strconv.FormatFloat(number, 'g', -1, 64), walletPricingOptionRuntime(t, option.key))
				}
			}
		})
	}
}

func TestWalletPricingReadersSynchronizeWithSaveAndReload(t *testing.T) {
	for _, mode := range []string{"save", "reload"} {
		for _, scenario := range []struct{ reader, key, initial, latest, before, after string }{
			{"epay", "Price", "1", "2", "100", "200"},
			{"stripe", "StripeUnitPrice", "1", "2", "100", "200"},
			{"waffo", "WaffoUnitPrice", "1", "2", "100", "200"},
			{"pancake", "WaffoPancakeUnitPrice", "1", "2", "100", "200"},
			{"wallet_units", "QuotaPerUnit", "10", "100", "10", "100"},
			{"payment_compliance", "payment_setting.compliance_confirmed", "true", "true", "true", "true"},
			{"payment_compliance", "payment_setting.compliance_terms_version", operation_setting.CurrentComplianceTermsVersion, operation_setting.CurrentComplianceTermsVersion, "true", "true"},
			{"epay", "payment_setting.amount_discount", `{"100":1}`, `{"100":0.5}`, "100", "50"},
			{"waffo", "payment_setting.amount_discount", `{"100":1}`, `{"100":0.5}`, "100", "50"},
			{"pancake", "payment_setting.amount_discount", `{"100":1}`, `{"100":0.5}`, "100", "50"},
			{"epay", "TopupGroupRatio", `{"default":1}`, `{"default":2}`, "100", "200"},
			{"creem", "CreemProducts", `[{"productId":"fixture","quota":100}]`, `[{"productId":"fixture","quota":200}]`, "Product does not exist", "Product does not exist"},
			{"info_products", "CreemProducts", `[{"productId":"fixture","quota":100}]`, `[{"productId":"fixture","quota":200}]`, `[{"productId":"fixture","quota":100}]`, `[{"productId":"fixture","quota":200}]`},
			{"info_discount", "payment_setting.amount_discount", `{"100":1}`, `{"100":0.5}`, `{"100":1}`, `{"100":0.5}`},
			{"epay_min", "MinTopUp", "1", "2", "1", "2"},
			{"stripe_min", "StripeMinTopUp", "1", "2", "1", "2"},
			{"waffo_min", "WaffoMinTopUp", "1", "2", "1", "2"},
			{"pancake_min", "WaffoPancakeMinTopUp", "1", "2", "1", "2"},
			{"info:min_topup", "MinTopUp", "1", "2", "1", "2"},
			{"info:stripe_min_topup", "StripeMinTopUp", "1", "2", "1", "2"},
			{"info:waffo_min_topup", "WaffoMinTopUp", "1", "2", "1", "2"},
			{"info:waffo_pancake_min_topup", "WaffoPancakeMinTopUp", "1", "2", "1", "2"},
			{"info:topup_link", "TopUpLink", "https://old.example.invalid", "https://new.example.invalid", `"https://old.example.invalid"`, `"https://new.example.invalid"`},
			{"info:enable_online_topup", "PayMethods", `[]`, `[{"type":"alipay"}]`, "false", "true"},
			{"info:enable_stripe_topup", "StripeApiSecret", "", "sk_test_fixture", "false", "true"},
			{"info:enable_creem_topup", "CreemProducts", `[]`, `[{"productId":"fixture"}]`, "false", "true"},
			{"info:enable_waffo_topup", "WaffoEnabled", "false", "true", "false", "true"},
			{"info:enable_waffo_pancake_topup", "WaffoPancakeMerchantID", "", "fixture", "false", "true"},
			{"info:amount_options", "payment_setting.amount_options", `[100,200]`, `[300,400]`, `[100,200]`, `[300,400]`},
			{"waffo_sdk_key", "WaffoApiKey", "old-key", "new-key", "old-key", "new-key"},
			{"waffo_sdk_merchant", "WaffoMerchantId", "old-merchant", "new-merchant", "old-merchant", "new-merchant"},
			{"waffo_sdk_env", "WaffoSandbox", "false", "true", "false", "true"},
			{"waffo_currency", "WaffoCurrency", "USD", "EUR", "USD", "EUR"},
			{"pancake_checkout", "WaffoPancakeMerchantID", "MER_aaaaaaaaaaaaaaaaaaaaaa", "MER_bbbbbbbbbbbbbbbbbbbbbb", "not_started", "not_started"},
			{"pancake_verify", "WaffoPancakeStoreID", "store_fixture", "other_store", "valid", "invalid"},
			{"stripe_price_id", "StripePriceId", "price_before", "price_after", "price_before", "price_after"},
			{"stripe_api_key", "StripeApiSecret", "sk_test_before", "sk_test_after", "Bearer sk_test_before", "Bearer sk_test_after"},
			{"stripe_promotion", "StripePromotionCodesEnabled", "false", "true", "false", "true"},
			{"creem_api_key", "CreemApiKey", "test_before", "test_after", "test_before", "test_after"},
			{"creem_mode", "CreemTestMode", "false", "true", "api.creem.io", "test-api.creem.io"},
			{"epay_checkout_method", "PayMethods", `[]`, `[{"type":"alipay"}]`, "false", "true"},
			{"epay_webhook_gate", "PayMethods", `[]`, `[{"type":"alipay"}]`, "fail", "fail"},
			{"waffo_webhook_gate", "WaffoEnabled", "false", "true", "403", "400"},
			{"pancake_webhook_gate", "WaffoPancakeProductID", "", "product_fixture", "403", "401"},
		} {
			t.Run(mode+"/"+scenario.reader+"/"+scenario.key, func(t *testing.T) {
				router, keys := walletCheckoutFixture(t)
				oldOptions := common.OptionMap
				common.OptionMap = make(map[string]string)
				oldStripe, oldWaffo := setting.StripeUnitPrice, setting.WaffoUnitPrice
				oldWaffoMin, oldTopupLink := setting.WaffoMinTopUp, common.TopUpLink
				oldAmountOptions := slices.Clone(operation_setting.GetPaymentSetting().AmountOptions)
				oldMerchant, oldCurrency := setting.WaffoMerchantId, setting.WaffoCurrency
				oldPromotions := setting.StripePromotionCodesEnabled
				oldSandboxKey, oldSandboxPrivate, oldSandboxPublic := setting.WaffoSandboxApiKey, setting.WaffoSandboxPrivateKey, setting.WaffoSandboxPublicCert
				setting.WaffoSandboxApiKey, setting.WaffoSandboxPrivateKey, setting.WaffoSandboxPublicCert = "sandbox-fixture", keys.PrivateKey, keys.PublicKey
				verifiedRequest := walletWebhookRequest(t, keys, model.PaymentProviderWaffoPancake, "config-reader", "90", true)
				verifiedBody, bodyErr := io.ReadAll(verifiedRequest.Body)
				require.NoError(t, bodyErr)
				setting.StripeUnitPrice, setting.WaffoUnitPrice = 1, 1
				t.Cleanup(func() {
					common.OptionMap = oldOptions
					setting.StripeUnitPrice, setting.WaffoUnitPrice = oldStripe, oldWaffo
					setting.WaffoMinTopUp, common.TopUpLink = oldWaffoMin, oldTopupLink
					operation_setting.GetPaymentSetting().AmountOptions = oldAmountOptions
					setting.WaffoMerchantId, setting.WaffoCurrency = oldMerchant, oldCurrency
					setting.StripePromotionCodesEnabled = oldPromotions
					setting.WaffoSandboxApiKey, setting.WaffoSandboxPrivateKey, setting.WaffoSandboxPublicCert = oldSandboxKey, oldSandboxPrivate, oldSandboxPublic
				})
				require.NoError(t, model.UpdateOption(scenario.key, scenario.initial))
				if mode == "reload" {
					require.NoError(t, model.DB.Model(&model.Option{}).Where(&model.Option{Key: scenario.key}).Update("value", scenario.latest).Error)
				}
				router.GET("/pricing-info", GetTopUpInfo)
				router.GET("/pricing-compliance", func(c *gin.Context) {
					if requirePaymentCompliance(c) {
						c.Status(http.StatusNoContent)
					}
				})
				router.POST("/pricing-products", func(c *gin.Context) { c.Set("id", 902) }, RequestCreemPay)
				router.POST("/pricing-epay", func(c *gin.Context) { c.Set("id", 902) }, RequestEpay)
				oldTransport, oldBackend := http.DefaultTransport, stripe.GetBackend(stripe.APIBackend)
				t.Cleanup(func() { http.DefaultTransport = oldTransport; stripe.SetBackend(stripe.APIBackend, oldBackend) })
				if strings.HasPrefix(scenario.reader, "stripe_") || strings.HasPrefix(scenario.reader, "creem_") {
					transport := walletCheckoutTransport(func(request *http.Request) (*http.Response, error) {
						if err := request.ParseForm(); err != nil {
							return nil, err
						}
						value := request.Header.Get("x-api-key")
						switch scenario.reader {
						case "stripe_price_id":
							value = request.Form.Get("line_items[0][price]")
						case "stripe_api_key":
							value = request.Header.Get("Authorization")
						case "stripe_promotion":
							value = request.Form.Get("allow_promotion_codes")
						case "creem_mode":
							value = request.URL.Host
						}
						body, err := common.Marshal(map[string]string{"url": value, "checkout_url": value})
						if err != nil {
							return nil, err
						}
						return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(body)), Request: request}, nil
					})
					http.DefaultTransport = transport
					stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{HTTPClient: &http.Client{Transport: transport}, MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false)}))
				}
				read := func() (string, error) {
					var amount float64
					switch scenario.reader {
					case "epay":
						amount = getPayMoney(100, "default", operation_setting.QuotaDisplayTypeUSD, 10)
					case "stripe":
						amount = getStripePayMoney(100)
					case "waffo":
						amount = getWaffoPayMoney(100, "default", operation_setting.QuotaDisplayTypeUSD, 10)
					case "pancake":
						amount = getWaffoPancakePayMoney(100, "default", operation_setting.QuotaDisplayTypeUSD, 10)
					case "wallet_units":
						_, amount = walletTopUpUnits()
					case "payment_compliance":
						response := httptest.NewRecorder()
						router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/pricing-compliance", nil))
						return strconv.FormatBool(response.Code == http.StatusNoContent), nil
					case "epay_min":
						amount = float64(getMinTopup(operation_setting.QuotaDisplayTypeUSD, 10))
					case "stripe_min":
						amount = float64(getStripeMinTopup())
					case "waffo_min":
						amount = float64(getWaffoMinTopup())
					case "pancake_min":
						amount = float64(getWaffoPancakeMinTopup())
					case "waffo_currency":
						return getWaffoCurrency(), nil
					case "waffo_sdk_key", "waffo_sdk_merchant", "waffo_sdk_env":
						sdk, err := getWaffoSDK()
						if err != nil {
							return "", err
						}
						config := sdk.GetConfig()
						if scenario.reader == "waffo_sdk_merchant" {
							return config.MerchantID, nil
						}
						if scenario.reader == "waffo_sdk_env" {
							return strconv.FormatBool(string(config.Environment) == "SANDBOX"), nil
						}
						return config.APIKey, nil
					case "pancake_checkout":
						_, err := service.CreateWaffoPancakeCheckoutSession(t.Context(), &service.WaffoPancakeCreateSessionParams{
							ProductID: "invalid-product", BuyerIdentity: "reader-fixture", OrderMerchantExternalID: "reader-fixture",
						})
						if errors.Is(err, service.ErrWaffoPancakeCheckoutNotStarted) {
							return "not_started", nil
						}
						return "unexpected request", err
					case "pancake_verify":
						_, err := service.VerifyConfiguredWaffoPancakeWebhook(string(verifiedBody), verifiedRequest.Header.Get("X-Waffo-Signature"))
						if err != nil {
							return "invalid", nil
						}
						return "valid", nil
					case "stripe_price_id", "stripe_api_key", "stripe_promotion":
						return genStripeLink("reader-fixture", "", "", 1, "https://fixture.invalid/success", "https://fixture.invalid/cancel")
					case "creem_api_key", "creem_mode":
						return genCreemLink(t.Context(), "reader-fixture", &CreemProduct{ProductId: "prod_fixture"}, "", "")
					case "epay_checkout_method":
						request := httptest.NewRequest(http.MethodPost, "/pricing-epay", strings.NewReader(`{"amount":100,"payment_method":"alipay"}`))
						request.Header.Set("Content-Type", "application/json")
						response := httptest.NewRecorder()
						router.ServeHTTP(response, request)
						return strconv.FormatBool(strings.Contains(response.Body.String(), `"message":"success"`)), nil
					case "epay_webhook_gate", "waffo_webhook_gate", "pancake_webhook_gate":
						path := "/epay"
						if scenario.reader == "waffo_webhook_gate" {
							path = "/waffo"
						} else if scenario.reader == "pancake_webhook_gate" {
							path = "/waffo_pancake/test"
						}
						response := httptest.NewRecorder()
						router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, strings.NewReader("invalid")))
						if scenario.reader == "epay_webhook_gate" {
							return response.Body.String(), nil
						}
						return strconv.Itoa(response.Code), nil
					default:
						response := httptest.NewRecorder()
						request := httptest.NewRequest(http.MethodGet, "/pricing-info", nil)
						if scenario.reader == "creem" {
							request = httptest.NewRequest(http.MethodPost, "/pricing-products", strings.NewReader(`{"product_id":"absent","payment_method":"creem"}`))
							request.Header.Set("Content-Type", "application/json")
						}
						router.ServeHTTP(response, request)
						var result struct {
							Data json.RawMessage `json:"data"`
						}
						if err := common.Unmarshal(response.Body.Bytes(), &result); err != nil {
							return "", err
						}
						if scenario.reader == "creem" {
							var message string
							err := common.Unmarshal(result.Data, &message)
							return message, err
						}
						var data map[string]json.RawMessage
						if err := common.Unmarshal(result.Data, &data); err != nil {
							return "", err
						}
						if scenario.reader == "info_products" {
							var products string
							err := common.Unmarshal(data["creem_products"], &products)
							return products, err
						}
						if field, ok := strings.CutPrefix(scenario.reader, "info:"); ok {
							return string(data[field]), nil
						}
						return string(data["discount"]), nil
					}
					return strconv.FormatFloat(amount, 'f', -1, 64), nil
				}
				start := make(chan struct{})
				var workers sync.WaitGroup
				var saveErr, readErr error
				var observed string
				workers.Go(func() {
					<-start
					if mode == "reload" {
						model.InitOptionMap() // Same reload path used by SyncOptions.
					} else {
						saveErr = model.UpdateOption(scenario.key, scenario.latest)
					}
				})
				workers.Go(func() { <-start; observed, readErr = read() })
				close(start)
				workers.Wait()
				require.NoError(t, saveErr)
				require.NoError(t, readErr)
				assert.Contains(t, []string{scenario.before, scenario.after}, observed)
				after, err := read()
				require.NoError(t, err)
				assert.Equal(t, scenario.after, after)
			})
		}
	}
	t.Run("concurrent_info_requests_keep_configured_methods_unchanged", func(t *testing.T) {
		router, _ := walletCheckoutFixture(t)
		operation_setting.PayMethods = make([]map[string]string, 1, 4)
		operation_setting.PayMethods[0] = map[string]string{"type": "alipay"}
		router.GET("/pricing-info", GetTopUpInfo)
		start := make(chan struct{})
		responses := [2]*httptest.ResponseRecorder{httptest.NewRecorder(), httptest.NewRecorder()}
		var workers sync.WaitGroup
		for i := range responses {
			workers.Go(func() {
				<-start
				router.ServeHTTP(responses[i], httptest.NewRequest(http.MethodGet, "/pricing-info", nil))
			})
		}
		close(start)
		workers.Wait()
		assert.Equal(t, []map[string]string{{"type": "alipay"}}, operation_setting.PayMethods)
		for _, response := range responses {
			var result struct {
				Data struct {
					Methods []map[string]string `json:"pay_methods"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
			methods := make([]string, 0, len(result.Data.Methods))
			for _, method := range result.Data.Methods {
				methods = append(methods, method["type"])
			}
			assert.ElementsMatch(t, []string{"alipay", "stripe", model.PaymentMethodWaffo, model.PaymentMethodWaffoPancake}, methods)
		}
	})
}

// walletWaffoSDKTransport preserves SDK serialization, response verification
// and decoding while keeping regression tests off the real payment network.
type walletWaffoSDKTransport func(context.Context, *waffonet.HttpRequest) (*waffonet.HttpResponse, error)

// walletWaffoInquiryTransport simulates the provider at the SDK's HTTP boundary.
// Requests and replies retain real RSA signatures and SDK decoding.
type walletWaffoInquiryTransport struct {
	t         *testing.T
	keys      *waffoutils.KeyPair
	responses sync.Map
	requests  atomic.Int32
}

func (transport *walletWaffoInquiryTransport) setResult(result map[string]any) {
	transport.t.Helper()
	body, err := common.Marshal(result)
	require.NoError(transport.t, err)
	var data map[string]any
	require.NoError(transport.t, common.Unmarshal(body, &data))
	tradeNo, _ := data["merchantOrderId"].(string)
	data["paymentRequestId"] = tradeNo
	data["acquiringOrderId"] = "acquiring_" + tradeNo
	if data["orderCurrency"] == nil || data["orderCurrency"] == "" {
		data["orderCurrency"] = "USD"
	}
	body, err = common.Marshal(map[string]any{"code": "0", "data": data})
	require.NoError(transport.t, err)
	transport.responses.Store(tradeNo, body)
}

func (transport *walletWaffoInquiryTransport) Send(ctx context.Context, request *waffonet.HttpRequest) (*waffonet.HttpResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	transport.requests.Add(1)
	if request.Method != http.MethodPost || !strings.HasSuffix(request.URL, "/order/inquiry") ||
		request.Headers["X-API-KEY"] != "fixture" || !waffoutils.Verify(string(request.Body), request.Headers["X-SIGNATURE"], transport.keys.PublicKey) {
		return nil, errors.New("invalid simulated merchant inquiry request")
	}
	var query order.InquiryOrderParams
	if err := common.Unmarshal(request.Body, &query); err != nil {
		return nil, err
	}
	body := []byte(`{"code":"E0002","msg":"order not found"}`)
	if fixture, ok := transport.responses.Load(query.PaymentRequestID); ok {
		body = fixture.([]byte)
	}
	signature, err := waffoutils.Sign(string(body), transport.keys.PrivateKey)
	if err != nil {
		return nil, err
	}
	return waffonet.NewHttpResponse(http.StatusOK, map[string]string{"X-SIGNATURE": signature}, body), nil
}

func (transport walletWaffoSDKTransport) Send(ctx context.Context, request *waffonet.HttpRequest) (*waffonet.HttpResponse, error) {
	return transport(ctx, request)
}

func TestWalletWaffoInquiryBindsMerchantOrderBeforeSettlement(t *testing.T) {
	for _, scenario := range []struct {
		name, field string
		value       any
		raw         string
		closed      bool
		accepted    bool
	}{
		{name: "discounted_amount", accepted: true},
		{name: "zero_paid", field: "orderAmount", value: "0.00", accepted: true},
		{name: "merchant_order_mismatch", field: "merchantOrderId", value: "other_order"},
		{name: "payment_request_mismatch", field: "paymentRequestId", value: "other_request"},
		{name: "missing_payment_request", field: "paymentRequestId", value: nil},
		{name: "missing_acquiring_order", field: "acquiringOrderId", value: nil},
		{name: "pending_query", field: "orderStatus", value: "PAY_IN_PROGRESS"},
		{name: "paid_query_cannot_close", field: "orderStatus", value: "PAY_SUCCESS", closed: true},
		{name: "closed_query_cannot_pay", field: "orderStatus", value: "ORDER_CLOSE"},
		{name: "amount_mismatch", field: "orderAmount", value: "1.00"},
		{name: "negative_amount", field: "orderAmount", value: "-1"},
		{name: "invalid_amount", field: "orderAmount", value: "invalid"},
		{name: "currency_mismatch", field: "orderCurrency", value: "EUR"},
		{name: "missing_currency", field: "orderCurrency", value: nil},
		{name: "merchant_mismatch", field: "merchantInfo", value: map[string]any{"merchantId": "other_merchant"}},
		{name: "buyer_mismatch", field: "userInfo", value: map[string]any{"userId": "903"}},
		{name: "subscription_order", field: "subscriptionInfo", value: map[string]any{"subscriptionId": "subscription_other"}},
		{name: "empty_optional_subscription_info", field: "subscriptionInfo", value: map[string]any{}, accepted: true},
		{name: "missing_data", raw: `{"code":"0"}`},
		{name: "null_data", raw: `{"code":"0","data":null}`},
		{name: "missing_code", raw: `{}`},
		{name: "json_null", raw: `null`},
		{name: "unknown_query", raw: `{"code":"E0001"}`},
		{name: "query_not_found", raw: `{"code":"E0002"}`},
		{name: "network_failure"},
		{name: "bad_query_signature"},
		{name: "nil_http_response"},
		{name: "http_unauthorized_with_valid_body"},
		{name: "http_server_error_with_valid_body"},
		{name: "valid_closed", closed: true, accepted: true},
		{name: "closed_without_payment_fields", closed: true, accepted: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			router, keys := walletWebhookFixture(t)
			topUp := walletWebhookOrder(t, model.PaymentProviderWaffo, "waffo-inquiry-binding")
			require.NoError(t, model.DB.Model(topUp).Update("waffo_merchant_id", "merchant_checkout").Error)
			status, amount := "PAY_SUCCESS", "90.00"
			if scenario.closed {
				status = "ORDER_CLOSE"
			}
			if scenario.name == "zero_paid" {
				amount = "0.00"
			}
			result := map[string]any{"merchantOrderId": topUp.TradeNo, "paymentRequestId": topUp.TradeNo, "orderStatus": status, "orderAmount": amount, "orderCurrency": "USD"}
			if scenario.name == "closed_without_payment_fields" {
				delete(result, "orderAmount")
				delete(result, "orderCurrency")
			}
			request := signedWalletWebhookRequest(t, keys, model.PaymentProviderWaffo, map[string]any{"eventType": "PAYMENT_NOTIFICATION", "result": result})
			callbackBody, err := io.ReadAll(request.Body)
			require.NoError(t, err)
			request.Body = io.NopCloser(bytes.NewReader(callbackBody))
			transport := service.WaffoHTTPTransport.(*walletWaffoInquiryTransport)
			query := map[string]any{"merchantOrderId": topUp.TradeNo, "paymentRequestId": topUp.TradeNo, "acquiringOrderId": "acquiring_" + topUp.TradeNo, "orderStatus": status, "orderAmount": amount, "orderCurrency": "USD", "merchantInfo": map[string]any{"merchantId": "merchant_checkout"}, "userInfo": map[string]any{"userId": "902"}}
			if scenario.field != "" {
				query[scenario.field] = scenario.value
			}
			if scenario.name == "closed_without_payment_fields" {
				delete(query, "orderAmount")
				delete(query, "orderCurrency")
				delete(query, "acquiringOrderId")
			}
			body, err := common.Marshal(map[string]any{"code": "0", "data": query})
			require.NoError(t, err)
			if scenario.raw != "" {
				body = []byte(scenario.raw)
			}
			transport.responses.Store(topUp.TradeNo, body)
			if scenario.name == "network_failure" || scenario.name == "bad_query_signature" || scenario.name == "nil_http_response" || strings.HasSuffix(scenario.name, "_with_valid_body") {
				service.WaffoHTTPTransport = walletWaffoSDKTransport(func(ctx context.Context, request *waffonet.HttpRequest) (*waffonet.HttpResponse, error) {
					response, err := transport.Send(ctx, request)
					switch scenario.name {
					case "network_failure":
						return nil, errors.New("simulated inquiry response loss")
					case "nil_http_response":
						return nil, nil
					case "http_unauthorized_with_valid_body":
						response.StatusCode = http.StatusUnauthorized
					case "http_server_error_with_valid_body":
						response.StatusCode = http.StatusInternalServerError
					case "bad_query_signature":
						if err == nil {
							response.Headers["X-SIGNATURE"] = "invalid"
						}
					}
					return response, err
				})
			}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			expectedStatus, expectedQuota, expectedAffQuota, expectedFacts := common.TopUpStatusPending, -10, 7, int64(0)
			if scenario.accepted {
				assert.JSONEq(t, `{"message":"success"}`, recorder.Body.String())
				if scenario.closed {
					expectedStatus = common.TopUpStatusFailed
				} else {
					expectedStatus, expectedQuota, expectedAffQuota, expectedFacts = common.TopUpStatusSuccess, 990, 107, 1
				}
			} else {
				assert.JSONEq(t, `{"message":"failed"}`, recorder.Body.String())
			}
			require.NoError(t, model.DB.First(topUp, topUp.Id).Error)
			assert.Equal(t, expectedStatus, topUp.Status)
			var buyer, inviter model.User
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			assert.Equal(t, expectedQuota, buyer.Quota)
			assert.Equal(t, expectedAffQuota, inviter.AffQuota)
			var facts int64
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			assert.Equal(t, expectedFacts, facts)
			assert.EqualValues(t, 1, transport.requests.Load(), "terminal notification must query the merchant-authenticated original order")
			// Restore the provider's original fact and replay the exact signed
			// notification. A retry does not need a replacement local order.
			transport.setResult(result)
			service.WaffoHTTPTransport = transport
			retry := request.Clone(t.Context())
			retry.Body = io.NopCloser(bytes.NewReader(callbackBody))
			retryResponse := httptest.NewRecorder()
			router.ServeHTTP(retryResponse, retry)
			assert.JSONEq(t, `{"message":"success"}`, retryResponse.Body.String())
			// After commit, even an inquiry outage cannot prevent idempotent
			// cache recovery or cause a second credit.
			service.WaffoHTTPTransport = walletWaffoSDKTransport(func(context.Context, *waffonet.HttpRequest) (*waffonet.HttpResponse, error) {
				t.Error("committed order unexpectedly depends on provider inquiry")
				return nil, errors.New("provider unavailable after commit")
			})
			retry = request.Clone(t.Context())
			retry.Body = io.NopCloser(bytes.NewReader(callbackBody))
			retryResponse = httptest.NewRecorder()
			router.ServeHTTP(retryResponse, retry)
			assert.JSONEq(t, `{"message":"success"}`, retryResponse.Body.String())
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
			if scenario.closed {
				assert.Equal(t, -10, buyer.Quota)
				assert.Equal(t, 7, inviter.AffQuota)
				assert.Zero(t, facts)
			} else {
				assert.Equal(t, 990, buyer.Quota)
				assert.Equal(t, 107, inviter.AffQuota)
				assert.EqualValues(t, 1, facts)
			}
		})
	}
}

func TestWalletWaffoMissingCheckoutOutcomePreservesLateSettlement(t *testing.T) {
	t.Run("handler freezes authenticated SDK checkout", func(t *testing.T) {
		router, keys := walletCheckoutFixture(t)
		oldPrice, oldMin := setting.WaffoUnitPrice, setting.WaffoMinTopUp
		oldMerchant, oldCurrency := setting.WaffoMerchantId, setting.WaffoCurrency
		t.Cleanup(func() {
			setting.WaffoUnitPrice, setting.WaffoMinTopUp = oldPrice, oldMin
			setting.WaffoMerchantId, setting.WaffoCurrency = oldMerchant, oldCurrency
		})
		setting.WaffoUnitPrice, setting.WaffoMinTopUp = 1, 1
		setting.WaffoMerchantId, setting.WaffoCurrency = "merchant_checkout", "USD"
		inquiryTransport := service.WaffoHTTPTransport
		var outgoing order.CreateOrderParams
		service.WaffoHTTPTransport = walletWaffoSDKTransport(func(_ context.Context, request *waffonet.HttpRequest) (*waffonet.HttpResponse, error) {
			require.True(t, strings.HasSuffix(request.URL, "/order/create"))
			require.Equal(t, "fixture", request.Headers["X-API-KEY"])
			require.True(t, waffoutils.Verify(string(request.Body), request.Headers["X-SIGNATURE"], keys.PublicKey))
			require.NoError(t, common.Unmarshal(request.Body, &outgoing))
			// The local identity and credit must exist before the SDK sends.
			stored, err := model.GetTopUpByTradeNoWithError(outgoing.PaymentRequestID)
			require.NoError(t, err)
			require.NotNil(t, stored.CreditedQuota)
			assert.Equal(t, 1000, *stored.CreditedQuota)
			assert.Equal(t, 902, stored.UserId)
			body, err := common.Marshal(map[string]any{"code": "0", "data": order.CreateOrderData{MerchantOrderID: outgoing.MerchantOrderID, PaymentRequestID: outgoing.PaymentRequestID, OrderAction: `{"actionType":"REDIRECT","webUrl":"https://checkout.example.invalid/waffo"}`}})
			require.NoError(t, err)
			signature, err := waffoutils.Sign(string(body), keys.PrivateKey)
			require.NoError(t, err)
			return waffonet.NewHttpResponse(http.StatusOK, map[string]string{"X-SIGNATURE": signature}, body), nil
		})
		router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, RequestWaffoPay)
		request := httptest.NewRequest(http.MethodPost, "/checkout", strings.NewReader(`{"amount":100,"user_id":901,"orderAmount":"0","orderCurrency":"EUR","merchantOrderId":"client-selected"}`))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		var checkoutResponse struct {
			Message string            `json:"message"`
			Data    map[string]string `json:"data"`
		}
		require.NoError(t, common.Unmarshal(response.Body.Bytes(), &checkoutResponse))
		require.Equal(t, "success", checkoutResponse.Message)
		require.Equal(t, "https://checkout.example.invalid/waffo", checkoutResponse.Data["payment_url"])
		assert.Equal(t, outgoing.PaymentRequestID, outgoing.MerchantOrderID)
		assert.NotEqual(t, "client-selected", outgoing.MerchantOrderID)
		assert.LessOrEqual(t, len(outgoing.PaymentRequestID), 32)
		assert.Equal(t, "100.00", outgoing.OrderAmount)
		assert.Equal(t, "USD", outgoing.OrderCurrency)
		require.NotNil(t, outgoing.MerchantInfo)
		assert.Equal(t, "merchant_checkout", outgoing.MerchantInfo.MerchantID)
		require.NotNil(t, outgoing.UserInfo)
		assert.Equal(t, "902", outgoing.UserInfo.UserID)
		assert.Equal(t, "902@examples.com", outgoing.UserInfo.UserEmail)
		require.NotNil(t, outgoing.PaymentInfo)
		assert.Equal(t, "ONE_TIME_PAYMENT", outgoing.PaymentInfo.ProductName)
		service.WaffoHTTPTransport = inquiryTransport
		common.QuotaPerUnit, setting.WaffoUnitPrice = 100, 9
		for range 2 {
			callback := httptest.NewRecorder()
			router.ServeHTTP(callback, walletWebhookRequest(t, keys, model.PaymentProviderWaffo, outgoing.PaymentRequestID, "90.00", true))
			assert.JSONEq(t, `{"message":"success"}`, callback.Body.String())
		}
		var buyer, inviter model.User
		require.NoError(t, model.DB.First(&buyer, 902).Error)
		require.NoError(t, model.DB.First(&inviter, 901).Error)
		assert.Equal(t, 990, buyer.Quota)
		assert.Equal(t, 107, inviter.AffQuota)
		var facts int64
		require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&facts).Error)
		assert.EqualValues(t, 1, facts)
	})
	t.Run("generated id fits provider contract", func(t *testing.T) {
		router, keys := walletCheckoutFixture(t)
		oldPrice, oldMin := setting.WaffoUnitPrice, setting.WaffoMinTopUp
		t.Cleanup(func() { setting.WaffoUnitPrice, setting.WaffoMinTopUp = oldPrice, oldMin })
		setting.WaffoUnitPrice, setting.WaffoMinTopUp = 1, 1
		user := model.User{Id: 100000, Username: "waffo-large-user-id", AffCode: "waffo-large-user", Status: common.UserStatusEnabled, Group: "default", Quota: -10}
		require.NoError(t, model.DB.Create(&user).Error)
		router.POST("/checkout", func(c *gin.Context) { c.Set("id", user.Id) }, RequestWaffoPay)
		ctx, cancel := context.WithCancel(t.Context())
		cancel() // The real SDK cannot contact the payment platform.
		request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/checkout", strings.NewReader(`{"amount":100}`))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		var stored model.TopUp
		require.NoError(t, model.DB.Where("user_id = ?", user.Id).First(&stored).Error)
		// Waffo's paymentRequestId is also our persisted merchantOrderId.
		// The published Create Order schema limits paymentRequestId to 32.
		assert.LessOrEqual(t, len(stored.TradeNo), 32)
		assert.Equal(t, common.TopUpStatusPending, stored.Status)
		for range 2 {
			callback := httptest.NewRecorder()
			router.ServeHTTP(callback, walletWebhookRequest(t, keys, model.PaymentProviderWaffo, stored.TradeNo, "100.00", true))
			assert.JSONEq(t, `{"message":"success"}`, callback.Body.String())
		}
		require.NoError(t, model.DB.First(&user, user.Id).Error)
		assert.Equal(t, 990, user.Quota)
	})
	for _, tc := range []struct {
		name, body    string
		nilResponse   bool
		wantFailed    bool
		sdkError      bool
		settledBefore bool
		wantURL       string
	}{
		{name: "nil_response", nilResponse: true},
		{name: "empty_object", body: "{}"},
		{name: "json_null", body: "null"},
		{name: "null_code", body: "{\"code\":null}"},
		{name: "empty_code", body: "{\"code\":\"\"}"},
		{name: "whitespace_code", body: "{\"code\":\" \\t\\n\"}"},
		{name: "missing_code_with_checkout", body: "{\"data\":{\"orderAction\":\"https://checkout.example.invalid/accepted\"}}"},
		{name: "success_missing_checkout", body: "{\"code\":\"0\",\"data\":{}}"},
		{name: "unknown_status", body: "{\"code\":\"E0001\"}", sdkError: true},
		{name: "explicit_rejection", body: "{\"code\":\"A0003\"}", wantFailed: true},
		{name: "rejection_after_payment", body: "{\"code\":\"A0003\"}", settledBefore: true},
		{name: "successful_checkout", body: "{\"code\":\"0\",\"data\":{\"orderAction\":\"https://checkout.example.invalid/accepted\"}}", wantURL: "https://checkout.example.invalid/accepted"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router, keys := walletWebhookFixture(t)
			topUp := walletWebhookOrder(t, model.PaymentProviderWaffo, "waffo-missing-outcome")
			if tc.settledBefore {
				response := httptest.NewRecorder()
				router.ServeHTTP(response, walletWebhookRequest(t, keys, model.PaymentProviderWaffo, topUp.TradeNo, "90", true))
				assert.JSONEq(t, "{\"message\":\"success\"}", response.Body.String())
			}
			var sdkResponse *core.ApiResponse[order.CreateOrderData]
			if !tc.nilResponse {
				sdk, err := getWaffoSDK()
				require.NoError(t, err)
				cfg := sdk.GetConfig()
				requests := 0
				cfg.CustomTransport = walletWaffoSDKTransport(func(_ context.Context, request *waffonet.HttpRequest) (*waffonet.HttpResponse, error) {
					requests++
					assert.True(t, waffoutils.Verify(string(request.Body), request.Headers["X-SIGNATURE"], keys.PublicKey))
					signature, err := waffoutils.Sign(tc.body, keys.PrivateKey)
					if err != nil {
						return nil, err
					}
					return waffonet.NewHttpResponse(http.StatusOK, map[string]string{"X-SIGNATURE": signature}, []byte(tc.body)), nil
				})
				sdk = waffo.New(cfg)
				sdkResponse, err = sdk.Order().Create(t.Context(), &order.CreateOrderParams{MerchantOrderID: topUp.TradeNo}, nil)
				assert.Equal(t, 1, requests)
				if tc.sdkError {
					require.Error(t, err)
					require.Nil(t, sdkResponse)
				} else {
					require.NoError(t, err)
					require.NotNil(t, sdkResponse, "the installed SDK decodes JSON null into a response with an empty code")
				}
			}
			if !tc.sdkError {
				paymentURL, err := resolveWaffoCheckoutResponse(topUp, sdkResponse)
				assert.Equal(t, tc.wantURL, paymentURL)
				if tc.wantURL == "" {
					require.Error(t, err)
				} else {
					require.NoError(t, err)
				}
			}
			var stored model.TopUp
			require.NoError(t, model.DB.First(&stored, topUp.Id).Error)
			wantStatus := common.TopUpStatusPending
			if tc.wantFailed {
				wantStatus = common.TopUpStatusFailed
			}
			if tc.settledBefore {
				wantStatus = common.TopUpStatusSuccess
			}
			assert.Equal(t, wantStatus, stored.Status)
			require.NotNil(t, stored.CreditedQuota)
			assert.Equal(t, 1000, *stored.CreditedQuota)
			for range 2 {
				response := httptest.NewRecorder()
				router.ServeHTTP(response, walletWebhookRequest(t, keys, model.PaymentProviderWaffo, topUp.TradeNo, "90", true))
				wantBody := "{\"message\":\"success\"}"
				if tc.wantFailed {
					wantBody = "{\"message\":\"failed\"}"
				}
				assert.JSONEq(t, wantBody, response.Body.String())
			}
			var buyer, inviter model.User
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			require.NoError(t, model.DB.First(&stored, topUp.Id).Error)
			var facts []model.ReferralRebate
			require.NoError(t, model.DB.Where("top_up_id = ?", topUp.Id).Find(&facts).Error)
			if tc.wantFailed {
				assert.Equal(t, common.TopUpStatusFailed, stored.Status)
				assert.Zero(t, stored.CompleteTime)
				assert.Equal(t, -10, buyer.Quota)
				assert.Equal(t, 7, inviter.AffQuota)
				assert.Equal(t, 11, inviter.AffHistoryQuota)
				assert.Empty(t, facts)
			} else {
				assert.Equal(t, common.TopUpStatusSuccess, stored.Status)
				assert.Equal(t, 990, buyer.Quota)
				assert.Equal(t, 107, inviter.AffQuota)
				assert.Equal(t, 111, inviter.AffHistoryQuota)
				require.Len(t, facts, 1)
				assert.EqualValues(t, 1000, facts[0].CreditedQuota)
				assert.EqualValues(t, 100, facts[0].RewardQuota)
				assert.Equal(t, stored.CompleteTime, facts[0].SettledAt)
			}
		})
	}
}
