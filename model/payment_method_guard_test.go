package model

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/glebarez/sqlite"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func insertUserForPaymentGuardTest(t *testing.T, id int, quota int) *User {
	t.Helper()
	user := &User{
		Id:       id,
		Username: "payment_guard_user",
		Status:   common.UserStatusEnabled,
		Quota:    quota,
	}
	require.NoError(t, DB.Create(user).Error)
	return user
}

func insertSubscriptionPlanForPaymentGuardTest(t *testing.T, id int) *SubscriptionPlan {
	t.Helper()
	plan := &SubscriptionPlan{
		Id:            id,
		Title:         "Guard Plan",
		PriceAmount:   9.99,
		Currency:      "USD",
		DurationUnit:  SubscriptionDurationMonth,
		DurationValue: 1,
		Enabled:       true,
		TotalAmount:   1000,
	}
	require.NoError(t, DB.Create(plan).Error)
	return plan
}

func insertSubscriptionOrderForPaymentGuardTest(t *testing.T, tradeNo string, userID int, planID int, paymentProvider string) {
	t.Helper()
	order := &SubscriptionOrder{
		UserId:          userID,
		PlanId:          planID,
		Money:           9.99,
		TradeNo:         tradeNo,
		PaymentMethod:   paymentProvider,
		PaymentProvider: paymentProvider,
		Status:          common.TopUpStatusPending,
		CreateTime:      time.Now().Unix(),
	}
	require.NoError(t, order.Insert())
}

func insertTopUpForPaymentGuardTest(t *testing.T, tradeNo string, userID int, paymentProvider string) {
	t.Helper()
	topUp := &TopUp{
		UserId:          userID,
		Amount:          2,
		Money:           9.99,
		TradeNo:         tradeNo,
		PaymentMethod:   paymentProvider,
		PaymentProvider: paymentProvider,
		Status:          common.TopUpStatusPending,
		CreateTime:      time.Now().Unix(),
	}
	require.NoError(t, topUp.Insert())
}

func getTopUpStatusForPaymentGuardTest(t *testing.T, tradeNo string) string {
	t.Helper()
	topUp := GetTopUpByTradeNo(tradeNo)
	require.NotNil(t, topUp)
	return topUp.Status
}

func countUserSubscriptionsForPaymentGuardTest(t *testing.T, userID int) int64 {
	t.Helper()
	var count int64
	require.NoError(t, DB.Model(&UserSubscription{}).Where("user_id = ?", userID).Count(&count).Error)
	return count
}

func getUserQuotaForPaymentGuardTest(t *testing.T, userID int) int {
	t.Helper()
	var user User
	require.NoError(t, DB.Select("quota").Where("id = ?", userID).First(&user).Error)
	return user.Quota
}

func TestRechargeWaffoPancake_RejectsMismatchedPaymentMethod(t *testing.T) {
	truncateTables(t)

	insertUserForPaymentGuardTest(t, 101, 0)
	insertTopUpForPaymentGuardTest(t, "waffo-pancake-guard", 101, PaymentProviderStripe)

	err := RechargeWaffoPancake("waffo-pancake-guard")
	require.Error(t, err)

	topUp := GetTopUpByTradeNo("waffo-pancake-guard")
	require.NotNil(t, topUp)
	assert.Equal(t, common.TopUpStatusPending, topUp.Status)
	assert.Equal(t, 0, getUserQuotaForPaymentGuardTest(t, 101))
}

func TestTopUpHistoryQueriesKeepOneSnapshotAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB := DB
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			DB = db
			kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(kind, kind)
			t.Cleanup(func() {
				DB = previousDB
				common.SetDatabaseTypes(previousMain, previousLog)
			})
			if dialect == "sqlite" {
				require.NoError(t, db.Exec("PRAGMA journal_mode=WAL").Error)
			}
			require.NoError(t, db.AutoMigrate(&TopUp{}))
			for _, query := range []string{"user", "admin", "search_user", "search_admin"} {
				t.Run(query, func(t *testing.T) {
					require.NoError(t, db.Where("1 = 1").Delete(&TopUp{}).Error)
					original := TopUp{UserId: 1, TradeNo: "snapshot-original", CreateTime: time.Now().Unix(), Status: common.TopUpStatusPending}
					require.NoError(t, db.Create(&original).Error)
					inserted := false
					hook := "test_topup_history_concurrent_insert"
					require.NoError(t, db.Callback().Query().After("gorm:query").Register(hook, func(tx *gorm.DB) {
						if inserted || tx.Statement.Table != "top_ups" {
							return
						}
						inserted = true
						// The first query is COUNT. Commit through another connection before
						// the page read to reproduce a normal concurrently created checkout.
						concurrent := TopUp{UserId: 1, TradeNo: "snapshot-concurrent", CreateTime: original.CreateTime, Status: common.TopUpStatusPending}
						require.NoError(t, db.Create(&concurrent).Error)
					}))
					t.Cleanup(func() { require.NoError(t, db.Callback().Query().Remove(hook)) })
					page := &common.PageInfo{Page: 1, PageSize: 10}
					var rows []*TopUp
					var total int64
					var err error
					switch query {
					case "user":
						rows, total, err = GetUserTopUps(t.Context(), 1, page)
					case "admin":
						rows, total, err = GetAllTopUps(t.Context(), page)
					case "search_user":
						rows, total, err = SearchUserTopUps(t.Context(), 1, "snapshot%", page)
					case "search_admin":
						rows, total, err = SearchAllTopUps(t.Context(), "snapshot%", page)
					}
					require.NoError(t, err)
					require.True(t, inserted)
					assert.EqualValues(t, 1, total)
					require.Len(t, rows, 1, "count and page must use the same committed snapshot")
					assert.Equal(t, original.TradeNo, rows[0].TradeNo)
					var committedCount int64
					require.NoError(t, db.Model(&TopUp{}).Count(&committedCount).Error)
					assert.EqualValues(t, 2, committedCount, "the concurrent order was durably created")
				})
			}
		})
	}
}

func TestUpdatePendingTopUpStatus_RejectsMismatchedPaymentProvider(t *testing.T) {
	testCases := []struct {
		name                    string
		tradeNo                 string
		storedPaymentProvider   string
		expectedPaymentProvider string
		targetStatus            string
	}{
		{
			name:                    "stripe expire",
			tradeNo:                 "stripe-expire-guard",
			storedPaymentProvider:   PaymentProviderCreem,
			expectedPaymentProvider: PaymentProviderStripe,
			targetStatus:            common.TopUpStatusExpired,
		},
		{
			name:                    "waffo failed",
			tradeNo:                 "waffo-failed-guard",
			storedPaymentProvider:   PaymentProviderStripe,
			expectedPaymentProvider: PaymentProviderWaffo,
			targetStatus:            common.TopUpStatusFailed,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			truncateTables(t)
			insertUserForPaymentGuardTest(t, 150, 0)
			insertTopUpForPaymentGuardTest(t, tc.tradeNo, 150, tc.storedPaymentProvider)

			err := UpdatePendingTopUpStatus(tc.tradeNo, tc.expectedPaymentProvider, tc.targetStatus)
			require.ErrorIs(t, err, ErrPaymentMethodMismatch)
			assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForPaymentGuardTest(t, tc.tradeNo))
		})
	}
}

func TestCompleteSubscriptionOrder_RejectsMismatchedPaymentProvider(t *testing.T) {
	truncateTables(t)

	insertUserForPaymentGuardTest(t, 202, 0)
	plan := insertSubscriptionPlanForPaymentGuardTest(t, 301)
	insertSubscriptionOrderForPaymentGuardTest(t, "sub-guard-order", 202, plan.Id, PaymentProviderStripe)

	err := CompleteSubscriptionOrder("sub-guard-order", `{"provider":"epay"}`, PaymentProviderEpay, "alipay")
	require.ErrorIs(t, err, ErrPaymentMethodMismatch)

	order := GetSubscriptionOrderByTradeNo("sub-guard-order")
	require.NotNil(t, order)
	assert.Equal(t, common.TopUpStatusPending, order.Status)
	assert.Zero(t, countUserSubscriptionsForPaymentGuardTest(t, 202))

	topUp := GetTopUpByTradeNo("sub-guard-order")
	assert.Nil(t, topUp)
}

func TestExpireSubscriptionOrder_RejectsMismatchedPaymentProvider(t *testing.T) {
	truncateTables(t)

	insertUserForPaymentGuardTest(t, 303, 0)
	plan := insertSubscriptionPlanForPaymentGuardTest(t, 401)
	insertSubscriptionOrderForPaymentGuardTest(t, "sub-expire-guard", 303, plan.Id, PaymentProviderStripe)

	err := ExpireSubscriptionOrder("sub-expire-guard", PaymentProviderCreem)
	require.ErrorIs(t, err, ErrPaymentMethodMismatch)

	order := GetSubscriptionOrderByTradeNo("sub-expire-guard")
	require.NotNil(t, order)
	assert.Equal(t, common.TopUpStatusPending, order.Status)
}

func createEpayTestOrder(t *testing.T, userId int, tradeNo string, provider string, status string) TopUp {
	t.Helper()
	topUp := TopUp{
		UserId:          userId,
		Amount:          2,
		Money:           10.0,
		TradeNo:         tradeNo,
		PaymentMethod:   "alipay",
		PaymentProvider: provider,
		CreateTime:      common.GetTimestamp(),
		Status:          status,
	}
	require.NoError(t, DB.Create(&topUp).Error)
	return topUp
}

