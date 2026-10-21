package router

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/stripe/stripe-go/v81/webhook"
	waffoutils "github.com/waffo-com/waffo-go/utils"
	"gorm.io/gorm"
)

// accessTokenExemptRoutes are /api routes that never reach dashboard
// authentication, so a personal access token has no rule to satisfy there.
var accessTokenExemptRoutes = []string{
	// Anonymous pages and setup.
	"GET /api/setup",
	"POST /api/setup",
	"GET /api/status",
	"GET /api/uptime/status",
	"GET /api/notice",
	"GET /api/user-agreement",
	"GET /api/privacy-policy",
	"GET /api/about",
	"GET /api/home_page_content",
	"GET /api/ratio_config",
	"GET /api/user/groups",

	// Anonymous account entry points.
	"GET /api/verification",
	"GET /api/reset_password",
	"POST /api/user/reset",
	"POST /api/user/register",
	"GET /api/user/login/encryption-key",
	"POST /api/user/login",
	"POST /api/user/login/2fa",
	"POST /api/user/login/verify",
	"POST /api/user/login/passkey/begin",
	"POST /api/user/login/passkey/finish",
	"POST /api/user/passkey/login/begin",
	"POST /api/user/passkey/login/finish",
	"GET /api/oauth/wechat",
	"GET /api/oauth/telegram/login",
	"GET /api/oauth/telegram/bind/:flow_token",

	// Browser session cookie endpoints.
	"POST /api/user/auth/refresh",
	"POST /api/user/auth/logout",

	// Payment callbacks.
	"POST /api/stripe/webhook",
	"POST /api/creem/webhook",
	"POST /api/waffo/webhook",
	"POST /api/waffo-pancake/webhook/:env",
	"GET /api/user/epay/notify",
	"POST /api/user/epay/notify",
	"GET /api/subscription/epay/notify",
	"POST /api/subscription/epay/notify",
	"GET /api/subscription/epay/return",
	"POST /api/subscription/epay/return",

	// API key authentication (TokenAuthReadOnly).
	"GET /api/usage/token/",
	"GET /api/log/token",
}

// accessTokenHelperRoutes are declared through handlePermissionRoute outside
// channelPermissionRoutes.
var accessTokenHelperRoutes = map[string]authz.Permission{
	"GET /api/task_plugin_options": authz.TaskPluginBind,
	"GET /api/audit":               authz.AuditRead,
}

func newAccessTokenScopeTestEngine(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	// A permission route that is also in the static table panics here.
	require.NotPanics(t, func() {
		SetApiRouter(engine)
		SetDashboardRouter(engine)
		SetRelayRouter(engine)
		SetTaskPluginProtocolRouter(engine)
		SetVideoRouter(engine)
		SetTaskRouter(engine)
	})
	return engine
}

func TestAccessTokenRouteRulesCoverEveryDashboardRoute(t *testing.T) {
	engine := newAccessTokenScopeTestEngine(t)
	exempt := map[string]bool{}
	for _, key := range accessTokenExemptRoutes {
		exempt[key] = true
	}
	registered := map[string]bool{}
	panel := map[string]bool{}
	for _, route := range engine.Routes() {
		if !strings.HasPrefix(route.Path, "/api/") && !strings.HasPrefix(route.Path, "/pg/") {
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		if !exempt[key] {
			panel[key] = true
		}
	}
	for _, key := range accessTokenExemptRoutes {
		assert.True(t, registered[key], "exempt route %s is no longer registered", key)
	}

	declared := map[string]int{}
	for _, key := range middleware.AccessTokenRouteRuleKeys() {
		declared[key]++
	}
	for key := range panel {
		assert.Equal(t, 1, declared[key], "panel route %s must be declared exactly once", key)
	}
	for key := range declared {
		assert.True(t, panel[key], "declared route %s is not a registered panel route", key)
	}

	permissionRoutes := map[string]authz.Permission{}
	for _, route := range channelPermissionRoutes {
		permissionRoutes[route.method+" "+joinPaths("/api/channel", route.path)] = route.permission
	}
	for key, permission := range accessTokenHelperRoutes {
		permissionRoutes[key] = permission
	}
	for key, permission := range permissionRoutes {
		rule, ok := middleware.AccessTokenRouteRule(key)
		require.True(t, ok, key)
		assert.Equal(t, "scope", rule.Kind(), key)
		assert.Equal(t, service.AccessTokenScopeOf(permission), rule.Scope(), key)
	}
}

func TestAccessTokenCatalogCoversEveryPermission(t *testing.T) {
	catalog := service.AccessTokenCatalog(1, common.RoleRootUser)
	scopes := map[string]bool{}
	resources := map[string]int{}
	for _, group := range catalog {
		for _, resource := range group.Resources {
			resources[resource.Resource]++
			for _, action := range resource.Actions {
				scopes[resource.Resource+":"+action.Action] = true
			}
		}
	}
	for _, permission := range authz.AllPermissions() {
		assert.True(t, scopes[service.AccessTokenScopeOf(permission)], "root catalog lacks %s", service.AccessTokenScopeOf(permission))
	}
	for resource, count := range resources {
		assert.Equal(t, 1, count, "resource %s appears in more than one catalog entry", resource)
	}
}

func TestAccessTokenVerificationScopesAreAllListed(t *testing.T) {
	files, err := filepath.Glob("../service/*.go")
	require.NoError(t, err)
	fileSet := token.NewFileSet()
	var scopes []string
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fileSet, file, nil, 0)
		require.NoError(t, err)
		for _, declaration := range parsed.Decls {
			general, ok := declaration.(*ast.GenDecl)
			if !ok || general.Tok != token.CONST {
				continue
			}
			for _, spec := range general.Specs {
				value := spec.(*ast.ValueSpec)
				for i, name := range value.Names {
					if !strings.HasPrefix(name.Name, "VerificationScope") || i >= len(value.Values) {
						continue
					}
					literal, ok := value.Values[i].(*ast.BasicLit)
					require.True(t, ok, name.Name)
					scope, err := strconv.Unquote(literal.Value)
					require.NoError(t, err)
					scopes = append(scopes, scope)
				}
			}
		}
	}
	require.NotEmpty(t, scopes)
	for _, scope := range scopes {
		_, listed := service.AccessTokenVerificationScope(scope)
		assert.True(t, listed, "verification scope %s has no access token rule", scope)
	}
}

