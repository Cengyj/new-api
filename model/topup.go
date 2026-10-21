package model

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"math"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"

	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

type TopUp struct {
	Id              int     `json:"id"`
	UserId          int     `json:"user_id" gorm:"index"`
	Amount          int64   `json:"amount"`
	Money           float64 `json:"money"`
	TradeNo         string  `json:"trade_no" gorm:"unique;type:varchar(255);index"`
	PaymentMethod   string  `json:"payment_method" gorm:"type:varchar(50)"`
	PaymentProvider string  `json:"payment_provider" gorm:"type:varchar(50);default:''"`
	CreateTime      int64   `json:"create_time"`
	CompleteTime    int64   `json:"complete_time"`
	CreditedQuota   *int    `json:"credited_quota" gorm:"type:bigint"`
	// Waffo merchant identity is frozen at checkout; nil marks legacy orders.
	WaffoMerchantID *string `json:"-" gorm:"type:varchar(64)"`
	Status          string  `json:"status"`
}

const (
	PaymentMethodStripe       = "stripe"
	PaymentMethodCreem        = "creem"
	PaymentMethodWaffo        = "waffo"
	PaymentMethodWaffoPancake = "waffo_pancake"
	PaymentMethodBalance      = "balance"
)

const (
	PaymentProviderEpay         = "epay"
	PaymentProviderStripe       = "stripe"
	PaymentProviderCreem        = "creem"
	PaymentProviderWaffo        = "waffo"
	PaymentProviderWaffoPancake = "waffo_pancake"
	PaymentProviderBalance      = "balance"
)

var (
	ErrPaymentMethodMismatch = errors.New("payment method mismatch")
	ErrTopUpNotFound         = errors.New("topup not found")
	ErrTopUpStatusInvalid    = errors.New("topup status invalid")
	// The quota errors reach the web console, so they carry message keys.
	ErrInvalidTopUpQuota        error = common.NewMessage("Invalid top-up quota")
	ErrTopUpQuotaLimitExceeded  error = common.NewMessage("Top-up quota limit exceeded")
	ErrWalletQuotaLimitExceeded error = common.NewMessage("Wallet quota limit exceeded")
)

// Insert freezes the channel's existing integer credit before checkout is sent
// to the provider. A nil snapshot identifies an order created before this field.
func (topUp *TopUp) Insert() error {
	quota, err := topUp.walletCreditQuota()
	if err != nil {
		return err
	}
	topUp.CreditedQuota = &quota
	return DB.Create(topUp).Error
}

// walletCreditQuota preserves each provider's historical units. It is also the
// legacy-order fallback; its result is not a checkout-time price snapshot.
func (topUp *TopUp) walletCreditQuota() (int, error) {
	if topUp.CreditedQuota != nil {
		if _, err := topUpQuotaMaxCurrent(*topUp.CreditedQuota); err != nil {
			return 0, err
		}
		return *topUp.CreditedQuota, nil
	}
	common.OptionMapRWMutex.RLock()
	quotaPerUnit := common.QuotaPerUnit
	common.OptionMapRWMutex.RUnlock()
	var amount decimal.Decimal
	switch topUp.PaymentProvider {
	case PaymentProviderCreem:
		amount = decimal.NewFromInt(topUp.Amount)
	case PaymentProviderStripe:
		if topUp.Money <= 0 || quotaPerUnit <= 0 || math.IsNaN(topUp.Money) || math.IsInf(topUp.Money, 0) || math.IsNaN(quotaPerUnit) || math.IsInf(quotaPerUnit, 0) {
			return 0, ErrInvalidTopUpQuota
		}
		amount = decimal.NewFromFloat(topUp.Money).Mul(decimal.NewFromFloat(quotaPerUnit))
	default:
		if topUp.Amount <= 0 || quotaPerUnit <= 0 || math.IsNaN(quotaPerUnit) || math.IsInf(quotaPerUnit, 0) {
			return 0, ErrInvalidTopUpQuota
		}
		amount = decimal.NewFromInt(topUp.Amount).Mul(decimal.NewFromFloat(quotaPerUnit))
	}
	quota, err := common.WalletQuotaFromDecimalStrict(amount)
	if err != nil || quota <= 0 {
		return 0, ErrInvalidTopUpQuota
	}
	return quota, nil
}