func TestRechargeEpayCreditsQuotaExactlyOnce(t *testing.T) {
	truncateTables(t)

	oldQuotaPerUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 500000
	t.Cleanup(func() { common.QuotaPerUnit = oldQuotaPerUnit })

	user := insertUserForPaymentGuardTest(t, 501, 0)
	order := createEpayTestOrder(t, user.Id, "EPAYTESTONCE", PaymentProviderEpay, common.TopUpStatusPending)

	alreadyDone, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
	require.NoError(t, err)
	assert.False(t, alreadyDone)
	assert.Equal(t, 2*500000, getUserQuotaForPaymentGuardTest(t, user.Id))

	reloaded := GetTopUpByTradeNo(order.TradeNo)
	require.NotNil(t, reloaded)
	assert.Equal(t, common.TopUpStatusSuccess, reloaded.Status)
	assert.NotZero(t, reloaded.CompleteTime)

	alreadyDone, err = RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
	require.NoError(t, err)
	assert.True(t, alreadyDone)
	assert.Equal(t, 2*500000, getUserQuotaForPaymentGuardTest(t, user.Id))
}

func TestRechargeEpayKeepsRedisAndDatabaseCreditInSync(t *testing.T) {
	truncateTables(t)
	useUserCacheMiniRedis(t)

	oldQuotaPerUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 5
	t.Cleanup(func() { common.QuotaPerUnit = oldQuotaPerUnit })

	user := insertUserForPaymentGuardTest(t, 502, 7)
	require.NoError(t, populateUserCache(*user))
	order := createEpayTestOrder(t, user.Id, "EPAYTESTREDISSYNC", PaymentProviderEpay, common.TopUpStatusPending)

	alreadyDone, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
	require.NoError(t, err)
	assert.False(t, alreadyDone)
	assert.Equal(t, 17, getUserQuotaForPaymentGuardTest(t, user.Id))
	cached, err := cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, 17, cached.Quota)

	alreadyDone, err = RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
	require.NoError(t, err)
	assert.True(t, alreadyDone)
	cached, err = cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, 17, cached.Quota)
}

func TestRechargeEpayUpdatesPaymentMethodToActual(t *testing.T) {
	truncateTables(t)

	oldQuotaPerUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 500000
	t.Cleanup(func() { common.QuotaPerUnit = oldQuotaPerUnit })

	user := insertUserForPaymentGuardTest(t, 503, 0)
	order := createEpayTestOrder(t, user.Id, "EPAYTESTMETHOD", PaymentProviderEpay, common.TopUpStatusPending)

	alreadyDone, err := RechargeEpay(order.TradeNo, "wxpay", "127.0.0.1")
	require.NoError(t, err)
	assert.False(t, alreadyDone)

	reloaded := GetTopUpByTradeNo(order.TradeNo)
	require.NotNil(t, reloaded)
	assert.Equal(t, "wxpay", reloaded.PaymentMethod)
	assert.Equal(t, 2*500000, getUserQuotaForPaymentGuardTest(t, user.Id))
}

func TestRechargeEpayRejectsForeignAndNonPendingOrders(t *testing.T) {
	truncateTables(t)

	oldQuotaPerUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 500000
	t.Cleanup(func() { common.QuotaPerUnit = oldQuotaPerUnit })

	user := insertUserForPaymentGuardTest(t, 504, 7)

	t.Run("order from another payment provider", func(t *testing.T) {
		order := createEpayTestOrder(t, user.Id, "EPAYTESTSTRIPE", PaymentProviderStripe, common.TopUpStatusPending)
		_, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
		assert.ErrorIs(t, err, ErrPaymentMethodMismatch)
		assert.Equal(t, 7, getUserQuotaForPaymentGuardTest(t, user.Id))
	})

	t.Run("order that is not pending", func(t *testing.T) {
		order := createEpayTestOrder(t, user.Id, "EPAYTESTEXPIRED", PaymentProviderEpay, common.TopUpStatusExpired)
		_, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
		assert.ErrorIs(t, err, ErrTopUpStatusInvalid)
		assert.Equal(t, 7, getUserQuotaForPaymentGuardTest(t, user.Id))
	})

	t.Run("missing order", func(t *testing.T) {
		_, err := RechargeEpay("EPAYTESTMISSING", "alipay", "127.0.0.1")
		assert.ErrorIs(t, err, ErrTopUpNotFound)
	})
}

func TestRechargeEpayRejectsQuotaOverflowBeforeCompletingOrder(t *testing.T) {
	truncateTables(t)

	oldQuotaPerUnit := common.QuotaPerUnit
	common.QuotaPerUnit = float64(common.MaxWalletQuota + 1)
	t.Cleanup(func() { common.QuotaPerUnit = oldQuotaPerUnit })

	user := insertUserForPaymentGuardTest(t, 505, 3)
	order := createEpayTestOrder(t, user.Id, "EPAYTESTOVERFLOW", PaymentProviderEpay, common.TopUpStatusPending)

	_, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
	require.Error(t, err)
	assert.Equal(t, 3, getUserQuotaForPaymentGuardTest(t, user.Id))
	assert.Equal(t, common.TopUpStatusPending, getTopUpStatusForPaymentGuardTest(t, order.TradeNo))
}

func TestRechargeEpayEnforcesFinalWalletQuotaLimit(t *testing.T) {
	oldQuotaPerUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 500000
	t.Cleanup(func() { common.QuotaPerUnit = oldQuotaPerUnit })

	testCases := []struct {
		name         string
		currentQuota int
		wantErr      bool
		wantQuota    int
		wantStatus   string
	}{
		{
			name:         "allows exact highest representable wallet balance",
			currentQuota: common.MaxWalletQuota - 1_000_000,
			wantQuota:    common.MaxWalletQuota,
			wantStatus:   common.TopUpStatusSuccess,
		},
		{
			name:         "rejects balance above wallet quota domain",
			currentQuota: common.MaxWalletQuota - 999_999,
			wantErr:      true,
			wantQuota:    common.MaxWalletQuota - 999_999,
			wantStatus:   common.TopUpStatusPending,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			truncateTables(t)
			user := insertUserForPaymentGuardTest(t, 506, tc.currentQuota)
			order := createEpayTestOrder(t, user.Id, "EPAYTESTWALLETLIMIT", PaymentProviderEpay, common.TopUpStatusPending)

			_, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
			if tc.wantErr {
				require.ErrorIs(t, err, ErrTopUpQuotaLimitExceeded)
			} else {
				require.NoError(t, err)
			}
			assert.Equal(t, tc.wantQuota, getUserQuotaForPaymentGuardTest(t, user.Id))
			assert.Equal(t, tc.wantStatus, getTopUpStatusForPaymentGuardTest(t, order.TradeNo))
		})
	}
}

type referralProcessOutcome struct {
	Error string `json:"error"`
	Quota int    `json:"quota,omitempty"`
}

type referralProcessOperation struct {
	Mode      string
	TradeNo   string
	RequestID string
	Quota     int
}