func TestReferralRoutesEnforceIdentityRolesAndTokenScopes(t *testing.T) {
	previousDB, previousLogDB, previousRedis := model.DB, model.LOG_DB, common.RedisEnabled
	previousType := common.MainDatabaseType()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "referral-auth.db")), &gorm.Config{})
	require.NoError(t, err)
	model.DB, model.LOG_DB, common.RedisEnabled = db, db, false
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		model.DB, model.LOG_DB, common.RedisEnabled = previousDB, previousLogDB, previousRedis
		common.SetMainDatabaseType(previousType)
	})
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserAccessToken{}, &model.AuditLog{}, &model.Option{}, &model.ReferralRebate{}, &model.AffiliateTransfer{}, &model.TopUp{}, &model.SubscriptionOrder{}, &model.Log{}))
	require.NoError(t, model.InitializeReferralRebateRule(db))
	users := []model.User{
		{Username: "referral-normal", AffCode: "r-normal", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AffQuota: 321, Group: "default"},
		{Username: "referral-admin", AffCode: "r-admin", Role: common.RoleAdminUser, Status: common.UserStatusEnabled, AffQuota: 654, Group: "default"},
		{Username: "referral-root", AffCode: "r-root", Role: common.RoleRootUser, Status: common.UserStatusEnabled, Group: "default"},
	}
	for i := range users {
		require.NoError(t, db.Create(&users[i]).Error)
	}
	credit := 100
	order := model.TopUp{UserId: users[0].Id, TradeNo: "referral-route-completion", Amount: 100, Money: 90, PaymentProvider: model.PaymentProviderEpay, Status: common.TopUpStatusPending, CreditedQuota: &credit}
	require.NoError(t, db.Create(&order).Error)
	engine := newAccessTokenScopeTestEngine(t)
	for _, tc := range []struct {
		name, method, path, scope, body string
		user                            int
		status                          int
		quota                           string
		failure                         bool
	}{
		{name: "anonymous", method: "GET", path: "/api/user/referral", user: -1, status: http.StatusUnauthorized},
		{name: "own summary ignores injected identity", method: "GET", path: "/api/user/referral?user_id=2", scope: "wallet:read", user: 0, status: http.StatusOK, quota: "321"},
		{name: "own list", method: "GET", path: "/api/user/referral/invitees?user_id=2", scope: "wallet:read", user: 0, status: http.StatusOK},
		{name: "transfer result is a wallet read", method: "GET", path: "/api/user/aff_transfer/abcdefghijklmnop", scope: "wallet:read", user: 0, status: http.StatusOK},
		{name: "profile scope cannot read wallet", method: "GET", path: "/api/user/referral", scope: "profile:read", user: 0, status: http.StatusForbidden},
		{name: "user cannot read admin history", method: "GET", path: "/api/user/referral_rebates", scope: "billing:read", user: 0, status: http.StatusForbidden},
		{name: "admin requires financial read scope", method: "GET", path: "/api/user/referral_rebates", scope: "user:read", user: 1, status: http.StatusForbidden},
		{name: "wallet scope cannot read admin history", method: "GET", path: "/api/user/referral_rebates", scope: "wallet:read", user: 1, status: http.StatusForbidden},
		{name: "admin reads history while disabled", method: "GET", path: "/api/user/referral_rebates", scope: "billing:read", user: 1, status: http.StatusOK},
		{name: "anonymous cannot complete orders", method: "POST", path: "/api/user/topup/complete", user: -1, status: http.StatusUnauthorized, body: `{"trade_no":"referral-route-completion"}`},
		{name: "user billing scope cannot complete orders", method: "POST", path: "/api/user/topup/complete", scope: "billing:write", user: 0, status: http.StatusForbidden, body: `{"trade_no":"referral-route-completion"}`},
		{name: "admin read scope cannot complete orders", method: "POST", path: "/api/user/topup/complete", scope: "billing:read", user: 1, status: http.StatusForbidden, body: `{"trade_no":"referral-route-completion"}`},
		{name: "admin billing write completes pending order", method: "POST", path: "/api/user/topup/complete", scope: "billing:write", user: 1, status: http.StatusOK, body: `{"trade_no":"referral-route-completion"}`},
		{name: "root replay cannot credit completed order again", method: "POST", path: "/api/user/topup/complete", scope: "billing:write", user: 2, status: http.StatusOK, body: `{"trade_no":"referral-route-completion"}`},
		{name: "admin cannot change root settings", method: "PUT", path: "/api/option/referral_rebate", scope: "option:write", user: 1, status: http.StatusForbidden},
		{name: "root needs read scope", method: "GET", path: "/api/option/referral_rebate", scope: "wallet:read", user: 2, status: http.StatusForbidden},
		{name: "root reads rule", method: "GET", path: "/api/option/referral_rebate", scope: "option:read", user: 2, status: http.StatusOK},
		{name: "read scope cannot save", method: "PUT", path: "/api/option/referral_rebate", scope: "option:read", user: 2, status: http.StatusForbidden},
		{name: "root saves complete unconfigured rule", method: "PUT", path: "/api/option/referral_rebate", scope: "option:write", user: 2, status: http.StatusOK, body: `{"enabled":false,"percentage":"","valid_days":""}`},
		{name: "root cannot save only one rule field", method: "PUT", path: "/api/option/referral_rebate", scope: "option:write", user: 2, status: http.StatusOK, body: `{"enabled":true}`, failure: true},
		{name: "general option endpoint cannot bypass rule validation", method: "PUT", path: "/api/option/", scope: "option:write", user: 2, status: http.StatusOK, body: `{"key":"ReferralRebateRule","value":"{}"}`, failure: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			if tc.user >= 0 {
				raw := model.AccessTokenPrefix + strings.Repeat("x", 24) + strconv.Itoa(tc.user) + strings.ReplaceAll(tc.name, " ", "-")
				token := model.UserAccessToken{Name: tc.name, TokenHash: model.AccessTokenFingerprint(raw), TokenHint: model.AccessTokenHint(raw)}
				require.NoError(t, token.SetScopes([]string{tc.scope}))
				require.NoError(t, model.CreateUserAccessToken(users[tc.user].Id, &token, service.AccessTokenMaxPerUser))
				request.Header.Set("Authorization", "Bearer "+raw)
			}
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			assert.Equal(t, tc.status, response.Code, response.Body.String())
			if tc.status == http.StatusOK {
				var result struct {
					Success bool `json:"success"`
					Data    struct {
						AffQuota string `json:"aff_quota"`
					} `json:"data"`
				}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
				assert.Equal(t, !tc.failure, result.Success, response.Body.String())
				if tc.quota != "" {
					assert.Equal(t, tc.quota, result.Data.AffQuota)
				}
			}
		})
	}
	var creditedUser model.User
	require.NoError(t, db.First(&creditedUser, users[0].Id).Error)
	assert.Equal(t, credit, creditedUser.Quota)
	assert.Equal(t, 321, creditedUser.AffQuota)
	require.NoError(t, db.First(&order, order.Id).Error)
	assert.Equal(t, common.TopUpStatusSuccess, order.Status)
	assert.Positive(t, order.CompleteTime)
	var rebateCount int64
	require.NoError(t, db.Model(&model.ReferralRebate{}).Count(&rebateCount).Error)
	assert.Zero(t, rebateCount, "manual completion does not create eligibility for a historical user")

	t.Run("dashboard login sessions enforce identity and revocation", func(t *testing.T) {
		previousLogin, previousEncryption, previousTurnstile := common.PasswordLoginEnabled, common.PasswordLoginEncryptionEnabled, common.TurnstileCheckEnabled
		previousSecret := common.SessionSecret
		common.PasswordLoginEnabled, common.PasswordLoginEncryptionEnabled, common.TurnstileCheckEnabled = true, false, false
		common.SessionSecret = "referral-route-session-test-secret"
		t.Cleanup(func() {
			common.PasswordLoginEnabled, common.PasswordLoginEncryptionEnabled, common.TurnstileCheckEnabled = previousLogin, previousEncryption, previousTurnstile
			common.SessionSecret = previousSecret
		})
		require.NoError(t, db.AutoMigrate(&model.UserSession{}, &model.TwoFA{}, &model.PasskeyCredential{}))
		hash, err := common.HashAccountPassword("referral-session-password")
		require.NoError(t, err)
		require.NoError(t, db.Model(&model.User{}).Where("id IN ?", []int{users[0].Id, users[2].Id}).Update("password", hash).Error)
		for _, userIndex := range []int{0, 2} {
			loginBody, err := common.Marshal(map[string]any{"username": users[userIndex].Username, "password": "referral-session-password"})
			require.NoError(t, err)
			loginRequest := httptest.NewRequest(http.MethodPost, "/api/user/login", strings.NewReader(string(loginBody)))
			loginRequest.Header.Set("Content-Type", "application/json")
			loginResponse := httptest.NewRecorder()
			engine.ServeHTTP(loginResponse, loginRequest)
			var login struct {
				Success bool `json:"success"`
				Data    struct {
					AccessToken string `json:"access_token"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(loginResponse.Body.Bytes(), &login))
			require.True(t, login.Success, loginResponse.Body.String())
			require.NotEmpty(t, login.Data.AccessToken)
			for _, path := range []string{"/api/user/referral?user_id=2", "/api/option/referral_rebate"} {
				request := httptest.NewRequest(http.MethodGet, path, nil)
				request.Header.Set("Authorization", "Bearer "+login.Data.AccessToken)
				response := httptest.NewRecorder()
				engine.ServeHTTP(response, request)
				expectedStatus := http.StatusOK
				if userIndex == 0 && path == "/api/option/referral_rebate" {
					expectedStatus = http.StatusForbidden
				}
				assert.Equal(t, expectedStatus, response.Code, response.Body.String())
				if userIndex == 0 && strings.Contains(path, "/user/referral") {
					assert.Contains(t, response.Body.String(), `"aff_quota":"321"`)
					assert.NotContains(t, response.Body.String(), `"aff_quota":"654"`)
				}
			}
			cookieRequest := httptest.NewRequest(http.MethodPut, "/api/option/referral_rebate", strings.NewReader(`{"enabled":false,"percentage":"","valid_days":""}`))
			cookieRequest.Header.Set("Origin", "https://untrusted.example")
			for _, cookie := range loginResponse.Result().Cookies() {
				cookieRequest.AddCookie(cookie)
			}
			cookieResponse := httptest.NewRecorder()
			engine.ServeHTTP(cookieResponse, cookieRequest)
			assert.Equal(t, http.StatusUnauthorized, cookieResponse.Code, "refresh cookies alone cannot authorize a rule write")
			identity, err := service.ParseAccessToken(login.Data.AccessToken)
			require.NoError(t, err)
			_, err = model.RevokeUserSession(users[userIndex].Id, identity.SessionID, "referral_route_test")
			require.NoError(t, err)
			revokedRequest := httptest.NewRequest(http.MethodGet, "/api/user/referral", nil)
			revokedRequest.Header.Set("Authorization", "Bearer "+login.Data.AccessToken)
			revokedResponse := httptest.NewRecorder()
			engine.ServeHTTP(revokedResponse, revokedRequest)
			assert.Equal(t, http.StatusUnauthorized, revokedResponse.Code, revokedResponse.Body.String())
		}
	})
}

// Exercise the real public routing/middleware chain, rather than mounting a
// callback directly. These local signed notifications do not prove that a real
// payment provider has accepted a charge or can reach a deployed callback URL.
func TestWalletPaymentRoutesVerifySignaturesAndSettleOnce(t *testing.T) {
	previousDB, previousLogDB, previousRedis := model.DB, model.LOG_DB, common.RedisEnabled
	previousMainType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "payment-routes.db")), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB, model.LOG_DB, common.RedisEnabled = db, db, false
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	previousRateEnabled, previousRateNum, previousRateDuration := common.GlobalApiRateLimitEnable, common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration
	previousBodyLimit := constant.AnonymousRequestBodyLimitKB
	common.GlobalApiRateLimitEnable, common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration = true, 1000, 180
	constant.AnonymousRequestBodyLimitKB = 1
	t.Cleanup(func() {
		model.DB, model.LOG_DB, common.RedisEnabled = previousDB, previousLogDB, previousRedis
		common.SetDatabaseTypes(previousMainType, previousLogType)
		common.GlobalApiRateLimitEnable, common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration = previousRateEnabled, previousRateNum, previousRateDuration
		constant.AnonymousRequestBodyLimitKB = previousBodyLimit
		require.NoError(t, sqlDB.Close())
	})
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserAccessToken{}, &model.AuditLog{}, &model.Option{}, &model.ReferralRebate{}, &model.TopUp{}, &model.SubscriptionOrder{}, &model.Log{}))
	paymentSetting := operation_setting.GetPaymentSetting()
	previousCompliance, previousTerms := paymentSetting.ComplianceConfirmed, paymentSetting.ComplianceTermsVersion
	paymentSetting.ComplianceConfirmed, paymentSetting.ComplianceTermsVersion = true, operation_setting.CurrentComplianceTermsVersion
	t.Cleanup(func() {
		paymentSetting.ComplianceConfirmed, paymentSetting.ComplianceTermsVersion = previousCompliance, previousTerms
	})
	require.NoError(t, model.InitializeReferralRebateRule(db))
	require.NoError(t, model.SaveReferralRebateRule(model.ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 30}))
	keys, err := waffoutils.GenerateKeyPair()
	require.NoError(t, err)
	wrongKeys, err := waffoutils.GenerateKeyPair()
	require.NoError(t, err)
	merchantKeys, err := waffoutils.GenerateKeyPair()
	require.NoError(t, err)
	stringsToRestore := []*string{
		&setting.StripeApiSecret, &setting.StripeWebhookSecret, &setting.StripePriceId,
		&setting.CreemApiKey, &setting.CreemProducts, &setting.CreemWebhookSecret,
		&setting.WaffoApiKey, &setting.WaffoPrivateKey, &setting.WaffoPublicCert, &setting.WaffoMerchantId,
		&setting.WaffoPancakeMerchantID, &setting.WaffoPancakePrivateKey, &setting.WaffoPancakeProductID, &setting.WaffoPancakeStoreID,
		&operation_setting.PayAddress, &operation_setting.EpayId, &operation_setting.EpayKey,
	}
	previousStrings := make([]string, len(stringsToRestore))
	for i, value := range stringsToRestore {
		previousStrings[i] = *value
	}
	previousWaffoEnabled, previousSandbox, previousCreemTest, previousMethods := setting.WaffoEnabled, setting.WaffoSandbox, setting.CreemTestMode, operation_setting.PayMethods
	t.Cleanup(func() {
		for i, value := range stringsToRestore {
			*value = previousStrings[i]
		}
		setting.WaffoEnabled, setting.WaffoSandbox, setting.CreemTestMode, operation_setting.PayMethods = previousWaffoEnabled, previousSandbox, previousCreemTest, previousMethods
	})
	setting.StripeApiSecret, setting.StripeWebhookSecret, setting.StripePriceId = "sk_test_route_fixture", "whsec_route_fixture", "price_route_fixture"
	setting.CreemApiKey, setting.CreemProducts, setting.CreemWebhookSecret = "creem_route_key", "[{}]", "creem_route_secret"
	setting.CreemTestMode = false
	setting.WaffoEnabled, setting.WaffoSandbox = true, false
	setting.WaffoApiKey, setting.WaffoPrivateKey, setting.WaffoPublicCert, setting.WaffoMerchantId = "waffo_route_key", merchantKeys.PrivateKey, keys.PublicKey, "merchant_route_fixture"
	setting.WaffoPancakeMerchantID, setting.WaffoPancakePrivateKey, setting.WaffoPancakeProductID, setting.WaffoPancakeStoreID = "merchant_route_fixture", keys.PrivateKey, "product_route_fixture", "store_route_fixture"
	// This is the SDK's existing public-key injection contract, not a mock of
	// signature verification and not an application-level verification bypass.
	t.Setenv("WAFFO_WEBHOOK_TEST_PUBLIC_KEY", keys.PublicKey)
	t.Setenv("WAFFO_WEBHOOK_PROD_PUBLIC_KEY", "")
	t.Setenv("WAFFO_WEBHOOK_PUBLIC_KEY", "")
	operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey = "https://pay.example.invalid", "epay_route_id", "epay_route_secret"
	operation_setting.PayMethods = []map[string]string{{"type": "alipay"}}
	engine := newAccessTokenScopeTestEngine(t)
	admin := model.User{Username: "payment-route-admin", AffCode: "route-admin", Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Group: "default"}
	require.NoError(t, db.Create(&admin).Error)
	adminRaw := model.AccessTokenPrefix + strings.Repeat("a", 32)
	adminToken := model.UserAccessToken{Name: "payment-route-admin", TokenHash: model.AccessTokenFingerprint(adminRaw), TokenHint: model.AccessTokenHint(adminRaw)}
	require.NoError(t, adminToken.SetScopes([]string{"billing:read", "billing:write"}))
	require.NoError(t, model.CreateUserAccessToken(admin.Id, &adminToken, service.AccessTokenMaxPerUser))
	for i, tc := range []struct{ provider, method string }{
		{model.PaymentProviderEpay, http.MethodGet}, {model.PaymentProviderEpay, http.MethodPost},
		{model.PaymentProviderStripe, http.MethodPost}, {model.PaymentProviderCreem, http.MethodPost},
		{model.PaymentProviderWaffo, http.MethodPost}, {model.PaymentProviderWaffoPancake, http.MethodPost},
	} {
		t.Run(tc.provider+"/"+tc.method, func(t *testing.T) {
			name := "route-" + tc.provider + "-" + tc.method
			now := time.Now().Unix()
			inviter := model.User{Username: "route-inviter-" + strconv.Itoa(i), AffCode: "route-aff-" + strconv.Itoa(i), Status: common.UserStatusEnabled, Role: common.RoleCommonUser, AffQuota: 7, AffHistoryQuota: 11, Group: "default"}
			require.NoError(t, db.Create(&inviter).Error)
			buyer := model.User{Username: "route-buyer-" + strconv.Itoa(i), AffCode: "route-buyer-aff-" + strconv.Itoa(i), Status: common.UserStatusEnabled, Role: common.RoleCommonUser, Quota: -10, InviterId: inviter.Id, CreatedAt: now - 60, ReferralRateBPS: 1000, ReferralExpiresAt: now + 3600, Group: "default"}
			require.NoError(t, db.Create(&buyer).Error)
			credit, merchant := 1000, setting.WaffoMerchantId
			money := 90.0
			if tc.provider == model.PaymentProviderStripe {
				money = 100
			}
			method := tc.provider
			if method == model.PaymentProviderEpay {
				method = "alipay"
			}
			order := model.TopUp{UserId: buyer.Id, TradeNo: name, Amount: 100, Money: money, PaymentMethod: method, PaymentProvider: tc.provider, Status: common.TopUpStatusPending, CreditedQuota: &credit}
			if tc.provider == model.PaymentProviderCreem {
				order.Amount = 1000
			}
			if tc.provider == model.PaymentProviderWaffo {
				order.WaffoMerchantID = &merchant
			}
			require.NoError(t, db.Create(&order).Error)
			foreignProvider := model.PaymentProviderEpay
			if tc.provider == model.PaymentProviderEpay {
				foreignProvider = model.PaymentProviderStripe
			}
			foreign := model.TopUp{UserId: buyer.Id, TradeNo: name + "-foreign", Amount: 100, Money: money, PaymentProvider: foreignProvider, Status: common.TopUpStatusPending, CreditedQuota: &credit}
			require.NoError(t, db.Create(&foreign).Error)
			variants := []string{"wrong-key", "tampered", "missing-signature", "malformed-signature", "unrelated-event", "wrong-binding", "cross-channel"}
			if tc.method == http.MethodPost {
				variants = append(variants, "oversized-body")
			}
			if tc.provider == model.PaymentProviderStripe || tc.provider == model.PaymentProviderWaffoPancake {
				variants = append(variants, "expired-signature")
			}
			variants = append(variants, "valid", "duplicate", "manual-replay")
			for _, variant := range variants {
				t.Run(variant, func(t *testing.T) {
					signingKeys := keys
					if variant == "wrong-key" {
						signingKeys = wrongKeys
					}
					request := signedPaymentRouteRequest(t, signingKeys, tc.provider, name, buyer.Id, variant)
					if tc.method == http.MethodGet {
						body, err := io.ReadAll(request.Body)
						require.NoError(t, err)
						request = httptest.NewRequest(http.MethodGet, request.URL.Path+"?"+string(body), nil)
					}
					if variant == "manual-replay" {
						body, err := common.Marshal(map[string]string{"trade_no": name})
						require.NoError(t, err)
						request = httptest.NewRequest(http.MethodPost, "/api/user/topup/complete", bytes.NewReader(body))
						request.Header.Set("Content-Type", "application/json")
						request.Header.Set("Authorization", "Bearer "+adminRaw)
					}
					request.RemoteAddr = "198.51.100." + strconv.Itoa(40+i) + ":10000"
					response := httptest.NewRecorder()
					engine.ServeHTTP(response, request)
					settled := variant == "valid" || variant == "duplicate" || variant == "manual-replay"
					wantStatus := http.StatusOK
					switch variant {
					case "wrong-key", "tampered", "missing-signature", "malformed-signature", "expired-signature":
						switch tc.provider {
						case model.PaymentProviderStripe, model.PaymentProviderWaffo:
							wantStatus = http.StatusBadRequest
						case model.PaymentProviderCreem, model.PaymentProviderWaffoPancake:
							wantStatus = http.StatusUnauthorized
						}
					case "cross-channel":
						if tc.provider == model.PaymentProviderStripe || tc.provider == model.PaymentProviderCreem {
							wantStatus = http.StatusInternalServerError
						}
					case "oversized-body":
						wantStatus = http.StatusRequestEntityTooLarge
					}
					assert.Equal(t, wantStatus, response.Code, response.Body.String())
					if wantStatus == http.StatusOK {
						if variant == "manual-replay" {
							assert.Contains(t, response.Body.String(), "\"success\":true")
						} else if tc.provider == model.PaymentProviderEpay {
							wantBody := "fail"
							if settled || variant == "unrelated-event" {
								wantBody = "success"
							}
							assert.Equal(t, wantBody, response.Body.String())
						} else if tc.provider == model.PaymentProviderWaffo {
							assert.True(t, waffoutils.Verify(response.Body.String(), response.Header().Get("X-SIGNATURE"), merchantKeys.PublicKey))
							if settled || variant == "unrelated-event" {
								assert.Contains(t, response.Body.String(), "\"message\":\"success\"")
							} else {
								assert.Contains(t, response.Body.String(), "\"message\":\"failed\"")
							}
						}
					}
					require.NoError(t, db.First(&buyer, buyer.Id).Error)
					require.NoError(t, db.First(&inviter, inviter.Id).Error)
					require.NoError(t, db.First(&order, order.Id).Error)
					require.NoError(t, db.First(&foreign, foreign.Id).Error)
					assert.Equal(t, common.TopUpStatusPending, foreign.Status)
					assert.Zero(t, foreign.CompleteTime)
					var foreignFacts int64
					require.NoError(t, db.Model(&model.ReferralRebate{}).Where("top_up_id = ?", foreign.Id).Count(&foreignFacts).Error)
					assert.Zero(t, foreignFacts)
					var facts []model.ReferralRebate
					require.NoError(t, db.Where("top_up_id = ?", order.Id).Find(&facts).Error)
					if settled {
						assert.Equal(t, 990, buyer.Quota)
						assert.Equal(t, 107, inviter.AffQuota)
						assert.Equal(t, 111, inviter.AffHistoryQuota)
						assert.Equal(t, common.TopUpStatusSuccess, order.Status)
						if tc.provider == model.PaymentProviderEpay {
							assert.Equal(t, "wxpay", order.PaymentMethod)
						}
						assert.GreaterOrEqual(t, order.CompleteTime, now)
						require.Len(t, facts, 1)
						assert.Equal(t, order.Id, facts[0].TopUpID)
						assert.Equal(t, name, facts[0].TradeNo)
						assert.Equal(t, inviter.Id, facts[0].InviterID)
						assert.Equal(t, buyer.Id, facts[0].InviteeID)
						assert.EqualValues(t, 1000, facts[0].CreditedQuota)
						assert.EqualValues(t, 100, facts[0].RewardQuota)
					} else {
						assert.Equal(t, -10, buyer.Quota)
						assert.Equal(t, 7, inviter.AffQuota)
						assert.Equal(t, 11, inviter.AffHistoryQuota)
						assert.Equal(t, common.TopUpStatusPending, order.Status)
						assert.Zero(t, order.CompleteTime)
						assert.Empty(t, facts)
					}
				})
			}
			// Close the HTTP chain with actual token authentication, never c.Set(id).
			raw := model.AccessTokenPrefix + strings.Repeat("u", 24) + strconv.Itoa(inviter.Id)
			token := model.UserAccessToken{Name: name, TokenHash: model.AccessTokenFingerprint(raw), TokenHint: model.AccessTokenHint(raw)}
			require.NoError(t, token.SetScopes([]string{"wallet:read"}))
			require.NoError(t, model.CreateUserAccessToken(inviter.Id, &token, service.AccessTokenMaxPerUser))
			summaryRequest := httptest.NewRequest(http.MethodGet, "/api/user/referral", nil)
			summaryRequest.Header.Set("Authorization", "Bearer "+raw)
			summaryResponse := httptest.NewRecorder()
			engine.ServeHTTP(summaryResponse, summaryRequest)
			require.Equal(t, http.StatusOK, summaryResponse.Code, summaryResponse.Body.String())
			var summary struct {
				Success bool
				Data    model.ReferralSummary
			}
			require.NoError(t, common.Unmarshal(summaryResponse.Body.Bytes(), &summary))
			assert.True(t, summary.Success)
			assert.Equal(t, "107", summary.Data.AffQuota)
			assert.Equal(t, "111", summary.Data.AffHistoryQuota)
			assert.Equal(t, "100", summary.Data.RebateQuota)
			assert.EqualValues(t, 1, summary.Data.DirectCount)
			query := "/api/user/referral_rebates?inviter_id=" + strconv.Itoa(inviter.Id) + "&trade_no=" + url.QueryEscape(name)
			adminRequest := httptest.NewRequest(http.MethodGet, query, nil)
			adminRequest.Header.Set("Authorization", "Bearer "+adminRaw)
			adminResponse := httptest.NewRecorder()
			engine.ServeHTTP(adminResponse, adminRequest)
			require.Equal(t, http.StatusOK, adminResponse.Code, adminResponse.Body.String())
			var page struct {
				Success bool
				Data    model.ReferralRebatePage
			}
			require.NoError(t, common.Unmarshal(adminResponse.Body.Bytes(), &page))
			assert.True(t, page.Success)
			assert.EqualValues(t, 1, page.Data.Total)
			assert.Equal(t, "1000", page.Data.CreditedQuota)
			assert.Equal(t, "100", page.Data.RewardQuota)
			require.Len(t, page.Data.Items, 1)
			assert.Equal(t, order.Id, page.Data.Items[0].TopUpID)
			assert.Equal(t, inviter.Id, page.Data.Items[0].InviterID)
			assert.Equal(t, buyer.Id, page.Data.Items[0].InviteeID)
		})
	}
}

// Generate protocol signatures with the installed SDK algorithms and local
// credentials, then let SetApiRouter read the original bytes and authenticate.
func signedPaymentRouteRequest(t *testing.T, keys *waffoutils.KeyPair, provider, tradeNo string, buyerID int, variant string) *http.Request {
	t.Helper()
	if variant == "cross-channel" {
		tradeNo += "-foreign"
	}
	if provider == model.PaymentProviderEpay {
		params := map[string]string{"pid": operation_setting.EpayId, "type": "alipay", "name": "route fixture", "out_trade_no": tradeNo, "trade_status": epay.StatusTradeSuccess, "money": "90.00", "sign_type": "MD5"}
		if variant == "unrelated-event" {
			params["trade_status"] = "WAIT_BUYER_PAY"
		}
		if variant == "wrong-binding" {
			params["out_trade_no"] += "-unknown"
		}
		// Epay reports the final chosen method; it may legitimately differ
		// from the original checkout. Provider/order binding is the guard.
		if variant == "valid" || variant == "duplicate" {
			params["type"] = "wxpay"
		}
		secret := operation_setting.EpayKey
		if variant == "wrong-key" {
			secret += "_wrong"
		}
		signed, err := epay.GenerateParamsWithError(params, secret)
		require.NoError(t, err)
		switch variant {
		case "tampered":
			signed["name"] += " changed"
		case "missing-signature":
			delete(signed, "sign")
		case "malformed-signature":
			signed["sign"] = "invalid"
		}
		encoded := make(url.Values, len(signed))
		for key, value := range signed {
			encoded.Set(key, value)
		}
		body := encoded.Encode()
		if variant == "oversized-body" {
			body = strings.Repeat("x", 1025)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/user/epay/notify", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		return request
	}
	path := "/api/" + provider + "/webhook"
	var payload map[string]any
	switch provider {
	case model.PaymentProviderStripe:
		object := map[string]any{"id": "cs_route_fixture", "mode": "payment", "payment_link": nil, "status": "complete", "payment_status": "paid", "client_reference_id": tradeNo, "customer": "cus_route_fixture", "currency": "usd", "amount_total": 9000}
		eventType := "checkout.session.completed"
		if variant == "unrelated-event" {
			eventType = "customer.created"
		}
		if variant == "wrong-binding" {
			object["payment_link"] = "plink_other"
		}
		payload = map[string]any{"id": "evt_route_fixture", "object": "event", "type": eventType, "data": map[string]any{"object": object}}
	case model.PaymentProviderCreem:
		eventType := "checkout.completed"
		if variant == "unrelated-event" {
			eventType = "checkout.expired"
		}
		orderType := "onetime"
		if variant == "wrong-binding" {
			orderType = "recurring"
		}
		payload = map[string]any{"id": "evt_route_fixture", "eventType": eventType, "object": map[string]any{"id": "ch_route_fixture", "request_id": tradeNo, "order": map[string]any{"id": "ord_route_fixture", "status": "paid", "type": orderType, "currency": "USD", "amount": 9000, "amount_paid": 9000}}}
	case model.PaymentProviderWaffo:
		eventType, merchant := "PAYMENT_NOTIFICATION", setting.WaffoMerchantId
		if variant == "unrelated-event" {
			eventType = "UNRELATED_NOTIFICATION"
		}
		if variant == "wrong-binding" {
			merchant = "other_merchant"
		}
		payload = map[string]any{"eventType": eventType, "result": map[string]any{"merchantOrderId": tradeNo, "paymentRequestId": tradeNo, "orderStatus": "PAY_SUCCESS", "orderAmount": "90.00", "orderCurrency": "USD", "merchantInfo": map[string]any{"merchantId": merchant}}}
	case model.PaymentProviderWaffoPancake:
		path = "/api/waffo-pancake/webhook/test"
		eventType := "order.completed"
		if variant == "unrelated-event" {
			eventType = "order.pending"
		}
		if variant == "wrong-binding" {
			path = "/api/waffo-pancake/webhook/prod"
		}
		payload = map[string]any{"id": "evt_route_fixture", "eventType": eventType, "mode": "test", "storeId": setting.WaffoPancakeStoreID, "data": map[string]any{"orderId": "ORD_route_fixture", "orderMerchantExternalId": tradeNo, "merchantProvidedBuyerIdentity": service.WaffoPancakeBuyerIdentityFromUserID(buyerID), "amount": "90.00", "currency": "USD"}}
	default:
		t.Fatalf("unsupported payment fixture provider %s", provider)
	}
	body, err := common.Marshal(payload)
	require.NoError(t, err)
	header, signature := "", ""
	switch provider {
	case model.PaymentProviderStripe:
		secret := setting.StripeWebhookSecret
		if variant == "wrong-key" {
			secret += "_wrong"
		}
		timestamp := time.Now()
		if variant == "expired-signature" {
			timestamp = timestamp.Add(-6 * time.Minute)
		}
		signed := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{Payload: body, Secret: secret, Timestamp: timestamp})
		header, signature = "Stripe-Signature", signed.Header
	case model.PaymentProviderCreem:
		secret := setting.CreemWebhookSecret
		if variant == "wrong-key" {
			secret += "_wrong"
		}
		mac := hmac.New(sha256.New, []byte(secret))
		_, err = mac.Write(body)
		require.NoError(t, err)
		header, signature = "creem-signature", hex.EncodeToString(mac.Sum(nil))
	case model.PaymentProviderWaffo:
		header = "X-SIGNATURE"
		signature, err = waffoutils.Sign(string(body), keys.PrivateKey)
		require.NoError(t, err)
	case model.PaymentProviderWaffoPancake:
		timestamp := time.Now()
		if variant == "expired-signature" {
			timestamp = timestamp.Add(-46 * time.Minute)
		}
		millis := strconv.FormatInt(timestamp.UnixMilli(), 10)
		signed, err := waffoutils.Sign(millis+"."+string(body), keys.PrivateKey)
		require.NoError(t, err)
		header, signature = "X-Waffo-Signature", "t="+millis+",v1="+signed
	}
	switch variant {
	case "tampered":
		body = append(body, ' ')
	case "malformed-signature":
		signature = "invalid"
	case "missing-signature":
		signature = ""
	case "oversized-body":
		body = []byte(strings.Repeat("x", 1025))
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if signature != "" {
		request.Header.Set(header, signature)
	}
	return request
}