func topUpQuotaMaxCurrent(creditedQuota int) (int, error) {
	if creditedQuota <= 0 || creditedQuota > common.MaxWalletQuota {
		return 0, ErrInvalidTopUpQuota
	}
	return common.MaxWalletQuota - creditedQuota, nil
}

// ValidateTopUpQuotaCapacity performs the user-facing pre-payment check. The
// settlement path repeats the same invariant with an atomic conditional
// update, because the wallet balance can change after checkout creation.
func ValidateTopUpQuotaCapacity(userId int, creditedQuota int) error {
	maxCurrentQuota, err := topUpQuotaMaxCurrent(creditedQuota)
	if err != nil {
		return err
	}

	var user User
	if err := DB.Select("quota").Where("id = ?", userId).First(&user).Error; err != nil {
		return err
	}
	if user.Quota > maxCurrentQuota {
		return ErrTopUpQuotaLimitExceeded
	}
	return nil
}

// creditTopUpQuota atomically enforces the wallet ceiling while adding quota.
// Keeping the predicate and increment in one UPDATE prevents two
// concurrent callbacks from both passing a separate read/check.
func creditTopUpQuota(tx *gorm.DB, userId int, creditedQuota int, updates map[string]any) error {
	maxCurrentQuota, err := topUpQuotaMaxCurrent(creditedQuota)
	if err != nil {
		return err
	}

	updateFields := make(map[string]any, len(updates)+1)
	maps.Copy(updateFields, updates)
	updateFields["quota"] = gorm.Expr("quota + ?", creditedQuota)

	result := tx.Model(&User{}).
		Where("id = ? AND quota <= ?", userId, maxCurrentQuota).
		Updates(updateFields)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 1 {
		return nil
	}

	var count int64
	if err := tx.Model(&User{}).Where("id = ?", userId).Count(&count).Error; err != nil {
		return err
	}
	if count == 0 {
		return gorm.ErrRecordNotFound
	}
	return ErrTopUpQuotaLimitExceeded
}

// Update is only used for a pending checkout's terminal failure. Never save a
// stale order object over an already committed success or its frozen credit.
func (topUp *TopUp) Update() error {
	return UpdatePendingTopUpStatus(topUp.TradeNo, topUp.PaymentProvider, topUp.Status)
}

func GetTopUpById(id int) *TopUp {
	var topUp *TopUp
	var err error
	err = DB.Where("id = ?", id).First(&topUp).Error
	if err != nil {
		return nil
	}
	return topUp
}

func GetTopUpByTradeNo(tradeNo string) *TopUp {
	topUp, _ := GetTopUpByTradeNoWithError(tradeNo)
	return topUp
}

func GetTopUpByTradeNoWithError(tradeNo string) (*TopUp, error) {
	var topUp TopUp
	if err := DB.Where("trade_no = ?", tradeNo).First(&topUp).Error; err != nil {
		return nil, err
	}
	return &topUp, nil
}

func UpdatePendingTopUpStatus(tradeNo string, expectedPaymentProvider string, targetStatus string) error {
	if tradeNo == "" {
		return errors.New("payment order number not provided")
	}

	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}

	return DB.Transaction(func(tx *gorm.DB) error {
		topUp := &TopUp{}
		if err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(topUp).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrTopUpNotFound
			}
			return err
		}
		if expectedPaymentProvider != "" && topUp.PaymentProvider != expectedPaymentProvider {
			return ErrPaymentMethodMismatch
		}
		if topUp.Status != common.TopUpStatusPending {
			return ErrTopUpStatusInvalid
		}

		return tx.Model(&TopUp{}).Where("id = ? AND status = ?", topUp.Id, common.TopUpStatusPending).Update("status", targetStatus).Error
	})
}