// The helper is a separate OS process and opens its own pool. FD 3 announces
// that its funds transaction has reached its first locking read; FD 4 releases
// the competitors together. FD 5 returns only the operation result.
func TestReferralCrossProcessWorker(t *testing.T) {
	mode := os.Getenv("REFERRAL_PROCESS_MODE")
	if mode == "" {
		t.Skip("only executed by the isolated cross-process integration test")
	}
	dialect, dsn := os.Getenv("REFERRAL_PROCESS_DIALECT"), os.Getenv("REFERRAL_PROCESS_DSN")
	var dialector gorm.Dialector
	switch dialect {
	case "sqlite":
		dialector = sqlite.Open(dsn)
		common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	case "mysql":
		dialector = mysql.Open(dsn)
		common.SetDatabaseTypes(common.DatabaseTypeMySQL, common.DatabaseTypeMySQL)
	case "postgres":
		dialector = postgres.New(postgres.Config{DSN: dsn, PreferSimpleProtocol: true})
		common.SetDatabaseTypes(common.DatabaseTypePostgreSQL, common.DatabaseTypePostgreSQL)
	default:
		t.Fatal("unexpected child database dialect")
	}
	db, err := gorm.Open(dialector, newGormConfig(false))
	require.NoError(t, err)
	DB, LOG_DB = db, db
	common.RedisEnabled, common.BatchUpdateEnabled = false, false
	common.QuotaPerUnit = 1
	payment := operation_setting.GetPaymentSetting()
	payment.ComplianceConfirmed, payment.ComplianceTermsVersion = true, operation_setting.CurrentComplianceTermsVersion
	if interruption := os.Getenv("REFERRAL_PROCESS_INTERRUPT"); interruption != "" {
		client := redis.NewClient(&redis.Options{Addr: os.Getenv("NEW_API_REFERRAL_REDIS_ADDR"), DB: 14, MaxRetries: -1})
		require.NoError(t, client.Ping(t.Context()).Err())
		common.RDB, common.RedisEnabled = client, true
		switch interruption {
		case "before_commit":
			require.NoError(t, db.Callback().Update().After("gorm:update").Register("referral_exit_before_commit", func(tx *gorm.DB) {
				// The last funds write ran in the outer SQL transaction. Exiting
				// here closes the process without running rollback/cache defers.
				if tx.Statement.Table == "top_ups" && tx.Error == nil && tx.RowsAffected == 1 {
					os.Exit(87)
				}
			}))
		case "after_commit":
			DB = db.Session(&gorm.Session{Context: t.Context()})
			DB.Statement.ConnPool = creditCommitPool{ConnPool: db.Statement.ConnPool, afterCommit: func() error {
				// creditCommitPool calls this only after sql.Tx.Commit succeeds,
				// before the caller can finalize its captured Redis delta.
				os.Exit(88)
				return nil
			}}
		default:
			t.Fatal("unexpected process interruption point")
		}
		_, err := RechargeEpay(os.Getenv("REFERRAL_PROCESS_TRADE"), "alipay", "127.0.0.1")
		t.Fatalf("wallet settlement returned instead of reaching interruption: %v", err)
	}
	ready, release, resultPipe := os.NewFile(3, "ready"), os.NewFile(4, "release"), os.NewFile(5, "result")
	defer ready.Close()
	defer release.Close()
	defer resultPipe.Close()
	if mode == "cache_fill" || mode == "cache_credit" {
		client := redis.NewClient(&redis.Options{Addr: os.Getenv("NEW_API_REFERRAL_REDIS_ADDR"), DB: 14, MaxRetries: -1})
		require.NoError(t, client.Ping(t.Context()).Err())
		defer client.Close()
		common.RDB, common.RedisEnabled = client, true
		userID, parseErr := strconv.Atoi(os.Getenv("REFERRAL_PROCESS_USER"))
		require.NoError(t, parseErr)
		var barrierOnce sync.Once
		barrier := func(tx *gorm.DB) {
			barrierOnce.Do(func() {
				var backendID int
				backendQuery := "SELECT CONNECTION_ID()"
				if dialect == "postgres" {
					backendQuery = "SELECT pg_backend_pid()"
				}
				if dialect != "sqlite" {
					if err := tx.Session(&gorm.Session{NewDB: true}).Raw(backendQuery).Scan(&backendID).Error; err != nil {
						tx.AddError(err)
						return
					}
				}
				if _, err := fmt.Fprintln(ready, backendID); err != nil {
					tx.AddError(err)
					return
				}
				var signal [1]byte
				if _, err := io.ReadFull(release, signal[:]); err != nil {
					tx.AddError(err)
				}
			})
		}
		if os.Getenv("REFERRAL_PROCESS_CACHE_BARRIER") == "holder" {
			if mode == "cache_fill" {
				require.NoError(t, db.Callback().Query().After("gorm:query").Register("cache_fill_holds_user", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" && tx.Error == nil {
						barrier(tx) // Authoritative read completed; cache is still cold.
					}
				}))
			} else {
				require.NoError(t, db.Callback().Update().After("gorm:update").Register("cache_credit_before_commit", func(tx *gorm.DB) {
					if tx.Statement.Table == "top_ups" && tx.Error == nil && tx.RowsAffected == 1 {
						barrier(tx) // Cold-cache capture and funds writes have completed.
					}
				}))
			}
		} else if dialect == "sqlite" {
			require.NoError(t, db.Callback().Update().Before("gorm:update").Register("cache_waits_for_user", func(tx *gorm.DB) {
				if tx.Statement.Table == "users" {
					barrier(tx)
				}
			}))
		} else {
			require.NoError(t, db.Callback().Query().Before("gorm:query").Register("cache_waits_for_user", func(tx *gorm.DB) {
				locking, ok := tx.Statement.Clauses["FOR"].Expression.(clause.Locking)
				if tx.Statement.Table == "users" && ok && locking.Strength == "UPDATE" {
					barrier(tx)
				}
			}))
		}
		result := referralProcessOutcome{}
		if mode == "cache_fill" {
			var user *UserBase
			user, err = GetUserCache(userID)
			if err == nil {
				result.Quota = user.Quota
			}
		} else {
			_, err = RechargeEpay(os.Getenv("REFERRAL_PROCESS_TRADE"), "alipay", "127.0.0.1")
		}
		if err != nil {
			result.Error = err.Error()
		}
		encoded, marshalErr := common.Marshal(result)
		require.NoError(t, marshalErr)
		_, writeErr := resultPipe.Write(encoded)
		require.NoError(t, writeErr)
		return
	}
	var once sync.Once
	table := "top_ups"
	if mode == "transfer" {
		table = "users"
	}
	barrier := func(tx *gorm.DB) {
		if tx.Statement.Table != table {
			return
		}
		once.Do(func() {
			if _, err := ready.Write([]byte{1}); err != nil {
				tx.AddError(err)
				return
			}
			var signal [1]byte
			if _, err := io.ReadFull(release, signal[:]); err != nil {
				tx.AddError(err)
			}
		})
	}
	if dialect == "sqlite" && mode == "transfer" {
		// SQLite's first account lock is its write reservation; waiting
		// after that write would prevent the other process reaching the gate.
		require.NoError(t, db.Callback().Update().Before("gorm:update").Register("referral_process_barrier", barrier))
	} else {
		require.NoError(t, db.Callback().Query().Before("gorm:query").Register("referral_process_barrier", barrier))
	}
	tradeNo := os.Getenv("REFERRAL_PROCESS_TRADE")
	switch mode {
	case "callback":
		_, err = RechargeEpay(tradeNo, "alipay", "127.0.0.1")
	case "manual":
		err = ManualCompleteTopUp(tradeNo, "127.0.0.1")
	case "transfer":
		quota, parseErr := strconv.Atoi(os.Getenv("REFERRAL_PROCESS_QUOTA"))
		require.NoError(t, parseErr)
		user := User{Id: 1}
		_, err = user.TransferAffQuotaToQuota(quota, os.Getenv("REFERRAL_PROCESS_REQUEST"))
	default:
		t.Fatal("unexpected child operation")
	}
	result := referralProcessOutcome{}
	if err != nil {
		result.Error = err.Error()
	}
	encoded, marshalErr := common.Marshal(result)
	require.NoError(t, marshalErr)
	_, writeErr := resultPipe.Write(encoded)
	require.NoError(t, writeErr)
}

func runReferralProcessRace(t *testing.T, dialect, dsn string, operations ...referralProcessOperation) []referralProcessOutcome {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	type competitor struct {
		command *exec.Cmd
		ready   *os.File
		release *os.File
		result  *os.File
		output  bytes.Buffer
	}
	competitors := make([]*competitor, 0, len(operations))
	for _, operation := range operations {
		readyRead, readyWrite, err := os.Pipe()
		require.NoError(t, err)
		releaseRead, releaseWrite, err := os.Pipe()
		require.NoError(t, err)
		resultRead, resultWrite, err := os.Pipe()
		require.NoError(t, err)
		worker := &competitor{ready: readyRead, release: releaseWrite, result: resultRead}
		worker.command = exec.CommandContext(ctx, executable, "-test.run=^TestReferralCrossProcessWorker$", "-test.count=1")
		worker.command.Env = append(os.Environ(), "REFERRAL_PROCESS_MODE="+operation.Mode, "REFERRAL_PROCESS_DIALECT="+dialect, "REFERRAL_PROCESS_DSN="+dsn,
			"REFERRAL_PROCESS_TRADE="+operation.TradeNo, "REFERRAL_PROCESS_REQUEST="+operation.RequestID, "REFERRAL_PROCESS_QUOTA="+strconv.Itoa(operation.Quota))
		worker.command.ExtraFiles = []*os.File{readyWrite, releaseRead, resultWrite}
		worker.command.Stdout, worker.command.Stderr = &worker.output, &worker.output
		require.NoError(t, worker.command.Start())
		_ = readyWrite.Close()
		_ = releaseRead.Close()
		_ = resultWrite.Close()
		competitors = append(competitors, worker)
		t.Cleanup(func() {
			_ = worker.ready.Close()
			_ = worker.release.Close()
			_ = worker.result.Close()
			if worker.command.ProcessState == nil {
				_ = worker.command.Process.Kill()
				_ = worker.command.Wait()
			}
		})
	}
	for _, worker := range competitors {
		var signal [1]byte
		_, err := io.ReadFull(worker.ready, signal[:])
		if err != nil {
			cancel()
			_ = worker.command.Wait()
			t.Fatalf("child did not reach the transaction barrier: %v; %s", err, worker.output.String())
		}
	}
	for _, worker := range competitors {
		_, err := worker.release.Write([]byte{1})
		require.NoError(t, err)
		_ = worker.release.Close()
	}
	outcomes := make([]referralProcessOutcome, 0, len(competitors))
	for _, worker := range competitors {
		require.NoError(t, worker.command.Wait(), worker.output.String())
		encoded, err := io.ReadAll(worker.result)
		require.NoError(t, err)
		var result referralProcessOutcome
		require.NoError(t, common.Unmarshal(encoded, &result), worker.output.String())
		outcomes = append(outcomes, result)
	}
	return outcomes
}

