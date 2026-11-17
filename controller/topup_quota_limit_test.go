package controller

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/shopspring/decimal"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	waffonet "github.com/waffo-com/waffo-go/net"
	waffoorder "github.com/waffo-com/waffo-go/types/order"
	waffoutils "github.com/waffo-com/waffo-go/utils"
	"gorm.io/gorm"
)

func TestTopUpQuotaValidation(t *testing.T) {
	oldQuotaPerUnit := common.QuotaPerUnit
	oldMinTopup := operation_setting.MinTopUp
	operation_setting.MinTopUp = 1
	oldDisplayType := operation_setting.GetGeneralSetting().QuotaDisplayType
	common.QuotaPerUnit = 500000
	t.Cleanup(func() {
		common.QuotaPerUnit = oldQuotaPerUnit
		operation_setting.MinTopUp = oldMinTopup
		operation_setting.GetGeneralSetting().QuotaDisplayType = oldDisplayType
	})

	testCases := []struct {
		name        string
		displayType string
		amount      int64
		wantQuota   int
		wantMin     int64
		wantErr     bool
	}{
		{
			name:        "currency amount below limit",
			displayType: operation_setting.QuotaDisplayTypeUSD,
			amount:      4294,
			wantQuota:   2_147_000_000,
			wantMin:     1,
		},
		{
			name:        "currency amount above limit",
			displayType: operation_setting.QuotaDisplayTypeUSD,
			amount:      4295,
			wantQuota:   2_147_500_000,
			wantMin:     1,
		},
		{
			name:        "token amount freezes requested quantity",
			displayType: operation_setting.QuotaDisplayTypeTokens,
			amount:      2_147_500_000,
			wantQuota:   2_147_500_000,
			wantMin:     500000,
		},
		{
			name:        "token quantity preserves fractional currency units",
			displayType: operation_setting.QuotaDisplayTypeTokens,
			amount:      749999,
			wantQuota:   749999,
			wantMin:     500000,
		},
		{
			name:        "token amount above legacy int32 range",
			displayType: operation_setting.QuotaDisplayTypeTokens,
			amount:      4_294_500_000,
			wantQuota:   4_294_500_000,
			wantMin:     500000,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// A concurrent setting change must not reinterpret captured units.
			operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeTokens
			if tc.displayType == operation_setting.QuotaDisplayTypeTokens {
				operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
			}
			assert.Equal(t, tc.wantMin, getMinTopup(tc.displayType, common.QuotaPerUnit))
			quota, err := getTopUpQuota(tc.amount, tc.displayType, common.QuotaPerUnit)
			if tc.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.wantQuota, quota)
		})
	}
}