// settleWalletTopUp is the single wallet-payment transaction boundary. The
// order lock and conditional transition protect callbacks and manual completion
// across processes. Subscription display rows are never wallet orders.
// A non-nil order confirms SQL success; an accompanying error means its cache
// completion still needs retrying with this same order, never a new credit.
func settleWalletTopUp(tradeNo, expectedProvider, actualMethod, customerID, customerEmail string) (*TopUp, int, bool, error) {
	if tradeNo == "" {
		return nil, 0, false, errors.New("payment order number not provided")
	}
	var topUp TopUp
	var quota int
	alreadyDone := false
	var cacheOperation, cacheAttempt string
	commitAttempted := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("trade_no = ?", tradeNo).First(&topUp).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrTopUpNotFound
			}
			return err
		}
		if expectedProvider != "" && topUp.PaymentProvider != expectedProvider {
			return ErrPaymentMethodMismatch
		}
		cacheOperation = "topup:" + strconv.Itoa(topUp.Id)
		if topUp.Status == common.TopUpStatusSuccess {
			alreadyDone = true
			if topUp.CreditedQuota != nil {
				quota = *topUp.CreditedQuota
				if quota <= 0 || quota > common.MaxWalletQuota {
					return ErrInvalidTopUpQuota
				}
			}
			return nil
		}
		if topUp.Status != common.TopUpStatusPending {
			return ErrTopUpStatusInvalid
		}
		var subscriptionCount int64
		if err := tx.Model(&SubscriptionOrder{}).Where("trade_no = ?", tradeNo).Count(&subscriptionCount).Error; err != nil {
			return err
		}
		if subscriptionCount != 0 {
			return ErrTopUpStatusInvalid
		}
		var err error
		quota, err = topUp.walletCreditQuota()
		if err != nil {
			return err
		}
		if err := AwardReferralRebateTx(tx, &topUp, quota); err != nil {
			return err
		}
		cacheAttempt, err = captureWalletCreditCache(tx, topUp.UserId, cacheOperation)
		if err != nil {
			return err
		}
		updates := map[string]any{}
		if expectedProvider == PaymentProviderStripe {
			updates["stripe_customer"] = customerID
		}
		if expectedProvider == PaymentProviderCreem && customerEmail != "" {
			// Only fill an empty email; do not overwrite a concurrent profile edit.
			if err := tx.Model(&User{}).Where("id = ? AND email = ?", topUp.UserId, "").Update("email", customerEmail).Error; err != nil {
				return err
			}
		}
		if err := creditTopUpQuota(tx, topUp.UserId, quota, updates); err != nil {
			return err
		}
		// For legacy pending orders this records what was actually credited
		// now; it does not claim a historical checkout-time price snapshot.
		orderUpdates := map[string]any{"status": common.TopUpStatusSuccess, "complete_time": topUp.CompleteTime, "credited_quota": quota}
		if actualMethod != "" {
			topUp.PaymentMethod = actualMethod
			orderUpdates["payment_method"] = actualMethod
		}
		result := tx.Model(&TopUp{}).Where("id = ? AND status = ?", topUp.Id, common.TopUpStatusPending).Updates(orderUpdates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrTopUpStatusInvalid
		}
		topUp.Status = common.TopUpStatusSuccess
		topUp.CreditedQuota = &quota
		commitAttempted = true
		return nil
	})
	if err != nil {
		if !commitAttempted {
			cancelWalletCreditCache(topUp.UserId, cacheOperation, cacheAttempt)
		}
		if commitAttempted {
			// A commit error can mean only its acknowledgement was lost.
			// Resolve the original order; an absent/unreadable result remains
			// unknown, with its marker available for a later same-order retry.
			var persisted TopUp
			if lookupErr := DB.Where("id = ?", topUp.Id).First(&persisted).Error; lookupErr == nil && persisted.Status == common.TopUpStatusSuccess && persisted.CreditedQuota != nil && *persisted.CreditedQuota > 0 && *persisted.CreditedQuota <= common.MaxWalletQuota && (expectedProvider == "" || persisted.PaymentProvider == expectedProvider) {
				cacheErr := finishWalletCreditCache(persisted.UserId, cacheOperation, *persisted.CreditedQuota)
				return &persisted, *persisted.CreditedQuota, true, cacheErr
			}
		}
		return nil, 0, false, err
	}
	if quota > 0 {
		// SQL is committed even if its cache completion needs a same-order retry.
		err = finishWalletCreditCache(topUp.UserId, cacheOperation, quota)
	}
	return &topUp, quota, alreadyDone, err
}

func RechargeEpay(tradeNo string, actualPaymentMethod string, callerIp string) (bool, error) {
	topUp, quota, alreadyDone, err := settleWalletTopUp(tradeNo, PaymentProviderEpay, actualPaymentMethod, "", "")
	if topUp == nil || alreadyDone {
		return alreadyDone, err
	}
	RecordTopupLog(topUp.UserId, common.NewMessage("Online top-up succeeded, amount added: {{quota}}, payment amount: {{amount}}", map[string]any{"quota": logger.FormatQuota(quota), "amount": fmt.Sprintf("%f", topUp.Money)}), callerIp, topUp.PaymentMethod, PaymentProviderEpay)
	return false, err
}

