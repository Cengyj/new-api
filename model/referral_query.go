package model

import (
	"context"
	"database/sql"
	"math/big"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

type ReferralSummary struct {
	Rule                ReferralRebateRule `json:"rule"`
	ComplianceConfirmed bool               `json:"compliance_confirmed"`
	AffQuota            string             `json:"aff_quota"`
	AffHistoryQuota     string             `json:"aff_history_quota"`
	RebateQuota         string             `json:"rebate_quota"`
	DirectCount         int64              `json:"direct_count"`
}

type ReferralInvitee struct {
	ID          int    `json:"id"`
	DisplayName string `json:"display_name"`
	Deleted     bool   `json:"deleted"`
	CreatedAt   *int64 `json:"created_at"`
	Status      string `json:"status"`
	RateBPS     *int   `json:"rate_bps"`
	ExpiresAt   *int64 `json:"expires_at"`
	RebateQuota string `json:"rebate_quota"`
}

type ReferralInvitees struct {
	Items []ReferralInvitee `json:"items"`
	Total int64             `json:"total"`
}

type ReferralRebateFilter struct {
	InviterID int
	InviteeID int
	TradeNo   string
	StartTime int64
	EndTime   int64
}

type ReferralRebatePage struct {
	Items         []ReferralRebate `json:"items"`
	Total         int64            `json:"total"`
	CreditedQuota string           `json:"credited_quota"`
	RewardQuota   string           `json:"reward_quota"`
}

// Lists, counts and sums share one database snapshot, including on PostgreSQL
// (whose default READ COMMITTED would give each query a different snapshot).
func referralReadSnapshot(ctx context.Context, fn func(*gorm.DB) error) error {
	db := DB.WithContext(ctx)
	if common.UsingMainDatabase(common.DatabaseTypeSQLite) {
		return db.Transaction(fn)
	}
	return db.Transaction(fn, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
}

// MySQL SUM(integer) returns DECIMAL and PostgreSQL SUM(bigint) returns numeric.
// Transfer those exact aggregates as strings, avoiding both floating point and
// fetching the entire matching history into the application. SQLite SUM uses
// int64, so it still needs a cancellable arbitrary-precision streaming sum.
func referralTotals(query *gorm.DB) (count int64, credited, rewards string, err error) {
	if !common.UsingMainDatabase(common.DatabaseTypeSQLite) {
		textType := "CHAR"
		if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
			textType = "TEXT"
		}
		var totals struct {
			Count    int64
			Credited string
			Rewards  string
			Invalid  int64
		}
		err := query.Select("COUNT(*) AS count, CAST(COALESCE(SUM(credited_quota), 0) AS "+textType+") AS credited, "+
			"CAST(COALESCE(SUM(reward_quota), 0) AS "+textType+") AS rewards, "+
			"COALESCE(SUM(CASE WHEN credited_quota <= 0 OR credited_quota > ? OR reward_quota <= 0 OR reward_quota > ? THEN 1 ELSE 0 END), 0) AS invalid",
			common.MaxWalletQuota, common.MaxWalletQuota).Scan(&totals).Error
		if err != nil {
			return 0, "", "", err
		}
		if totals.Invalid != 0 {
			return 0, "", "", ErrInvalidReferralSnapshot
		}
		return totals.Count, totals.Credited, totals.Rewards, nil
	}
	rows, err := query.Select("credited_quota", "reward_quota").Rows()
	if err != nil {
		return 0, "", "", err
	}
	defer rows.Close()
	var totalCredit, totalReward big.Int
	for rows.Next() {
		var credit, reward int64
		if err := rows.Scan(&credit, &reward); err != nil {
			return 0, "", "", err
		}
		if credit <= 0 || reward <= 0 || credit > common.MaxWalletQuota || reward > common.MaxWalletQuota {
			return 0, "", "", ErrInvalidReferralSnapshot
		}
		totalCredit.Add(&totalCredit, big.NewInt(credit))
		totalReward.Add(&totalReward, big.NewInt(reward))
		count++
	}
	return count, totalCredit.String(), totalReward.String(), rows.Err()
}

// Durable rebate facts retain a direct contributor after the existing user
// deletion flow removes their profile. UNION keeps a live relationship with
// multiple awards in the same set exactly once, without inventing missing users.
func referralInviteeIDs(tx *gorm.DB, inviterID int) *gorm.DB {
	relations := tx.Unscoped().Model(&User{}).Select("id").Where("inviter_id = ?", inviterID)
	contributors := tx.Model(&ReferralRebate{}).Select("invitee_id AS id").Where("inviter_id = ?", inviterID)
	return tx.Table("(? UNION ?) AS referral_invitee_ids", relations, contributors)
}

func GetReferralSummary(ctx context.Context, userID int) (ReferralSummary, error) {
	var result ReferralSummary
	err := referralReadSnapshot(ctx, func(tx *gorm.DB) error {
		var user User
		if err := tx.Select("id", "aff_quota", "aff_history").First(&user, userID).Error; err != nil {
			return err
		}
		var err error
		result.Rule, err = readReferralRebateRule(tx, false)
		if err != nil {
			return err
		}
		result.ComplianceConfirmed = paymentComplianceConfirmed()
		result.AffQuota = strconv.Itoa(user.AffQuota)
		result.AffHistoryQuota = strconv.Itoa(user.AffHistoryQuota)
		if err := referralInviteeIDs(tx, userID).Count(&result.DirectCount).Error; err != nil {
			return err
		}
		_, _, result.RebateQuota, err = referralTotals(tx.Model(&ReferralRebate{}).Where("inviter_id = ?", userID))
		return err
	})
	return result, err
}

func ListReferralInvitees(ctx context.Context, userID, offset, limit int) (ReferralInvitees, error) {
	result := ReferralInvitees{Items: []ReferralInvitee{}}
	err := referralReadSnapshot(ctx, func(tx *gorm.DB) error {
		rule, err := readReferralRebateRule(tx, false)
		if err != nil {
			return err
		}
		if err := referralInviteeIDs(tx, userID).Count(&result.Total).Error; err != nil {
			return err
		}
		var ids []int
		if err := referralInviteeIDs(tx, userID).Select("id").Order("id DESC").Offset(offset).Limit(limit).Scan(&ids).Error; err != nil {
			return err
		}
		usersByID := make(map[int]User, len(ids))
		contributions := make(map[int]*big.Int, len(ids))
		if len(ids) > 0 {
			var users []User
			if err := tx.Unscoped().Where("inviter_id = ? AND id IN ?", userID, ids).
				Select("id", "display_name", "deleted_at", "created_at", "referral_rate_bps", "referral_expires_at").Find(&users).Error; err != nil {
				return err
			}
			for _, user := range users {
				usersByID[user.Id] = user
			}
			query := tx.Model(&ReferralRebate{}).Where("inviter_id = ? AND invitee_id IN ?", userID, ids)
			// Aggregate in the database when SUM uses a wider exact numeric
			// type. A page then returns one total per invitee instead
			// of transferring their entire payment history. SQLite retains the
			// arbitrary-precision streaming fallback used by referralTotals.
			grouped := !common.UsingMainDatabase(common.DatabaseTypeSQLite)
			if grouped {
				textType := "CHAR"
				if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
					textType = "TEXT"
				}
				query = query.Select("invitee_id, CAST(SUM(reward_quota) AS "+textType+") AS reward_quota, "+
					"SUM(CASE WHEN reward_quota <= 0 OR reward_quota > ? THEN 1 ELSE 0 END) AS invalid", common.MaxWalletQuota).Group("invitee_id")
			} else {
				query = query.Select("invitee_id", "reward_quota")
			}
			rows, err := query.Rows()
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id int
				if grouped {
					var reward string
					var invalid int64
					if err := rows.Scan(&id, &reward, &invalid); err != nil {
						return err
					}
					total, valid := new(big.Int).SetString(reward, 10)
					if invalid != 0 || !valid || total.Sign() <= 0 {
						return ErrInvalidReferralSnapshot
					}
					contributions[id] = total
					continue
				}
				var reward int64
				if err := rows.Scan(&id, &reward); err != nil {
					return err
				}
				if reward <= 0 || reward > common.MaxWalletQuota {
					return ErrInvalidReferralSnapshot
				}
				if contributions[id] == nil {
					contributions[id] = new(big.Int)
				}
				contributions[id].Add(contributions[id], big.NewInt(reward))
			}
			if err := rows.Err(); err != nil {
				return err
			}
		}
		now := time.Now().Unix()
		paused := !rule.Enabled || !paymentComplianceConfirmed()
		for _, id := range ids {
			user, present := usersByID[id]
			item := ReferralInvitee{ID: id, DisplayName: user.DisplayName, Deleted: !present || user.DeletedAt.Valid, Status: "none", RebateQuota: "0"}
			if item.Deleted {
				item.DisplayName = ""
			}
			if user.CreatedAt > 0 {
				item.CreatedAt = &user.CreatedAt
			}
			if user.ReferralRateBPS != 0 || user.ReferralExpiresAt != 0 {
				if user.ReferralRateBPS < 1 || user.ReferralRateBPS > 10000 || user.ReferralExpiresAt <= user.CreatedAt || user.ReferralExpiresAt > maxReferralTimestamp || user.CreatedAt <= 0 {
					return ErrInvalidReferralSnapshot
				}
				item.RateBPS, item.ExpiresAt = &user.ReferralRateBPS, &user.ReferralExpiresAt
				item.Status = "active"
				if now >= user.ReferralExpiresAt {
					item.Status = "expired"
				} else if paused {
					item.Status = "paused"
				}
			}
			if contribution := contributions[id]; contribution != nil {
				item.RebateQuota = contribution.String()
			}
			result.Items = append(result.Items, item)
		}
		return nil
	})
	return result, err
}

func ListReferralRebates(ctx context.Context, filter ReferralRebateFilter, offset, limit int) (ReferralRebatePage, error) {
	result := ReferralRebatePage{Items: []ReferralRebate{}}
	err := referralReadSnapshot(ctx, func(tx *gorm.DB) error {
		query := tx.Model(&ReferralRebate{})
		if filter.InviterID > 0 {
			query = query.Where("inviter_id = ?", filter.InviterID)
		}
		if filter.InviteeID > 0 {
			query = query.Where("invitee_id = ?", filter.InviteeID)
		}
		if filter.TradeNo != "" {
			query = query.Where("trade_no = ?", filter.TradeNo)
		}
		if filter.StartTime > 0 {
			query = query.Where("settled_at >= ?", filter.StartTime)
		}
		if filter.EndTime > 0 {
			query = query.Where("settled_at < ?", filter.EndTime)
		}
		var err error
		result.Total, result.CreditedQuota, result.RewardQuota, err = referralTotals(query.Session(&gorm.Session{}))
		if err != nil {
			return err
		}
		return query.Order("id DESC").Offset(offset).Limit(limit).Find(&result.Items).Error
	})
	return result, err
}
