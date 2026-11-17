package service

import (
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/system_setting"
)

func PaymentReturnURL(suffix string) string {
	common.OptionMapRWMutex.RLock()
	serverAddress := system_setting.ServerAddress
	common.OptionMapRWMutex.RUnlock()
	base := strings.TrimRight(serverAddress, "/")
	return base + suffix
}
