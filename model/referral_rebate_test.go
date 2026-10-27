package model

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func referralFixture(t *testing.T, rate int) (User, User) {
	t.Helper()
	truncateTables(t)
	settings := operation_setting.GetPaymentSetting()
	previous := *settings
	settings.ComplianceConfirmed = true
	settings.ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
	t.Cleanup(func() { *settings = previous })
	require.NoError(t, InitializeReferralRebateRule(DB))
	require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: rate, ValidDays: 1}))
	inviter := User{Username: "referral-inviter", AffCode: "referral-inviter", Status: common.UserStatusEnabled}
	require.NoError(t, DB.Create(&inviter).Error)
	invitee := User{Username: "referral-invitee", AffCode: "referral-invitee", Status: common.UserStatusEnabled, InviterId: inviter.Id, CreatedAt: time.Now().Unix(), ReferralRateBPS: rate, ReferralExpiresAt: time.Now().Unix() + 86400}
	require.NoError(t, DB.Create(&invitee).Error)
	return inviter, invitee
}

func TestReferralRuleInitializationDefaultsAndPreservesExistingAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, dsn := newReferralIntegrationDatabase(t, dialect)
			require.NoError(t, db.AutoMigrate(&Option{}))
			for _, outcome := range runReferralProcessRace(t, dialect, dsn,
				referralProcessOperation{Mode: "initialize_rule"},
				referralProcessOperation{Mode: "initialize_rule"}) {
				require.Empty(t, outcome.Error, "independent startup processes must initialize one missing rule")
			}
			for range 2 {
				require.NoError(t, db.AutoMigrate(&Option{}))
				require.NoError(t, InitializeReferralRebateRule(db))
				rule, err := readReferralRebateRule(db, false)
				require.NoError(t, err)
				assert.Equal(t, ReferralRebateRule{Enabled: false, RateBPS: 500, ValidDays: 7}, rule)
			}
			for _, tc := range []struct {
				name string
				rule ReferralRebateRule
			}{
				{"legacy_unconfigured", ReferralRebateRule{}},
				{"configured_pause", ReferralRebateRule{RateBPS: 1250, ValidDays: 20}},
				{"configured_enabled", ReferralRebateRule{Enabled: true, RateBPS: 2500, ValidDays: 60}},
			} {
				t.Run(tc.name, func(t *testing.T) {
					value, err := common.Marshal(tc.rule)
					require.NoError(t, err)
					require.NoError(t, db.Model(&Option{}).Where(&Option{Key: ReferralRebateOptionKey}).Update("value", string(value)).Error)
					for range 2 {
						require.NoError(t, InitializeReferralRebateRule(db))
						rule, err := readReferralRebateRule(db, false)
						require.NoError(t, err)
						assert.Equal(t, tc.rule, rule, "startup must preserve the existing rule")
					}
					for _, outcome := range runReferralProcessRace(t, dialect, dsn,
						referralProcessOperation{Mode: "initialize_rule"},
						referralProcessOperation{Mode: "initialize_rule"}) {
						require.Empty(t, outcome.Error)
					}
					rule, err := readReferralRebateRule(db, false)
					require.NoError(t, err)
					assert.Equal(t, tc.rule, rule, "concurrent startup must preserve the saved rule")
				})
			}
			for _, damaged := range []string{"", "null", "{}", "invalid-json"} {
				require.NoError(t, db.Model(&Option{}).Where(&Option{Key: ReferralRebateOptionKey}).Update("value", damaged).Error)
				require.NoError(t, InitializeReferralRebateRule(db))
				var stored Option
				require.NoError(t, db.Where(&Option{Key: ReferralRebateOptionKey}).First(&stored).Error)
				assert.Equal(t, damaged, stored.Value, "startup must not silently replace damaged persisted configuration")
				_, err := readReferralRebateRule(db, false)
				assert.ErrorIs(t, err, ErrInvalidReferralRule)
			}
			var count int64
			require.NoError(t, db.Model(&Option{}).Where(&Option{Key: ReferralRebateOptionKey}).Count(&count).Error)
			assert.EqualValues(t, 1, count)
		})
	}
}

func TestReferralDefaultRuleRegistrationAndActivationAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB, previousLogDB, previousRedis := DB, LOG_DB, common.RedisEnabled
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousPayment := *operation_setting.GetPaymentSetting()
			previousNew, previousInvitee, previousInviter := common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter
			DB, LOG_DB, common.RedisEnabled = db, db, false
			kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(kind, kind)
			common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter = 0, 0, 0
			payment := operation_setting.GetPaymentSetting()
			payment.ComplianceConfirmed = true
			payment.ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
			t.Cleanup(func() {
				DB, LOG_DB, common.RedisEnabled = previousDB, previousLogDB, previousRedis
				common.SetDatabaseTypes(previousMain, previousLog)
				*payment = previousPayment
				common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter = previousNew, previousInvitee, previousInviter
			})
			require.NoError(t, db.AutoMigrate(&User{}, &Option{}, &TopUp{}, &ReferralRebate{}, &SubscriptionOrder{}, &Log{}))
			require.NoError(t, InitializeReferralRebateRule(db))
			inviter := User{Username: "default-owner", AffCode: "default-owner", Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&inviter).Error)
			legacy := User{Username: "default-legacy", AffCode: "default-legacy", InviterId: inviter.Id, Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&legacy).Error)
			closed := User{Username: "default-closed", RegistrationAffCode: inviter.AffCode, Status: common.UserStatusEnabled}
			require.NoError(t, closed.Insert(0))
			assert.Equal(t, inviter.Id, closed.InviterId)
			assert.Positive(t, closed.CreatedAt)
			assert.Zero(t, closed.ReferralRateBPS)
			assert.Zero(t, closed.ReferralExpiresAt)
			rule, err := GetReferralRebateRule()
			require.NoError(t, err)
			rule.Enabled = true
			payment.ComplianceConfirmed = false
			require.Error(t, SaveReferralRebateRule(rule), "default values cannot bypass the compliance switch")
			saved, err := GetReferralRebateRule()
			require.NoError(t, err)
			assert.False(t, saved.Enabled)
			payment.ComplianceConfirmed = true
			require.NoError(t, SaveReferralRebateRule(rule))
			active := User{Username: "default-active", RegistrationAffCode: inviter.AffCode, Status: common.UserStatusEnabled}
			require.NoError(t, active.Insert(0))
			assert.Equal(t, 500, active.ReferralRateBPS)
			assert.Equal(t, active.CreatedAt+7*86400, active.ReferralExpiresAt)
			require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1250, ValidDays: 30}))
			for range 2 {
				require.NoError(t, InitializeReferralRebateRule(db))
			}
			credit := 100
			for _, user := range []User{legacy, closed, active} {
				var stored User
				require.NoError(t, db.First(&stored, user.Id).Error)
				assert.Equal(t, user.CreatedAt, stored.CreatedAt)
				assert.Equal(t, user.ReferralRateBPS, stored.ReferralRateBPS)
				assert.Equal(t, user.ReferralExpiresAt, stored.ReferralExpiresAt)
				order := TopUp{UserId: user.Id, TradeNo: user.Username, CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
				require.NoError(t, order.Insert())
				_, err := RechargeEpay(order.TradeNo, "", "")
				require.NoError(t, err)
				require.NoError(t, db.First(&stored, user.Id).Error)
				assert.Equal(t, credit, stored.Quota)
			}
			for _, enabled := range []bool{false, true} {
				require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: enabled, RateBPS: 1250, ValidDays: 30}))
				order := TopUp{UserId: active.Id, TradeNo: "default-resume-" + strconv.FormatBool(enabled), CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
				require.NoError(t, order.Insert())
				_, err := RechargeEpay(order.TradeNo, "", "")
				require.NoError(t, err)
			}
			var facts []ReferralRebate
			require.NoError(t, db.Order("id").Find(&facts).Error)
			require.Len(t, facts, 2, "old/closed users and paused payments never acquire retroactive rewards")
			for _, fact := range facts {
				assert.Equal(t, active.Id, fact.InviteeID)
				assert.Equal(t, 500, fact.RateBPS)
				assert.EqualValues(t, 5, fact.RewardQuota)
			}
			require.NoError(t, db.First(&inviter, inviter.Id).Error)
			assert.Equal(t, 10, inviter.AffQuota)
			assert.Equal(t, 10, inviter.AffHistoryQuota)
			require.NoError(t, db.First(&active, active.Id).Error)
			assert.Equal(t, 300, active.Quota)
		})
	}
}