func TestReferralWalletSettlementAndTransferAcrossProcesses(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, dsn := newReferralIntegrationDatabase(t, dialect)
			previousDB, previousLogDB := DB, LOG_DB
			previousMainType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
			previousRedis, previousBatch, previousUnit := common.RedisEnabled, common.BatchUpdateEnabled, common.QuotaPerUnit
			previousPayment := *operation_setting.GetPaymentSetting()
			DB, LOG_DB = db, db
			common.RedisEnabled, common.BatchUpdateEnabled, common.QuotaPerUnit = false, false, 1
			databaseType := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(databaseType, databaseType)
			operation_setting.GetPaymentSetting().ComplianceConfirmed = true
			operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
			t.Cleanup(func() {
				DB, LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMainType, previousLogType)
				common.RedisEnabled, common.BatchUpdateEnabled, common.QuotaPerUnit = previousRedis, previousBatch, previousUnit
				*operation_setting.GetPaymentSetting() = previousPayment
			})
			require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &Option{}, &ReferralRebate{}, &AffiliateTransfer{}, &SubscriptionOrder{}, &Log{}))
			require.NoError(t, InitializeReferralRebateRule(db))
			require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 2}))
			owner := User{Id: 1, Username: "race-owner", AffCode: "race-owner-code", Quota: -5, AffQuota: 100, AffHistoryQuota: 200, Status: common.UserStatusEnabled}
			invitee := User{Id: 2, Username: "race-invitee", AffCode: "race-invitee-code", InviterId: 1, ReferralRateBPS: 1000, CreatedAt: time.Now().Unix() - 1, ReferralExpiresAt: time.Now().Unix() + 86400, Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&owner).Error)
			require.NoError(t, db.Create(&invitee).Error)
			quota := 100
			order := TopUp{UserId: invitee.Id, TradeNo: "cross-process-order", Amount: 100, Money: 90, CreditedQuota: &quota, PaymentProvider: PaymentProviderEpay, PaymentMethod: "alipay", Status: common.TopUpStatusPending, CreateTime: time.Now().Unix()}
			require.NoError(t, order.Insert())
			outcomes := runReferralProcessRace(t, dialect, dsn,
				referralProcessOperation{Mode: "callback", TradeNo: order.TradeNo},
				referralProcessOperation{Mode: "manual", TradeNo: order.TradeNo})
			successful := 0
			for _, outcome := range outcomes {
				if outcome.Error == "" {
					successful++
				} else {
					t.Logf("competing transaction returned a retryable/technical result: %s", outcome.Error)
				}
			}
			require.GreaterOrEqual(t, successful, 1)
			if dialect != "sqlite" {
				assert.Equal(t, 2, successful, "row locks must serialize independent process settlements")
			}
			// Retry only the original order identity after observing the race.
			duplicate, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
			require.NoError(t, err)
			assert.True(t, duplicate)
			require.NoError(t, ManualCompleteTopUp(order.TradeNo, "127.0.0.1"))
			require.NoError(t, db.First(&invitee, invitee.Id).Error)
			require.NoError(t, db.First(&owner, owner.Id).Error)
			require.NoError(t, db.First(&order, order.Id).Error)
			assert.Equal(t, 100, invitee.Quota)
			assert.Equal(t, 110, owner.AffQuota)
			assert.Equal(t, 210, owner.AffHistoryQuota)
			assert.Equal(t, common.TopUpStatusSuccess, order.Status)
			assert.GreaterOrEqual(t, order.CompleteTime, order.CreateTime)
			var facts []ReferralRebate
			require.NoError(t, db.Find(&facts).Error)
			require.Len(t, facts, 1)
			assert.EqualValues(t, 100, facts[0].CreditedQuota)
			assert.EqualValues(t, 10, facts[0].RewardQuota)
			assert.Equal(t, order.CompleteTime, facts[0].SettledAt)

			outcomes = runReferralProcessRace(t, dialect, dsn,
				referralProcessOperation{Mode: "transfer", RequestID: "cross-process-transfer-identity", Quota: 50},
				referralProcessOperation{Mode: "transfer", RequestID: "cross-process-transfer-identity", Quota: 50})
			successful = 0
			for _, outcome := range outcomes {
				if outcome.Error == "" {
					successful++
				}
			}
			require.GreaterOrEqual(t, successful, 1)
			if dialect != "sqlite" {
				assert.Equal(t, 2, successful)
			}
			_, err = owner.TransferAffQuotaToQuota(50, "cross-process-transfer-identity")
			require.NoError(t, err)
			require.NoError(t, db.First(&owner, owner.Id).Error)
			assert.Equal(t, 45, owner.Quota)
			assert.Equal(t, 60, owner.AffQuota)
			assert.Equal(t, 210, owner.AffHistoryQuota)
			var transfers []AffiliateTransfer
			require.NoError(t, db.Find(&transfers).Error)
			require.Len(t, transfers, 1)
			assert.Equal(t, 50, transfers[0].Quota)
			known, err := GetAffiliateTransfer(owner.Id, "cross-process-transfer-identity")
			require.NoError(t, err)
			require.NotNil(t, known)
			assert.Equal(t, transfers[0].ID, known.ID)

			// Independent orders must not lose increments on their common inviter.
			secondInvitee := User{Id: 3, Username: "race-second-invitee", AffCode: "race-second-code", InviterId: owner.Id, ReferralRateBPS: 1000, CreatedAt: invitee.CreatedAt, ReferralExpiresAt: invitee.ReferralExpiresAt, Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&secondInvitee).Error)
			secondOrder := TopUp{UserId: invitee.Id, TradeNo: "cross-process-second-order", Amount: 100, Money: 90, CreditedQuota: &quota, PaymentProvider: PaymentProviderEpay, PaymentMethod: "alipay", Status: common.TopUpStatusPending, CreateTime: time.Now().Unix()}
			thirdOrder := TopUp{UserId: secondInvitee.Id, TradeNo: "cross-process-third-order", Amount: 100, Money: 90, CreditedQuota: &quota, PaymentProvider: PaymentProviderEpay, PaymentMethod: "alipay", Status: common.TopUpStatusPending, CreateTime: time.Now().Unix()}
			require.NoError(t, secondOrder.Insert())
			require.NoError(t, thirdOrder.Insert())
			outcomes = runReferralProcessRace(t, dialect, dsn,
				referralProcessOperation{Mode: "callback", TradeNo: secondOrder.TradeNo},
				referralProcessOperation{Mode: "callback", TradeNo: thirdOrder.TradeNo})
			successful = 0
			for _, outcome := range outcomes {
				if outcome.Error == "" {
					successful++
				} else {
					t.Logf("independent order race returned: %s", outcome.Error)
				}
			}
			require.GreaterOrEqual(t, successful, 1)
			if dialect != "sqlite" {
				assert.Equal(t, 2, successful, "both distinct orders must settle under row locks")
			}
			for _, tradeNo := range []string{secondOrder.TradeNo, thirdOrder.TradeNo} {
				_, err := RechargeEpay(tradeNo, "alipay", "127.0.0.1")
				require.NoError(t, err, "retry the original identity after any SQLite write conflict")
			}
			require.NoError(t, db.First(&owner, owner.Id).Error)
			require.NoError(t, db.First(&invitee, invitee.Id).Error)
			require.NoError(t, db.First(&secondInvitee, secondInvitee.Id).Error)
			assert.Equal(t, 45, owner.Quota)
			assert.Equal(t, 80, owner.AffQuota)
			assert.Equal(t, 230, owner.AffHistoryQuota)
			assert.Equal(t, 200, invitee.Quota)
			assert.Equal(t, 100, secondInvitee.Quota)

			// Reward credit and transfer contend on the same account; either
			// serialization order must preserve both money movements.
			fourthOrder := TopUp{UserId: invitee.Id, TradeNo: "cross-process-credit-transfer", Amount: 100, Money: 90, CreditedQuota: &quota, PaymentProvider: PaymentProviderEpay, PaymentMethod: "alipay", Status: common.TopUpStatusPending, CreateTime: time.Now().Unix()}
			require.NoError(t, fourthOrder.Insert())
			outcomes = runReferralProcessRace(t, dialect, dsn,
				referralProcessOperation{Mode: "callback", TradeNo: fourthOrder.TradeNo},
				referralProcessOperation{Mode: "transfer", RequestID: "cross-process-rebate-transfer", Quota: 50})
			successful = 0
			for _, outcome := range outcomes {
				if outcome.Error == "" {
					successful++
				} else {
					t.Logf("reward credit and transfer race returned: %s", outcome.Error)
				}
			}
			require.GreaterOrEqual(t, successful, 1)
			if dialect != "sqlite" {
				assert.Equal(t, 2, successful)
			}
			_, err = RechargeEpay(fourthOrder.TradeNo, "alipay", "127.0.0.1")
			require.NoError(t, err)
			_, err = owner.TransferAffQuotaToQuota(50, "cross-process-rebate-transfer")
			require.NoError(t, err)
			require.NoError(t, db.First(&owner, owner.Id).Error)
			require.NoError(t, db.First(&invitee, invitee.Id).Error)
			assert.Equal(t, 95, owner.Quota)
			assert.Equal(t, 40, owner.AffQuota)
			assert.Equal(t, 240, owner.AffHistoryQuota)
			assert.Equal(t, 300, invitee.Quota)

			// Two different request identities may not each spend the same 40.
			limitedRequests := []string{"cross-process-limited-one", "cross-process-limited-two"}
			outcomes = runReferralProcessRace(t, dialect, dsn,
				referralProcessOperation{Mode: "transfer", RequestID: limitedRequests[0], Quota: 30},
				referralProcessOperation{Mode: "transfer", RequestID: limitedRequests[1], Quota: 30})
			successful = 0
			for _, outcome := range outcomes {
				if outcome.Error == "" {
					successful++
				}
			}
			require.Equal(t, 1, successful, "only one competing request can consume the limited reward balance")
			var limitedTransfers []AffiliateTransfer
			require.NoError(t, db.Where("request_id IN ?", limitedRequests).Find(&limitedTransfers).Error)
			var successfulRequest string
			rejectedCount := 0
			for _, transfer := range limitedTransfers {
				if transfer.Status == "success" {
					require.Empty(t, successfulRequest, "only one identity may move money")
					successfulRequest = transfer.RequestID
				} else {
					assert.Equal(t, "rejected", transfer.Status)
					rejectedCount++
				}
			}
			require.NotEmpty(t, successfulRequest)
			if dialect != "sqlite" {
				assert.Equal(t, 1, rejectedCount)
			}
			for _, requestID := range limitedRequests {
				known, lookupErr := GetAffiliateTransfer(owner.Id, requestID)
				result, retryErr := owner.TransferAffQuotaToQuota(30, requestID)
				if requestID == successfulRequest {
					require.NoError(t, lookupErr)
					require.NotNil(t, known)
					require.NoError(t, retryErr)
					assert.Equal(t, known.ID, result.ID)
				} else {
					var rejected *AffiliateTransferRejectedError
					if known == nil {
						require.Equal(t, "sqlite", dialect, "only a write conflict may lack a durable outcome")
						require.NoError(t, lookupErr)
					} else {
						require.ErrorAs(t, lookupErr, &rejected)
						assert.True(t, rejected.Persisted)
						assert.Equal(t, "rejected", known.Status)
					}
					require.ErrorAs(t, retryErr, &rejected)
					assert.True(t, rejected.Persisted)
					require.NotNil(t, result)
					assert.Equal(t, "rejected", result.Status)
					require.ErrorContains(t, retryErr, "Invitation quota is insufficient!")
				}
			}
			require.NoError(t, db.First(&owner, owner.Id).Error)
			assert.Equal(t, 125, owner.Quota)
			assert.Equal(t, 10, owner.AffQuota)
			assert.Equal(t, 240, owner.AffHistoryQuota)
			require.NoError(t, db.Find(&transfers).Error)
			require.Len(t, transfers, 4)
			transferred := 0
			successCount, rejectedCount := 0, 0
			for _, transfer := range transfers {
				if transfer.Status == "success" {
					transferred += transfer.Quota
					successCount++
				} else {
					assert.Equal(t, "rejected", transfer.Status)
					rejectedCount++
				}
			}
			assert.Equal(t, 3, successCount)
			assert.Equal(t, 1, rejectedCount)
			assert.Equal(t, 130, transferred)
			require.NoError(t, db.Order("top_up_id").Find(&facts).Error)
			require.Len(t, facts, 4)
			var settledOrders []TopUp
			require.NoError(t, db.Order("id").Find(&settledOrders).Error)
			require.Len(t, settledOrders, 4)
			var rewarded int64
			for i, fact := range facts {
				assert.Equal(t, settledOrders[i].Id, fact.TopUpID)
				assert.Equal(t, common.TopUpStatusSuccess, settledOrders[i].Status)
				assert.Equal(t, settledOrders[i].CompleteTime, fact.SettledAt)
				assert.GreaterOrEqual(t, fact.SettledAt, settledOrders[i].CreateTime)
				assert.EqualValues(t, 100, fact.CreditedQuota)
				assert.EqualValues(t, 10, fact.RewardQuota)
				rewarded += fact.RewardQuota
			}
			assert.EqualValues(t, 40, rewarded)
			assert.Equal(t, -5+transferred, owner.Quota)
			assert.Equal(t, 100+int(rewarded)-transferred, owner.AffQuota)
			assert.Equal(t, 200+int(rewarded), owner.AffHistoryQuota)
		})
	}
}

