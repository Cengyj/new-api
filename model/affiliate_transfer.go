package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"gorm.io/gorm"
)

// AffiliateTransfer is the durable outcome of an invitation reward transfer.
// Its identity survives response loss and log cleanup, including rejections.
type AffiliateTransfer struct {
	ID        int    `json:"id" gorm:"primaryKey"`
	UserID    int    `json:"-" gorm:"not null;uniqueIndex:idx_affiliate_transfer_request,priority:1"`
	RequestID string `json:"request_id" gorm:"type:varchar(64);not null;uniqueIndex:idx_affiliate_transfer_request,priority:2"`
	Quota     int    `json:"quota" gorm:"type:bigint;not null"`
	CreatedAt int64  `json:"created_at" gorm:"type:bigint;not null"`
	Status    string `json:"-" gorm:"type:varchar(16)"`
	Rejection string `json:"-" gorm:"type:text"`
}

// AffiliateTransferRejectedError identifies rejection before any wallet/cache
// write. Persisted distinguishes a committed terminal result from invalid input.
// Existing-result conflicts and technical failures remain unclassified.
type AffiliateTransferRejectedError struct {
	error
	Persisted bool
}

func (err *AffiliateTransferRejectedError) Unwrap() error { return err.error }

// A terminal rejection belongs to the same durable identity as a credit. It
// prevents a delayed retry from becoming money after the first page has safely
// released that identity. Empty status is a successful pre-upgrade record.
func (transfer *AffiliateTransfer) outcomeError() error {
	switch transfer.Status {
	case "", "success":
		if transfer.Rejection != "" || transfer.Quota <= 0 || transfer.Quota > common.MaxWalletQuota {
			return ErrWalletQuotaLimitExceeded
		}
		return nil
	case "rejected":
		var message common.Message
		if len(transfer.Rejection) > 2048 || common.UnmarshalJsonStr(transfer.Rejection, &message) != nil {
			return fmt.Errorf("invalid stored invitation transfer rejection")
		}
		switch message.Key {
		case "Invalid parameters", "Invitation quota is insufficient!", "Payment, redemption, subscription, and invitation reward features are disabled. The administrator must confirm compliance terms before enabling them.":
			if len(message.Params) != 0 {
				return fmt.Errorf("invalid stored invitation transfer rejection")
			}
		case "Minimum transfer quota is {{min}}!":
			minimum, ok := message.Params["min"].(string)
			if !ok || minimum == "" || len(message.Params) != 1 {
				return fmt.Errorf("invalid stored invitation transfer rejection")
			}
		case "Wallet quota limit exceeded":
			if len(message.Params) != 0 {
				return fmt.Errorf("invalid stored invitation transfer rejection")
			}
			return &AffiliateTransferRejectedError{error: ErrWalletQuotaLimitExceeded, Persisted: true}
		default:
			return fmt.Errorf("invalid stored invitation transfer rejection")
		}
		return &AffiliateTransferRejectedError{error: &message, Persisted: true}
	default:
		return fmt.Errorf("invalid stored invitation transfer status")
	}
}

func validAffiliateTransferRequestID(requestID string) bool {
	return len(requestID) >= 16 && len(requestID) <= 64 && !strings.ContainsFunc(requestID, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_')
	})
}

func GetAffiliateTransfer(userID int, requestID string) (*AffiliateTransfer, error) {
	if userID <= 0 || !validAffiliateTransferRequestID(requestID) {
		return nil, common.NewMessage("Invalid parameters")
	}
	var result AffiliateTransfer
	err := DB.Where("user_id = ? AND request_id = ?", userID, requestID).First(&result).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := result.outcomeError(); err != nil {
		return &result, err
	}
	// Result verification also completes a cache update interrupted after SQL
	// commit. It never starts a new transfer or changes a durable balance.
	// SQL collations may match a differently cased request ID. The cache
	// operation always belongs to the identity that was actually persisted.
	err = finishWalletCreditCache(userID, "affiliate:"+result.RequestID, result.Quota)
	return &result, err
}

