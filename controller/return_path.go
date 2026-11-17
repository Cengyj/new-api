package controller

import (
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/system_setting"
)

func paymentReturnPath(suffix string) string {
	common.OptionMapRWMutex.RLock()
	base := strings.TrimRight(system_setting.ServerAddress, "/")
	common.OptionMapRWMutex.RUnlock()
	return base + suffix
}