func TestReferralRuleSaveOrdersConcurrentSettlement(t *testing.T) {
	for _, dialect := range []string{"mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB, previousLogDB := DB, LOG_DB
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousRedis, previousBatch := common.RedisEnabled, common.BatchUpdateEnabled
			previousPayment := *operation_setting.GetPaymentSetting()
			DB, LOG_DB = db, db
			databaseType := common.DatabaseTypeMySQL
			if dialect == "postgres" {
				databaseType = common.DatabaseTypePostgreSQL
			}
			common.SetDatabaseTypes(databaseType, databaseType)
			common.RedisEnabled, common.BatchUpdateEnabled = false, false
			operation_setting.GetPaymentSetting().ComplianceConfirmed = true
			operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
			t.Cleanup(func() {
				DB, LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.RedisEnabled, common.BatchUpdateEnabled = previousRedis, previousBatch
				*operation_setting.GetPaymentSetting() = previousPayment
			})
			require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &Option{}, &ReferralRebate{}, &SubscriptionOrder{}, &Log{}))
			require.NoError(t, InitializeReferralRebateRule(db))
			require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 2}))
			owner := User{Username: "rule-lock-owner", AffCode: "rule-lock-owner", Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&owner).Error)
			invitee := User{Username: "rule-lock-invitee", AffCode: "rule-lock-invitee", InviterId: owner.Id, ReferralRateBPS: 1000, CreatedAt: time.Now().Unix() - 1, ReferralExpiresAt: time.Now().Unix() + 86400, Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&invitee).Error)
			quota := 100
			first := TopUp{UserId: invitee.Id, TradeNo: "rule-before-pause", PaymentProvider: PaymentProviderEpay, PaymentMethod: "alipay", Status: common.TopUpStatusPending, CreditedQuota: &quota}
			require.NoError(t, first.Insert())
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			DB = db.WithContext(ctx)
			readerAcquired := make(chan int, 1)
			writerStarted := make(chan int, 1)
			releaseReader := make(chan struct{})
			release := sync.OnceFunc(func() { close(releaseReader) })
			var readerOnce sync.Once
			backendQuery := "SELECT CONNECTION_ID()"
			waitQuery := "SELECT COUNT(*) FROM information_schema.innodb_lock_waits w JOIN information_schema.innodb_trx t ON t.trx_id = w.requesting_trx_id WHERE t.trx_mysql_thread_id = ?"
			if dialect == "postgres" {
				backendQuery = "SELECT pg_backend_pid()"
				waitQuery = "SELECT COUNT(*) FROM pg_stat_activity WHERE pid = ? AND wait_event_type = 'Lock'"
			}
			require.NoError(t, db.Callback().Query().Before("gorm:query").Register("referral_rule_writer_ready", func(tx *gorm.DB) {
				locking, ok := tx.Statement.Clauses["FOR"].Expression.(clause.Locking)
				if tx.Statement.Table != "options" || !ok || locking.Strength != "UPDATE" {
					return
				}
				var backendID int
				if err := tx.Session(&gorm.Session{NewDB: true}).Raw(backendQuery).Scan(&backendID).Error; err != nil {
					tx.AddError(err)
					return
				}
				writerStarted <- backendID
			}))
			require.NoError(t, db.Callback().Query().After("gorm:query").Register("referral_rule_reader_acquired", func(tx *gorm.DB) {
				locking, ok := tx.Statement.Clauses["FOR"].Expression.(clause.Locking)
				if tx.Statement.Table != "options" || !ok || locking.Strength != "SHARE" || tx.Error != nil {
					return
				}
				readerOnce.Do(func() {
					var backendID int
					if err := tx.Session(&gorm.Session{NewDB: true}).Raw(backendQuery).Scan(&backendID).Error; err != nil {
						tx.AddError(err)
						return
					}
					readerAcquired <- backendID
					select {
					case <-releaseReader:
					case <-ctx.Done():
						tx.AddError(ctx.Err())
					}
				})
			}))
			removeCallbacks := sync.OnceFunc(func() {
				assert.NoError(t, db.Callback().Query().Remove("referral_rule_writer_ready"))
				assert.NoError(t, db.Callback().Query().Remove("referral_rule_reader_acquired"))
			})
			t.Cleanup(removeCallbacks)
			var workers sync.WaitGroup
			t.Cleanup(func() {
				// Failure must join both workers before callbacks or global fixture
				// state are restored for the next database subtest.
				cancel()
				release()
				workers.Wait()
			})
			settled := make(chan error, 1)
			workers.Go(func() {
				_, err := RechargeEpay(first.TradeNo, "alipay", "127.0.0.1")
				settled <- err
			})
			var readerID int
			select {
			case readerID = <-readerAcquired:
			case <-ctx.Done():
				t.Fatal("settlement did not acquire the shared configuration lock")
			}
			saved := make(chan error, 1)
			workers.Go(func() {
				saved <- SaveReferralRebateRule(ReferralRebateRule{Enabled: false, RateBPS: 1000, ValidDays: 2})
			})
			var writerID int
			select {
			case writerID = <-writerStarted:
			case <-ctx.Done():
				t.Fatal("configuration writer did not reach its exclusive lock")
			}
			require.NotEqual(t, readerID, writerID, "the race must use separate real database connections")
			// Wait for the database's own lock-wait evidence, not elapsed time.
			// MySQL 5.7 refreshes this snapshot only after more than 100ms
			// without a read. Reset after each observation so busy polling
			// cannot keep an initially empty monitor snapshot alive forever.
			poll := time.NewTimer(0)
			defer poll.Stop()
			for {
				select {
				case <-poll.C:
				case <-ctx.Done():
					t.Fatal("configuration writer did not enter the database lock wait")
				}
				var blocked int64
				require.NoError(t, db.WithContext(ctx).Raw(waitQuery, writerID).Scan(&blocked).Error)
				if blocked > 0 {
					break
				}
				poll.Reset(150 * time.Millisecond)
			}
			release()
			require.NoError(t, <-settled)
			require.NoError(t, <-saved)
			workers.Wait()
			removeCallbacks()
			var originalFact ReferralRebate
			require.NoError(t, db.Where("top_up_id = ?", first.Id).First(&originalFact).Error)
			assert.EqualValues(t, 10, originalFact.RewardQuota, "an earlier shared-lock settlement commits before the pause")
			paused := TopUp{UserId: invitee.Id, TradeNo: "rule-during-pause", PaymentProvider: PaymentProviderEpay, PaymentMethod: "alipay", Status: common.TopUpStatusPending, CreditedQuota: &quota}
			require.NoError(t, paused.Insert())
			_, err := RechargeEpay(paused.TradeNo, "alipay", "127.0.0.1")
			require.NoError(t, err)
			require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 2000, ValidDays: 5}))
			resumed := TopUp{UserId: invitee.Id, TradeNo: "rule-after-resume", PaymentProvider: PaymentProviderEpay, PaymentMethod: "alipay", Status: common.TopUpStatusPending, CreditedQuota: &quota}
			require.NoError(t, resumed.Insert())
			_, err = RechargeEpay(resumed.TradeNo, "alipay", "127.0.0.1")
			require.NoError(t, err)
			_, err = RechargeEpay(paused.TradeNo, "alipay", "127.0.0.1")
			require.NoError(t, err)
			var facts []ReferralRebate
			require.NoError(t, db.Order("id").Find(&facts).Error)
			require.Len(t, facts, 2, "a paused success never receives a retroactive reward")
			assert.EqualValues(t, 10, facts[1].RewardQuota, "the registered snapshot survives a changed global rate")
			require.NoError(t, db.First(&owner, owner.Id).Error)
			require.NoError(t, db.First(&invitee, invitee.Id).Error)
			assert.Equal(t, 20, owner.AffQuota)
			assert.Equal(t, 20, owner.AffHistoryQuota)
			assert.Equal(t, 300, invitee.Quota)
		})
	}
}

