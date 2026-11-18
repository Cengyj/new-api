package controller

import (
	"errors"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func isPaymentComplianceConfirmed() bool {
	return operation_setting.IsPaymentComplianceConfirmed()
}

func isStripeTopUpEnabled() bool {
	if !isPaymentComplianceConfirmed() {
		return false
	}
	return strings.TrimSpace(setting.StripeApiSecret) != "" &&
		strings.TrimSpace(setting.StripeWebhookSecret) != "" &&
		strings.TrimSpace(setting.StripePriceId) != ""
}

func isStripeWebhookConfigured() bool {
	return strings.TrimSpace(setting.StripeWebhookSecret) != ""
}

func isStripeWebhookEnabled() bool {
	return isPaymentComplianceConfirmed() && strings.TrimSpace(setting.StripeApiSecret) != "" && isStripeWebhookConfigured()
}

func isCreemTopUpEnabled() bool {
	if !isPaymentComplianceConfirmed() {
		return false
	}
	products := strings.TrimSpace(setting.CreemProducts)
	return strings.TrimSpace(setting.CreemApiKey) != "" &&
		isCreemWebhookConfigured() &&
		products != "" &&
		products != "[]"
}

func isCreemWebhookConfigured() bool {
	return strings.TrimSpace(setting.CreemWebhookSecret) != ""
}

func isCreemWebhookEnabled() bool {
	return isPaymentComplianceConfirmed() && strings.TrimSpace(setting.CreemApiKey) != "" && isCreemWebhookConfigured()
}

func isWaffoTopUpEnabled() bool {
	if !isPaymentComplianceConfirmed() {
		return false
	}
	if !setting.WaffoEnabled {
		return false
	}

	return isWaffoWebhookConfigured()
}

func isWaffoWebhookConfigured() bool {
	if setting.WaffoSandbox {
		return strings.TrimSpace(setting.WaffoSandboxApiKey) != "" &&
			strings.TrimSpace(setting.WaffoSandboxPrivateKey) != "" &&
			strings.TrimSpace(setting.WaffoSandboxPublicCert) != ""
	}

	return strings.TrimSpace(setting.WaffoApiKey) != "" &&
		strings.TrimSpace(setting.WaffoPrivateKey) != "" &&
		strings.TrimSpace(setting.WaffoPublicCert) != ""
}

func isWaffoWebhookEnabled() bool {
	return isPaymentComplianceConfirmed() && isWaffoWebhookConfigured()
}

func isWaffoPancakeTopUpEnabled() bool {
	if !isPaymentComplianceConfirmed() {
		return false
	}
	// Presence-of-credentials = enabled. Webhook public keys ship inside
	// the SDK; mode (test/prod) is read from each event.
	return isWaffoPancakeWebhookConfigured() && strings.TrimSpace(setting.WaffoPancakeProductID) != ""
}

func isWaffoPancakeWebhookConfigured() bool {
	return strings.TrimSpace(setting.WaffoPancakeMerchantID) != "" && strings.TrimSpace(setting.WaffoPancakePrivateKey) != ""
}

func isWaffoPancakeWebhookEnabled() bool {
	return isPaymentComplianceConfirmed() && isWaffoPancakeWebhookConfigured()
}

// Stripe and Creem share their notification endpoints with subscriptions. The
// delisting exception admits only an issued wallet order, never a subscription
// (including its top-up history row). Retriable lookup errors are not absence.
func requireIssuedWalletOrder(c *gin.Context, tradeNo, provider string) bool {
	order, err := model.GetTopUpByTradeNoWithError(tradeNo)
	if errors.Is(err, gorm.ErrRecordNotFound) || err == nil && order.PaymentProvider != provider {
		c.AbortWithStatus(http.StatusForbidden)
		return false
	}
	if err == nil {
		_, err = model.GetSubscriptionOrderByTradeNoWithError(tradeNo)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return true
		}
		if err == nil {
			c.AbortWithStatus(http.StatusForbidden)
			return false
		}
	}
	c.AbortWithStatus(http.StatusInternalServerError)
	return false
}

func isEpayTopUpEnabled() bool {
	if !isPaymentComplianceConfirmed() {
		return false
	}
	return isEpayWebhookConfigured() && len(operation_setting.PayMethods) > 0
}

func isEpayWebhookConfigured() bool {
	if strings.TrimSpace(operation_setting.PayAddress) == "" || strings.TrimSpace(operation_setting.EpayId) == "" {
		return false
	}
	paymentSetting := operation_setting.GetPaymentSetting()
	switch paymentSetting.EpaySignType {
	case operation_setting.EpaySignTypeRSA:
		return strings.TrimSpace(paymentSetting.EpayMerchantPrivateKey) != "" &&
			strings.TrimSpace(paymentSetting.EpayPlatformPublicKey) != ""
	case "", operation_setting.EpaySignTypeMD5:
		return strings.TrimSpace(operation_setting.EpayKey) != ""
	default:
		return false
	}
}

func isEpayWebhookEnabled() bool {
	// Removing checkout methods stops new sales, not payments on issued forms.
	return isPaymentComplianceConfirmed() && isEpayWebhookConfigured()
}