func TestWalletConversionRejectsUnsafeCheckoutAndPreservesFrozenOrder(t *testing.T) {
	for _, scenario := range []struct {
		name, conversion, messageKey string
		amount                       int64
	}{
		{"zero_rate", "0", `"message_key":"Invalid top-up amount"`, 100},
		{"normalized_amount_overflow", "0.000001", `"message_key":"Top-up amount cannot exceed {{max}}"`, 20_000_000_000_000},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			router, keys := walletCheckoutFixture(t)
			require.NoError(t, model.DB.AutoMigrate(&model.UserSession{}, &model.AuditLog{}, &model.UserAccessToken{}))
			oldOptions := common.OptionMap
			oldWaffoPrice, oldWaffoMin := setting.WaffoUnitPrice, setting.WaffoMinTopUp
			common.OptionMap = make(map[string]string)
			setting.WaffoUnitPrice, setting.WaffoMinTopUp = 1, 1
			operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeTokens
			t.Cleanup(func() {
				common.OptionMap = oldOptions
				setting.WaffoUnitPrice, setting.WaffoMinTopUp = oldWaffoPrice, oldWaffoMin
			})
			require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 901).Updates(map[string]any{"role": common.RoleRootUser, "auth_version": 1, "group": "default"}).Error)
			require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", 902).Updates(map[string]any{"role": common.RoleCommonUser, "auth_version": 1, "group": "default"}).Error)
			_, rootToken := createAccessTokenTestSession(t, 901, "zero-conversion-root")
			_, userToken := createAccessTokenTestSession(t, 902, "zero-conversion-user")
			router.PUT("/api/option/", middleware.RootAuth(), UpdateOption)
			for _, route := range []struct {
				path    string
				handler gin.HandlerFunc
			}{
				{"/amount", RequestAmount}, {"/pay", RequestEpay},
				{"/waffo/amount", RequestWaffoAmount}, {"/waffo/pay", RequestWaffoPay},
				{"/pancake/amount", RequestWaffoPancakeAmount}, {"/pancake/pay", RequestWaffoPancakePay},
				{"/stripe/amount", RequestStripeAmount}, {"/stripe/pay", RequestStripePay},
			} {
				router.POST(route.path, middleware.DisableCache(), middleware.UserAuth(), route.handler)
			}

			oldClient, oldWaffoTransport := http.DefaultClient, service.WaffoHTTPTransport
			var externalRequests atomic.Int32
			http.DefaultClient = &http.Client{Transport: walletCheckoutTransport(func(*http.Request) (*http.Response, error) {
				externalRequests.Add(1)
				return nil, errors.New("unexpected provider request in invalid conversion fixture")
			})}
			service.WaffoHTTPTransport = walletWaffoSDKTransport(func(context.Context, *waffonet.HttpRequest) (*waffonet.HttpResponse, error) {
				externalRequests.Add(1)
				return nil, errors.New("unexpected provider request in invalid conversion fixture")
			})
			t.Cleanup(func() {
				http.DefaultClient, service.WaffoHTTPTransport = oldClient, oldWaffoTransport
			})
			const body = `{"amount":100,"payment_method":"alipay"}`
			created := accessTokenRequest(router, http.MethodPost, "/pay", userToken, "", body)
			require.Contains(t, created.Body.String(), `"message":"success"`)
			var order model.TopUp
			require.NoError(t, model.DB.First(&order).Error)
			require.NotNil(t, order.CreditedQuota)
			require.Equal(t, 100, *order.CreditedQuota)
			require.Equal(t, 10.0, order.Money)

			// Both rates are valid settings. Reject unsafe new conversions while
			// existing orders keep their frozen credit.
			saved := accessTokenRequest(router, http.MethodPut, "/api/option/", rootToken, "", fmt.Sprintf(`{"key":"QuotaPerUnit","value":%q}`, scenario.conversion))
			require.Contains(t, saved.Body.String(), `"success":true`)
			var option model.Option
			require.NoError(t, model.DB.Where(&model.Option{Key: "QuotaPerUnit"}).First(&option).Error)
			require.Equal(t, scenario.conversion, option.Value)
			for _, path := range []string{"/amount", "/pay", "/waffo/amount", "/waffo/pay", "/pancake/amount", "/pancake/pay", "/stripe/amount", "/stripe/pay"} {
				if scenario.name == "normalized_amount_overflow" && strings.HasPrefix(path, "/stripe/") {
					continue // Stripe uses product quantity, independent of token display.
				}
				t.Run(path, func(t *testing.T) {
					requestBody := fmt.Sprintf(`{"amount":%d,"payment_method":"alipay"}`, scenario.amount)
					if strings.HasPrefix(path, "/stripe/") {
						requestBody = `{"amount":100,"payment_method":"stripe"}`
					}
					var response *httptest.ResponseRecorder
					require.NotPanics(t, func() {
						response = accessTokenRequest(router, http.MethodPost, path, userToken, "", requestBody)
					})
					assert.Equal(t, http.StatusOK, response.Code)
					assert.Contains(t, response.Body.String(), `"message":"error"`)
					if !strings.HasPrefix(path, "/stripe/") {
						assert.Contains(t, response.Body.String(), scenario.messageKey)
					} else {
						assert.Contains(t, response.Body.String(), `"message_key":"Top-up quota must be greater than 0"`)
					}
				})
			}
			assert.Zero(t, externalRequests.Load(), "invalid conversion must be rejected before any provider request")
			var count int64
			require.NoError(t, model.DB.Model(&model.TopUp{}).Count(&count).Error)
			assert.EqualValues(t, 1, count, "invalid conversion must not create a replacement order")
			for range 2 {
				response := httptest.NewRecorder()
				router.ServeHTTP(response, walletWebhookRequest(t, keys, model.PaymentProviderEpay, order.TradeNo, "10.00", true))
				require.Equal(t, "success", response.Body.String())
			}
			var buyer, inviter model.User
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			assert.Equal(t, 90, buyer.Quota)
			assert.Equal(t, 17, inviter.AffQuota)
			require.NoError(t, model.DB.Model(&model.ReferralRebate{}).Count(&count).Error)
			assert.EqualValues(t, 1, count)

			restored := accessTokenRequest(router, http.MethodPut, "/api/option/", rootToken, "", `{"key":"QuotaPerUnit","value":"10"}`)
			require.Contains(t, restored.Body.String(), `"success":true`)
			for _, path := range []string{"/amount", "/waffo/amount", "/pancake/amount"} {
				quoted := accessTokenRequest(router, http.MethodPost, path, userToken, "", body)
				assert.Contains(t, quoted.Body.String(), `"message":"success"`)
				assert.Contains(t, quoted.Body.String(), `"data":"10.00"`)
			}
		})
	}
}

