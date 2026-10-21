package model

import (
	"errors"
	"regexp"
	"slices"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const ReferralRebateOptionKey = "ReferralRebateRule"
const maxReferralTimestamp int64 = 253402300799 // Last second representable in year 9999.

// One option value is the entire rule. Money paths deliberately read this row,
// never OptionMap: another instance's pause must take effect without cache lag.
type ReferralRebateRule struct {
	Enabled   bool  `json:"enabled"`
	RateBPS   int   `json:"rate_bps"`
	ValidDays int64 `json:"valid_days"`
}

type ReferralRebate struct {
	ID            int64  `json:"id" gorm:"primaryKey"`
	TopUpID       int    `json:"top_up_id" gorm:"not null;uniqueIndex"`
	TradeNo       string `json:"trade_no" gorm:"type:varchar(255);not null;index"`
	InviterID     int    `json:"inviter_id" gorm:"not null;index"`
	InviteeID     int    `json:"invitee_id" gorm:"not null;index"`
	CreditedQuota int64  `json:"credited_quota,string" gorm:"type:bigint;not null"`
	RateBPS       int    `json:"rate_bps" gorm:"not null"`
	RewardQuota   int64  `json:"reward_quota,string" gorm:"type:bigint;not null"`
	SettledAt     int64  `json:"settled_at" gorm:"type:bigint;not null;index"`
	CreatedAt     int64  `json:"created_at" gorm:"type:bigint;not null;autoCreateTime:false"`
}

var referralPercentagePattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]{1,2})?$`)
var referralDaysPattern = regexp.MustCompile(`^[0-9]+$`)

var ErrInvalidReferralRule = common.NewMessage("Invalid referral rebate rule")
var ErrInvalidReferralSnapshot = common.NewMessage("Invalid referral rebate eligibility snapshot")
var ErrReferralRewardLimit = common.NewMessage("Invitation reward limit exceeded")

// Read both fields under the same lock used by option save and reload. Keep
// this snapshot short: the option lock must not span database or network work.
func paymentComplianceConfirmed() bool {
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	return operation_setting.IsPaymentComplianceConfirmed()
}

// Generic option writes must use the database's key equality, too: MySQL
// collations can resolve case, accent, width or trailing-space aliases to the
// protected rule. Check before any bulk dispatch or write so all values remain
// unchanged when the dedicated, validated rule endpoint would be bypassed.
func rejectGenericReferralRuleUpdates(keys []string) error {
	if slices.Contains(keys, ReferralRebateOptionKey) {
		return ErrInvalidReferralRule
	}
	var matches int64
	if err := DB.Model(&Option{}).Where(&Option{Key: ReferralRebateOptionKey}).
		Where(map[string]any{"key": keys}).Count(&matches).Error; err != nil {
		return err
	}
	if matches != 0 {
		return ErrInvalidReferralRule
	}
	return nil
}

func ParseReferralRebateRule(enabled bool, percentage, days string) (ReferralRebateRule, error) {
	rule := ReferralRebateRule{Enabled: enabled}
	if !enabled && percentage == "" && days == "" {
		return rule, nil
	}
	if !referralPercentagePattern.MatchString(percentage) || !referralDaysPattern.MatchString(days) {
		return rule, ErrInvalidReferralRule
	}
	rate, err := decimal.NewFromString(percentage)
	if err != nil || rate.LessThan(decimal.RequireFromString("0.01")) || rate.GreaterThan(decimal.NewFromInt(100)) {
		return rule, ErrInvalidReferralRule
	}
	rule.RateBPS = int(rate.Mul(decimal.NewFromInt(100)).IntPart()) // Exact, validated two decimal places.
	rule.ValidDays, err = strconv.ParseInt(days, 10, 64)
	if err != nil || rule.ValidDays <= 0 || rule.ValidDays > (maxReferralTimestamp-time.Now().Unix())/86400 {
		return rule, ErrInvalidReferralRule
	}
	return rule, nil
}

func InitializeReferralRebateRule(db *gorm.DB) error {
	value, err := common.Marshal(ReferralRebateRule{})
	if err != nil {
		return err
	}
	return db.Clauses(clause.OnConflict{DoNothing: true}).Create(&Option{Key: ReferralRebateOptionKey, Value: string(value)}).Error
}

// A shared row lock lets independent registrations and settlements run together.
// A rule save takes an exclusive lock on that same row: whichever acquires its
// lock first commits first. No payment network request runs inside these locks.
// MySQL's GORM driver emits LOCK IN SHARE MODE on MySQL 5.7; PostgreSQL uses
// FOR SHARE. SQLite's writer/snapshot conflict rolls a competing write back.
func readReferralRebateRule(tx *gorm.DB, shareLock bool) (ReferralRebateRule, error) {
	query := tx
	if shareLock && !common.UsingMainDatabase(common.DatabaseTypeSQLite) {
		query = query.Clauses(clause.Locking{Strength: "SHARE"})
	}
	var option Option
	err := query.Where(&Option{Key: ReferralRebateOptionKey}).First(&option).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ReferralRebateRule{}, ErrInvalidReferralRule
	}
	if err != nil {
		return ReferralRebateRule{}, err
	}
	// Missing or null members are damaged configuration, not a valid pause.
	var stored struct {
		Enabled   *bool  `json:"enabled"`
		RateBPS   *int   `json:"rate_bps"`
		ValidDays *int64 `json:"valid_days"`
	}
	if common.UnmarshalJsonStr(option.Value, &stored) != nil || stored.Enabled == nil || stored.RateBPS == nil || stored.ValidDays == nil {
		return ReferralRebateRule{}, ErrInvalidReferralRule
	}
	rule := ReferralRebateRule{Enabled: *stored.Enabled, RateBPS: *stored.RateBPS, ValidDays: *stored.ValidDays}
	if !rule.Enabled && rule.RateBPS == 0 && rule.ValidDays == 0 {
		return rule, nil
	}
	if rule.RateBPS < 1 || rule.RateBPS > 10000 || rule.ValidDays <= 0 || rule.ValidDays > maxReferralTimestamp/86400 {
		return rule, ErrInvalidReferralRule
	}
	return rule, nil
}

func GetReferralRebateRule() (ReferralRebateRule, error) {
	return readReferralRebateRule(DB, false)
}

func SaveReferralRebateRule(rule ReferralRebateRule) error {
	if rule.Enabled && !paymentComplianceConfirmed() {
		return common.NewMessage("Payment, redemption, subscription, and invitation reward features are disabled. The administrator must confirm compliance terms before enabling them.")
	}
	// Validate the internal form too; this function is also used by integrations.
	if rule.Enabled || rule.RateBPS != 0 || rule.ValidDays != 0 {
		if rule.RateBPS < 1 || rule.RateBPS > 10000 || rule.ValidDays <= 0 || rule.ValidDays > (maxReferralTimestamp-time.Now().Unix())/86400 {
			return ErrInvalidReferralRule
		}
	}
	value, err := common.Marshal(rule)
	if err != nil {
		return err
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var current Option
		if err := lockForUpdate(tx).Where(&Option{Key: ReferralRebateOptionKey}).First(&current).Error; err != nil {
			return err
		}
		var previous ReferralRebateRule
		if err := common.UnmarshalJsonStr(current.Value, &previous); err != nil {
			return ErrInvalidReferralRule
		}
		if previous.RateBPS != 0 && rule.RateBPS == 0 {
			return ErrInvalidReferralRule // Pause preserves a configured rule.
		}
		return tx.Model(&Option{}).Where(&Option{Key: ReferralRebateOptionKey}).Update("value", string(value)).Error
	})
}

// Called only by first-registration insertion, before user creation and fixed
// invitation awards. The relation and CreatedAt remain the authoritative facts.
func PrepareReferralRegistrationTx(tx *gorm.DB, user *User) error {
	user.ReferralRateBPS, user.ReferralExpiresAt = 0, 0
	user.CreatedAt = time.Now().Unix()
	if user.InviterId == 0 {
		return nil
	}
	if user.Id != 0 && user.InviterId == user.Id {
		user.InviterId = 0
		return nil
	}
	rule, err := readReferralRebateRule(tx, true)
	if err != nil {
		return err
	}
	var inviter User
	err = lockForUpdate(tx).Select("id", "status").First(&inviter, user.InviterId).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		user.InviterId = 0
		return nil
	}
	if err != nil {
		return err
	}
	user.CreatedAt = time.Now().Unix()
	if !rule.Enabled || !paymentComplianceConfirmed() || inviter.Status != common.UserStatusEnabled {
		return nil
	}
	if rule.ValidDays > (maxReferralTimestamp-user.CreatedAt)/86400 {
		return ErrInvalidReferralRule
	}
	user.ReferralRateBPS = rule.RateBPS
	user.ReferralExpiresAt = user.CreatedAt + rule.ValidDays*86400
	return nil
}

// AwardReferralRebateTx runs before the principal credit and order-success
// update in the caller's transaction. It owns the successful settlement time.
// Lock order: order -> shared rule -> users by ascending ID. Facts never have
// soft-delete or a user FK cascade, so historical contributions survive removal.
func AwardReferralRebateTx(tx *gorm.DB, topUp *TopUp, creditedQuota int) error {
	if creditedQuota <= 0 || creditedQuota > common.MaxWalletQuota {
		return ErrInvalidTopUpQuota
	}
	var invitee User
	if err := tx.First(&invitee, topUp.UserId).Error; err != nil {
		return err
	}
	qualified := invitee.ReferralRateBPS != 0 || invitee.ReferralExpiresAt != 0
	if qualified {
		rule, err := readReferralRebateRule(tx, true)
		if err != nil {
			return err
		}
		qualified = rule.Enabled && paymentComplianceConfirmed()
	}
	userIDs := []int{invitee.Id}
	if qualified {
		userIDs = append(userIDs, invitee.InviterId)
	}
	// Every principal credit must also serialize with cold-cache refill,
	// including historical users and activity pauses. Preserve rule-before-user
	// and ascending-user lock order when an inviter reward is possible.
	users, err := lockWalletUsersTx(tx, userIDs...)
	if err != nil {
		return err
	}
	foundInvitee := false
	var inviter *User
	for i := range users {
		if users[i].Id == invitee.Id {
			foundInvitee = true
			invitee = users[i]
		}
		if users[i].Id == invitee.InviterId {
			inviter = &users[i]
		}
	}
	if !foundInvitee {
		return gorm.ErrRecordNotFound
	}
	topUp.CompleteTime = time.Now().Unix()
	if !qualified {
		return nil
	}
	if invitee.InviterId <= 0 || invitee.InviterId == invitee.Id {
		return ErrInvalidReferralSnapshot
	}
	if inviter == nil || inviter.Status != common.UserStatusEnabled {
		return nil
	}
	if invitee.ReferralRateBPS < 1 || invitee.ReferralRateBPS > 10000 || invitee.CreatedAt <= 0 || invitee.ReferralExpiresAt <= invitee.CreatedAt || invitee.ReferralExpiresAt > maxReferralTimestamp {
		return ErrInvalidReferralSnapshot
	}
	if topUp.CompleteTime < invitee.CreatedAt || topUp.CompleteTime >= invitee.ReferralExpiresAt {
		return nil
	}
	// Decimal arithmetic preserves exact integer inputs, rounds each award half
	// away from zero, and rejects out-of-range results rather than saturating.
	reward, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(creditedQuota)).Mul(decimal.NewFromInt(int64(invitee.ReferralRateBPS))).Div(decimal.NewFromInt(10000)))
	if err != nil {
		return err
	}
	if reward == 0 {
		return nil
	}
	if inviter.AffQuota < 0 || inviter.AffHistoryQuota < 0 || inviter.AffQuota > common.MaxWalletQuota-reward || inviter.AffHistoryQuota > common.MaxWalletQuota-reward {
		return ErrReferralRewardLimit
	}
	result := tx.Model(&User{}).Where("id = ? AND aff_quota >= 0 AND aff_quota <= ? AND aff_history >= 0 AND aff_history <= ?", inviter.Id, common.MaxWalletQuota-reward, common.MaxWalletQuota-reward).
		Updates(map[string]any{"aff_quota": gorm.Expr("aff_quota + ?", reward), "aff_history": gorm.Expr("aff_history + ?", reward)})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrReferralRewardLimit
	}
	return tx.Create(&ReferralRebate{TopUpID: topUp.Id, TradeNo: topUp.TradeNo, InviterID: inviter.Id, InviteeID: invitee.Id, CreditedQuota: int64(creditedQuota), RateBPS: invitee.ReferralRateBPS, RewardQuota: int64(reward), SettledAt: topUp.CompleteTime, CreatedAt: time.Now().Unix()}).Error
}