func TestReferralRuleRejectsInvalidPrecisionAndPreservesCommittedRule(t *testing.T) {
	referralFixture(t, 1000)
	for _, percentage := range []string{"0", "-1", "NaN", "Inf", "100.01", "0.001", "10.000", "1e1", "", "0x10", "10%"} {
		_, err := ParseReferralRebateRule(true, percentage, "1")
		assert.Error(t, err, percentage)
	}
	for _, days := range []string{"0", "-1", "1.5", "1e1", "9223372036854775807", "", "999999999999999999999"} {
		_, err := ParseReferralRebateRule(true, "10", days)
		assert.Error(t, err, days)
	}
	for _, tc := range []struct {
		input string
		bps   int
	}{{"0.01", 1}, {"10", 1000}, {"10.25", 1025}, {"100.00", 10000}} {
		rule, err := ParseReferralRebateRule(true, tc.input, "30")
		require.NoError(t, err)
		assert.Equal(t, tc.bps, rule.RateBPS)
	}
	_, err := ParseReferralRebateRule(false, "", "")
	require.NoError(t, err)
	assert.Error(t, SaveReferralRebateRule(ReferralRebateRule{}), "pausing cannot erase an existing rule")
	require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{RateBPS: 1000, ValidDays: 1}))
	expected, err := GetReferralRebateRule()
	require.NoError(t, err)
	require.NoError(t, DB.Callback().Update().Before("gorm:update").Register("test:reject_referral_rule", func(tx *gorm.DB) {
		if tx.Statement.Table == "options" {
			tx.AddError(errors.New("injected config write failure"))
		}
	}))
	assert.Error(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 2000, ValidDays: 30}))
	require.NoError(t, DB.Callback().Update().Remove("test:reject_referral_rule"))
	actual, err := GetReferralRebateRule()
	require.NoError(t, err)
	assert.Equal(t, expected, actual)
	assert.Error(t, UpdateOption(ReferralRebateOptionKey, `{}`))
	assert.Error(t, UpdateOptionsBulk(map[string]string{ReferralRebateOptionKey: `{}`}))
	assert.ErrorIs(t, UpdateOptionsBulk(map[string]string{
		ReferralRebateOptionKey: `{}`,
		"ServerAddress":         "https://referral-rule.example.invalid",
		"passkey.rp_id":         "referral-rule.example.invalid",
		"passkey.origins":       "https://referral-rule.example.invalid",
		"passkey.legacy_rp_ids": "",
	}), ErrInvalidReferralRule, "delegated bulk settings cannot bypass referral rule validation")
	actual, err = GetReferralRebateRule()
	require.NoError(t, err)
	assert.Equal(t, expected, actual)
}

func TestReferralAwardsUseFrozenPersonalRateAndActualIntegerCredit(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		rate, credit, reward int
	}{
		{"discounted_payment", 1000, 1000, 100},
		{"half_rounds_up", 1, 5000, 1},
		{"below_half_creates_no_fact", 1, 4999, 0},
		{"maximum_exact_integer", 10000, common.MaxWalletQuota, common.MaxWalletQuota},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inviter, invitee := referralFixture(t, tc.rate)
			require.NoError(t, DB.Model(&invitee).Update("quota", -100).Error)
			require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 5000, ValidDays: 30}))
			order := TopUp{UserId: invitee.Id, TradeNo: "referral-rounding", Amount: 2, Money: 90, CreditedQuota: &tc.credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
			require.NoError(t, order.Insert())
			_, err := RechargeEpay(order.TradeNo, "", "")
			require.NoError(t, err)
			require.NoError(t, DB.First(&inviter, inviter.Id).Error)
			require.NoError(t, DB.First(&invitee, invitee.Id).Error)
			assert.Equal(t, tc.credit-100, invitee.Quota, "negative balances remain valid")
			assert.Equal(t, tc.reward, inviter.AffQuota)
			assert.Equal(t, tc.reward, inviter.AffHistoryQuota)
			var facts []ReferralRebate
			require.NoError(t, DB.Where("top_up_id = ?", order.Id).Find(&facts).Error)
			if tc.reward == 0 {
				assert.Empty(t, facts)
			} else {
				require.Len(t, facts, 1)
				assert.EqualValues(t, tc.credit, facts[0].CreditedQuota)
				assert.Equal(t, tc.rate, facts[0].RateBPS)
			}
			already, err := RechargeEpay(order.TradeNo, "", "")
			require.NoError(t, err)
			assert.True(t, already)
		})
	}
}