func TestReferralSettlementRechecksEligibilityAfterUserLockWait(t *testing.T) {
	for _, dialect := range []string{"mysql", "postgres"} {
		for _, scenario := range []string{"expires_while_blocked", "inviter_disabled_while_blocked"} {
			t.Run(dialect+"/"+scenario, func(t *testing.T) {
				db, _ := newReferralIntegrationDatabase(t, dialect)
				previousDB, previousLogDB := DB, LOG_DB
				previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
				previousRedis, previousBatch := common.RedisEnabled, common.BatchUpdateEnabled
				previousPayment := *operation_setting.GetPaymentSetting()
				ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
				defer cancel()
				DB, LOG_DB = db.WithContext(ctx), db
				databaseType := common.DatabaseTypeMySQL
				backendQuery := "SELECT CONNECTION_ID()"
				waitQuery := "SELECT COUNT(*) FROM information_schema.innodb_lock_waits w JOIN information_schema.innodb_trx t ON t.trx_id = w.requesting_trx_id WHERE t.trx_mysql_thread_id = ?"
				if dialect == "postgres" {
					databaseType = common.DatabaseTypePostgreSQL
					backendQuery = "SELECT pg_backend_pid()"
					waitQuery = "SELECT COUNT(*) FROM pg_stat_activity WHERE pid = ? AND wait_event_type = 'Lock'"
				}
				common.SetDatabaseTypes(databaseType, databaseType)
				common.RedisEnabled, common.BatchUpdateEnabled = false, false
				operation_setting.GetPaymentSetting().ComplianceConfirmed = true
				operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
				t.Cleanup(func() {
					DB, LOG_DB = previousDB, previousLogDB
					common.SetDatabaseTypes(previousMain, previousLog)
					common.RedisEnabled, common.BatchUpdateEnabled = previousRedis, previousBatch
					*operation_setting.GetPaymentSetting() = previousPayment
				})
				require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &Option{}, &ReferralRebate{}, &SubscriptionOrder{}, &Log{}))
				require.NoError(t, InitializeReferralRebateRule(db))
				require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 2}))
				owner := User{Username: "user-lock-owner", AffCode: "user-lock-owner", Status: common.UserStatusEnabled}
				require.NoError(t, db.Create(&owner).Error)
				invitee := User{Username: "user-lock-invitee", AffCode: "user-lock-invitee", InviterId: owner.Id, ReferralRateBPS: 1000, CreatedAt: time.Now().Unix() - 1, ReferralExpiresAt: time.Now().Unix() + 86400, Status: common.UserStatusEnabled}
				require.NoError(t, db.Create(&invitee).Error)
				credit := 100
				order := TopUp{UserId: invitee.Id, TradeNo: "eligibility-after-user-lock", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, PaymentMethod: "alipay", Status: common.TopUpStatusPending}
				require.NoError(t, order.Insert())
				blocker := db.WithContext(ctx).Begin()
				require.NoError(t, blocker.Error)
				defer blocker.Rollback()
				require.NoError(t, lockForUpdate(blocker).First(&owner, owner.Id).Error)
				var blockerID int
				require.NoError(t, blocker.Raw(backendQuery).Scan(&blockerID).Error)
				if scenario == "expires_while_blocked" {
					invitee.ReferralExpiresAt = time.Now().Unix() + 3
					require.NoError(t, db.Model(&invitee).Update("referral_expires_at", invitee.ReferralExpiresAt).Error)
				}
				waiting := make(chan int, 1)
				var once sync.Once
				require.NoError(t, db.Callback().Query().Before("gorm:query").Register("referral_user_lock_wait", func(tx *gorm.DB) {
					locking, ok := tx.Statement.Clauses["FOR"].Expression.(clause.Locking)
					if tx.Statement.Table != "users" || !ok || locking.Strength != "UPDATE" {
						return
					}
					once.Do(func() {
						var backendID int
						if err := tx.Session(&gorm.Session{NewDB: true}).Raw(backendQuery).Scan(&backendID).Error; err != nil {
							tx.AddError(err)
							return
						}
						waiting <- backendID
					})
				}))
				t.Cleanup(func() {
					assert.NoError(t, db.Callback().Query().Remove("referral_user_lock_wait"))
				})
				var workers sync.WaitGroup
				t.Cleanup(func() {
					cancel()
					_ = blocker.Rollback().Error
					workers.Wait()
				})
				settled := make(chan error, 1)
				workers.Go(func() {
					_, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
					settled <- err
				})
				var waiterID int
				select {
				case waiterID = <-waiting:
				case <-ctx.Done():
					t.Fatal("settlement did not reach the user locking read")
				}
				require.NotEqual(t, blockerID, waiterID)
				// Allow MySQL's shared lock-monitor snapshot to refresh after
				// each read; only actual lock-wait evidence releases this gate.
				poll := time.NewTimer(0)
				defer poll.Stop()
				for {
					select {
					case <-poll.C:
					case <-ctx.Done():
						t.Fatal("settlement did not enter the database user lock wait")
					}
					var blocked int64
					require.NoError(t, db.WithContext(ctx).Raw(waitQuery, waiterID).Scan(&blocked).Error)
					if blocked > 0 {
						break
					}
					poll.Reset(150 * time.Millisecond)
				}
				require.Less(t, time.Now().Unix(), invitee.ReferralExpiresAt, "the actual database lock wait must begin before expiry")
				if scenario == "expires_while_blocked" {
					// Concurrency is established by the database lock-wait view.
					// Hold that lock until the fixed eligibility boundary passes.
					timer := time.NewTimer(time.Until(time.Unix(invitee.ReferralExpiresAt, 0)))
					defer timer.Stop()
					select {
					case <-timer.C:
					case <-ctx.Done():
						t.Fatal("timed out while holding the lock across expiry")
					}
				} else {
					require.NoError(t, blocker.Model(&owner).Update("status", common.UserStatusDisabled).Error)
				}
				require.NoError(t, blocker.Commit().Error)
				require.NoError(t, <-settled)
				require.NoError(t, db.First(&owner, owner.Id).Error)
				require.NoError(t, db.First(&invitee, invitee.Id).Error)
				require.NoError(t, db.First(&order, order.Id).Error)
				assert.Equal(t, common.TopUpStatusSuccess, order.Status)
				assert.Equal(t, 100, invitee.Quota)
				assert.Zero(t, owner.AffQuota)
				assert.Zero(t, owner.AffHistoryQuota)
				if scenario == "expires_while_blocked" {
					assert.GreaterOrEqual(t, order.CompleteTime, invitee.ReferralExpiresAt)
				} else {
					assert.Equal(t, common.UserStatusDisabled, owner.Status)
					require.NoError(t, db.Model(&owner).Update("status", common.UserStatusEnabled).Error)
				}
				duplicate, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
				require.NoError(t, err)
				assert.True(t, duplicate)
				var facts int64
				require.NoError(t, db.Model(&ReferralRebate{}).Count(&facts).Error)
				assert.Zero(t, facts, "neither expiry nor a disabled inviter may be bypassed by an early attempt or replay")
			})
		}
	}
}