func Recharge(referenceId string, customerId string, callerIp string) error {
	topUp, quota, alreadyDone, err := settleWalletTopUp(referenceId, PaymentProviderStripe, "", customerId, "")
	if topUp == nil || alreadyDone {
		return err
	}
	RecordTopupLog(topUp.UserId, common.NewMessage("Online top-up succeeded, amount added: {{quota}}, payment amount: {{amount}}", map[string]any{"quota": logger.FormatQuota(quota), "amount": topUp.Amount}), callerIp, topUp.PaymentMethod, PaymentMethodStripe)
	return err
}

// topUpQueryWindowSeconds 限制充值记录查询的时间窗口（秒）。
const topUpQueryWindowSeconds int64 = 30 * 24 * 60 * 60

// topUpQueryCutoff 返回允许查询的最早 create_time（秒级 Unix 时间戳）。
func topUpQueryCutoff() int64 {
	return common.GetTimestamp() - topUpQueryWindowSeconds
}

func validateTopUpPagination(pageInfo *common.PageInfo) error {
	if pageInfo == nil || pageInfo.Page < 1 || pageInfo.PageSize < 1 || pageInfo.PageSize > 100 || pageInfo.Page-1 > math.MaxInt32/pageInfo.PageSize {
		return common.NewMessage("Invalid parameters")
	}
	return nil
}

func GetUserTopUps(ctx context.Context, userId int, pageInfo *common.PageInfo) (topups []*TopUp, total int64, err error) {
	if err := validateTopUpPagination(pageInfo); err != nil {
		return nil, 0, err
	}
	// Start transaction
	tx := DB.WithContext(ctx).Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	cutoff := topUpQueryCutoff()

	// Get total count within transaction
	err = tx.Model(&TopUp{}).Where("user_id = ? AND create_time >= ?", userId, cutoff).Count(&total).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	// Get paginated topups within same transaction
	err = tx.Where("user_id = ? AND create_time >= ?", userId, cutoff).Order("id desc").Limit(pageInfo.GetPageSize()).Offset(pageInfo.GetStartIdx()).Find(&topups).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	// Commit transaction
	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}

	return topups, total, nil
}

// GetAllTopUps 获取全平台的充值记录（管理员使用，不限制时间窗口）
func GetAllTopUps(ctx context.Context, pageInfo *common.PageInfo) (topups []*TopUp, total int64, err error) {
	if err := validateTopUpPagination(pageInfo); err != nil {
		return nil, 0, err
	}
	tx := DB.WithContext(ctx).Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	if err = tx.Model(&TopUp{}).Count(&total).Error; err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	if err = tx.Order("id desc").Limit(pageInfo.GetPageSize()).Offset(pageInfo.GetStartIdx()).Find(&topups).Error; err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}

	return topups, total, nil
}

// searchTopUpCountHardLimit 搜索充值记录时 COUNT 的安全上限，
// 防止对超大表执行无界 COUNT 触发 DoS。
const searchTopUpCountHardLimit = 10000

// SearchUserTopUps 按订单号搜索某用户的充值记录
func SearchUserTopUps(ctx context.Context, userId int, keyword string, pageInfo *common.PageInfo) (topups []*TopUp, total int64, err error) {
	if err := validateTopUpPagination(pageInfo); err != nil {
		return nil, 0, err
	}
	tx := DB.WithContext(ctx).Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	query := tx.Model(&TopUp{}).Where("user_id = ? AND create_time >= ?", userId, topUpQueryCutoff())
	if keyword != "" {
		pattern, perr := sanitizeLikePattern(keyword)
		if perr != nil {
			tx.Rollback()
			return nil, 0, perr
		}
		query = query.Where("trade_no LIKE ? ESCAPE '!'", pattern)
	}

	if err = query.Limit(searchTopUpCountHardLimit).Count(&total).Error; err != nil {
		tx.Rollback()
		common.SysError(common.LogText("failed to count search topups: %s", err.Error()))
		return nil, 0, common.NewMessage("Failed to search top-up records")
	}

	if err = query.Order("id desc").Limit(pageInfo.GetPageSize()).Offset(pageInfo.GetStartIdx()).Find(&topups).Error; err != nil {
		tx.Rollback()
		common.SysError(common.LogText("failed to search topups: %s", err.Error()))
		return nil, 0, common.NewMessage("Failed to search top-up records")
	}

	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}
	return topups, total, nil
}