func TestReferralIneligibilityCompletesPrincipalWithoutBackfill(t *testing.T) {
	for _, state := range []string{"no_snapshot", "expired", "paused", "inviter_disabled", "inviter_deleted", "inviter_absent", "compliance"} {
		t.Run(state, func(t *testing.T) {
			inviter, invitee := referralFixture(t, 1000)
			switch state {
			case "no_snapshot":
				require.NoError(t, DB.Model(&invitee).Updates(map[string]any{"referral_rate_bps": 0, "referral_expires_at": 0}).Error)
			case "expired":
				require.NoError(t, DB.Model(&invitee).Updates(map[string]any{"created_at": time.Now().Unix() - 86400, "referral_expires_at": time.Now().Unix()}).Error)
			case "paused":
				require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{RateBPS: 1000, ValidDays: 1}))
			case "inviter_disabled":
				require.NoError(t, DB.Model(&inviter).Update("status", common.UserStatusDisabled).Error)
			case "inviter_deleted":
				require.NoError(t, DB.Delete(&inviter).Error)
			case "inviter_absent":
				require.NoError(t, DB.Unscoped().Delete(&inviter).Error)
			case "compliance":
				operation_setting.GetPaymentSetting().ComplianceConfirmed = false
			}
			credit := 100
			order := TopUp{UserId: invitee.Id, TradeNo: "no-backfill", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
			require.NoError(t, order.Insert())
			_, err := RechargeEpay(order.TradeNo, "", "")
			require.NoError(t, err)
			operation_setting.GetPaymentSetting().ComplianceConfirmed = true
			require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1}))
			require.NoError(t, DB.Model(&invitee).Updates(map[string]any{"referral_rate_bps": 1000, "referral_expires_at": time.Now().Unix() + 86400}).Error)
			already, err := RechargeEpay(order.TradeNo, "", "")
			require.NoError(t, err)
			assert.True(t, already)
			require.NoError(t, DB.First(&invitee, invitee.Id).Error)
			assert.Equal(t, credit, invitee.Quota)
			var count int64
			require.NoError(t, DB.Model(&ReferralRebate{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}

func TestReferralFailuresRollbackAllFourFactsAndRetryUsesNewTime(t *testing.T) {
	for _, failure := range []string{"reward_overflow", "wallet_overflow", "corrupt_snapshot", "missing_rule", "fact_write"} {
		t.Run(failure, func(t *testing.T) {
			inviter, invitee := referralFixture(t, 1000)
			switch failure {
			case "reward_overflow":
				require.NoError(t, DB.Model(&inviter).Update("aff_history", common.MaxWalletQuota).Error)
			case "wallet_overflow":
				require.NoError(t, DB.Model(&invitee).Update("quota", common.MaxWalletQuota).Error)
			case "corrupt_snapshot":
				require.NoError(t, DB.Model(&invitee).Update("referral_rate_bps", 10001).Error)
			case "missing_rule":
				require.NoError(t, DB.Where(&Option{Key: ReferralRebateOptionKey}).Delete(&Option{}).Error)
			case "fact_write":
				require.NoError(t, DB.Callback().Create().Before("gorm:create").Register("test:reject_rebate", func(tx *gorm.DB) {
					if tx.Statement.Table == "referral_rebates" {
						tx.AddError(errors.New("injected fact write failure"))
					}
				}))
			}
			credit := 100
			order := TopUp{UserId: invitee.Id, TradeNo: "rollback-referral", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
			require.NoError(t, order.Insert())
			_, err := RechargeEpay(order.TradeNo, "", "")
			assert.Error(t, err)
			if failure == "fact_write" {
				require.NoError(t, DB.Callback().Create().Remove("test:reject_rebate"))
			}
			reloaded := GetTopUpByTradeNo(order.TradeNo)
			require.NotNil(t, reloaded)
			assert.Equal(t, common.TopUpStatusPending, reloaded.Status)
			assert.Zero(t, reloaded.CompleteTime)
			require.NoError(t, DB.First(&inviter, inviter.Id).Error)
			assert.Zero(t, inviter.AffQuota)
			var count int64
			require.NoError(t, DB.Model(&ReferralRebate{}).Count(&count).Error)
			assert.Zero(t, count)
			require.NoError(t, InitializeReferralRebateRule(DB))
			// A subsequent genuine completion after expiry must not use a time
			// left by the failed attempt; the original transaction left none.
			require.NoError(t, DB.Model(&invitee).Updates(map[string]any{"quota": 0, "referral_rate_bps": 1000, "created_at": time.Now().Unix() - 86400, "referral_expires_at": time.Now().Unix()}).Error)
			_, err = RechargeEpay(order.TradeNo, "", "")
			require.NoError(t, err)
			require.NoError(t, DB.Model(&ReferralRebate{}).Count(&count).Error)
			assert.Zero(t, count)
			reloaded = GetTopUpByTradeNo(order.TradeNo)
			assert.Positive(t, reloaded.CompleteTime)
		})
	}
}

func TestReferralQueriesKeepDeletedContributionsAndExactAllPageTotals(t *testing.T) {
	inviter, invitee := referralFixture(t, 1000)
	other := User{Username: "other-invitee", AffCode: "other-invitee", InviterId: inviter.Id}
	require.NoError(t, DB.Create(&other).Error)
	now := time.Now().Unix()
	for i := range 2 {
		require.NoError(t, DB.Create(&ReferralRebate{TopUpID: 8000 + i, TradeNo: "summary-" + strconv.Itoa(i), InviterID: inviter.Id + i, InviteeID: invitee.Id, CreditedQuota: common.MaxWalletQuota, RateBPS: 10000, RewardQuota: common.MaxWalletQuota, SettledAt: now, CreatedAt: now}).Error)
	}
	require.NoError(t, DB.Delete(&invitee).Error)
	page, err := ListReferralRebates(t.Context(), ReferralRebateFilter{}, 0, 1)
	require.NoError(t, err)
	assert.Len(t, page.Items, 1)
	assert.EqualValues(t, 2, page.Total)
	assert.Equal(t, "18014398509481982", page.CreditedQuota)
	assert.Equal(t, "18014398509481982", page.RewardQuota)
	page, err = ListReferralRebates(t.Context(), ReferralRebateFilter{TradeNo: "summary-0", StartTime: now, EndTime: now + 1}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, page.Total)
	page, err = ListReferralRebates(t.Context(), ReferralRebateFilter{EndTime: now}, 0, 10)
	require.NoError(t, err)
	assert.Zero(t, page.Total)
	assert.Equal(t, "0", page.RewardQuota)
	summary, err := GetReferralSummary(t.Context(), inviter.Id)
	require.NoError(t, err)
	assert.EqualValues(t, 2, summary.DirectCount, "counts actual relations including users with no fixed award")
	assert.Equal(t, strconv.Itoa(common.MaxWalletQuota), summary.RebateQuota)
	items, err := ListReferralInvitees(t.Context(), inviter.Id, 0, 10)
	require.NoError(t, err)
	require.Len(t, items.Items, 2)
	assert.Equal(t, "none", items.Items[0].Status)
	assert.True(t, items.Items[1].Deleted)
	assert.Empty(t, items.Items[1].DisplayName)
	assert.Equal(t, strconv.Itoa(common.MaxWalletQuota), items.Items[1].RebateQuota)
	isolated, err := ListReferralInvitees(t.Context(), other.Id, 0, 10)
	require.NoError(t, err)
	assert.Empty(t, isolated.Items)
	// Historical reporting is available even if configuration is corrupt.
	require.NoError(t, DB.Model(&Option{}).Where(&Option{Key: ReferralRebateOptionKey}).Update("value", "invalid").Error)
	_, err = ListReferralRebates(t.Context(), ReferralRebateFilter{}, 0, 10)
	assert.NoError(t, err)
}

func TestReferralHardDeletedContributorsRemainQueryableAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB, previousLogDB, previousRedis := DB, LOG_DB, common.RedisEnabled
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousPayment := *operation_setting.GetPaymentSetting()
			DB, LOG_DB, common.RedisEnabled = db, db, false
			kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(kind, kind)
			operation_setting.GetPaymentSetting().ComplianceConfirmed = true
			operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
			t.Cleanup(func() {
				DB, LOG_DB, common.RedisEnabled = previousDB, previousLogDB, previousRedis
				common.SetDatabaseTypes(previousMain, previousLog)
				*operation_setting.GetPaymentSetting() = previousPayment
			})
			require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &Option{}, &ReferralRebate{}, &SubscriptionOrder{}, &Log{},
				&UserAccessToken{}, &ExternalIdentityClaim{}, &TwoFABackupCode{}, &TwoFA{}, &UserSession{}, &AuthFlow{}, &PasskeyCredential{}, &Token{}, &UserOAuthBinding{}))
			require.NoError(t, InitializeReferralRebateRule(db))
			require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1}))
			owner := User{Username: "deleted-owner", AffCode: "deleted-owner", Status: common.UserStatusEnabled}
			otherOwner := User{Username: "unrelated-owner", AffCode: "unrelated-owner", Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&owner).Error)
			require.NoError(t, db.Create(&otherOwner).Error)
			children := make([]User, 4)
			for i := range children {
				name := "deleted-child-" + strconv.Itoa(i)
				children[i] = User{Username: name, AffCode: name, InviterId: owner.Id, Status: common.UserStatusEnabled,
					CreatedAt: time.Now().Unix() - 1, ReferralRateBPS: 1000, ReferralExpiresAt: time.Now().Unix() + 86400}
				if i == 3 {
					children[i].InviterId = otherOwner.Id
				}
				require.NoError(t, db.Create(&children[i]).Error)
			}
			for i, childIndex := range []int{0, 1, 1, 3} {
				credit := 100
				order := TopUp{UserId: children[childIndex].Id, TradeNo: "deleted-contribution-" + strconv.Itoa(i),
					PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending, CreditedQuota: &credit}
				require.NoError(t, order.Insert())
				_, err := RechargeEpay(order.TradeNo, "alipay", "")
				require.NoError(t, err)
			}
			for _, childIndex := range []int{1, 2, 3} {
				_, err := HardDeleteUserById(children[childIndex].Id)
				require.NoError(t, err)
			}
			summary, err := GetReferralSummary(t.Context(), owner.Id)
			require.NoError(t, err)
			assert.EqualValues(t, 2, summary.DirectCount, "live relation and retained contributor are distinct; no-fact erased relations are not fabricated")
			assert.Equal(t, "30", summary.AffQuota)
			assert.Equal(t, "30", summary.AffHistoryQuota)
			assert.Equal(t, "30", summary.RebateQuota)
			first, err := ListReferralInvitees(t.Context(), owner.Id, 0, 1)
			require.NoError(t, err)
			require.Len(t, first.Items, 1)
			assert.Equal(t, summary.DirectCount, first.Total)
			assert.Equal(t, children[1].Id, first.Items[0].ID)
			assert.True(t, first.Items[0].Deleted)
			assert.Empty(t, first.Items[0].DisplayName)
			assert.Nil(t, first.Items[0].CreatedAt)
			assert.Nil(t, first.Items[0].RateBPS)
			assert.Nil(t, first.Items[0].ExpiresAt)
			assert.Equal(t, "20", first.Items[0].RebateQuota)
			second, err := ListReferralInvitees(t.Context(), owner.Id, 1, 1)
			require.NoError(t, err)
			require.Len(t, second.Items, 1)
			assert.Equal(t, first.Total, second.Total)
			assert.Equal(t, children[0].Id, second.Items[0].ID)
			assert.False(t, second.Items[0].Deleted)
			assert.Equal(t, "10", second.Items[0].RebateQuota)
			foreign, err := ListReferralInvitees(t.Context(), otherOwner.Id, 0, 10)
			require.NoError(t, err)
			require.Len(t, foreign.Items, 1)
			assert.Equal(t, children[3].Id, foreign.Items[0].ID)
			assert.Equal(t, "10", foreign.Items[0].RebateQuota)
		})
	}
}