func TestReferralWalletRecoversIndependentProcessInterruption(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	for _, dialect := range []string{"mysql", "postgres"} {
		for _, interruption := range []string{"before_commit", "after_commit"} {
			t.Run(dialect+"/"+interruption, func(t *testing.T) {
				db, dsn := newReferralIntegrationDatabase(t, dialect)
				previousDB, previousLogDB := DB, LOG_DB
				previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
				previousRedis, previousClient := common.RedisEnabled, common.RDB
				previousBatch, previousUnit := common.BatchUpdateEnabled, common.QuotaPerUnit
				previousPayment := *operation_setting.GetPaymentSetting()
				client := redis.NewClient(&redis.Options{Addr: address, DB: 14, MaxRetries: -1})
				require.NoError(t, client.Ping(t.Context()).Err())
				DB, LOG_DB = db, db
				common.RDB, common.RedisEnabled = client, true
				common.BatchUpdateEnabled, common.QuotaPerUnit = false, 1
				databaseType := common.DatabaseTypeMySQL
				if dialect == "postgres" {
					databaseType = common.DatabaseTypePostgreSQL
				}
				common.SetDatabaseTypes(databaseType, databaseType)
				operation_setting.GetPaymentSetting().ComplianceConfirmed = true
				operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
				// DB 14 and high user IDs avoid the other isolated Redis fixtures.
				ownerID := 100000000 + int(time.Now().UnixNano()%1000000000)
				inviteeID := ownerID + 1
				ownedKeys := []string{getUserCacheKey(inviteeID), getUserAuthFenceKey(inviteeID), getUserAuthVersionKey(inviteeID)}
				t.Cleanup(func() {
					assert.NoError(t, client.Del(context.Background(), ownedKeys...).Err())
					assert.NoError(t, client.Close())
					DB, LOG_DB = previousDB, previousLogDB
					common.SetDatabaseTypes(previousMain, previousLog)
					common.RDB, common.RedisEnabled = previousClient, previousRedis
					common.BatchUpdateEnabled, common.QuotaPerUnit = previousBatch, previousUnit
					*operation_setting.GetPaymentSetting() = previousPayment
				})
				require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &Option{}, &ReferralRebate{}, &SubscriptionOrder{}, &Log{}))
				require.NoError(t, InitializeReferralRebateRule(db))
				require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 2}))
				owner := User{Id: ownerID, Username: "interrupt-owner", AffCode: "interrupt-owner", AffQuota: 10, AffHistoryQuota: 20, Status: common.UserStatusEnabled, AuthVersion: 1}
				invitee := User{Id: inviteeID, Username: "interrupt-invitee", AffCode: "interrupt-invitee", InviterId: owner.Id, Quota: 7, ReferralRateBPS: 1000, CreatedAt: time.Now().Unix() - 1, ReferralExpiresAt: time.Now().Unix() + 86400, Status: common.UserStatusEnabled, AuthVersion: 1}
				require.NoError(t, db.Create(&owner).Error)
				require.NoError(t, db.Create(&invitee).Error)
				require.NoError(t, populateUserCache(invitee))
				credit := 100
				order := TopUp{UserId: invitee.Id, TradeNo: "independent-process-interruption", Amount: 100, Money: 90, CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, PaymentMethod: "alipay", Status: common.TopUpStatusPending}
				require.NoError(t, order.Insert())
				executable, err := os.Executable()
				require.NoError(t, err)
				ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
				defer cancel()
				command := exec.CommandContext(ctx, executable, "-test.run=^TestReferralCrossProcessWorker$", "-test.count=1")
				command.Env = append(os.Environ(), "REFERRAL_PROCESS_MODE=callback", "REFERRAL_PROCESS_DIALECT="+dialect,
					"REFERRAL_PROCESS_DSN="+dsn, "REFERRAL_PROCESS_TRADE="+order.TradeNo, "REFERRAL_PROCESS_INTERRUPT="+interruption)
				output, runErr := command.CombinedOutput()
				var exitErr *exec.ExitError
				require.ErrorAs(t, runErr, &exitErr, string(output))
				expectedExit := 87
				if interruption == "after_commit" {
					expectedExit = 88
				}
				require.Equal(t, expectedExit, exitErr.ExitCode(), "the child must exit at the requested transaction boundary: %s", output)
				require.NoError(t, db.First(&owner, owner.Id).Error)
				require.NoError(t, db.First(&invitee, invitee.Id).Error)
				require.NoError(t, db.First(&order, order.Id).Error)
				var factCount int64
				require.NoError(t, db.Model(&ReferralRebate{}).Count(&factCount).Error)
				if interruption == "before_commit" {
					assert.Equal(t, common.TopUpStatusPending, order.Status)
					assert.Zero(t, order.CompleteTime)
					assert.Equal(t, 7, invitee.Quota)
					assert.Equal(t, 10, owner.AffQuota)
					assert.Equal(t, 20, owner.AffHistoryQuota)
					assert.Zero(t, factCount)
				} else {
					assert.Equal(t, common.TopUpStatusSuccess, order.Status)
					assert.Positive(t, order.CompleteTime)
					assert.Equal(t, 107, invitee.Quota)
					assert.Equal(t, 20, owner.AffQuota)
					assert.Equal(t, 30, owner.AffHistoryQuota)
					assert.EqualValues(t, 1, factCount)
				}
				cached, err := cacheGetUserBase(invitee.Id)
				require.NoError(t, err)
				assert.Equal(t, 7, cached.Quota, "the exited process never ran post-commit cache finalization")
				originalCompletion := order.CompleteTime
				duplicate, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
				require.NoError(t, err)
				assert.Equal(t, interruption == "after_commit", duplicate)
				duplicate, err = RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
				require.NoError(t, err)
				assert.True(t, duplicate)
				require.NoError(t, db.First(&owner, owner.Id).Error)
				require.NoError(t, db.First(&invitee, invitee.Id).Error)
				require.NoError(t, db.First(&order, order.Id).Error)
				assert.Equal(t, common.TopUpStatusSuccess, order.Status)
				assert.Equal(t, 107, invitee.Quota)
				assert.Equal(t, 20, owner.AffQuota)
				assert.Equal(t, 30, owner.AffHistoryQuota)
				if interruption == "after_commit" {
					assert.Equal(t, originalCompletion, order.CompleteTime)
				}
				var facts []ReferralRebate
				require.NoError(t, db.Find(&facts).Error)
				require.Len(t, facts, 1)
				assert.Equal(t, order.Id, facts[0].TopUpID)
				assert.Equal(t, order.CompleteTime, facts[0].SettledAt)
				assert.EqualValues(t, 100, facts[0].CreditedQuota)
				assert.EqualValues(t, 10, facts[0].RewardQuota)
				cached, err = cacheGetUserBase(invitee.Id)
				require.NoError(t, err)
				assert.Equal(t, 107, cached.Quota, "the original identity must recover the warm hash exactly once")
			})
		}
	}
}

type referralCacheProcess struct {
	command *exec.Cmd
	ready   *os.File
	release *os.File
	result  *os.File
	output  bytes.Buffer
}

func startReferralCacheProcess(t *testing.T, dialect, dsn, mode, barrier, tradeNo string, userID int) *referralCacheProcess {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	readyRead, readyWrite, err := os.Pipe()
	require.NoError(t, err)
	releaseRead, releaseWrite, err := os.Pipe()
	require.NoError(t, err)
	resultRead, resultWrite, err := os.Pipe()
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Second)
	worker := &referralCacheProcess{ready: readyRead, release: releaseWrite, result: resultRead}
	worker.command = exec.CommandContext(ctx, executable, "-test.run=^TestReferralCrossProcessWorker$", "-test.count=1")
	worker.command.Env = append(os.Environ(), "REFERRAL_PROCESS_MODE="+mode, "REFERRAL_PROCESS_DIALECT="+dialect,
		"REFERRAL_PROCESS_DSN="+dsn, "REFERRAL_PROCESS_TRADE="+tradeNo,
		"REFERRAL_PROCESS_USER="+strconv.Itoa(userID), "REFERRAL_PROCESS_CACHE_BARRIER="+barrier)
	worker.command.ExtraFiles = []*os.File{readyWrite, releaseRead, resultWrite}
	worker.command.Stdout, worker.command.Stderr = &worker.output, &worker.output
	require.NoError(t, worker.command.Start())
	_ = readyWrite.Close()
	_ = releaseRead.Close()
	_ = resultWrite.Close()
	t.Cleanup(func() {
		cancel()
		_ = worker.ready.Close()
		_ = worker.release.Close()
		_ = worker.result.Close()
		if worker.command.ProcessState == nil {
			_ = worker.command.Process.Kill()
			_ = worker.command.Wait()
		}
	})
	return worker
}

func (worker *referralCacheProcess) waitForBarrier(t *testing.T) int {
	t.Helper()
	var backendID int
	_, err := fmt.Fscanln(worker.ready, &backendID)
	if err != nil {
		_ = worker.command.Process.Kill()
		_ = worker.command.Wait()
		t.Fatalf("cache process did not reach barrier: %v; %s", err, worker.output.String())
	}
	return backendID
}

func (worker *referralCacheProcess) resume(t *testing.T) {
	t.Helper()
	_, err := worker.release.Write([]byte{1})
	require.NoError(t, err)
	require.NoError(t, worker.release.Close())
}

func (worker *referralCacheProcess) outcome(t *testing.T) referralProcessOutcome {
	t.Helper()
	require.NoError(t, worker.command.Wait(), worker.output.String())
	encoded, err := io.ReadAll(worker.result)
	require.NoError(t, err)
	var result referralProcessOutcome
	require.NoError(t, common.Unmarshal(encoded, &result), worker.output.String())
	return result
}