func (user *User) TransferAffQuotaToQuota(quota int, requestID string) (*AffiliateTransfer, error) {
	if user.Id <= 0 || !validAffiliateTransferRequestID(requestID) {
		return nil, &AffiliateTransferRejectedError{error: common.NewMessage("Invalid parameters")}
	}
	var result AffiliateTransfer
	cacheOperation := "affiliate:" + requestID
	var cacheAttempt string
	commitAttempted := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		// One account lock serializes competing transfers and reward credits.
		users, err := lockWalletUsersTx(tx, user.Id)
		if err != nil {
			return err
		}
		if len(users) != 1 {
			return gorm.ErrRecordNotFound
		}
		current := users[0]
		err = tx.Where("user_id = ? AND request_id = ?", user.Id, requestID).First(&result).Error
		if err == nil {
			if result.Quota != quota {
				return common.NewMessage("Invalid parameters")
			}
			outcomeErr := result.outcomeError()
			var rejected *AffiliateTransferRejectedError
			if errors.As(outcomeErr, &rejected) {
				return nil
			}
			return outcomeErr
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		common.OptionMapRWMutex.RLock()
		compliant := operation_setting.IsPaymentComplianceConfirmed()
		minimum := common.QuotaPerUnit
		minimumLabel := ""
		if float64(quota) < minimum {
			minimumLabel = logger.FormatQuota(common.QuotaFromFloat(minimum))
		}
		common.OptionMapRWMutex.RUnlock()
		var rejection *common.Message
		switch {
		case !compliant:
			rejection = common.NewMessage("Payment, redemption, subscription, and invitation reward features are disabled. The administrator must confirm compliance terms before enabling them.")
		case quota <= 0 || quota > common.MaxWalletQuota, current.Status != common.UserStatusEnabled:
			rejection = common.NewMessage("Invalid parameters")
		case float64(quota) < minimum:
			rejection = common.NewMessage("Minimum transfer quota is {{min}}!", map[string]any{"min": minimumLabel})
		case current.AffQuota < quota:
			rejection = common.NewMessage("Invitation quota is insufficient!")
		case current.AffQuota > common.MaxWalletQuota || current.Quota > common.MaxWalletQuota:
			return ErrWalletQuotaLimitExceeded
		case current.Quota > common.MaxWalletQuota-quota:
			rejection = common.NewMessage("Wallet quota limit exceeded")
		}
		if rejection != nil {
			encoded, err := common.Marshal(rejection)
			if err != nil {
				return err
			}
			if len(encoded) > 2048 {
				return fmt.Errorf("invitation transfer rejection exceeds storage limit")
			}
			result = AffiliateTransfer{UserID: user.Id, RequestID: requestID, Quota: quota, CreatedAt: common.GetTimestamp(), Status: "rejected", Rejection: string(encoded)}
			if err := tx.Create(&result).Error; err != nil {
				return err
			}
			commitAttempted = true
			return nil
		}
		cacheAttempt, err = captureWalletCreditCache(tx, user.Id, cacheOperation)
		if err != nil {
			return err
		}
		update := tx.Model(&User{}).Where("id = ? AND aff_quota >= ? AND quota <= ?", current.Id, quota, common.MaxWalletQuota-quota).Updates(map[string]any{
			"aff_quota": gorm.Expr("aff_quota - ?", quota),
			"quota":     gorm.Expr("quota + ?", quota),
		})
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected != 1 {
			return fmt.Errorf("invitation transfer balance changed concurrently")
		}
		result = AffiliateTransfer{UserID: user.Id, RequestID: requestID, Quota: quota, CreatedAt: common.GetTimestamp(), Status: "success"}
		if err := tx.Create(&result).Error; err != nil {
			return err
		}
		commitAttempted = true
		return nil
	})
	if err != nil {
		if !commitAttempted {
			cancelWalletCreditCache(user.Id, cacheOperation, cacheAttempt)
		}
		// A failed commit response is not proof of rollback. Check the original
		// identity, and never initiate a replacement transfer to resolve it.
		persisted, lookupErr := GetAffiliateTransfer(user.Id, requestID)
		var rejected *AffiliateTransferRejectedError
		if persisted != nil && persisted.Quota == quota && (lookupErr == nil || errors.As(lookupErr, &rejected) && rejected.Persisted) {
			return persisted, lookupErr
		}
		return nil, err
	}
	if err := result.outcomeError(); err != nil {
		return &result, err
	}
	err = finishWalletCreditCache(user.Id, "affiliate:"+result.RequestID, result.Quota)
	return &result, err
}