func TestReferralOnlyDirectInviterReceivesEachRoundedAward(t *testing.T) {
	grandparent, parent := referralFixture(t, 3333)
	child := User{Username: "referral-child", AffCode: "referral-child", InviterId: parent.Id, Status: common.UserStatusEnabled, CreatedAt: time.Now().Unix(), ReferralRateBPS: 3333, ReferralExpiresAt: time.Now().Unix() + 86400}
	require.NoError(t, DB.Create(&child).Error)
	credit := 2
	for i := range 2 {
		order := TopUp{UserId: child.Id, TradeNo: "child-" + strconv.Itoa(i), PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending, CreditedQuota: &credit}
		require.NoError(t, order.Insert())
		_, err := RechargeEpay(order.TradeNo, "", "")
		require.NoError(t, err)
	}
	require.NoError(t, DB.First(&parent, parent.Id).Error)
	require.NoError(t, DB.First(&grandparent, grandparent.Id).Error)
	assert.Equal(t, 2, parent.AffQuota, "round each 0.6666 award separately; do not round cumulative 1.3332")
	assert.Equal(t, 2, parent.AffHistoryQuota)
	assert.Zero(t, grandparent.AffQuota, "no second level of rewards")
	require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{RateBPS: 3333, ValidDays: 1}))
	require.NoError(t, DB.Model(&parent).Update("referral_expires_at", parent.CreatedAt+1).Error)
	// Use server-owned expiry, with an explicitly historical registration.
	require.NoError(t, DB.Model(&parent).Updates(map[string]any{"created_at": time.Now().Unix() - 10, "referral_expires_at": time.Now().Unix() - 1}).Error)
	items, err := ListReferralInvitees(t.Context(), grandparent.Id, 0, 10)
	require.NoError(t, err)
	require.Len(t, items.Items, 1)
	assert.Equal(t, "expired", items.Items[0].Status, "pause cannot mask expiry")
	items, err = ListReferralInvitees(t.Context(), parent.Id, 0, 10)
	require.NoError(t, err)
	require.Len(t, items.Items, 1)
	assert.Equal(t, "paused", items.Items[0].Status)
}

func TestReferralExactHistoryAggregatesAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB, previousMain, previousLog := DB, common.MainDatabaseType(), common.LogDatabaseType()
			DB = db
			kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(kind, kind)
			t.Cleanup(func() {
				DB = previousDB
				common.SetDatabaseTypes(previousMain, previousLog)
			})
			require.NoError(t, db.AutoMigrate(&User{}, &Option{}, &ReferralRebate{}))
			require.NoError(t, InitializeReferralRebateRule(db))
			facts := make([]ReferralRebate, 2048)
			for i := range facts {
				facts[i] = ReferralRebate{TopUpID: i + 1, TradeNo: "aggregate-" + strconv.Itoa(i), InviterID: i + 1, InviteeID: i + 10000, CreditedQuota: common.MaxWalletQuota, RewardQuota: common.MaxWalletQuota, RateBPS: 10000, SettledAt: 100 + int64(i%2), CreatedAt: 102}
			}
			require.NoError(t, db.CreateInBatches(facts, 100).Error)
			page, err := ListReferralRebates(t.Context(), ReferralRebateFilter{}, 0, 1)
			require.NoError(t, err)
			assert.EqualValues(t, 2048, page.Total)
			assert.Equal(t, "18446744073709549568", page.CreditedQuota, "aggregate exceeds int64 and JavaScript's exact integer range")
			assert.Equal(t, page.CreditedQuota, page.RewardQuota)
			require.Len(t, page.Items, 1)
			assert.Equal(t, "aggregate-2047", page.Items[0].TradeNo)
			filtered, err := ListReferralRebates(t.Context(), ReferralRebateFilter{InviterID: 1, InviteeID: 10000, TradeNo: "aggregate-0", StartTime: 100, EndTime: 101}, 0, 10)
			require.NoError(t, err)
			assert.EqualValues(t, 1, filtered.Total)
			assert.Equal(t, strconv.Itoa(common.MaxWalletQuota), filtered.RewardQuota)
			cancelled, cancel := context.WithCancel(t.Context())
			cancel()
			_, err = ListReferralRebates(cancelled, ReferralRebateFilter{}, 0, 10)
			assert.ErrorIs(t, err, context.Canceled, "cancelled requests must release query work instead of scanning history")
			require.NoError(t, db.Model(&ReferralRebate{}).Where("top_up_id = ?", 1).Update("reward_quota", -1).Error)
			_, err = ListReferralRebates(t.Context(), ReferralRebateFilter{}, 0, 10)
			assert.ErrorIs(t, err, ErrInvalidReferralSnapshot, "aggregating must not conceal invalid historical money")

			// The invitee page must preserve the same exact totals, even when
			// SQL groups a contributor's history into one row. Profile removal,
			// pagination and another inviter's records must not change the sum.
			require.NoError(t, db.Model(&ReferralRebate{}).Where("top_up_id > ?", 0).Updates(map[string]any{
				"inviter_id": 1, "invitee_id": 10000, "reward_quota": common.MaxWalletQuota,
			}).Error)
			foreign := ReferralRebate{TopUpID: 2049, TradeNo: "another-inviter", InviterID: 2, InviteeID: 10000, CreditedQuota: 1, RewardQuota: 1, RateBPS: 10000, SettledAt: 100, CreatedAt: 102}
			require.NoError(t, db.Create(&foreign).Error)
			noAwards := User{Id: 10001, Username: "no-awards", AffCode: "no-awards", InviterId: 1, Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&noAwards).Error)
			first, err := ListReferralInvitees(t.Context(), 1, 0, 1)
			require.NoError(t, err)
			require.Len(t, first.Items, 1)
			assert.EqualValues(t, 2, first.Total)
			assert.Equal(t, noAwards.Id, first.Items[0].ID)
			assert.Equal(t, "0", first.Items[0].RebateQuota)
			second, err := ListReferralInvitees(t.Context(), 1, 1, 1)
			require.NoError(t, err)
			require.Len(t, second.Items, 1)
			assert.Equal(t, first.Total, second.Total)
			assert.Equal(t, 10000, second.Items[0].ID)
			assert.True(t, second.Items[0].Deleted)
			assert.Equal(t, page.RewardQuota, second.Items[0].RebateQuota, "grouped sum exceeds int64 without float conversion or cross-inviter leakage")
			_, err = ListReferralInvitees(cancelled, 1, 0, 10)
			assert.ErrorIs(t, err, context.Canceled)
			for _, invalid := range []int64{-1, 0, common.MaxWalletQuota + 1} {
				require.NoError(t, db.Model(&ReferralRebate{}).Where("top_up_id = ?", 1).Update("reward_quota", invalid).Error)
				_, err = ListReferralInvitees(t.Context(), 1, 0, 10)
				assert.ErrorIs(t, err, ErrInvalidReferralSnapshot, "a positive grouped sum must not conceal an invalid individual reward")
			}
		})
	}
}

func TestReferralLegacyCompletionRecordsActualQuotaWithoutRepricingReplay(t *testing.T) {
	for _, provider := range []string{PaymentProviderEpay, PaymentProviderStripe, PaymentProviderCreem, PaymentProviderWaffo, PaymentProviderWaffoPancake} {
		t.Run(provider, func(t *testing.T) {
			_, user := referralFixture(t, 1000)
			previousUnit := common.QuotaPerUnit
			common.QuotaPerUnit = 2
			t.Cleanup(func() { common.QuotaPerUnit = previousUnit })
			order := TopUp{UserId: user.Id, TradeNo: "legacy-actual-credit", Amount: 100, Money: 90, PaymentProvider: provider, Status: common.TopUpStatusPending}
			require.NoError(t, DB.Create(&order).Error, "legacy rows have no creation-time credit snapshot")
			_, actual, duplicate, err := settleWalletTopUp(order.TradeNo, provider, "", "", "")
			require.NoError(t, err)
			assert.False(t, duplicate)
			expected := 200
			if provider == PaymentProviderStripe {
				expected = 180
			} else if provider == PaymentProviderCreem {
				expected = 100 // User-approved historical callback convention.
			}
			assert.Equal(t, expected, actual)
			require.NoError(t, DB.First(&order, order.Id).Error)
			require.NotNil(t, order.CreditedQuota)
			assert.Equal(t, expected, *order.CreditedQuota)
			common.QuotaPerUnit = 3
			_, actual, duplicate, err = settleWalletTopUp(order.TradeNo, provider, "", "", "")
			require.NoError(t, err)
			assert.True(t, duplicate)
			assert.Equal(t, expected, actual, "commit recovery must use the exact successful credit")
			require.NoError(t, ManualCompleteTopUp(order.TradeNo, ""))
			require.NoError(t, DB.First(&user, user.Id).Error)
			assert.Equal(t, expected, user.Quota)
			// Already-successful pre-feature rows stay untouched and are never
			// assigned a made-up amount for cache recovery or retroactive awards.
			oldSuccess := TopUp{UserId: user.Id, TradeNo: "legacy-already-success", Amount: 100, Money: 90, PaymentProvider: provider, Status: common.TopUpStatusSuccess, CompleteTime: 100}
			require.NoError(t, DB.Create(&oldSuccess).Error)
			_, actual, duplicate, err = settleWalletTopUp(oldSuccess.TradeNo, provider, "", "", "")
			require.NoError(t, err)
			assert.True(t, duplicate)
			assert.Zero(t, actual)
			require.NoError(t, DB.First(&oldSuccess, oldSuccess.Id).Error)
			assert.Nil(t, oldSuccess.CreditedQuota)
			assert.EqualValues(t, 100, oldSuccess.CompleteTime)
		})
	}
}

func TestReferralCorruptRulesRollbackSettlementAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB, previousLogDB := DB, LOG_DB
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousRedis, previousBatch := common.RedisEnabled, common.BatchUpdateEnabled
			settings := operation_setting.GetPaymentSetting()
			previousSettings := *settings
			DB, LOG_DB = db, db
			kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(kind, kind)
			common.RedisEnabled, common.BatchUpdateEnabled = false, false
			settings.ComplianceConfirmed = true
			settings.ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
			t.Cleanup(func() {
				DB, LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.RedisEnabled, common.BatchUpdateEnabled = previousRedis, previousBatch
				*settings = previousSettings
			})
			require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &Option{}, &ReferralRebate{}, &SubscriptionOrder{}, &Log{}))
			require.NoError(t, InitializeReferralRebateRule(db))
			initial, err := GetReferralRebateRule()
			require.NoError(t, err)
			assert.Equal(t, ReferralRebateRule{Enabled: false, RateBPS: 500, ValidDays: 7}, initial, "first initialization remains a complete disabled rule")
			for _, state := range []string{"default_disabled", "configured_pause", "unqualified_corrupt_rule"} {
				t.Run(state, func(t *testing.T) {
					inviter := User{Username: state, AffCode: state, Status: common.UserStatusEnabled}
					require.NoError(t, db.Create(&inviter).Error)
					invitee := User{Username: state + "-child", AffCode: state + "-child", Status: common.UserStatusEnabled, InviterId: inviter.Id}
					if state == "configured_pause" {
						require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{RateBPS: 1000, ValidDays: 1}))
						invitee.CreatedAt, invitee.ReferralRateBPS, invitee.ReferralExpiresAt = time.Now().Unix(), 1000, time.Now().Unix()+86400
					}
					if state == "unqualified_corrupt_rule" {
						require.NoError(t, db.Model(&Option{}).Where(&Option{Key: ReferralRebateOptionKey}).Update("value", "null").Error)
					}
					require.NoError(t, db.Create(&invitee).Error)
					credit := 100
					order := TopUp{UserId: invitee.Id, TradeNo: state, CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
					require.NoError(t, order.Insert())
					_, err := RechargeEpay(order.TradeNo, "", "")
					require.NoError(t, err, "legitimate principal-only settlement must remain available")
					require.NoError(t, db.First(&invitee, invitee.Id).Error)
					require.NoError(t, db.First(&inviter, inviter.Id).Error)
					assert.Equal(t, 100, invitee.Quota)
					assert.Zero(t, inviter.AffQuota)
					var count int64
					require.NoError(t, db.Model(&ReferralRebate{}).Where("top_up_id = ?", order.Id).Count(&count).Error)
					assert.Zero(t, count)
				})
			}
			for index, raw := range []string{
				"null", "{}", "missing_rule", "read_failure", "invalid-json", "{\"rate_bps\":1000,\"valid_days\":1}",
				"{\"enabled\":null,\"rate_bps\":1000,\"valid_days\":1}",
				"{\"enabled\":false,\"rate_bps\":null,\"valid_days\":null}",
				"{\"enabled\":\"false\",\"rate_bps\":1000,\"valid_days\":1}",
				"{\"enabled\":true,\"rate_bps\":10001,\"valid_days\":1}",
				"{\"enabled\":true,\"rate_bps\":1000,\"valid_days\":9223372036854775807}",
			} {
				t.Run(strconv.Itoa(index), func(t *testing.T) {
					name := "damaged-rule-" + strconv.Itoa(index)
					inviter := User{Username: name, AffCode: name, Status: common.UserStatusEnabled}
					require.NoError(t, db.Create(&inviter).Error)
					invitee := User{Username: name + "-child", AffCode: name + "-child", Status: common.UserStatusEnabled, InviterId: inviter.Id, CreatedAt: time.Now().Unix(), ReferralRateBPS: 1000, ReferralExpiresAt: time.Now().Unix() + 86400}
					require.NoError(t, db.Create(&invitee).Error)
					var expectedErr error = ErrInvalidReferralRule
					if raw == "missing_rule" {
						require.NoError(t, db.Where(&Option{Key: ReferralRebateOptionKey}).Delete(&Option{}).Error)
					} else {
						require.NoError(t, db.Model(&Option{}).Where(&Option{Key: ReferralRebateOptionKey}).Update("value", raw).Error)
					}
					readBlocked := raw == "read_failure"
					if readBlocked {
						expectedErr = errors.New("isolated stored referral rule read failure")
						require.NoError(t, db.Callback().Query().Before("gorm:query").Register("referral_rule_read_failure", func(tx *gorm.DB) {
							if readBlocked && tx.Statement.Table == "options" {
								tx.AddError(expectedErr)
							}
						}))
						t.Cleanup(func() { assert.NoError(t, db.Callback().Query().Remove("referral_rule_read_failure")) })
					}
					_, err := GetReferralRebateRule()
					assert.ErrorIs(t, err, expectedErr)
					_, err = GetReferralSummary(t.Context(), inviter.Id)
					assert.ErrorIs(t, err, expectedErr)
					_, err = ListReferralInvitees(t.Context(), inviter.Id, 0, 10)
					assert.ErrorIs(t, err, expectedErr)
					err = db.Transaction(func(tx *gorm.DB) error {
						return PrepareReferralRegistrationTx(tx, &User{InviterId: inviter.Id})
					})
					assert.ErrorIs(t, err, expectedErr, "registration must not silently lose eligibility")
					require.NoError(t, db.Transaction(func(tx *gorm.DB) error {
						return PrepareReferralRegistrationTx(tx, &User{})
					}), "registration without an inviter does not depend on referral configuration")

					credit := 100
					order := TopUp{UserId: invitee.Id, TradeNo: name, CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
					require.NoError(t, order.Insert())
					_, err = RechargeEpay(order.TradeNo, "", "")
					assert.ErrorIs(t, err, expectedErr)
					require.NoError(t, db.First(&order, order.Id).Error)
					assert.Equal(t, common.TopUpStatusPending, order.Status)
					assert.Zero(t, order.CompleteTime)
					require.NoError(t, db.First(&invitee, invitee.Id).Error)
					require.NoError(t, db.First(&inviter, inviter.Id).Error)
					assert.Zero(t, invitee.Quota)
					assert.Zero(t, inviter.AffQuota)
					var count int64
					require.NoError(t, db.Model(&ReferralRebate{}).Where("top_up_id = ?", order.Id).Count(&count).Error)
					assert.Zero(t, count)
					readBlocked = false
					require.NoError(t, InitializeReferralRebateRule(db))
					restored, marshalErr := common.Marshal(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1})
					require.NoError(t, marshalErr)
					require.NoError(t, db.Model(&Option{}).Where(&Option{Key: ReferralRebateOptionKey}).Update("value", string(restored)).Error)
					_, err = RechargeEpay(order.TradeNo, "", "")
					require.NoError(t, err)
					require.NoError(t, db.First(&invitee, invitee.Id).Error)
					require.NoError(t, db.First(&inviter, inviter.Id).Error)
					assert.Equal(t, credit, invitee.Quota)
					assert.Equal(t, 10, inviter.AffQuota)
					require.NoError(t, db.Model(&ReferralRebate{}).Where("top_up_id = ?", order.Id).Count(&count).Error)
					assert.EqualValues(t, 1, count)
				})
			}
		})
	}
}

func TestReferralInviteeTimestampDomainMatchesSettlementAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB, previousRedis := DB, common.RedisEnabled
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousPayment := *operation_setting.GetPaymentSetting()
			DB, common.RedisEnabled = db, false
			kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(kind, kind)
			operation_setting.GetPaymentSetting().ComplianceConfirmed = true
			operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
			t.Cleanup(func() {
				DB, common.RedisEnabled = previousDB, previousRedis
				common.SetDatabaseTypes(previousMain, previousLog)
				*operation_setting.GetPaymentSetting() = previousPayment
			})
			require.NoError(t, db.AutoMigrate(&User{}, &Option{}, &ReferralRebate{}))
			require.NoError(t, InitializeReferralRebateRule(db))
			require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1}))
			owner := User{Username: "timestamp-owner", AffCode: "timestamp-owner", Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&owner).Error)
			child := User{Username: "timestamp-child", AffCode: "timestamp-child", InviterId: owner.Id, Status: common.UserStatusEnabled, CreatedAt: time.Now().Unix() - 1, ReferralRateBPS: 1000, ReferralExpiresAt: maxReferralTimestamp}
			require.NoError(t, db.Create(&child).Error)
			page, err := ListReferralInvitees(t.Context(), owner.Id, 0, 10)
			require.NoError(t, err)
			require.Len(t, page.Items, 1)
			assert.Equal(t, "active", page.Items[0].Status)
			order := TopUp{Id: 1, UserId: child.Id, TradeNo: "timestamp-upper-bound"}
			require.NoError(t, db.Transaction(func(tx *gorm.DB) error { return AwardReferralRebateTx(tx, &order, 100) }))
			for _, state := range []string{"active", "expired", "none"} {
				t.Run("compliance_pause_"+state, func(t *testing.T) {
					rate, createdAt, expiresAt := 1000, time.Now().Unix()-100, maxReferralTimestamp
					expected := "paused"
					if state == "expired" {
						expiresAt, expected = createdAt+1, "expired"
					} else if state == "none" {
						rate, expiresAt, expected = 0, 0, "none"
					}
					require.NoError(t, db.Model(&child).Updates(map[string]any{"created_at": createdAt, "referral_rate_bps": rate, "referral_expires_at": expiresAt}).Error)
					operation_setting.GetPaymentSetting().ComplianceConfirmed = false
					page, err := ListReferralInvitees(t.Context(), owner.Id, 0, 10)
					require.NoError(t, err)
					require.Len(t, page.Items, 1)
					assert.Equal(t, expected, page.Items[0].Status)
					var unchanged User
					require.NoError(t, db.First(&unchanged, child.Id).Error)
					assert.Equal(t, rate, unchanged.ReferralRateBPS)
					assert.Equal(t, expiresAt, unchanged.ReferralExpiresAt)
				})
			}
			operation_setting.GetPaymentSetting().ComplianceConfirmed = true
			require.NoError(t, db.Model(&child).Updates(map[string]any{"created_at": time.Now().Unix() - 1, "referral_rate_bps": 1000}).Error)
			require.NoError(t, db.Model(&child).Update("referral_expires_at", maxReferralTimestamp+1).Error)
			_, err = ListReferralInvitees(t.Context(), owner.Id, 0, 10)
			assert.ErrorIs(t, err, ErrInvalidReferralSnapshot, "queries must not label an out-of-domain snapshot as eligible")
			order = TopUp{Id: 2, UserId: child.Id, TradeNo: "timestamp-out-of-domain"}
			err = db.Transaction(func(tx *gorm.DB) error { return AwardReferralRebateTx(tx, &order, 100) })
			assert.ErrorIs(t, err, ErrInvalidReferralSnapshot)
			var current User
			require.NoError(t, db.First(&current, owner.Id).Error)
			assert.Equal(t, 10, current.AffQuota)
			assert.Equal(t, 10, current.AffHistoryQuota)
			var count int64
			require.NoError(t, db.Model(&ReferralRebate{}).Count(&count).Error)
			assert.EqualValues(t, 1, count)
		})
	}
}