func TestReferralColdCacheAndWalletCreditAcrossProcesses(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		for _, scenario := range []string{"fill_first_without_snapshot", "credit_first_paused", "credit_first_qualified", "fill_loses_sql_connection"} {
			// Both lock orders and the qualified rebate run on every engine.
			// SQLite has no independent server connection to terminate.
			if scenario == "fill_loses_sql_connection" && dialect == "sqlite" {
				continue
			}
			t.Run(dialect+"/"+scenario, func(t *testing.T) {
				db, dsn := newReferralIntegrationDatabase(t, dialect)
				if dialect == "sqlite" {
					// Explicit deferred mode proves the shared write reservation is
					// needed even without a DSN-wide BEGIN IMMEDIATE default.
					dsn += "?_txlock=deferred&_pragma=busy_timeout(0)"
				}
				previousDB, previousLogDB := DB, LOG_DB
				previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
				previousRedis, previousClient := common.RedisEnabled, common.RDB
				previousBatch, previousUnit := common.BatchUpdateEnabled, common.QuotaPerUnit
				previousPayment := *operation_setting.GetPaymentSetting()
				client := redis.NewClient(&redis.Options{Addr: address, DB: 14, MaxRetries: -1})
				require.NoError(t, client.Ping(t.Context()).Err())
				DB, LOG_DB = db, db
				common.RDB, common.RedisEnabled = client, true
				common.BatchUpdateEnabled, common.QuotaPerUnit = false, 1
				databaseType := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
				common.SetDatabaseTypes(databaseType, databaseType)
				operation_setting.GetPaymentSetting().ComplianceConfirmed = true
				operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
				ownerID := 100000000 + int(time.Now().UnixNano()%1000000000)
				inviteeID := ownerID + 1
				ownedKeys := []string{getUserCacheKey(inviteeID), getUserAuthFenceKey(inviteeID), getUserAuthVersionKey(inviteeID), getWalletCacheFillKey(inviteeID)}
				t.Cleanup(func() {
					assert.NoError(t, client.Del(context.Background(), ownedKeys...).Err())
					assert.NoError(t, client.Close())
					DB, LOG_DB = previousDB, previousLogDB
					common.SetDatabaseTypes(previousMain, previousLog)
					common.RDB, common.RedisEnabled = previousClient, previousRedis
					common.BatchUpdateEnabled, common.QuotaPerUnit = previousBatch, previousUnit
					*operation_setting.GetPaymentSetting() = previousPayment
				})
				require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &Option{}, &ReferralRebate{}, &SubscriptionOrder{}, &Log{}))
				require.NoError(t, InitializeReferralRebateRule(db))
				require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: scenario != "credit_first_paused", RateBPS: 1000, ValidDays: 2}))
				owner := User{Id: ownerID, Username: "cold-owner", AffCode: "cold-owner", AffQuota: 10, AffHistoryQuota: 20, Status: common.UserStatusEnabled, AuthVersion: 1}
				invitee := User{Id: inviteeID, Username: "cold-invitee", AffCode: "cold-invitee", InviterId: owner.Id, Quota: 7, CreatedAt: time.Now().Unix() - 1, Status: common.UserStatusEnabled, AuthVersion: 1}
				if scenario != "fill_first_without_snapshot" {
					invitee.ReferralRateBPS, invitee.ReferralExpiresAt = 1000, time.Now().Unix()+86400
				}
				require.NoError(t, db.Create(&owner).Error)
				require.NoError(t, db.Create(&invitee).Error)
				credit := 100
				order := TopUp{UserId: invitee.Id, TradeNo: "cold-refill-process-order", Amount: 100, Money: 90, CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, PaymentMethod: "alipay", Status: common.TopUpStatusPending}
				require.NoError(t, order.Insert())
				holderMode, waiterMode := "cache_credit", "cache_fill"
				if scenario == "fill_first_without_snapshot" || scenario == "fill_loses_sql_connection" {
					holderMode, waiterMode = "cache_fill", "cache_credit"
				}
				holder := startReferralCacheProcess(t, dialect, dsn, holderMode, "holder", order.TradeNo, invitee.Id)
				holderID := holder.waitForBarrier(t)
				require.Zero(t, client.Exists(t.Context(), getUserCacheKey(invitee.Id)).Val(), "holder is paused before publication, or after capture of the absent cache")
				if scenario == "fill_loses_sql_connection" {
					// The child has read quota 7 under its SQL lock, but has not
					// published it. Kill that actual backend while its Go callback
					// remains alive and blocked, simulating an unnoticed lost lock.
					require.Positive(t, holderID)
					remainingQuery := "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID = ?"
					if dialect == "mysql" {
						require.NoError(t, db.Exec("KILL CONNECTION "+strconv.Itoa(holderID)).Error)
					} else {
						var terminated bool
						require.NoError(t, db.Raw("SELECT pg_terminate_backend(?)", holderID).Scan(&terminated).Error)
						require.True(t, terminated)
						remainingQuery = "SELECT COUNT(*) FROM pg_stat_activity WHERE pid = ?"
					}
					ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
					defer cancel()
					poll := time.NewTicker(20 * time.Millisecond)
					defer poll.Stop()
					for {
						var remaining int64
						require.NoError(t, db.WithContext(ctx).Raw(remainingQuery, holderID).Scan(&remaining).Error)
						if remaining == 0 {
							break
						}
						select {
						case <-poll.C:
						case <-ctx.Done():
							t.Fatal("the child SQL connection was not terminated")
						}
					}
					// Use the wallet transaction boundary directly: a post-commit
					// log's username read could refill quota 107 and mask a stale
					// publication bug by making the hash already contain Quota.
					_, settledQuota, duplicate, err := settleWalletTopUp(order.TradeNo, PaymentProviderEpay, "alipay", "", "")
					require.NoError(t, err)
					require.False(t, duplicate)
					require.Equal(t, 100, settledQuota)
					require.Zero(t, client.Exists(t.Context(), getUserCacheKey(invitee.Id)).Val())
					holder.resume(t)
					staleFill := holder.outcome(t)
					require.NotEmpty(t, staleFill.Error, "a lost SQL transaction cannot return a successful cached user")
					assert.Zero(t, staleFill.Quota)
					require.Zero(t, client.Exists(t.Context(), getUserCacheKey(invitee.Id)).Val(), "the old quota 7 must never be published after the credit")
					t.Logf("terminated independent SQL backend %d after the locked read; credit committed before stale fill resumed: %s", holderID, staleFill.Error)
				} else {
					waiter := startReferralCacheProcess(t, dialect, dsn, waiterMode, "waiter", order.TradeNo, invitee.Id)
					waiterID := waiter.waitForBarrier(t)
					require.NotEqual(t, holder.command.Process.Pid, waiter.command.Process.Pid)
					waiter.resume(t)
					var waiterResult referralProcessOutcome
					if dialect == "sqlite" {
						// A real independent connection attempts the write while the
						// other process still holds it. Rejection must not publish data.
						waiterResult = waiter.outcome(t)
						require.Contains(t, waiterResult.Error, "SQLITE_BUSY")
						require.Zero(t, client.Exists(t.Context(), getUserCacheKey(invitee.Id)).Val())
						t.Logf("independent SQLite writer rejected before holder release: %s", waiterResult.Error)
					} else {
						require.NotEqual(t, holderID, waiterID)
						waitQuery := "SELECT COUNT(*) FROM information_schema.innodb_lock_waits w JOIN information_schema.innodb_trx t ON t.trx_id = w.requesting_trx_id WHERE t.trx_mysql_thread_id = ?"
						if dialect == "postgres" {
							waitQuery = "SELECT COUNT(*) FROM pg_stat_activity WHERE pid = ? AND wait_event_type = 'Lock'"
						}
						ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
						defer cancel()
						// MySQL 5.7 caches the InnoDB information-schema snapshot;
						// leave time between observations for that view to refresh.
						poll := time.NewTicker(100 * time.Millisecond)
						defer poll.Stop()
						for {
							var blocked int64
							require.NoError(t, db.WithContext(ctx).Raw(waitQuery, waiterID).Scan(&blocked).Error)
							if blocked > 0 {
								break
							}
							select {
							case <-poll.C:
							case <-ctx.Done():
								t.Fatal("independent cache process did not enter the database user lock wait")
							}
						}
						t.Logf("independent process SQL user-lock wait observed: holder=%d waiter=%d", holderID, waiterID)
						require.Zero(t, client.Exists(t.Context(), getUserCacheKey(invitee.Id)).Val())
					}
					holder.resume(t)
					holderResult := holder.outcome(t)
					require.Empty(t, holderResult.Error)
					if holderMode == "cache_fill" {
						assert.Equal(t, 7, holderResult.Quota)
					}
					if dialect != "sqlite" {
						waiterResult = waiter.outcome(t)
						require.Empty(t, waiterResult.Error)
						if waiterMode == "cache_fill" {
							assert.Equal(t, 107, waiterResult.Quota)
						}
					}
				}
				// A BUSY result is retried only with the same order/read identity.
				// Repeated original callbacks must not add another principal or delta.
				_, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
				require.NoError(t, err)
				duplicate, err := RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
				require.NoError(t, err)
				assert.True(t, duplicate)
				cached, err := GetUserCache(invitee.Id)
				require.NoError(t, err)
				assert.Equal(t, 107, cached.Quota)
				require.Equal(t, "107", client.HGet(t.Context(), getUserCacheKey(invitee.Id), "Quota").Val())
				require.NoError(t, db.First(&invitee, invitee.Id).Error)
				require.NoError(t, db.First(&owner, owner.Id).Error)
				require.NoError(t, db.First(&order, order.Id).Error)
				assert.Equal(t, 107, invitee.Quota)
				assert.Equal(t, common.TopUpStatusSuccess, order.Status)
				assert.Positive(t, order.CompleteTime)
				var facts []ReferralRebate
				require.NoError(t, db.Find(&facts).Error)
				if scenario == "credit_first_qualified" || scenario == "fill_loses_sql_connection" {
					require.Len(t, facts, 1)
					assert.Equal(t, order.Id, facts[0].TopUpID)
					assert.Equal(t, order.CompleteTime, facts[0].SettledAt)
					assert.EqualValues(t, 100, facts[0].CreditedQuota)
					assert.EqualValues(t, 10, facts[0].RewardQuota)
					assert.Equal(t, 20, owner.AffQuota)
					assert.Equal(t, 30, owner.AffHistoryQuota)
				} else {
					assert.Empty(t, facts)
					assert.Equal(t, 10, owner.AffQuota)
					assert.Equal(t, 20, owner.AffHistoryQuota)
				}
			})
		}
	}
}