// SearchAllTopUps 按订单号搜索全平台充值记录（管理员使用，不限制时间窗口）
func SearchAllTopUps(ctx context.Context, keyword string, pageInfo *common.PageInfo) (topups []*TopUp, total int64, err error) {
	if err := validateTopUpPagination(pageInfo); err != nil {
		return nil, 0, err
	}
	tx := DB.WithContext(ctx).Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	query := tx.Model(&TopUp{})
	if keyword != "" {
		pattern, perr := sanitizeLikePattern(keyword)
		if perr != nil {
			tx.Rollback()
			return nil, 0, perr
		}
		query = query.Where("trade_no LIKE ? ESCAPE '!'", pattern)
	}

	if err = query.Limit(searchTopUpCountHardLimit).Count(&total).Error; err != nil {
		tx.Rollback()
		common.SysError(common.LogText("failed to count search topups: %s", err.Error()))
		return nil, 0, common.NewMessage("Failed to search top-up records")
	}

	if err = query.Order("id desc").Limit(pageInfo.GetPageSize()).Offset(pageInfo.GetStartIdx()).Find(&topups).Error; err != nil {
		tx.Rollback()
		common.SysError(common.LogText("failed to search topups: %s", err.Error()))
		return nil, 0, common.NewMessage("Failed to search top-up records")
	}

	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}
	return topups, total, nil
}

// ManualCompleteTopUp preserves the existing pending-only manual completion
// policy and uses the same frozen credit and atomic settlement as callbacks.
func ManualCompleteTopUp(tradeNo string, callerIp string) error {
	if tradeNo == "" {
		return common.NewMessage("Order number not provided")
	}
	topUp, quota, alreadyDone, err := settleWalletTopUp(tradeNo, "", "", "", "")
	if errors.Is(err, ErrTopUpNotFound) {
		return common.NewMessage("Top-up order does not exist")
	}
	if errors.Is(err, ErrTopUpStatusInvalid) {
		return common.NewMessage("Order is not pending payment and cannot be completed")
	}
	if topUp == nil || alreadyDone {
		return err
	}
	RecordTopupLog(topUp.UserId, common.NewMessage("Administrator completed the order, amount added: {{quota}}, payment amount: {{amount}}", map[string]any{"quota": logger.FormatQuota(quota), "amount": fmt.Sprintf("%f", topUp.Money)}), callerIp, topUp.PaymentMethod, "admin")
	return err
}

func RechargeCreem(referenceId string, customerEmail string, customerName string, callerIp string) error {
	topUp, quota, alreadyDone, err := settleWalletTopUp(referenceId, PaymentProviderCreem, "", "", customerEmail)
	if topUp == nil || alreadyDone {
		return err
	}
	RecordTopupLog(topUp.UserId, common.NewMessage("{{provider}} top-up succeeded, amount added: {{quota}}, payment amount: {{amount}}", map[string]any{"provider": "Creem", "quota": quota, "amount": fmt.Sprintf("%.2f", topUp.Money)}), callerIp, topUp.PaymentMethod, PaymentMethodCreem)
	return err
}

func RechargeWaffo(tradeNo string, callerIp string) error {
	topUp, quota, alreadyDone, err := settleWalletTopUp(tradeNo, PaymentProviderWaffo, "", "", "")
	if topUp == nil || alreadyDone {
		return err
	}
	RecordTopupLog(topUp.UserId, common.NewMessage("{{provider}} top-up succeeded, amount added: {{quota}}, payment amount: {{amount}}", map[string]any{"provider": "Waffo", "quota": logger.FormatQuota(quota), "amount": fmt.Sprintf("%.2f", topUp.Money)}), callerIp, topUp.PaymentMethod, PaymentMethodWaffo)
	return err
}

func RechargeWaffoPancake(tradeNo string) error {
	topUp, quota, alreadyDone, err := settleWalletTopUp(tradeNo, PaymentProviderWaffoPancake, "", "", "")
	if topUp == nil || alreadyDone {
		return err
	}
	RecordLog(topUp.UserId, LogTypeTopup, common.NewMessage("{{provider}} top-up succeeded, amount added: {{quota}}, payment amount: {{amount}}", map[string]any{"provider": "Waffo Pancake", "quota": logger.FormatQuota(quota), "amount": fmt.Sprintf("%.2f", topUp.Money)}))
	return err
}