func TestReferralRuleRejectsGenericOptionAliasesAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB := DB
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousPayment := *operation_setting.GetPaymentSetting()
			common.OptionMapRWMutex.Lock()
			previousOptions := common.OptionMap
			common.OptionMap = map[string]string{}
			common.OptionMapRWMutex.Unlock()
			DB = db
			kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(kind, kind)
			operation_setting.GetPaymentSetting().ComplianceConfirmed = true
			operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
			t.Cleanup(func() {
				DB = previousDB
				common.SetDatabaseTypes(previousMain, previousLog)
				*operation_setting.GetPaymentSetting() = previousPayment
				common.OptionMapRWMutex.Lock()
				common.OptionMap = previousOptions
				common.OptionMapRWMutex.Unlock()
			})
			require.NoError(t, db.AutoMigrate(&Option{}))
			require.NoError(t, InitializeReferralRebateRule(db))
			expected := ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1}
			require.NoError(t, SaveReferralRebateRule(expected))
			const ordinaryKey = "referral-regression-unrelated-option"
			for _, method := range []string{"single", "bulk"} {
				for _, alias := range []string{ReferralRebateOptionKey, "referralrebaterule", "REFERRALREBATERULE", "ReferralRebateRule ", "ReferrálRebateRule", "ＲeferralRebateRule"} {
					t.Run(method+"/"+alias, func(t *testing.T) {
						require.NoError(t, UpdateOption(ordinaryKey, "before"))
						var resolved Option
						lookupErr := db.Where(&Option{Key: alias}).First(&resolved).Error
						require.True(t, lookupErr == nil || errors.Is(lookupErr, gorm.ErrRecordNotFound))
						protected := alias == ReferralRebateOptionKey || lookupErr == nil && resolved.Key == ReferralRebateOptionKey
						var err error
						if method == "single" {
							err = UpdateOption(alias, "null")
						} else {
							err = UpdateOptionsBulk(map[string]string{ordinaryKey: "after", alias: "null"})
						}
						if protected {
							assert.ErrorIs(t, err, ErrInvalidReferralRule)
						} else {
							require.NoError(t, err, "distinct database keys retain generic option behavior")
						}
						actual, err := GetReferralRebateRule()
						require.NoError(t, err)
						assert.Equal(t, expected, actual, "generic writes must preserve the complete validated rule")
						var ordinary Option
						require.NoError(t, db.Where(&Option{Key: ordinaryKey}).First(&ordinary).Error)
						expectedValue := "before"
						if method == "bulk" && !protected {
							expectedValue = "after"
						}
						assert.Equal(t, expectedValue, ordinary.Value)
						common.OptionMapRWMutex.RLock()
						published := common.OptionMap[ordinaryKey]
						common.OptionMapRWMutex.RUnlock()
						assert.Equal(t, expectedValue, published, "rejection must not publish partial configuration")
						if protected && method == "bulk" {
							// Bulk passkey dispatch accepts other supplied options; protection must
							// run before delegation, without changing authentication configuration.
							assert.ErrorIs(t, UpdateOptionsBulk(map[string]string{"ServerAddress": "https://unused.invalid", alias: "null"}), ErrInvalidReferralRule)
							var domains int64
							require.NoError(t, db.Model(&Option{}).Where(&Option{Key: "ServerAddress"}).Count(&domains).Error)
							assert.Zero(t, domains)
						}
					})
				}
			}
			require.NoError(t, UpdateOptionsBulk(map[string]string{ordinaryKey: "ordinary-bulk-success"}))
			var ordinary Option
			require.NoError(t, db.Where(&Option{Key: ordinaryKey}).First(&ordinary).Error)
			assert.Equal(t, "ordinary-bulk-success", ordinary.Value)
		})
	}
}

