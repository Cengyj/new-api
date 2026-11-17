package operation_setting

import (
	"strings"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"
)

type PaymentSetting struct {
	AmountOptions  []int           `json:"amount_options"`
	AmountDiscount map[int]float64 `json:"amount_discount"` // 充值金额对应的折扣，例如 100 元 0.9 表示 100 元充值享受 9 折优惠

	ComplianceConfirmed    bool   `json:"compliance_confirmed"`
	ComplianceTermsVersion string `json:"compliance_terms_version"`
	ComplianceConfirmedAt  int64  `json:"compliance_confirmed_at"`
	ComplianceConfirmedBy  int    `json:"compliance_confirmed_by"`
	ComplianceConfirmedIP  string `json:"compliance_confirmed_ip"`

	// 易支付签名方式：MD5 使用 EpayKey；RSA 使用商户私钥签名请求、平台公钥验证回调。
	EpaySignType           string `json:"epay_sign_type"`
	EpayMerchantPrivateKey string `json:"epay_merchant_private_key"`
	EpayPlatformPublicKey  string `json:"epay_platform_public_key"`
}

const CurrentComplianceTermsVersion = "v1"

const (
	EpaySignTypeMD5 = "MD5"
	EpaySignTypeRSA = "RSA"

	EpaySignTypeOptionKey           = "payment_setting.epay_sign_type"
	EpayMerchantPrivateKeyOptionKey = "payment_setting.epay_merchant_private_key"
	EpayPlatformPublicKeyOptionKey  = "payment_setting.epay_platform_public_key"
)

// 默认配置
var paymentSetting = PaymentSetting{
	AmountOptions:  []int{10, 20, 50, 100, 200, 500},
	AmountDiscount: map[int]float64{},
	// 没有保存过签名方式的站点按 MD5 运行，升级后行为不变。
	EpaySignType: EpaySignTypeMD5,
}

func init() {
	// 注册到全局配置管理器
	config.GlobalConfig.Register("payment_setting", &paymentSetting)
}

func GetPaymentSetting() *PaymentSetting {
	return &paymentSetting
}

func IsPaymentComplianceConfirmed() bool {
	return paymentSetting.ComplianceConfirmed &&
		paymentSetting.ComplianceTermsVersion == CurrentComplianceTermsVersion
}

// ValidateEpaySignOption validates a single setting against the active keys.
func ValidateEpaySignOption(key, value string) error {
	return ValidateEpaySignOptions(map[string]string{key: value})
}

// ValidateEpaySignOptions validates the complete proposed signing configuration.
// A batch can enable RSA with both keys, or switch to MD5 while clearing them.
// Callers serialize this validation with payment configuration publication.
func ValidateEpaySignOptions(values map[string]string) error {
	signValue, signChanged := values[EpaySignTypeOptionKey]
	privateValue, privateChanged := values[EpayMerchantPrivateKeyOptionKey]
	publicValue, publicChanged := values[EpayPlatformPublicKeyOptionKey]
	if !signChanged && !privateChanged && !publicChanged {
		return nil
	}
	common.OptionMapRWMutex.RLock()
	signType := paymentSetting.EpaySignType
	privateKey := paymentSetting.EpayMerchantPrivateKey
	publicKey := paymentSetting.EpayPlatformPublicKey
	common.OptionMapRWMutex.RUnlock()
	if signChanged {
		if signValue != EpaySignTypeMD5 && signValue != EpaySignTypeRSA {
			return common.NewMessage("Epay signature type must be MD5 or RSA")
		}
		signType = signValue
	}
	if privateChanged {
		privateKey = privateValue
	}
	if publicChanged {
		publicKey = publicValue
	}
	rsaActive := signType == EpaySignTypeRSA
	if rsaActive || (privateChanged && strings.TrimSpace(privateValue) != "") {
		if _, err := epay.ParseRSAPrivateKey(privateKey); err != nil {
			return common.NewMessage("The Epay merchant private key is missing or invalid")
		}
	}
	if rsaActive || (publicChanged && strings.TrimSpace(publicValue) != "") {
		if _, err := epay.ParseRSAPublicKey(publicKey); err != nil {
			return common.NewMessage("The Epay platform public key is missing or invalid")
		}
	}
	return nil
}