func TestWalletTokenCheckoutCreditsRequestedQuantity(t *testing.T) {
	for _, provider := range []string{model.PaymentProviderEpay, model.PaymentProviderWaffo, model.PaymentProviderWaffoPancake} {
		t.Run(provider, func(t *testing.T) {
			router, keys := walletCheckoutFixture(t)
			common.QuotaPerUnit = 500000
			operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeTokens
			oldWaffoPrice, oldWaffoMin := setting.WaffoUnitPrice, setting.WaffoMinTopUp
			setting.WaffoUnitPrice, setting.WaffoMinTopUp = 1, 1
			inquiryClient, inquiryTransport := http.DefaultClient, service.WaffoHTTPTransport
			t.Cleanup(func() {
				setting.WaffoUnitPrice, setting.WaffoMinTopUp = oldWaffoPrice, oldWaffoMin
				http.DefaultClient, service.WaffoHTTPTransport = inquiryClient, inquiryTransport
			})
			var externalRequests atomic.Int32
			quoteHandler, payHandler := RequestAmount, RequestEpay
			switch provider {
			case model.PaymentProviderWaffo:
				quoteHandler, payHandler = RequestWaffoAmount, RequestWaffoPay
				service.WaffoHTTPTransport = walletWaffoSDKTransport(func(_ context.Context, request *waffonet.HttpRequest) (*waffonet.HttpResponse, error) {
					externalRequests.Add(1)
					if !waffoutils.Verify(string(request.Body), request.Headers["X-SIGNATURE"], keys.PublicKey) {
						return nil, errors.New("invalid merchant checkout signature")
					}
					var outgoing waffoorder.CreateOrderParams
					if err := common.Unmarshal(request.Body, &outgoing); err != nil {
						return nil, err
					}
					assert.Equal(t, "1.50", outgoing.OrderAmount)
					body, err := common.Marshal(map[string]any{"code": "0", "data": waffoorder.CreateOrderData{
						MerchantOrderID: outgoing.MerchantOrderID, PaymentRequestID: outgoing.PaymentRequestID,
						OrderAction: `{"actionType":"REDIRECT","webUrl":"https://checkout.example.invalid/token-quantity"}`,
					}})
					if err != nil {
						return nil, err
					}
					signature, err := waffoutils.Sign(string(body), keys.PrivateKey)
					if err != nil {
						return nil, err
					}
					return waffonet.NewHttpResponse(http.StatusOK, map[string]string{"X-SIGNATURE": signature}, body), nil
				})
			case model.PaymentProviderWaffoPancake:
				quoteHandler, payHandler = RequestWaffoPancakeAmount, RequestWaffoPancakePay
				http.DefaultClient = &http.Client{Transport: walletCheckoutTransport(func(request *http.Request) (*http.Response, error) {
					externalRequests.Add(1)
					body := `{"data":{"token":"fixture","expiresAt":"2099-01-01T00:00:00Z"}}`
					switch request.URL.Path {
					case "/v1/actions/checkout/create-session":
						var outgoing struct {
							PriceSnapshot struct {
								Amount string `json:"amount"`
							} `json:"priceSnapshot"`
						}
						if err := common.DecodeJson(request.Body, &outgoing); err != nil {
							return nil, err
						}
						assert.Equal(t, "1.50", outgoing.PriceSnapshot.Amount)
						body = `{"data":{"sessionId":"CS_fixture","checkoutUrl":"https://checkout.example.invalid/token-quantity","expiresAt":"2099-01-01T00:00:00Z"}}`
					case "/v1/actions/auth/issue-session-token":
					default:
						return nil, fmt.Errorf("unexpected checkout request: %s", request.URL.Path)
					}
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
				})}
			}
			router.POST("/quote", func(c *gin.Context) { c.Set("id", 902) }, quoteHandler)
			router.POST("/checkout", func(c *gin.Context) { c.Set("id", 902) }, payHandler)
			for _, path := range []string{"/quote", "/checkout"} {
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"amount":749999,"payment_method":"alipay"}`))
				request.Header.Set("Content-Type", "application/json")
				router.ServeHTTP(response, request)
				require.Contains(t, response.Body.String(), `"message":"success"`)
				if path == "/quote" {
					assert.Contains(t, response.Body.String(), `"data":"1.50"`)
				} else if provider == model.PaymentProviderEpay {
					assert.Contains(t, response.Body.String(), `"money":"1.50"`)
				}
			}
			var topUp model.TopUp
			require.NoError(t, model.DB.First(&topUp).Error)
			require.NotNil(t, topUp.CreditedQuota)
			assert.Equal(t, 749999, *topUp.CreditedQuota)
			assert.EqualValues(t, 1, topUp.Amount, "legacy display units remain separate from the exact credit snapshot")
			assert.InDelta(t, 1.499998, topUp.Money, 0.000000000001)
			assert.Equal(t, common.TopUpStatusPending, topUp.Status)
			expectedRequests := map[string]int32{model.PaymentProviderEpay: 0, model.PaymentProviderWaffo: 1, model.PaymentProviderWaffoPancake: 2}
			assert.Equal(t, expectedRequests[provider], externalRequests.Load())

			// The signed callback and authenticated inquiry must use the frozen
			// requested quantity, even if conversion settings change after checkout.
			common.QuotaPerUnit = 1
			http.DefaultClient, service.WaffoHTTPTransport = inquiryClient, inquiryTransport
			for range 2 {
				response := httptest.NewRecorder()
				router.ServeHTTP(response, walletWebhookRequest(t, keys, provider, topUp.TradeNo, "1.50", true))
				require.Equal(t, http.StatusOK, response.Code)
				if provider == model.PaymentProviderWaffoPancake {
					assert.Equal(t, "OK", response.Body.String())
				} else {
					assert.Contains(t, response.Body.String(), "success")
				}
			}
			var buyer, inviter model.User
			require.NoError(t, model.DB.First(&buyer, 902).Error)
			require.NoError(t, model.DB.First(&inviter, 901).Error)
			assert.Equal(t, 749989, buyer.Quota)
			assert.Equal(t, 75007, inviter.AffQuota)
			assert.Equal(t, 75011, inviter.AffHistoryQuota)
			var facts []model.ReferralRebate
			require.NoError(t, model.DB.Find(&facts).Error)
			require.Len(t, facts, 1)
			assert.EqualValues(t, 749999, facts[0].CreditedQuota)
			assert.EqualValues(t, 75000, facts[0].RewardQuota)
			require.NoError(t, model.DB.First(&topUp, topUp.Id).Error)
			assert.Equal(t, common.TopUpStatusSuccess, topUp.Status)
			assert.Equal(t, 749999, *topUp.CreditedQuota)
		})
	}
}

func TestValidateTopUpQuotaReturnsMaximumAmount(t *testing.T) {
	oldQuotaPerUnit := common.QuotaPerUnit
	oldDisplayType := operation_setting.GetGeneralSetting().QuotaDisplayType
	common.QuotaPerUnit = 500000
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
	t.Cleanup(func() {
		common.QuotaPerUnit = oldQuotaPerUnit
		operation_setting.GetGeneralSetting().QuotaDisplayType = oldDisplayType
	})

	maxAmount := decimal.NewFromInt(common.MaxWalletQuota).
		Div(decimal.NewFromFloat(common.QuotaPerUnit)).
		Floor().IntPart()

	_, err := validateTopUpQuota(maxAmount, operation_setting.QuotaDisplayTypeUSD, common.QuotaPerUnit)
	require.NoError(t, err)
	_, err = validateTopUpQuota(maxAmount+1, operation_setting.QuotaDisplayTypeUSD, common.QuotaPerUnit)
	require.EqualError(t, err, fmt.Sprintf("Top-up amount cannot exceed %d", maxAmount))
	quota, err := validateTopUpQuota(common.MaxWalletQuota, operation_setting.QuotaDisplayTypeTokens, common.QuotaPerUnit)
	require.NoError(t, err)
	assert.Equal(t, common.MaxWalletQuota, quota)
	_, err = validateTopUpQuota(common.MaxWalletQuota+1, operation_setting.QuotaDisplayTypeTokens, common.QuotaPerUnit)
	require.EqualError(t, err, "Top-up amount cannot exceed 9007199254740991")

	// Token display must also fit the int64 normalized Amount stored by all
	// three channels, even when the final credited quota fits the wallet.
	quota, err = validateTopUpQuota(9_223_372_036_854, operation_setting.QuotaDisplayTypeTokens, 0.000001)
	require.NoError(t, err)
	assert.Equal(t, 9_223_372_036_854, quota)
	for _, amount := range []int64{9_223_372_036_855, 20_000_000_000_000} {
		_, err = validateTopUpQuota(amount, operation_setting.QuotaDisplayTypeTokens, 0.000001)
		require.EqualError(t, err, "Top-up amount cannot exceed 9223372036854")
	}
}

func TestRequestAmountRejectsTopUpThatCannotBeSettled(t *testing.T) {
	oldQuotaPerUnit := common.QuotaPerUnit
	oldDisplayType := operation_setting.GetGeneralSetting().QuotaDisplayType
	common.QuotaPerUnit = 500000
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
	t.Cleanup(func() {
		common.QuotaPerUnit = oldQuotaPerUnit
		operation_setting.GetGeneralSetting().QuotaDisplayType = oldDisplayType
	})

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	maxAmount := decimal.NewFromInt(common.MaxWalletQuota).
		Div(decimal.NewFromFloat(common.QuotaPerUnit)).
		Floor().IntPart()
	ctx.Request = httptest.NewRequest(
		http.MethodPost,
		"/api/user/amount",
		strings.NewReader(fmt.Sprintf(`{"amount":%d}`, maxAmount+1)),
	)
	ctx.Request.Header.Set("Content-Type", "application/json")

	RequestAmount(ctx)

	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.JSONEq(t, fmt.Sprintf(`{"success":false,"message":"error","data":"Top-up amount cannot exceed %d","message_key":"Top-up amount cannot exceed {{max}}","message_params":{"max":%d}}`, maxAmount, maxAmount), recorder.Body.String())
}

func TestRequestAmountRejectsTopUpThatWouldOverflowWallet(t *testing.T) {
	oldQuotaPerUnit := common.QuotaPerUnit
	oldDisplayType := operation_setting.GetGeneralSetting().QuotaDisplayType
	oldDB := model.DB
	common.QuotaPerUnit = 500000
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}))
	model.DB = db
	t.Cleanup(func() {
		common.QuotaPerUnit = oldQuotaPerUnit
		operation_setting.GetGeneralSetting().QuotaDisplayType = oldDisplayType
		model.DB = oldDB
		sqlDB, dbErr := db.DB()
		if dbErr == nil {
			require.NoError(t, sqlDB.Close())
		}
	})

	require.NoError(t, model.DB.Create(&model.User{
		Id:       42,
		Username: "topup_capacity_user",
		Quota:    common.MaxWalletQuota - 100_000,
		Status:   common.UserStatusEnabled,
	}).Error)

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("id", 42)
	ctx.Request = httptest.NewRequest(
		http.MethodPost,
		"/api/user/amount",
		strings.NewReader(`{"amount":1}`),
	)
	ctx.Request.Header.Set("Content-Type", "application/json")

	RequestAmount(ctx)

	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.JSONEq(t, `{"success":false,"message":"error","data":"Top-up quota limit exceeded","message_key":"Top-up quota limit exceeded"}`, recorder.Body.String())
}

func TestValidateCreditedQuotaRejectsOverflow(t *testing.T) {
	_, err := validateCreditedQuota(decimal.NewFromInt(int64(common.MaxWalletQuota / 2)))
	require.NoError(t, err)
	_, err = validateCreditedQuota(decimal.Zero)
	require.EqualError(t, err, "Top-up quota must be greater than 0")
	_, err = validateCreditedQuota(decimal.NewFromInt(common.MaxWalletQuota + 1))
	require.EqualError(
		t,
		err,
		"Top-up quota exceeds the range the system can represent",
	)
}

func TestStripeCreditedQuotaIncludesGroupRatio(t *testing.T) {
	oldQuotaPerUnit := common.QuotaPerUnit
	oldTopupGroupRatio := common.TopupGroupRatio2JSONString()
	common.QuotaPerUnit = 500000
	require.NoError(t, common.UpdateTopupGroupRatioByJSONString(`{"vip":2}`))
	t.Cleanup(func() {
		common.QuotaPerUnit = oldQuotaPerUnit
		require.NoError(t, common.UpdateTopupGroupRatioByJSONString(oldTopupGroupRatio))
	})

	_, err := getStripeCreditedQuota(GetChargedAmount(2147, model.User{Group: "vip"}), common.QuotaPerUnit)
	require.NoError(t, err)
	_, err = getStripeCreditedQuota(GetChargedAmount(2148, model.User{Group: "vip"}), common.QuotaPerUnit)
	require.NoError(t, err)
	_, err = getStripeCreditedQuota(GetChargedAmount(float64(common.MaxWalletQuota), model.User{Group: "vip"}), common.QuotaPerUnit)
	require.Error(t, err)

	require.NoError(t, common.UpdateTopupGroupRatioByJSONString(`{"free":0}`))
	quota, err := getStripeCreditedQuota(GetChargedAmount(1, model.User{Group: "free"}), common.QuotaPerUnit)
	require.NoError(t, err)
	assert.Equal(t, 500000, quota)
}