func TestReferralComplianceReadersDuringOptionPublication(t *testing.T) {
	for _, key := range []string{"payment_setting.compliance_confirmed", "payment_setting.compliance_terms_version"} {
		for _, scenario := range []string{"save_rule", "registration", "settlement", "summary", "invitees"} {
			t.Run(key+"/"+scenario, func(t *testing.T) {
				inviter, invitee := referralFixture(t, 1000)
				oldOptions := common.OptionMap
				common.OptionMap = make(map[string]string)
				oldInviterQuota, oldInviteeQuota := common.QuotaForInviter, common.QuotaForInvitee
				common.QuotaForInviter, common.QuotaForInvitee = 5, 4
				t.Cleanup(func() {
					common.OptionMap = oldOptions
					common.QuotaForInviter, common.QuotaForInvitee = oldInviterQuota, oldInviteeQuota
				})
				value := "true"
				if key == "payment_setting.compliance_terms_version" {
					value = operation_setting.CurrentComplianceTermsVersion
				}
				credit := 100
				order := TopUp{UserId: invitee.Id, TradeNo: "compliance-publication", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
				require.NoError(t, order.Insert())
				user := User{Username: "concurrent-referral-registration", Password: "fixture-only-password", Status: common.UserStatusEnabled}
				var summary ReferralSummary
				var invitees ReferralInvitees
				var writeErr, readErr error
				start := make(chan struct{})
				var workers sync.WaitGroup
				workers.Go(func() {
					<-start
					// The real publication boundary used by save and periodic reload.
					writeErr = updateOptionMap(key, value)
				})
				workers.Go(func() {
					<-start
					switch scenario {
					case "save_rule":
						readErr = SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1})
					case "registration":
						readErr = DB.Transaction(func(tx *gorm.DB) error { return user.InsertWithTx(tx, inviter.Id) })
					case "settlement":
						_, readErr = RechargeEpay(order.TradeNo, "", "")
					case "summary":
						summary, readErr = GetReferralSummary(t.Context(), inviter.Id)
					case "invitees":
						invitees, readErr = ListReferralInvitees(t.Context(), inviter.Id, 0, 10)
					}
				})
				close(start)
				workers.Wait()
				require.NoError(t, writeErr)
				require.NoError(t, readErr)
				switch scenario {
				case "save_rule":
					rule, err := GetReferralRebateRule()
					require.NoError(t, err)
					assert.Equal(t, ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1}, rule)
				case "registration":
					require.NoError(t, DB.First(&user, user.Id).Error)
					assert.Equal(t, inviter.Id, user.InviterId)
					assert.Equal(t, 1000, user.ReferralRateBPS)
					assert.Equal(t, user.CreatedAt+86400, user.ReferralExpiresAt)
					require.NoError(t, DB.First(&inviter, inviter.Id).Error)
					assert.Equal(t, 5, inviter.AffQuota)
					assert.Equal(t, 5, inviter.AffHistoryQuota)
				case "settlement":
					require.NoError(t, DB.First(&invitee, invitee.Id).Error)
					require.NoError(t, DB.First(&inviter, inviter.Id).Error)
					require.NoError(t, DB.First(&order, order.Id).Error)
					assert.Equal(t, 100, invitee.Quota)
					assert.Equal(t, 10, inviter.AffQuota)
					assert.Equal(t, 10, inviter.AffHistoryQuota)
					assert.Equal(t, common.TopUpStatusSuccess, order.Status)
					var count int64
					require.NoError(t, DB.Model(&ReferralRebate{}).Count(&count).Error)
					assert.EqualValues(t, 1, count)
				case "summary":
					assert.True(t, summary.ComplianceConfirmed)
					assert.EqualValues(t, 1, summary.DirectCount)
				case "invitees":
					require.Len(t, invitees.Items, 1)
					assert.Equal(t, "active", invitees.Items[0].Status)
				}
			})
		}
	}
}

func TestReferralRegistrationRewardsKeepConfigSnapshotAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB, previousLogDB, previousRedis := DB, LOG_DB, common.RedisEnabled
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousPayment := *operation_setting.GetPaymentSetting()
			previousOptions := common.OptionMap
			previousNew, previousInvitee, previousInviter := common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter
			DB, LOG_DB, common.RedisEnabled = db, db, false
			kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(kind, kind)
			operation_setting.GetPaymentSetting().ComplianceConfirmed = true
			operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
			common.OptionMap = make(map[string]string)
			t.Cleanup(func() {
				DB, LOG_DB, common.RedisEnabled = previousDB, previousLogDB, previousRedis
				common.SetDatabaseTypes(previousMain, previousLog)
				*operation_setting.GetPaymentSetting() = previousPayment
				common.OptionMapRWMutex.Lock()
				common.OptionMap = previousOptions
				common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter = previousNew, previousInvitee, previousInviter
				common.OptionMapRWMutex.Unlock()
			})
			require.NoError(t, db.AutoMigrate(&User{}, &Option{}, &Log{}))
			require.NoError(t, InitializeReferralRebateRule(db))
			require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1}))
			for _, scenario := range []string{"commit", "rollback", "concurrent"} {
				t.Run(scenario, func(t *testing.T) {
					common.OptionMapRWMutex.Lock()
					common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter = 20, 30, 40
					common.OptionMapRWMutex.Unlock()
					inviter := User{Username: "snapshot-owner-" + scenario, AffCode: "snapshot-owner-" + scenario,
						Status: common.UserStatusEnabled, AffQuota: 100, AffHistoryQuota: 200}
					require.NoError(t, db.Create(&inviter).Error)
					user := User{Username: "snapshot-user-" + scenario, Status: common.UserStatusEnabled}
					published := make(chan struct{})
					var publicationErr error
					userQueries := 0
					hook := "test_registration_reward_publication"
					require.NoError(t, db.Callback().Query().After("gorm:query").Register(hook, func(tx *gorm.DB) {
						if tx.Statement.Table != "users" {
							return
						}
						userQueries++
						if userQueries != 2 {
							return
						}
						// The existing inviter read is a real wait boundary. Publish a changed
						// configuration after the initial grant was read but before invite awards.
						// The concurrent case keeps the same value and is also checked with -race.
						if scenario == "concurrent" {
							go func() { publicationErr = updateOptionMap("QuotaForInviter", "40"); close(published) }()
							return
						}
						for _, option := range [][2]string{{"QuotaForNewUser", "200"}, {"QuotaForInvitee", "300"}, {"QuotaForInviter", "400"}} {
							if publicationErr = updateOptionMap(option[0], option[1]); publicationErr != nil {
								break
							}
						}
						close(published)
					}))
					t.Cleanup(func() { require.NoError(t, db.Callback().Query().Remove(hook)) })
					rollback := errors.New("identity association failed after user creation")
					err := db.Transaction(func(tx *gorm.DB) error {
						if err := user.InsertWithTx(tx, inviter.Id); err != nil {
							return err
						}
						if scenario == "rollback" {
							return rollback
						}
						return nil
					})
					require.GreaterOrEqual(t, userQueries, 2)
					<-published
					require.NoError(t, publicationErr)
					var storedOwner User
					require.NoError(t, db.First(&storedOwner, inviter.Id).Error)
					if scenario == "rollback" {
						require.ErrorIs(t, err, rollback)
						var count int64
						require.NoError(t, db.Model(&User{}).Where("username = ?", user.Username).Count(&count).Error)
						assert.Zero(t, count)
						assert.Equal(t, 100, storedOwner.AffQuota)
						assert.Equal(t, 200, storedOwner.AffHistoryQuota)
						assert.Zero(t, storedOwner.AffCount)
						require.NoError(t, db.Model(&Log{}).Where("user_id IN ?", []int{inviter.Id, user.Id}).Count(&count).Error)
						assert.Zero(t, count)
						return
					}
					require.NoError(t, err)
					var storedUser User
					require.NoError(t, db.First(&storedUser, user.Id).Error)
					assert.Equal(t, 50, storedUser.Quota, "one registration uses one observed fixed-reward configuration")
					assert.Equal(t, 140, storedOwner.AffQuota)
					assert.Equal(t, 240, storedOwner.AffHistoryQuota)
					assert.Equal(t, 1, storedOwner.AffCount)
					assert.Equal(t, inviter.Id, storedUser.InviterId)
					assert.Equal(t, 1000, storedUser.ReferralRateBPS)
					assert.Equal(t, storedUser.CreatedAt+86400, storedUser.ReferralExpiresAt)
					user.FinishInsert(inviter.Id)
					var logs []Log
					require.NoError(t, db.Where("user_id IN ? AND type = ?", []int{inviter.Id, user.Id}, LogTypeSystem).Order("id").Find(&logs).Error)
					require.Len(t, logs, 3)
					for i, expected := range []struct {
						key   string
						quota int
					}{
						{"New user sign-up bonus {{quota}}", 20},
						{"Invitation code bonus {{quota}}", 30},
						{"Bonus for inviting a user {{quota}}", 40},
					} {
						assert.Equal(t, common.NewMessage(expected.key, map[string]any{"quota": logger.FormatQuota(expected.quota)}).Error(), logs[i].Content,
							"post-commit logs describe the actual award, not the newly published rule")
					}
				})
			}
		})
	}
}
